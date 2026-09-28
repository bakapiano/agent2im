import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from './fixture.js';
import { Store } from '../src/db/store.js';

it('IM denial, identity separation and expiry govern interaction', async () => {
  const f = await fixture();
  try {
    await f.inbound('first private task');
    const denied = f.store.list('request')[0];
    f.broker.policy.deny(denied.id, denied.revision);
    await f.inbound('still private');
    expect(f.store.list('inbox')).toHaveLength(0);
    expect(f.store.list('grant')).toHaveLength(0);
    await f.inbound('/sessions', { userId: 'second-user', chatId: 'second-chat', displayName: 'same-name' });
    const second = f.store.list('request').find((r) => r.id !== denied.id)!;
    const grant = f.broker.policy.approve(second.id, second.revision);
    expect(grant.subject).not.toBe(denied.subject);
    expect(f.broker.policy.find(denied.subject, f.channel, denied.conversationId)).toBeUndefined();
    f.store.put('grant', { ...grant, expiresAt: Date.now() - 1 });
    await f.inbound('expired user task', { userId: 'second-user', chatId: 'second-chat' });
    expect(f.store.list('inbox')).toHaveLength(0);
    expect(f.store.list('job')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('local channel configuration and registration share only the IM user decision', async () => {
  const f = await fixture();
  try {
    const c = f.broker.enroll('new local client', 'test'),
      caller = { clientId: c.client_id, secret: c.secret, attemptId: 'configuration' };
    const inspected = (await f.broker.tool(
      'configure_im_channel',
      { operation: 'inspect', provider: 'feishu' },
      caller,
    )) as any;
    expect(inspected.channels).toHaveLength(1);
    expect(f.store.list('request')).toEqual([]);
    const credential = await f.vault.save('test-new-secret', 'feishu');
    await f.broker.tool(
      'configure_im_channel',
      {
        operation: 'upsert',
        provider: 'feishu',
        channel_alias: 'new-channel',
        display_name: 'local setup',
        app_id: 'cli_newtest',
        credential_ref: credential,
        expected_revision: 0,
        idempotency_key: 'new-config',
      },
      caller,
    );
    expect(f.store.list('request')).toEqual([]);
    expect(f.store.list('grant')).toEqual([]);
    const first = await f.connect('one'),
      second = await f.connect('two');
    expect(first.session.clientId).not.toBe(second.session.clientId);
    expect(f.store.list('request')).toHaveLength(1);
    expect(f.store.list('grant')).toHaveLength(1);
    expect(f.store.list('request')[0].subject).toMatch(/^im:/);
    expect(Object.keys(f.store.list('grant')[0]).sort()).toEqual(
      [
        'approvedAt',
        'channelId',
        'conversationId',
        'id',
        'identityVersion',
        'requestId',
        'revision',
        'state',
        'subject',
      ].sort(),
    );
  } finally {
    await f.close();
  }
});
