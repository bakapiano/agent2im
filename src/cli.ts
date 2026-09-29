import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from './db/store.js';
import { DpapiProtector } from './credentials/protector.js';
import { Vault } from './credentials/vault.js';
import { Broker } from './broker.js';
import { FeishuFactory } from './im/feishu/adapter.js';
import { CodexRuntimeFactory } from './code-cli/codex/runtime.js';
import { ImRegistry } from './im/registry.js';
import { CodeCliRegistry } from './code-cli/registry.js';
import { createServers } from './server.js';
import { runMcp, type Descriptor } from './mcp.js';
import { token } from './core/util.js';
import { ensure, errorBody } from './core/errors.js';
import { installLocal, rollbackLocal } from './code-cli/codex/install.js';
import { appVersion, buildId } from './core/build.js';
import { discoverNative } from './code-cli/codex/discovery.js';
import { ensureLocalClient, restrictDataDirectory } from './local/setup.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-dir': { type: 'string' },
    workspace: { type: 'string', multiple: true },
    'portal-port': { type: 'string' },
    'agent-port': { type: 'string' },
    descriptor: { type: 'string' },
    name: { type: 'string' },
    'codex-executable': { type: 'string' },
    'codex-home': { type: 'string' },
    backup: { type: 'string' },
  },
});
const command = positionals[0] ?? 'help';
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localData = join(projectDir, '.local');
const dataDir = resolve(
  values['data-dir'] ??
    process.env.AGENT_TO_IM_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? process.cwd(), 'agent-to-im'),
);
const protector = new DpapiProtector();
const settingsFile = join(dataDir, 'settings.json');

async function protectedWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, await protector.protect(JSON.stringify(value)), { mode: 0o600 });
}

async function protectedRead<T>(path: string): Promise<T> {
  return JSON.parse(await protector.unprotect(readFileSync(path, 'utf8')));
}

