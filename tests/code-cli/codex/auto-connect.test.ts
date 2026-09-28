import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fixture } from '../../fixture.js';
import { nativeThreadId } from '../../../src/code-cli/codex/discovery.js';
import { workspaceLabel, nativePath } from '../../../src/core/workspace.js';

it('thread identity comes from this MCP call metadata', () => {
  const actual = randomUUID();
  expect(nativeThreadId({ threadId: actual })).toBe(actual);
  expect(() => nativeThreadId(undefined)).toThrow();
  expect(() => nativeThreadId({ threadId: 'bad' })).toThrow();
});
it('one approved IM route is chosen automatically; no native IDs in model arguments', async () => {
  const f = await fixture();
  try {
    await f.inbound('/sessions');
    await f.approveAll();
    const c = f.broker.enroll('auto-test', 'fixture');
    const threadId = randomUUID();
    const caller = {
      clientId: c.client_id,
      secret: c.secret,
      attemptId: randomUUID(),
      nativeContext: {
        provider: 'codex' as const,
        threadId,
        homeId: resolve('.test-data/home'),
        owner: { pid: 123, createdAt: '2026-09-28T00:00:00Z', executable: 'C:/Codex/codex.exe' },
      },
    };
    // The test runtime derives cwd from the link, so provide a platform snapshot.
    const original = f.agents.create.bind(f.agents);
    f.agents.create = (link) => {
      const runtime = original(link);
      runtime.inspect = async () => ({
        threadId: link.threadId,
        cwd: resolve('.'),
        status: 'idle',
        activeTurns: [],
      });
      return runtime;
    };
    const args = { title: 'auto', idempotency_key: 'auto1', activate: true };
    const first = (await f.broker.tool('register', args, caller)) as any;
    expect(first.native_thread_id).toBe(threadId);
    expect(f.store.list('runtime')).toHaveLength(1);
    expect(f.store.list('request')).toHaveLength(1);
    const result = (await f.broker.tool('register', args, { ...caller, attemptId: randomUUID() })) as any;
    expect(result.native_thread_id).toBe(threadId);
    expect(result.active).toBe(true);
    expect(f.store.list('session')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it('failed native identity check persists no trusted runtime or access request', async () => {
  const f = await fixture();
  try {
    const c = f.broker.enroll('auto-test', 'fixture');
    const original = f.agents.create.bind(f.agents);
    f.agents.create = (link) => {
      const r = original(link);
      r.verified = false;
      return r;
    };
    await expect(
      f.broker.tool(
        'register',
        { title: 'auto', idempotency_key: 'auto1' },
        {
          clientId: c.client_id,
          secret: c.secret,
          attemptId: randomUUID(),
          nativeContext: {
            provider: 'codex' as const,
            threadId: randomUUID(),
            homeId: resolve('.test-data/home'),
            owner: { pid: 123, createdAt: '2026-09-28T00:00:00Z', executable: 'C:/Codex/codex.exe' },
          },
        },
      ),
    ).rejects.toThrow();
    expect(f.store.list('runtime')).toHaveLength(0);
    expect(f.store.list('request')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('approved identities connect multiple sessions from arbitrary directories without another approval', async () => {
  const f = await fixture();
  try {
    f.broker.config.workspaces = {};
    await f.inbound('/sessions');
    await f.approveAll();
    const client = f.broker.enroll('all sessions', 'fixture');
    let cwd = resolve('..');
    const original = f.agents.create.bind(f.agents);
    f.agents.create = (link) => {
      const r = original(link),
        at = cwd;
      r.inspect = async () => ({ threadId: link.threadId, cwd: at, status: 'idle', activeTurns: [] });
      return r;
    };
    const caller = () => ({
      clientId: client.client_id,
      secret: client.secret,
      attemptId: randomUUID(),
      nativeContext: {
        provider: 'codex' as const,
        threadId: randomUUID(),
        homeId: resolve('.test-data/home'),
        owner: { pid: 123, createdAt: '2026-09-28T00:00:00Z', executable: 'C:/Codex/codex.exe' },
      },
    });
    const first = caller(),
      args = { title: 'any directory', idempotency_key: 'first', activate: true };
    await f.broker.tool('register', args, { ...first, attemptId: randomUUID() });
    const requests = f.store.list('request').length;
    cwd = resolve('C:/Users/Administrator');
    const second = (await f.broker.tool('register', { ...args, idempotency_key: 'second' }, caller())) as any;
    expect(second.active).toBe(true);
    expect(f.store.list('session')).toHaveLength(2);
    expect(f.store.list('request')).toHaveLength(requests);
    expect(f.store.list('runtime').at(-1)?.cwd).toBe(cwd);
    expect(workspaceLabel(cwd, {})).toBe(workspaceLabel('\\\\?\\' + cwd, {}));
    expect(nativePath('\\\\?\\' + cwd)).toBe(cwd);
    const grant = f.store.list('grant').find((g) => g.subject.startsWith('im:'))!;
    f.broker.policy.revoke(grant.id, grant.revision);
    await expect(
      f.broker.tool('register', { ...args, idempotency_key: 'third' }, caller()),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_APPROVED' });
  } finally {
    await f.close();
  }
});
