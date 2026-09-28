import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { packageForTest } from '../../plugin-fixture.js';
import { sleep } from '../../../src/core/util.js';

async function freePort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return port;
}

it('relocated plugin initializes once on tool use and keeps data outside its cache', async () => {
  const { root, plugin } = await packageForTest();
  for (const file of readdirSync(plugin, { recursive: true, withFileTypes: true })) {
    expect(lstatSync(join(file.parentPath, file.name)).isSymbolicLink()).toBe(false);
  }
  const data = join(root, 'data');
  mkdirSync(data);
  const portalPort = await freePort(),
    agentPort = await freePort();
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ workspaces: {}, portalPort, agentPort }));
  const clients = [
    new Client({ name: 'plugin-test-a', version: '1' }),
    new Client({ name: 'plugin-test-b', version: '1' }),
  ];
  const manifest = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')).mcpServers['agent-to-im'];
  let brokerPid: number | undefined;
  try {
    await Promise.all(
      clients.map((client) =>
        client.connect(
          new StdioClientTransport({
            command: manifest.command,
            args: manifest.args,
            cwd: plugin,
            env: { ...process.env, AGENT_TO_IM_DATA_DIR: data } as Record<string, string>,
            stderr: 'pipe',
          }),
        ),
      ),
    );
    expect((await clients[0].listTools()).tools).toHaveLength(4);
    expect(existsSync(join(data, 'broker.sqlite'))).toBe(false);
    expect(existsSync(join(data, 'client-a.dpapi'))).toBe(false);
    const replies = await Promise.all(
      clients.map((client) =>
        client.callTool({
          name: 'configure_im_channel',
          arguments: { operation: 'inspect', provider: 'feishu' },
        }),
      ),
    );
    for (const reply of replies)
      expect(JSON.parse((reply.content as any)[0].text)).toMatchObject({
        ok: true,
        data: { provider: 'feishu', status: 'ready' },
      });
    const health = (await (await fetch(`http://127.0.0.1:${agentPort}/health`)).json()) as any;
    brokerPid = health.pid;
    expect(health.buildId).toBe(JSON.parse(readFileSync(join(plugin, 'build.json'), 'utf8')).buildId);
    const db = new Database(join(data, 'broker.sqlite'), { readonly: true });
    try {
      expect((db.prepare("select count(*) as n from records where kind='client'").get() as any).n).toBe(1);
      expect(db.pragma('user_version', { simple: true })).toBe(5);
    } finally {
      db.close();
    }
    expect(await (await fetch(`http://127.0.0.1:${portalPort}/`)).text()).toContain('本地控制台');
    expect(existsSync(join(data, 'portal-bootstrap.dpapi'))).toBe(true);
    expect(existsSync(join(plugin, 'runtime/.local'))).toBe(false);
    expect(
      (
        await clients[0].callTool({
          name: 'configure_im_channel',
          arguments: { operation: 'inspect', provider: 'qq' },
        })
      ).isError,
    ).toBe(false);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    if (!brokerPid)
      try {
        brokerPid = ((await (await fetch(`http://127.0.0.1:${agentPort}/health`)).json()) as any).pid;
      } catch {}
    if (brokerPid) {
      process.kill(brokerPid);
      await sleep(200);
    }
  }
}, 120_000);
