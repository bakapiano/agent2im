import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installLocal, rollbackLocal, renderMcpConfig } from '../../../src/code-cli/codex/install.js';
import type { LocalInstallation } from '../../../src/code-cli/codex/install.js';
import { execFileSync } from 'node:child_process';

const installation: LocalInstallation = {
  buildId: 'fixture',
  cliPath: 'D:/release/dist/cli.js',
  nodePath: 'D:/node.exe',
  descriptor: 'D:/private/client.dpapi',
  dataDir: 'D:/private',
  nativeExecutable: 'D:/codex.exe',
  projectRoot: 'D:/project',
};
it('updates only owned MCP fields, preserving native approval and other servers', () => {
  const original =
    'model = "test"\r\n[mcp_servers.agent-to-im]\r\ncommand = "old"\r\nargs = ["old"]\r\ndefault_tools_approval_mode = "prompt"\r\nrequired = false\r\n[mcp_servers.other]\r\ncommand = "untouched"\r\n';
  const result = renderMcpConfig(original, installation);
  expect(result).toContain('default_tools_approval_mode = "prompt"');
  expect(result).toContain('[mcp_servers.other]\r\ncommand = "untouched"\r\n');
  expect(result).toMatch(/^model = "test"\r\n/);
  expect(renderMcpConfig(result, installation)).toBe(result);
  const parsed = execFileSync(
    'python',
    ['-X', 'utf8', '-c', 'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
    { input: result, encoding: 'utf8' },
  );
  expect(JSON.parse(parsed).mcp_servers['agent-to-im'].command).toBe(installation.nodePath);
});
it('installation pins a release, is idempotent, and rollback retains user settings', () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/install-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const data = join(dir, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'client-a.dpapi'), 'test-only');
  const profile = join(dir, 'profile.ps1');
  const original = '# user profile\n';
  writeFileSync(profile, original);
  const config = 'model = "test"\n';
  writeFileSync(join(home, 'config.toml'), config);
  const options = {
    projectRoot: resolve('.'),
    dataDir: data,
    codexHome: home,
    nativeExecutable: process.execPath,
  };
  const result = installLocal(options);
  expect(result.changed).toBeGreaterThan(0);
  expect(existsSync(result.cliPath)).toBe(true);
  expect(installLocal(options).changed).toBe(0);
  expect(readFileSync(profile, 'utf8')).toBe(original);
  expect(existsSync(join(data, 'codex-shell.ps1'))).toBe(false);
  const info = JSON.parse(execFileSync(process.execPath, [result.cliPath, 'version'], { encoding: 'utf8' }));
  expect(info.buildId).toBe(result.buildId);
  const rolled = rollbackLocal(result.backupDir!, data);
  expect(rolled.restored).toBeGreaterThan(0);
  expect(readFileSync(profile, 'utf8')).toBe(original);
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
  expect(existsSync(join(data, 'active-install.json'))).toBe(false);
});
it('rollback fails closed on changes made after install', () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/install-race-'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data/client-a.dpapi'), 'test-only');
  const profile = join(dir, 'profile.ps1');
  writeFileSync(profile, '# original\n');
  const result = installLocal({
    projectRoot: resolve('.'),
    dataDir: join(dir, 'data'),
    codexHome: join(dir, 'home'),
    nativeExecutable: process.execPath,
  });
  const config = join(dir, 'home/config.toml');
  writeFileSync(config, '# edited by user\n');
  expect(() => rollbackLocal(result.backupDir!, join(dir, 'data'))).toThrow();
  expect(readFileSync(config, 'utf8')).toBe('# edited by user\n');
  expect(readFileSync(profile, 'utf8')).toBe('# original\n');
});
