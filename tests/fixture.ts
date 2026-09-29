import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Broker, type Caller } from '../src/broker.js';
import { Store } from '../src/db/store.js';
import { EphemeralTestProtector } from '../src/credentials/protector.js';
import { Vault } from '../src/credentials/vault.js';
import type { ImConnection, ImEvent, ImFactory, ImReceipt } from '../src/im/port.js';
import type { LiveRuntime, RuntimeFactory, RuntimeNotification } from '../src/code-cli/port.js';
import type { Conversation, Job, Outbox, RuntimeLink, Session } from '../src/core/model.js';
import { now } from '../src/core/util.js';
import { ImRegistry } from '../src/im/registry.js';
import { CodeCliRegistry } from '../src/code-cli/registry.js';
import { validateCodexContext } from '../src/code-cli/codex/discovery.js';

export class FakeIm implements ImFactory {
  sent: Outbox[] = [];

  receipts: ImReceipt[] = [];

  handler?: (e: ImEvent) => Promise<void>;

  validationGate?: Promise<void>;

  sendGate?: Promise<void>;

  async validate() {
    await this.validationGate;
    return { fingerprint: 'bot-identity', botId: 'bot-1' };
  }

  create(): ImConnection {
    return {
      start: async (fn) => {
        this.handler = fn;
      },
      send: async (c: Conversation, o: Outbox) => {
        this.sent.push(o);
        await this.sendGate;
        return this.receipts.shift() ?? { status: 'delivered', messageId: `platform-${o.id}` };
      },
      close: async () => {},
      health: () => ({ state: 'connected' }),
    };
  }
}
export class FakeRuntime implements LiveRuntime {
  events: Array<(e: RuntimeNotification) => void> = [];

  jobs: Job[] = [];

  cancelled: string[] = [];

  stops = 0;

  turnId = 'turn-fixture';

  verified = true;

  active = false;

  submitGate?: Promise<void>;

  inspectGate?: Promise<void>;

  inspectEntered = false;

  constructor(readonly link: RuntimeLink) {}

  async connect() {
    return this.inspect();
  }

  async inspect() {
    this.inspectEntered = true;
    const gate = this.inspectGate;
    this.inspectGate = undefined;
    await gate;
    if (!this.verified) {
      throw new Error('unverified');
    }
    return {
      threadId: this.link.threadId,
      cwd: this.link.cwd || resolve('.'),
      status: this.active ? 'active' : 'idle',
      activeTurns: this.active ? [this.turnId] : [],
    };
  }

  async submit(j: Job) {
    this.jobs.push(j);
    await this.submitGate;
    return { queueId: `queue-${j.id}` };
  }

  async cancelQueued(id: string) {
    this.cancelled.push(id);
  }

  async stop() {
    this.stops++;
    this.active = false;
    return {
      complete: true,
      scope: 'tracked_resources' as const,
      interruptedTurns: 1,
      cancelledNativeQueue: this.jobs.length,
      terminatedTerminals: 0,
      residuals: [],
    };
  }

  onEvent(fn: (e: RuntimeNotification) => void) {
    this.events.push(fn);
  }

  emit(method: string, params: Record<string, any>) {
    for (const fn of this.events) {
      fn({ method, params: { threadId: this.link.threadId, ...params } });
    }
  }

  async close() {}
}
export class FakeAgents implements RuntimeFactory {
  validateContext = validateCodexContext;

  all: FakeRuntime[] = [];

  create(link: RuntimeLink) {
    const r = new FakeRuntime(link);
    this.all.push(r);
    return r;
  }
}
export async function fixture(
  filename = ':memory:',
  ports = { portalPort: 18643, agentPort: 18642 },
  runtimeFactory?: RuntimeFactory,
) {
  const store = new Store(filename);
  const im = new FakeIm();
  const agents = new FakeAgents();
  const protector = new EphemeralTestProtector();
  const vault = new Vault(store, protector);
  const broker = new Broker(
    store,
    vault,
    {
      dataDir: '.test-data',
      portalHost: '127.0.0.1',
      ...ports,
      workspaces: { project: resolve('.') },
      webRoot: resolve('dist/web'),
    },
    new ImRegistry({ feishu: im }),
    new CodeCliRegistry({ codex: runtimeFactory ?? agents }),
  );
  const secret = await vault.save('fixture-secret', 'feishu');
  const created = (await broker.channels.execute({
    operation: 'upsert',
    provider: 'feishu',
    channel_alias: 'test-channel',
    display_name: '隔离测试飞书',
    app_id: 'cli_fixture',
    credential_ref: secret,
    expected_revision: 0,
    idempotency_key: 'create',
  })) as any;
  const cid = created.channel.channel_id;
  await broker.channels.execute({
    operation: 'validate',
    channel_id: cid,
    expected_revision: 1,
    idempotency_key: 'validate',
  });
  await broker.channels.execute({
    operation: 'set_enabled',
    channel_id: cid,
    enabled: true,
    expected_revision: 2,
    idempotency_key: 'enable',
  });
  const channel = store.get('channel', cid)!;
  const inbound = (text: string, extra: Partial<ImEvent> = {}) =>
    broker.receive(store.get('channel', cid)!, {
      eventId: randomUUID(),
      messageId: randomUUID(),
      tenantId: 'tenant-fixture',
      userId: 'user-fixture',
      chatId: 'chat-fixture',
      chatType: 'p2p',
      receivedAt: now(),
      text,
      ...extra,
    });

  async function approveAll() {
    for (const r of store.list('request').filter((r) => r.state === 'pending')) {
      broker.policy.approve(r.id, r.revision);
    }
  }

  async function connect(title = '测试会话', activate = true) {
    await inbound('/sessions');
    await approveAll();
    const conversation = store.list('conversation')[0];
    const enrollment = broker.enroll(title, 'fixture-user');
    const nativeContext = {
      provider: 'codex' as const,
      threadId: randomUUID(),
      homeId: resolve('.test-data/fake-home'),
      owner: { pid: 123, createdAt: '2026-09-28T00:00:00Z', executable: 'C:/Codex/codex.exe' },
    };
    const caller: Caller = {
      clientId: enrollment.client_id,
      secret: enrollment.secret,
      nativeContext,
      attemptId: randomUUID(),
    };
    const args = {
      connection_alias: conversation.alias!,
      title,
      idempotency_key: randomUUID(),
      activate,
    };
    const result = (await broker.tool('register', args, {
      ...caller,
      attemptId: randomUUID(),
    })) as any;
    return {
      caller,
      result,
      session: store.get('session', result.session_id)! as Session,
      runtime: agents.all.at(-1)!,
      registerArgs: args,
    };
  }

  return {
    store,
    broker,
    im,
    agents,
    vault,
    protector,
    channel,
    inbound,
    approveAll,
    connect,
    async close() {
      await broker.close();
      store.close();
    },
  };
}
