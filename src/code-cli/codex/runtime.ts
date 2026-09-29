import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ownerAlive, validateCodexContext } from './discovery.js';
import type { RuntimeLink, Job } from '../../core/model.js';
import { AppError, ensure, errorBody } from '../../core/errors.js';

import type {
  LiveRuntime,
  RuntimeFactory,
  RuntimeNotification,
  RuntimeSnapshot,
  RuntimeStop,
} from '../port.js';

/** Broker-owned protocol connection. Session execution remains with its CLI. */
export class Rpc {
  readonly events = new EventEmitter();

  private child?: ChildProcessWithoutNullStreams;

  private serial = 0;

  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private executable: string,
    private homeId: string,
    private args: string[] = ['app-server', '--stdio'],
  ) {}

  async connect() {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.homeId };
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    this.child = spawn(this.executable, this.args, { windowsHide: true, env, stdio: 'pipe' });
    const fail = (error: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.events.emit('notification', { method: 'connection/closed', params: {} });
    };
    this.child.on('error', (e) => fail(e));
    this.child.on('exit', () =>
      fail(new AppError('RUNTIME_DISCONNECTED', '队列中继已关闭。', 503)),
    );
    this.child.stdin.on('error', (e) => fail(e));
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        fail(new AppError('NATIVE_PROTOCOL_ERROR', '队列中继返回无效协议数据。', 502));
        return;
      }
      const p = this.pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        if (message.error) {
          p.reject(
            new AppError(
              'NATIVE_RPC_ERROR',
              `Codex ${message.error.code}: ${String(message.error.message).slice(0, 180)}`,
              502,
            ),
          );
        } else {
          p.resolve(message.result);
        }
      } else if (message.method && message.id !== undefined) {
        this.child!.stdin.write(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'Queue relay client' },
          }) + '\n',
        );
      } else if (message.method) {
        this.events.emit('notification', message);
      }
    });
    await this.call('initialize', {
      clientInfo: { name: 'agent_to_im_queue', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }

  call(method: string, params: unknown = {}, timeout = 10000): Promise<any> {
    ensure(
      this.child && this.child.exitCode === null && !this.child.killed,
      'RUNTIME_UNREACHABLE',
      '队列中继未连接。',
      503,
    );
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('NATIVE_RPC_TIMEOUT', '原生请求结果尚未确认。', 504));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    const child = this.child;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.stdin.end();
    });
  }

  get processId() {
    return this.child?.pid;
  }
}
export class CodexRuntime implements LiveRuntime {
  private rpc: Rpc;

  private ready = false;

  constructor(private link: RuntimeLink) {
    this.rpc = new Rpc(link.owner.executable, link.homeId);
  }

  onEvent(listener: (event: RuntimeNotification) => void) {
    this.rpc.events.on('notification', listener);
  }

  async connect() {
    if (!this.ready) {
      await this.rpc.connect();
      this.ready = true;
    }
    return this.inspect();
  }

  async inspect(): Promise<RuntimeSnapshot> {
    const { thread } = await this.rpc.call('thread/read', {
      threadId: this.link.threadId,
      includeTurns: false,
    });
    ensure(
      thread.id === this.link.threadId,
      'THREAD_CONTEXT_UNVERIFIED',
      '原生会话身份发生变化。',
      403,
    );
    return {
      threadId: thread.id,
      cwd: thread.cwd,
      status: (await ownerAlive(this.link.owner)) ? 'owner_online' : 'offline',
      activeTurns: [],
      executionState: 'unobserved',
      controlMode: 'queue_relay',
    };
  }

  async submit(job: Job) {
    const r = await this.rpc.call('thread/queue/add', {
      threadId: this.link.threadId,
      clientUserMessageId: job.id,
      input: [
        {
          type: 'text',
          text: `[agent-to-im job_id=${job.id}]\nIM 用户任务：\n${job.prompt}\n完成后通过 send_message_to_user 回传结果，purpose=result，job_id=${job.id}。`,
        },
      ],
    });
    ensure(r.queuedSubmission?.id, 'NATIVE_PROTOCOL_ERROR', '原生队列缺少投递回执。', 502);
    return { queueId: r.queuedSubmission.id };
  }

  async cancelQueued(queueId: string) {
    await this.rpc.call('thread/queue/delete', {
      threadId: this.link.threadId,
      queuedSubmissionId: queueId,
    });
  }

  async stop(): Promise<RuntimeStop> {
    const report: RuntimeStop = {
      complete: false,
      scope: 'tracked_resources',
      interruptedTurns: 0,
      cancelledNativeQueue: 0,
      terminatedTerminals: 0,
      residuals: [],
    };
    try {
      let cursor: string | undefined;
      do {
        const page = await this.rpc.call('thread/queue/list', {
          threadId: this.link.threadId,
          cursor,
        });
        for (const q of page.data) {
          await this.cancelQueued(q.id);
          report.cancelledNativeQueue++;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    } catch (error) {
      report.residuals.push({ resourceId: 'native-queue', reason: errorBody(error).error.message });
    }
    try {
      await this.rpc.call('thread/goal/clear', { threadId: this.link.threadId });
    } catch (error) {
      report.residuals.push({ resourceId: 'native-goal', reason: errorBody(error).error.message });
    }
    report.residuals.push({
      resourceId: this.link.threadId,
      reason:
        '队列与持续目标清理已尝试；原 CLI 的运行中 turn、子任务和终端需在原生界面停止并核对。',
    });
    return report;
  }

  async close() {
    await this.rpc.close();
    this.ready = false;
  }

  get processId() {
    return this.rpc.processId;
  }
}
export class CodexRuntimeFactory implements RuntimeFactory {
  validateContext = validateCodexContext;

  create(link: RuntimeLink) {
    return new CodexRuntime(link);
  }
}
