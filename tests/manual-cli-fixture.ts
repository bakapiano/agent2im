/** Isolated native TUI + browser acceptance rig. Never imported by production. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture } from './fixture.js';
import { CodexRuntimeFactory } from '../src/code-cli/codex/runtime.js';
import { DpapiProtector } from '../src/credentials/protector.js';
import { createServers } from '../src/server.js';
import { sleep } from '../src/core/util.js';
import { findCodexExecutable } from '../src/code-cli/codex/discovery.js';

const args = process.argv.slice(2);
if (args[0] === 'cli') {
  const setup = JSON.parse(readFileSync(args[1], 'utf8'));
  const child = spawn(
    findCodexExecutable(),
    ['--no-alt-screen', '请使用 $connect-to-im 连接本测试会话。'],
    {
      windowsHide: true,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: setup.dir,
        USERPROFILE: setup.dir,
        CODEX_HOME: setup.home,
        TERM: 'xterm-256color',
      },
    },
  );
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/native-tui-'));
  const home = join(dir, 'codex-home');
  mkdirSync(home);
  cpSync(
    resolve('plugins/codex/agent-to-im/skills/connect-to-im'),
    join(home, 'skills/connect-to-im'),
    {
      recursive: true,
    },
  );
  const f = await fixture(
    ':memory:',
    { portalPort: 21643, agentPort: 21642 },
    new CodexRuntimeFactory(),
  );
  f.broker.config.dataDir = dir;
  await f.broker.start();
  await f.inbound('/sessions');
  await f.approveAll();
  const c = f.broker.enroll('isolated-native-tui', 'test-only');
  const descriptor = join(dir, 'client.dpapi');
  writeFileSync(
    descriptor,
    await new DpapiProtector().protect(
      JSON.stringify({
        brokerUrl: 'http://127.0.0.1:21642',
        clientId: c.client_id,
        secret: c.secret,
      }),
    ),
  );
  // Test-only policy with shell tools disabled; avoids OS sandbox setup UIs.
  writeFileSync(
    join(home, 'config.toml'),
    `model="fixture-model"\nmodel_provider="fixture"\nweb_search="disabled"\nsandbox_mode="danger-full-access"\n[features]\nshell_tool=false\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:21644/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.agent-to-im]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([resolve('dist/cli.js'), 'mcp', '--descriptor', descriptor])}\nenv_vars=["CODEX_HOME"]\nrequired=true\nstartup_timeout_sec=20\ndefault_tools_approval_mode="approve"\n`,
  );
  // Model an existing, initialized user's home for the direct registration test.
  // These fixtures are confined to the newly created test directory; production
  // setup/approvals and Windows sandbox setup remain under the user's control.
  if (args.includes('--prepared-home')) {
    writeFileSync(
      join(home, 'config.toml'),
      readFileSync(join(home, 'config.toml'), 'utf8') +
        `\n[projects.${JSON.stringify(resolve('.'))}]\ntrust_level="trusted"\n`,
    );
    writeFileSync(join(home, '.sandbox_migration'), 'v1\n');
  }
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ portalPort: 21643, agentPort: 21642, workspaces: { project: resolve('.') } }),
  );
  const servers = await createServers(f.broker, 'test-only-installation', 'test-only-bootstrap');
  const status = () => ({
    testOnly: true,
    requests: f.store.list('request').map((r) => ({ id: r.id, state: r.state })),
    sessions: f.store
      .list('session')
      .map((s) => ({ id: s.id, state: s.state, threadId: s.threadId })),
    waits: f.store.list('wait').map((w) => ({ state: w.state, reply: w.reply?.text })),
    jobs: f.store.list('job').map((j) => ({ state: j.state })),
    messages: f.im.sent.map((o) => ({ purpose: o.purpose, text: o.text })),
    nativeRequests,
    toolNames,
    stop: f.store.list('stop').at(-1)?.report,
    completed: verified,
    controlError,
  });
  let verified = false;
  let controlError: string | undefined;
  let nativeRequests = 0;
  let toolNames: any[] = [];
  let stage = 'register';
  const registerArgs = {
    title: 'Native TUI E2E',
    idempotency_key: 'native-tui-auto',
    activate: true,
  };
  // Isolated test approvals are deterministic fixtures, separate from live grants.
  const approvalTimer = setInterval(() => {
    void f.approveAll();
  }, 100);
  servers.portal.get('/fixture/state', async () => status());
  servers.portal.get('/fixture', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html lang="zh"><meta charset="utf-8"><title>隔离 Native CLI E2E</title><style>body{font:16px system-ui;margin:40px;background:#f5f7fb}pre{white-space:pre-wrap;background:white;padding:24px}</style><h1>隔离 Native CLI E2E</h1><p>真实 Codex TUI + MCP + Broker；模型和 IM 为本机测试夹具。真实凭据保持独立。</p><pre id="state">Loading</pre><script src="/fixture/view.js"></script></html>',
      ),
  );
  servers.portal.get('/fixture/view.js', async (_, reply) =>
    reply
      .type('application/javascript')
      .send(
        'async function update(){const r=await fetch("/fixture/state");document.getElementById("state").textContent=JSON.stringify(await r.json(),null,2)}update();setInterval(update,1000);',
      ),
  );
  await servers.listen();
  const mock = createServer(async (req, res) => {
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
      }
    } catch {
      return;
    }
    let input: any;
    try {
      input = JSON.parse(raw);
    } catch {
      res.writeHead(404).end();
      return;
    }
    nativeRequests++;
    toolNames = (input.tools ?? []).map((t: any) => ({
      name: t.name,
      type: t.type,
      tools: t.tools?.map((t: any) => t.name),
    }));
    console.log(JSON.stringify({ nativeRequests, toolNames }));
    const namespace = input.tools?.find(
      (t: any) => t.type === 'namespace' && t.name?.includes('agent_to_im'),
    );
    const session = f.store.list('session')[0];
    let call: { name: string; args: unknown } | undefined;
    if (!session) {
      call = { name: 'register', args: registerArgs };
    } else if (!f.store.list('outbox').some((o) => o.text.includes('native TUI 主动消息'))) {
      call = {
        name: 'send_message_to_user',
        args: {
          session_id: session.id,
          text: 'native TUI 主动消息',
          idempotency_key: 'native-tui-send',
        },
      };
    } else if (!f.store.list('wait').length) {
      call = {
        name: 'wait_for_user_message',
        args: {
          session_id: session.id,
          mode: 'ask',
          request_key: 'native-tui-question',
          prompt: '继续这个测试吗？',
          timeout_seconds: 10,
        },
      };
    } else {
      stage = 'done';
      const job = f.store.list('job').find((j) => j.state === 'queued_native');
      if (job) {
        call = {
          name: 'send_message_to_user',
          args: {
            session_id: session.id,
            job_id: job.id,
            purpose: 'result',
            text: 'IM result from original CLI',
            idempotency_key: 'result-' + job.id,
          },
        };
      }
    }
    const fn = call
      ? (namespace?.tools?.find((t: any) => t.name === call.name) ??
        input.tools?.find((t: any) => t.name?.includes(call.name)))
      : undefined;
    const item =
      call && fn
        ? {
            type: 'function_call',
            id: `fc_${nativeRequests}`,
            call_id: `call_${nativeRequests}`,
            name: fn.name,
            ...(namespace ? { namespace: namespace.name } : {}),
            arguments: JSON.stringify(call.args),
            status: 'completed',
          }
        : {
            id: `msg_${nativeRequests}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'Native CLI 自动接入与问答验收完成。', annotations: [] },
            ],
          };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const e of [
      {
        type: 'response.created',
        response: { id: `resp_${nativeRequests}`, status: 'in_progress', output: [] },
      },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: `resp_${nativeRequests}`,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]) {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
    res.end();
  });
  await new Promise<void>((r) => mock.listen(21644, '127.0.0.1', r));
  let injected = false;
  const replyTimer = setInterval(() => {
    const w = f.store.list('wait').find((w) => w.state === 'open');
    if (w && !injected && f.store.get('outbox', w.outboxId)?.state === 'delivered') {
      injected = true;
      void f.inbound(`/reply ${w.shortId} 继续，真实 TUI 回复测试`);
    }
  }, 100);
  let controlsStarted = false;
  const controlsTimer = setInterval(() => {
    const s = f.store.list('session')[0];
    if (stage !== 'done' || !s || controlsStarted) {
      return;
    }
    controlsStarted = true;
    void (async () => {
      await f.inbound('/sessions');
      await f.inbound('/status');
      await f.inbound(`/send ${s.shortId} 从隔离 IM 提交的真实原生任务`);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !f.store.list('job').some((j) => j.state === 'completed')) {
        await sleep(50);
      }
      if (!f.store.list('job').some((j) => j.state === 'completed')) {
        throw new Error('IM-origin task did not complete');
      }
      await f.broker.tick();
      await f.inbound('/stop');
      await f.broker.tick();
      if (f.store.get('session', s.id)?.state !== 'stop_incomplete') {
        throw new Error('Relay must report native stop boundary');
      }
      verified = true;
      writeFileSync(join(dir, 'result.json'), JSON.stringify(status(), null, 2));
    })().catch((e) => {
      controlError = e.message;
    });
  }, 100);
  const setup = join(dir, 'setup.json');
  writeFileSync(setup, JSON.stringify({ dir, home, descriptor }));
  console.log(JSON.stringify({ setup, portal: 'http://127.0.0.1:21643/fixture' }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(approvalTimer);
      clearInterval(replyTimer);
      clearInterval(controlsTimer);
      void f.broker
        .close()
        .then(() => servers.close())
        .then(() => {
          f.store.close();
          mock.closeAllConnections();
          mock.close();
        });
    });
  }
}
