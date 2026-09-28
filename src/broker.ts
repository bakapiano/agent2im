import { randomUUID } from 'node:crypto';
import type { Store } from './db/store.js';
import type { Vault } from './credentials/vault.js';
import { Policy, imSubject } from './access/policy.js';
import { ChannelService } from './channels/service.js';
import type { ImEvent } from './im/port.js';
import type { ImRegistry } from './im/registry.js';
import type { LiveRuntime, RuntimeNotification, RuntimeSnapshot } from './code-cli/port.js';
import type { CodeCliRegistry } from './code-cli/registry.js';
import type {
  AuthStamp,
  Channel,
  Client,
  Config,
  Conversation,
  Job,
  Outbox,
  RuntimeLink,
  Session,
  WaitRequest,
} from './core/model.js';
import type {
  ConfigureImChannelArgs,
  RegisterArgs,
  SendMessageArgs,
  WaitForUserArgs,
} from '../spec/contracts.js';
import { AppError, ensure, errorBody } from './core/errors.js';
import { digest, hash, id, now, parseCommand, sameSecret, sleep, token } from './core/util.js';
import { KeyedLock } from './core/lock.js';
import { validateTool } from './core/validation.js';
import type { NativeContext } from './code-cli/port.js';
import { nativePath, sameWorkspace, workspaceLabel } from './core/workspace.js';

export interface Caller {
  clientId: string;
  secret: string;
  attemptId: string;
  nativeContext?: NativeContext;
}
const isFencedState = (state: Session['state']) => ['stopping', 'stopped', 'stop_incomplete'].includes(state);
const help =
  '/sessions · /switch <会话短ID> · /status [短ID] · /send <短ID> <任务> · /reply <问题短ID> <回答> · /stop [短ID]\n普通文本发送给当前会话；引用问题可回复原会话。';

