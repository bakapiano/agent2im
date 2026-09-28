import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DpapiProtector } from '../credentials/protector.js';
import { ensure, AppError } from '../core/errors.js';
import { sleep } from '../core/util.js';
import { ensureBrokerStarted } from '../broker-start.js';
import type { Descriptor } from '../mcp.js';

export function restrictDataDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const result = spawnSync(
      'icacls.exe',
      [path, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],
      { windowsHide: true, stdio: 'pipe' },
    );
    ensure(result.status === 0, 'ACL_FAILED', '数据目录权限设置失败。');
  }
}

export function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Serializes enrollment across concurrent MCP sidecars, including a cold installation. */
async function initializationLock<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const path = join(dataDir, 'initialization.lock');
  const deadline = Date.now() + 30_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid: number } | undefined;
      try {
        owner = JSON.parse(readFileSync(path, 'utf8'));
      } catch {}
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
            try {
              unlinkSync(path);
            } catch {}
            continue;
          }
        }
      }
      if (Date.now() >= deadline)
        throw new AppError('LOCAL_SETUP_BUSY', '本地初始化尚未结束，请重试并查看数据目录日志。');
      await sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}

/** Runs on first tool use. MCP initialization/listing remain side-effect free. */
export async function ensureLocalClient(dataDir: string, cliPath: string): Promise<Descriptor> {
  restrictDataDirectory(dataDir);
  return initializationLock(dataDir, async () => {
    const settingsPath = join(dataDir, 'settings.json');
    if (!existsSync(settingsPath))
      atomicWrite(settingsPath, JSON.stringify({ workspaces: {}, portalPort: 17643, agentPort: 17642 }));
    await ensureBrokerStarted(dataDir, cliPath);
    const protector = new DpapiProtector();
    const descriptorPath = join(dataDir, 'client-a.dpapi');
    if (!existsSync(descriptorPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const installation = JSON.parse(
        await protector.unprotect(readFileSync(join(dataDir, 'installation.dpapi'), 'utf8')),
      );
      const brokerUrl = `http://127.0.0.1:${settings.agentPort}`;
      const response = await fetch(`${brokerUrl}/local/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installation.secret}` },
        body: JSON.stringify({ name: 'Agent to IM plugin' }),
        signal: AbortSignal.timeout(5000),
      });
      const result = (await response.json()) as any;
      ensure(response.ok && result.ok, 'LOCAL_ENROLL_FAILED', '本地插件身份初始化失败，请查看 Broker 日志。');
      atomicWrite(
        descriptorPath,
        await protector.protect(
          JSON.stringify({ brokerUrl, clientId: result.data.client_id, secret: result.data.secret }),
        ),
      );
    }
    return JSON.parse(await protector.unprotect(readFileSync(descriptorPath, 'utf8')));
  });
}