async function main() {
  if (command === 'version') {
    console.log(JSON.stringify({ version: appVersion, buildId }));
    return;
  }
  if (command === 'install-local') {
    console.log(
      JSON.stringify(
        installLocal({
          projectRoot: projectDir,
          dataDir: values['data-dir'] ?? localData,
          codexHome:
            values['codex-home'] ??
            process.env.CODEX_HOME ??
            join(process.env.USERPROFILE ?? process.cwd(), '.codex'),
          nativeExecutable: values['codex-executable'],
        }),
      ),
    );
    return;
  }
  if (command === 'rollback-local') {
    ensure(values.backup, 'BACKUP_REQUIRED', '请指定安装备份目录。');
    console.log(JSON.stringify(rollbackLocal(values.backup, values['data-dir'] ?? localData)));
    return;
  }
  if (command === 'help') {
    console.log(
      'agent-to-im serve | enroll | mcp | portal | install-local | rollback-local | doctor | version\n公共参数：--data-dir <dir>',
    );
    return;
  }
  if (command === 'mcp') {
    const cliPath = resolve(fileURLToPath(import.meta.url));
    if (values.descriptor) {
      const path = resolve(values.descriptor);
      await runMcp(() => protectedRead<Descriptor>(path), discoverNative, {
        descriptorPath: path,
        cliPath,
      });
    } else {
      await runMcp(() => ensureLocalClient(dataDir, cliPath), discoverNative);
    }
    return;
  }
  if (command === 'serve') {
    restrictDataDirectory(dataDir);
    const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
    const workspaces: Record<string, string> = { ...saved.workspaces };
    for (const item of values.workspace ?? []) {
      const index = item.indexOf('=');
      ensure(index > 0, 'WORKSPACE_INVALID', '使用 --workspace alias=absolute-path');
      const alias = item.slice(0, index);
      ensure(/^[\w-]+$/.test(alias), 'WORKSPACE_INVALID', '工作区别名格式无效。');
      workspaces[alias] = resolve(item.slice(index + 1));
    }
    const settings = {
      workspaces,
      portalPort: Number(values['portal-port'] ?? saved.portalPort ?? 17643),
      agentPort: Number(values['agent-port'] ?? saved.agentPort ?? 17642),
    };
    for (const p of [settings.portalPort, settings.agentPort]) {
      ensure(
        Number.isInteger(p) && p >= 1024 && p <= 65535,
        'PORT_INVALID',
        '端口范围为 1024–65535。',
      );
    }
    ensure(settings.portalPort !== settings.agentPort, 'PORT_INVALID', '两个受众使用独立端口。');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    const installFile = join(dataDir, 'installation.dpapi');
    if (!existsSync(installFile)) {
      await protectedWrite(installFile, { secret: token() });
    }
    const installation = await protectedRead<{ secret: string }>(installFile);
    const bootstrap = token();
    const store = new Store(join(dataDir, 'broker.sqlite'));
    const vault = new Vault(store, protector);
    if (!store.setting('adminPassword')) {
      await protectedWrite(join(dataDir, 'portal-bootstrap.dpapi'), { token: bootstrap });
    }
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const broker = new Broker(
      store,
      vault,
      { ...settings, dataDir, portalHost: '127.0.0.1', webRoot: join(projectRoot, 'dist', 'web') },
      new ImRegistry({ feishu: new FeishuFactory() }),
      new CodeCliRegistry({ codex: new CodexRuntimeFactory() }),
    );
    const servers = await createServers(broker, installation.secret, bootstrap);
    await servers.listen();
    await broker.start();
    console.log(
      `Portal: http://127.0.0.1:${settings.portalPort}\nAgent RPC: http://127.0.0.1:${settings.agentPort}`,
    );
    if (!store.setting('adminPassword')) {
      console.log(`首次设置令牌（仅本次进程有效）：${bootstrap}`);
    }
    let closing = false;
    const close = async () => {
      if (closing) {
        return;
      }
      closing = true;
      await broker.close();
      await servers.close();
      store.close();
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    return;
  }
  if (command === 'portal') {
    await ensureLocalClient(dataDir, resolve(fileURLToPath(import.meta.url)));
  }
  ensure(
    existsSync(settingsFile),
    'SETUP_REQUIRED',
    '请先调用插件工具或运行 serve 初始化本地服务。',
  );
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const brokerUrl = `http://127.0.0.1:${settings.agentPort}`;
  if (command === 'portal') {
    const response = await fetch(`http://127.0.0.1:${settings.portalPort}/api/auth`, {
      signal: AbortSignal.timeout(3000),
    });
    const auth = (await response.json()) as any;
    let url = `http://127.0.0.1:${settings.portalPort}/`;
    if (!auth.data?.configured) {
      const bootstrap = await protectedRead<{ token: string }>(
        join(dataDir, 'portal-bootstrap.dpapi'),
      );
      url += `#setup=${encodeURIComponent(bootstrap.token)}`;
    }
    const opened = spawnSync('explorer.exe', [url], { windowsHide: true, stdio: 'pipe' });
    ensure(!opened.error, 'PORTAL_OPEN_FAILED', '本地浏览器打开失败。');
    console.log(`Portal: http://127.0.0.1:${settings.portalPort}`);
    return;
  }
  if (command === 'doctor') {
    const response = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(3000) });
    console.log(
      JSON.stringify({
        node: process.version,
        buildId,
        dataDir,
        broker: await response.json(),
        portal: `http://127.0.0.1:${settings.portalPort}`,
      }),
    );
    return;
  }
  const installation = await protectedRead<{ secret: string }>(join(dataDir, 'installation.dpapi'));
  const post = async (path: string, data: unknown) => {
    const r = await fetch(`${brokerUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${installation.secret}`,
      },
      body: JSON.stringify(data),
    });
    const b = (await r.json()) as any;
    ensure(b.ok, b.error?.code ?? 'RPC_FAILED', b.error?.message ?? '操作失败');
    return b.data;
  };
  ensure(values.descriptor, 'DESCRIPTOR_REQUIRED', '请指定 --descriptor 保护文件路径。');
  const descriptorPath = resolve(values.descriptor);
  if (command === 'enroll') {
    ensure(!existsSync(descriptorPath), 'DESCRIPTOR_EXISTS', '描述文件已存在，请选择新文件名。');
    const result = await post('/local/enroll', { name: values.name ?? 'Codex CLI' });
    await protectedWrite(descriptorPath, {
      brokerUrl,
      clientId: result.client_id,
      secret: result.secret,
    });
    console.log(`客户端已登记；保护文件：${descriptorPath}`);
    return;
  }
  throw new Error('未知命令，请运行 help。');
}

main().catch((error) => {
  console.error(JSON.stringify(errorBody(error)));
  process.exitCode = 1;
});