export class Broker {
  readonly policy: Policy;
  readonly channels: ChannelService;
  readonly runtimes = new Map<string, LiveRuntime>();
  private connecting = new Map<string, Promise<LiveRuntime>>();
  private locks = new KeyedLock();
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private closed = false;
  private stopping = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly vault: Vault,
    readonly config: Config,
    im: ImRegistry,
    readonly agents: CodeCliRegistry,
  ) {
    this.policy = new Policy(store);
    this.channels = new ChannelService(store, vault, this.policy, im);
    this.channels.onMessage = (c, e) => this.receive(c, e);
    this.policy.onChange = () => this.recheck();
    this.channels.onChange = () => this.recheck();
  }
  async start() {
    // A crash after a side effect yields an uncertain result, never blind replay.
    for (const o of this.store.list('outbox').filter((o) => o.state === 'sending')) {
      o.state = 'unknown';
      this.store.put('outbox', o);
    }
    for (const j of this.store.list('job').filter((j) => ['dispatching', 'running'].includes(j.state))) {
      j.state = 'unknown';
      this.store.put('job', j);
    }
    for (const s of this.store.list('session')) {
      if (s.state === 'stopping') {
        // The previous process never finished verification. Keep dispatch closed
        // until an explicit stop retries the native resource inventory.
        s.state = 'stop_incomplete';
        const report = {
          complete: false,
          scope: 'tracked_resources',
          residuals: [{ resourceId: s.threadId, reason: '服务重启前的停止操作未完成核对，请重试 /stop' }],
        };
        const pending = this.store.list('stop').filter((r) => r.sessionId === s.id && r.state === 'running');
        if (pending.length)
          for (const record of pending) this.store.put('stop', { ...record, state: 'incomplete', report });
        else
          this.store.put('stop', {
            id: id('stop'),
            sessionId: s.id,
            state: 'incomplete',
            report,
            createdAt: now(),
          });
      } else if (!isFencedState(s.state)) s.state = 'offline';
      this.store.put('session', s);
    }
    this.recheck();
    await this.channels.restore();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 300);
    this.timer.unref();
    // Subscribe before an agent makes its registration call.
    await Promise.all(this.store.list('runtime').map((r) => this.runtime(r.id).catch(() => undefined)));
  }
  authenticate(caller: Caller): Client {
    const c = this.store.get('client', caller.clientId);
    ensure(
      c && c.state === 'active' && sameSecret(c.secretHash, hash(caller.secret)),
      'CLIENT_UNAUTHORIZED',
      '本地客户端身份无效。',
      401,
    );
    return c;
  }
  enroll(name: string, osUser: string) {
    const secret = token();
    const client: Client = {
      id: id('client'),
      name,
      secretHash: hash(secret),
      installationId: this.store.setting<string>('installationId') ?? id('install'),
      osUser,
      state: 'active',
      createdAt: now(),
    };
    this.store.setSetting('installationId', client.installationId);
    this.store.put('client', client);
    this.store.audit('client.enrolled', 'local-installation', client.id);
    return { client_id: client.id, secret };
  }
  async runtime(runtimeId: string): Promise<LiveRuntime> {
    const live = this.runtimes.get(runtimeId);
    if (live) return live;
    const existing = this.connecting.get(runtimeId);
    if (existing) return existing;
    const work = (async () => {
      const link = this.store.get('runtime', runtimeId);
      ensure(link, 'RUNTIME_UNREACHABLE', '运行绑定不存在。', 503);
      const r = this.agents.create(link);
      try {
        const snapshot = await r.connect();
        ensure(
          sameWorkspace(snapshot.cwd, link.cwd),
          'THREAD_CONTEXT_UNVERIFIED',
          '原生工作目录已变化，请重新核对绑定。',
          403,
        );
      } catch (e) {
        await r.close();
        throw e;
      }
      this.runtimes.set(runtimeId, r);
      r.onEvent((e) => {
        if (this.runtimes.get(link.id) === r) this.event(link, e);
      });
      return r;
    })();
    this.connecting.set(runtimeId, work);
    try {
      return await work;
    } finally {
      this.connecting.delete(runtimeId);
    }
  }
  async tool(name: string, args: any, caller: Caller, signal?: AbortSignal): Promise<unknown> {
    validateTool(name, args);
    const client = this.authenticate(caller);
    if (name === 'configure_im_channel') return this.channels.execute(args as ConfigureImChannelArgs, client);
    const context = caller.nativeContext;
    ensure(context, 'THREAD_CONTEXT_UNVERIFIED', '需要当前原生会话元数据。', 403);
    const entered = this.store
      .list('session')
      .find(
        (s) =>
          s.provider === context.provider && s.homeId === context.homeId && s.threadId === context.threadId,
      );
    const link = await this.bindNative(context, client);
    const snapshot = await (await this.runtime(link.id)).inspect();
    ensure(
      snapshot.threadId === context.threadId && sameWorkspace(snapshot.cwd, link.cwd),
      'THREAD_CONTEXT_UNVERIFIED',
      '当前会话归属核对失败。',
      403,
    );
    if (entered)
      ensure(
        this.store.get('session', entered.id)?.epoch === entered.epoch,
        'STALE_CONTROL_EPOCH',
        '该调用发起后会话已被停止。',
        409,
      );
    this.authenticate(caller);
    if (name === 'register') return this.register(args, client, link);
    const s = this.store.get('session', args.session_id);
    ensure(
      s && s.clientId === client.id && s.runtimeId === link.id && s.threadId === context.threadId,
      'SESSION_FORBIDDEN',
      '工具只能操作当前会话。',
      403,
    );
    ensure(
      !['stopping', 'stopped', 'stop_incomplete'].includes(s.state),
      'SESSION_STOPPING',
      '会话已停止或仍需核对停止结果。',
      409,
    );
    if (name === 'send_message_to_user') return this.send(s, args);
    return this.wait(s, args, signal);
  }
  private async bindNative(context: NativeContext, client: Client): Promise<RuntimeLink> {
    this.agents.validateContext(context);
    return this.locks.run(`native:${context.provider}:${context.homeId}:${context.threadId}`, async () => {
      const existing = this.store
        .list('runtime')
        .find(
          (r) =>
            r.provider === context.provider && r.homeId === context.homeId && r.threadId === context.threadId,
        );
      ensure(
        !existing || existing.clientId === client.id,
        'THREAD_OWNERSHIP_CONFLICT',
        '该会话属于另一客户端。',
        409,
      );
      if (existing && digest(existing.owner) === digest(context.owner)) return existing;
      const link: RuntimeLink = {
        id: existing?.id ?? id('runtime'),
        provider: context.provider,
        clientId: client.id,
        threadId: context.threadId,
        homeId: context.homeId,
        owner: context.owner,
        cwd: '',
        workspace: '',
        createdAt: now(),
      };
      const live = this.agents.create(link);
      try {
        const snapshot = await live.connect();
        ensure(
          snapshot.threadId === context.threadId && snapshot.status !== 'offline',
          'THREAD_CONTEXT_UNVERIFIED',
          '当前原生宿主或会话无法核验。',
          403,
        );
        link.cwd = nativePath(snapshot.cwd);
        link.workspace = workspaceLabel(link.cwd, this.config.workspaces);
      } catch (error) {
        await live.close();
        throw error;
      }
      await this.runtimes.get(link.id)?.close();
      this.store.put('runtime', link);
      this.runtimes.set(link.id, live);
      live.onEvent((e) => {
        if (this.runtimes.get(link.id) === live) this.event(link, e);
      });
      this.store.audit('runtime.queue_relay_bound', client.id, link.id, {
        threadId: link.threadId,
        ownerPid: link.owner.pid,
      });
      return link;
    });
  }
  private register(args: RegisterArgs, client: Client, link: RuntimeLink) {
    ensure(
      !args.native_thread_id || args.native_thread_id === link.threadId,
      'THREAD_CONTEXT_UNVERIFIED',
      'thread 一致性检查失败。',
      403,
    );
    let c = args.connection_alias
      ? this.store.list('conversation').find((c) => c.alias === args.connection_alias)
      : undefined;
    if (!args.connection_alias) {
      const eligible = this.store.list('conversation').filter((c) => {
        const ch = this.store.get('channel', c.channelId);
        return (
          ch?.state === 'enabled' &&
          ch.identityVersion === c.identityVersion &&
          this.policy.find(imSubject(ch, c.tenantId, c.userId), ch, c.id)
        );
      });
      if (eligible.length > 1)
        throw new AppError('CONNECTION_SELECTION_REQUIRED', '存在多个获批私聊，请选择这次接入的会话。', 409, {
          connections: eligible.map((c) => ({ connection_alias: c.alias, display_name: c.displayName })),
        });
      c = eligible[0];
    }
    ensure(c, 'CONNECTION_NOT_APPROVED', '请先在 IM 私聊机器人，并在 Web 批准后使用私聊连接别名。', 403);
    const channel = this.store.get('channel', c.channelId)!;
    ensure(
      channel?.state === 'enabled' && channel.identityVersion === c.identityVersion,
      'CONNECTION_NOT_APPROVED',
      '私聊渠道需要启用并完成身份审批。',
      403,
    );
    const old = this.store
      .list('session')
      .find((s) => s.provider === link.provider && s.homeId === link.homeId && s.threadId === link.threadId);
    ensure(
      !old || (old.clientId === client.id && old.conversationId === c.id),
      'THREAD_OWNERSHIP_CONFLICT',
      '会话已绑定另一私聊路由。',
      409,
    );
    const sid =
      old?.id ??
      this.store.claim('native-session', `${link.provider}:${link.homeId}:${link.threadId}`, randomUUID());
    this.policy.require(imSubject(channel, c.tenantId, c.userId), channel, c.id);
    const memoId = `register:${client.id}:${link.id}:${args.idempotency_key}`;
    const memo = this.store.get('idempotency', memoId);
    if (memo) {
      ensure(memo.digest === digest(args), 'IDEMPOTENCY_CONFLICT', '注册幂等键内容变化。', 409);
      return memo.result;
    }
    const session: Session = {
      id: sid,
      provider: link.provider,
      shortId: `s_${sid.slice(0, 8)}`,
      title: args.title,
      clientId: client.id,
      runtimeId: link.id,
      threadId: link.threadId,
      homeId: link.homeId,
      cwd: link.cwd,
      workspace: link.workspace,
      channelId: channel.id,
      conversationId: c.id,
      epoch: old?.epoch ?? 1,
      state: old && ['stopping', 'stopped', 'stop_incomplete'].includes(old.state) ? old.state : 'ready',
      createdAt: old?.createdAt ?? now(),
      lastSeenAt: now(),
    };
    this.store.put('session', session);
    if (args.activate) this.store.setSetting(`selection:${c.id}`, sid);
    const result = {
      session_id: sid,
      short_id: session.shortId,
      title: session.title,
      connection_id: c.id,
      runtime_id: link.id,
      native_thread_id: link.threadId,
      control_mode: 'queue_relay',
      stop_scope: 'tracked_resources',
      active: this.store.setting(`selection:${c.id}`) === sid,
      control_epoch: session.epoch,
    };
    this.store.put('idempotency', { id: memoId, digest: digest(args), result });
    this.store.audit('session.registered', client.id, sid);
    return result;
  }
  private stamp(s: Session): AuthStamp {
    const c = this.store.get('conversation', s.conversationId)!;
    return {
      channelId: s.channelId,
      identityVersion: c.identityVersion,
      conversationId: c.id,
      subject: imSubject({ id: s.channelId, identityVersion: c.identityVersion }, c.tenantId, c.userId),
    };
  }
  private enqueue(
    c: Conversation,
    text: string,
    key: string,
    purpose: Outbox['purpose'],
    s?: Session,
    auth?: AuthStamp,
    nativeTurnId?: string,
  ): Outbox {
    return this.store.transaction(() => {
      const oid = this.store.claim('outbox', key, id('out'));
      const previous = this.store.get('outbox', oid);
      const payloadDigest = digest({ text, purpose });
      if (previous) {
        ensure(previous.payloadDigest === payloadDigest, 'IDEMPOTENCY_CONFLICT', '消息幂等键内容变化。', 409);
        return previous;
      }
      const o: Outbox = {
        id: oid,
        sessionId: s?.id,
        epoch: s?.epoch,
        channelId: c.channelId,
        conversationId: c.id,
        text,
        purpose,
        state: 'queued',
        auth,
        businessKey: key,
        payloadDigest,
        attempts: 0,
        nextAttemptAt: now(),
        createdAt: now(),
        nativeTurnId,
      };
      this.store.put('outbox', o);
      return o;
    });
  }
  private send(s: Session, args: SendMessageArgs) {
    const stamp = this.stamp(s);
    this.policy.check(stamp);
    const memoId = `send-memo:${s.id}:${args.idempotency_key}`;
    const memo = this.store.get('idempotency', memoId);
    const payload = digest({ text: args.text, purpose: args.purpose ?? 'notice', jobId: args.job_id });
    if (memo) {
      ensure(memo.digest === payload, 'IDEMPOTENCY_CONFLICT', '消息幂等键内容变化。', 409);
      return this.sendResult(s, this.store.get('outbox', memo.result as string)!);
    }
    const job = args.job_id ? this.store.get('job', args.job_id) : undefined;
    if (args.job_id)
      ensure(
        job &&
          job.sessionId === s.id &&
          job.epoch === s.epoch &&
          args.purpose === 'result' &&
          !['cancelled', 'failed'].includes(job.state),
        'JOB_CONTEXT_INVALID',
        '结果必须属于当前会话的当前任务。',
        403,
      );
    const key = job ? `result:${job.id}` : `send:${s.id}:${args.idempotency_key}`;
    const o = this.enqueue(
      this.store.get('conversation', s.conversationId)!,
      `[${s.shortId} · ${s.title}]\n${args.text}`,
      key,
      args.purpose ?? 'notice',
      s,
      stamp,
    );
    if (job) {
      job.state = 'completed';
      this.store.put('job', job);
      s.state = 'ready';
      this.store.put('session', s);
    }
    this.store.put('idempotency', { id: memoId, digest: payload, result: o.id });
    return this.sendResult(s, o);
  }
  private sendResult(s: Session, o: Outbox) {
    ensure(
      !['failed', 'cancelled'].includes(o.state),
      'DELIVERY_FAILED',
      '该消息投递已结束，请核对审计记录。',
      409,
    );
    return {
      message_id: o.id,
      session_id: s.id,
      conversation_id: s.conversationId,
      delivery_status: o.state === 'sending' ? 'queued' : o.state,
      platform_message_id: o.platformMessageId,
    };
  }
  private async wait(s: Session, args: WaitForUserArgs, signal?: AbortSignal) {
    const auth = this.stamp(s);
    this.policy.check(auth);
    const wid = this.store.claim('wait', `${s.id}:${args.request_key}`, id('wait'));
    let w = this.store.get('wait', wid);
    if (!w) {
      ensure(args.mode === 'ask', 'WAIT_NOT_FOUND', '该问题尚未创建。', 404);
      ensure(
        !this.store
          .list('wait')
          .some((w) => w.sessionId === s.id && w.state === 'open' && w.expiresAt > now()),
        'WAIT_ALREADY_OPEN',
        '请恢复当前开放问题。',
        409,
      );
      const shortId = `q_${wid.slice(-8)}`;
      const o = this.enqueue(
        this.store.get('conversation', s.conversationId)!,
        `[${s.shortId} · ${s.title} · ${shortId}]\n${args.prompt}\n回复：/reply ${shortId} 你的回答`,
        `question:${wid}`,
        'question',
        s,
        auth,
      );
      w = {
        id: wid,
        shortId,
        sessionId: s.id,
        epoch: s.epoch,
        conversationId: s.conversationId,
        requestKey: args.request_key,
        prompt: args.prompt,
        payloadDigest: digest({ prompt: args.prompt, ttl: args.reply_ttl_seconds ?? 1800 }),
        outboxId: o.id,
        state: 'open',
        auth,
        createdAt: now(),
        expiresAt: now() + (args.reply_ttl_seconds ?? 1800) * 1000,
      };
      this.store.put('wait', w);
      s.state = 'waiting_user';
      this.store.put('session', s);
    } else if (args.mode === 'ask')
      ensure(
        w.payloadDigest === digest({ prompt: args.prompt, ttl: args.reply_ttl_seconds ?? 1800 }),
        'IDEMPOTENCY_CONFLICT',
        '问题内容或期限变化。',
        409,
      );
    const deadline = now() + (args.timeout_seconds ?? 240) * 1000;
    do {
      this.recheck();
      w = this.store.get('wait', wid)!;
      if (w.state !== 'open' || signal?.aborted || this.closed) break;
      await sleep(Math.min(100, Math.max(1, deadline - now())));
    } while (now() < deadline);
    return {
      session_id: s.id,
      request_id: w.id,
      question_short_id: w.shortId,
      status: w.state === 'open' ? 'waiting' : w.state,
      ...(w.reply ? { reply: w.reply } : {}),
      ...(w.state === 'open' ? { expires_at: new Date(w.expiresAt).toISOString() } : {}),
      ...(w.reason ? { reason: w.reason } : {}),
    };
  }
  async receive(channel: Channel, event: ImEvent) {
    if (
      event.chatType !== 'p2p' ||
      !event.userId ||
      !event.tenantId ||
      !event.messageId ||
      event.text.length > 12000
    )
      return;
    await this.locks.run(`inbound:${channel.id}:${event.tenantId}:${event.userId}`, async () => {
      const current = this.store.get('channel', channel.id);
      if (current?.state !== 'enabled' || current.identityVersion !== channel.identityVersion) return;
      const cid = this.store.claim(
        'conversation',
        `${channel.id}:${channel.identityVersion}:${event.tenantId}:${event.userId}`,
        id('conv'),
      );
      let c = this.store.get('conversation', cid);
      if (!c) {
        c = {
          id: cid,
          channelId: channel.id,
          identityVersion: channel.identityVersion,
          tenantId: event.tenantId,
          userId: event.userId,
          chatId: event.chatId,
          displayName: event.displayName ?? event.userId,
          createdAt: now(),
        };
        this.store.put('conversation', c);
      }
      ensure(c.chatId === event.chatId, 'IDENTITY_MISMATCH', '私聊地址发生变化。', 403);
      const subject = imSubject(channel, c.tenantId, c.userId);
      if (!this.policy.find(subject, channel, cid)) {
        const request = this.policy.request({
          subject,
          subjectLabel: c.displayName,
          channelId: channel.id,
          identityVersion: channel.identityVersion,
          conversationId: cid,
        });
        this.enqueue(
          c,
          `请在本机 Web Portal 审阅访问申请 ${request.id}，批准后重新发送命令。`,
          `access:${request.id}`,
          'access_notice',
        );
        return;
      }
      const iid = this.store.claim('inbox', `${channel.id}:${event.messageId}`, id('in'));
      if (this.store.get('inbox', iid)) return;
      const inbox = {
        id: iid,
        channelId: channel.id,
        conversationId: cid,
        platformMessageId: event.messageId,
        text: event.text,
        replyTo: event.replyTo,
        receivedAt: now(),
        state: 'received' as const,
      };
      this.store.put('inbox', inbox);
      const control = (text: string) =>
        this.enqueue(c!, text, `control:${iid}`, 'control', undefined, {
          channelId: channel.id,
          identityVersion: channel.identityVersion,
          conversationId: cid,
          subject,
        });
      try {
        const command = parseCommand(event.text);
        const sessions = this.store.list('session').filter((s) => s.conversationId === cid);
        const selected = (arg?: string) => {
          const s = sessions.find((s) =>
            arg ? s.shortId === arg || s.id === arg : s.id === this.store.setting(`selection:${cid}`),
          );
          ensure(s, 'SESSION_NOT_REGISTERED', '请先注册会话，再使用 /sessions 和 /switch。', 404);
          return s;
        };
        if (command?.name === 'help') {
          control(help);
          return;
        }
        if (command?.name === 'sessions') {
          control(
            sessions
              .map(
                (s) =>
                  `${this.store.setting(`selection:${cid}`) === s.id ? '* ' : ''}${s.shortId} · ${s.title} · ${s.workspace} · ${s.state}`,
              )
              .join('\n') || '当前私聊还没有已注册会话。',
          );
          return;
        }
        if (command?.name === 'switch') {
          const s = selected(command.args);
          this.policy.check(this.stamp(s));
          this.store.setSetting(`selection:${cid}`, s.id);
          control(`当前会话：${s.shortId} · ${s.title} · ${s.state}`);
          return;
        }
        if (command?.name === 'status') {
          const s = selected(command.args || undefined);
          control(JSON.stringify(await this.status(s), null, 2));
          return;
        }
        if (command?.name === 'stop') {
          const s = selected(command.args || undefined);
          this.policy.check(this.stamp(s));
          control(JSON.stringify(await this.stop(s.id)));
          return;
        }
        let question: WaitRequest | undefined;
        let text = event.text;
        let explicitQuestion = false;
        let s: Session | undefined;
        if (command?.name === 'reply') {
          const split = command.args.match(/^(\S+)\s+([\s\S]+)$/);
          ensure(split, 'INVALID_ARGUMENTS', '用法：/reply <问题短ID> <回答>');
          question = this.store.list('wait').find((w) => w.conversationId === cid && w.shortId === split[1]);
          text = split[2];
          explicitQuestion = true;
        } else if (command?.name === 'send') {
          const split = command.args.match(/^(\S+)\s+([\s\S]+)$/);
          ensure(split, 'INVALID_ARGUMENTS', '用法：/send <会话短ID> <任务>');
          s = selected(split[1]);
          text = split[2];
        } else if (command) {
          control(help);
          return;
        } else if (event.replyTo) {
          const o = this.store
            .list('outbox')
            .find((o) => o.conversationId === cid && o.platformMessageId === event.replyTo);
          question = this.store.list('wait').find((w) => w.outboxId === o?.id);
          explicitQuestion = true;
        } else {
          s = selected();
          question = this.store.list('wait').find((w) => w.sessionId === s!.id && w.state === 'open');
        }
        if (explicitQuestion)
          ensure(question, 'WAIT_NOT_FOUND', '引用的问题不存在，请使用 /reply 指定问题。', 404);
        if (question) {
          s = selected(question.sessionId);
          this.recheck();
          question = this.store.get('wait', question.id)!;
          this.policy.check(question.auth);
          ensure(
            question.state === 'open' && question.epoch === s.epoch,
            'WAIT_NOT_OPEN',
            '问题已结束。',
            409,
          );
          question.state = 'answered';
          question.reply = {
            message_id: iid,
            platform_message_id: event.messageId,
            principal_id: subject,
            text,
            received_at: new Date().toISOString(),
          };
          this.store.put('wait', question);
          this.store.put('inbox', { ...inbox, state: 'consumed', targetSessionId: s.id });
          s.state = 'running';
          this.store.put('session', s);
          control(`已回复 ${question.shortId} → ${s.shortId}`);
          return;
        }
        s ??= selected();
        const auth = this.stamp(s);
        this.policy.check(auth);
        ensure(
          !['stopping', 'stop_incomplete'].includes(s.state),
          'SESSION_STOPPING',
          '请先核对停止报告。',
          409,
        );
        await (await this.runtime(s.runtimeId)).inspect();
        // Re-read after I/O: selection is already fixed, cancellation epoch is current.
        s = this.store.get('session', s.id)!;
        this.policy.check(auth);
        ensure(!['stopping', 'stop_incomplete'].includes(s.state), 'SESSION_STOPPING', '正在停止。', 409);
        if (s.state === 'stopped' || s.state === 'offline') {
          s.state = 'ready';
          this.store.put('session', s);
        }
        const job: Job = {
          id: id('job'),
          sessionId: s.id,
          epoch: s.epoch,
          inboxId: iid,
          prompt: text,
          state: 'queued',
          auth,
          createdAt: now(),
        };
        this.store.put('job', job);
        this.store.put('inbox', { ...inbox, state: 'queued', targetSessionId: s.id });
        control(`已排队 → ${s.shortId} · ${job.id}`);
      } catch (e) {
        this.store.put('inbox', { ...inbox, state: 'rejected' });
        control(errorBody(e).error.message);
      } finally {
        const record = this.store.get('inbox', iid);
        if (record?.state === 'received') this.store.put('inbox', { ...record, state: 'consumed' });
      }
    });
  }
  async status(s: Session) {
    this.recheck();
    let native: RuntimeSnapshot | { status: 'offline' };
    try {
      native = await (await this.runtime(s.runtimeId)).inspect();
    } catch {
      native = { status: 'offline' };
    }
    // Native I/O may overlap stop or a new turn. Preserve the latest epoch and
    // its fence; refresh visible state from the observed runtime and open wait.
    s = this.store.get('session', s.id)!;
    if (!isFencedState(s.state)) {
      const waiting = this.store.list('wait').some((w) => w.sessionId === s.id && w.state === 'open');
      if (native.status === 'offline') s.state = 'offline';
      else if ('activeFlags' in native && native.activeFlags?.includes('waitingOnApproval'))
        s.state = 'waiting_approval';
      else if (waiting) s.state = 'waiting_user';
      else if (native.status === 'active') s.state = 'running';
      else if (native.status === 'idle' || native.status === 'owner_online')
        s.state = this.store
          .list('job')
          .some((j) => j.sessionId === s.id && ['queued', 'dispatching', 'queued_native'].includes(j.state))
          ? 'running'
          : 'ready';
      else if (native.status === 'systemError') s.state = 'error';
      if (native.status !== 'offline') s.lastSeenAt = now();
      this.store.put('session', s);
    }
    return {
      session_id: s.id,
      short_id: s.shortId,
      title: s.title,
      state: this.store.get('session', s.id)?.state,
      native,
      queued_jobs: this.store
        .list('job')
        .filter((j) => j.sessionId === s.id && ['queued', 'dispatching', 'queued_native'].includes(j.state))
        .length,
      waiting_questions: this.store
        .list('wait')
        .filter((w) => w.sessionId === s.id && w.state === 'open')
        .map((w) => w.shortId),
      stop_scope: 'tracked_resources',
      control_epoch: s.epoch,
      last_seen_at: new Date(s.lastSeenAt).toISOString(),
      last_stop: this.store
        .list('stop')
        .filter((r) => r.sessionId === s.id)
        .at(-1),
    };
  }
  async stop(sessionId: string) {
    const ongoing = this.stopping.get(sessionId);
    if (ongoing) return ongoing;
    // Fence immediately, before waiting for a dispatch already in flight.
    const s = this.store.get('session', sessionId)!;
    s.epoch++;
    s.state = 'stopping';
    this.store.put('session', s);
    this.recheck();
    const work = this.locks.run(`session:${sessionId}`, async () => {
      const stop = { id: id('stop'), sessionId, state: 'running' as const, createdAt: now() };
      this.store.put('stop', stop);
      const runtime = await this.runtime(s.runtimeId).catch(() => undefined);
      this.recheck();
      let report;
      try {
        ensure(runtime, 'RUNTIME_UNREACHABLE', '运行实例离线。');
        report = await runtime.stop();
      } catch {
        report = {
          complete: false,
          scope: 'tracked_resources',
          residuals: [{ resourceId: s.threadId, reason: '原生停止未确认' }],
        };
      }
      for (const o of this.store
        .list('outbox')
        .filter((o) => o.sessionId === s.id && ['sending', 'unknown'].includes(o.state))) {
        report.residuals.push({ resourceId: o.id, reason: '停止时平台投递结果仍待核对' });
        report.complete = false;
      }
      for (const j of this.store
        .list('job')
        .filter(
          (j) => j.sessionId === s.id && ['queued', 'dispatching', 'queued_native'].includes(j.state),
        )) {
        j.state = 'cancelled';
        this.store.put('job', j);
      }
      s.state = report.complete ? 'stopped' : 'stop_incomplete';
      this.store.put('session', s);
      this.store.put('stop', {
        ...stop,
        state: report.complete ? 'completed' : 'incomplete',
        report: { ...report },
      });
      this.store.audit('session.stopped', 'im-user', s.id, { report });
      return report;
    });
    this.stopping.set(sessionId, work);
    try {
      return await work;
    } finally {
      this.stopping.delete(sessionId);
    }
  }
  recheck() {
    const valid = (auth: AuthStamp, sid?: string, epoch?: number) => {
      try {
        this.policy.check(auth);
        if (sid) {
          const s = this.store.get('session', sid);
          return !!s && s.epoch === epoch && !['stopping', 'stopped', 'stop_incomplete'].includes(s.state);
        }
        return true;
      } catch {
        return false;
      }
    };
    for (const w of this.store.list('wait').filter((w) => w.state === 'open')) {
      if (!valid(w.auth, w.sessionId, w.epoch)) {
        w.state = 'cancelled';
        w.reason = '访问权限或任务世代已变化';
      } else if (w.expiresAt <= now()) w.state = 'expired';
      else {
        const o = this.store.get('outbox', w.outboxId);
        if (o && ['failed', 'unknown', 'cancelled'].includes(o.state)) {
          w.state = 'delivery_failed';
          w.reason = '问题投递未确认';
        }
      }
      if (w.state !== 'open') this.store.put('wait', w);
    }
    for (const w of this.store.list('wait').filter((w) => w.state !== 'open')) {
      const question = this.store.get('outbox', w.outboxId);
      if (question?.state === 'queued') {
        question.state = 'cancelled';
        question.error = '问题已结束';
        this.store.put('outbox', question);
      }
    }
    for (const o of this.store.list('outbox').filter((o) => o.state === 'queued' && o.auth))
      if (!valid(o.auth!, o.sessionId, o.epoch)) {
        o.state = 'cancelled';
        this.store.put('outbox', o);
      }
    for (const j of this.store.list('job').filter((j) => j.state === 'queued'))
      if (!valid(j.auth, j.sessionId, j.epoch)) {
        j.state = 'cancelled';
        this.store.put('job', j);
      }
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }
  private async pump() {
    this.recheck();
    // Revocation also cancels work already accepted into the native queue.
    const revoked = new Set<string>();
    for (const j of this.store.list('job').filter((j) => j.state === 'queued_native')) {
      try {
        this.policy.check(j.auth);
      } catch {
        revoked.add(j.sessionId);
      }
    }
    for (const sid of revoked) await this.stop(sid);
    for (const initial of this.store
      .list('outbox')
      .filter((o) => o.state === 'queued' && o.nextAttemptAt <= now())) {
      // A previous network delivery may have taken long enough for this
      // question or one of its grants to expire. Check at the side effect.
      this.recheck();
      const o = this.store.get('outbox', initial.id)!;
      if (o.state !== 'queued') continue;
      const channel = this.store.get('channel', o.channelId);
      const conn = this.channels.connections.get(o.channelId);
      const c = this.store.get('conversation', o.conversationId);
      if (!conn || channel?.state !== 'enabled' || c?.identityVersion !== channel.identityVersion) continue;
      try {
        if (o.auth) this.policy.check(o.auth);
      } catch {
        o.state = 'cancelled';
        this.store.put('outbox', o);
        continue;
      }
      o.state = 'sending';
      o.attempts++;
      this.store.put('outbox', o);
      try {
        const receipt = await conn.send(c, o);
        if (receipt.status === 'delivered') {
          o.state = 'delivered';
          o.platformMessageId = receipt.messageId;
        } else if (receipt.status === 'retryable' && o.attempts < 5) {
          o.state = 'queued';
          o.nextAttemptAt = now() + (receipt.retryAfterMs ?? 1000 * 2 ** o.attempts);
        } else {
          o.state = receipt.status === 'retryable' ? 'failed' : receipt.status;
          o.error = receipt.reason;
        }
      } catch {
        o.state = 'unknown';
        o.error = '发送发生后结果未确认';
      }
      this.store.put('outbox', o);
    }
    for (const initial of this.store.list('job').filter((j) => j.state === 'queued'))
      await this.locks.run(`session:${initial.sessionId}`, async () => {
        const j = this.store.get('job', initial.id)!;
        const s = this.store.get('session', j.sessionId)!;
        if (j.state !== 'queued' || j.epoch !== s.epoch) return;
        try {
          this.policy.check(j.auth);
          const runtime = await this.runtime(s.runtimeId);
          const snapshot = await runtime.inspect();
          ensure(
            sameWorkspace(snapshot.cwd, s.cwd),
            'THREAD_CONTEXT_UNVERIFIED',
            '派发前原生工作目录核对失败。',
            403,
          );
          this.policy.check(j.auth);
          ensure(this.store.get('session', s.id)?.epoch === j.epoch, 'STALE_CONTROL_EPOCH', '任务世代变化。');
          j.state = 'dispatching';
          this.store.put('job', j);
          const result = await runtime.submit(j);
          const fresh = this.store.get('job', j.id)!;
          fresh.nativeQueueId = result.queueId;
          if (fresh.state === 'dispatching') fresh.state = 'queued_native';
          this.store.put('job', fresh);
          try {
            this.policy.check(j.auth);
            ensure(
              this.store.get('session', s.id)?.epoch === j.epoch,
              'STALE_CONTROL_EPOCH',
              '任务世代变化。',
            );
          } catch {
            await runtime.cancelQueued(result.queueId).catch(() => {});
            fresh.state = 'cancelled';
            this.store.put('job', fresh);
            void this.stop(s.id).catch(() => {});
          }
        } catch (e) {
          const fresh = this.store.get('job', j.id)!;
          if (!['completed', 'cancelled'].includes(fresh.state)) {
            fresh.state = fresh.state === 'dispatching' ? 'unknown' : 'failed';
            fresh.error = errorBody(e).error.code;
            this.store.put('job', fresh);
          }
        }
      });
  }
  private event(link: RuntimeLink, e: RuntimeNotification) {
    if (this.closed || e.method !== 'connection/closed') return;
    const s = this.store.list('session').find((s) => s.runtimeId === link.id);
    if (s) {
      if (!isFencedState(s.state)) s.state = 'offline';
      this.store.put('session', s);
    }
    this.runtimes.delete(link.id);
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.pumping;
    await Promise.all([...this.stopping.values()]);
    await this.channels.close();
    await Promise.all([...this.runtimes.values()].map((r) => r.close()));
  }
}
