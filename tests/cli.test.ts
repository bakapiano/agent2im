import { expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { sleep } from '../src/core/util.js';
import { DpapiProtector } from '../src/credentials/protector.js';

it('built CLI serves real portal, enrolls encrypted descriptor, and doctor reports health', async () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/cli-'));
  const cli = resolve('dist/cli.js');
  const portalPort = 22643;
  const agentPort = 22642;
  const child = spawn(
    process.execPath,
    [
      cli,
      'serve',
      '--data-dir',
      dir,
      '--portal-port',
      String(portalPort),
      '--agent-port',
      String(agentPort),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    output += b;
  });
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes('Portal:') && Date.now() < deadline && child.exitCode === null) {
      await sleep(50);
    }
    expect(output).toContain('Portal:');
    const page = await fetch(`http://127.0.0.1:${portalPort}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('本地控制台');
    const command = promisify(execFile);
    const doctor = await command(process.execPath, [cli, 'doctor', '--data-dir', dir]);
    expect(JSON.parse(doctor.stdout).broker.ok).toBe(true);
    const descriptor = join(dir, 'client.dpapi');
    const enrolled = await command(process.execPath, [
      cli,
      'enroll',
      '--data-dir',
      dir,
      '--name',
      'cli-fixture',
      '--descriptor',
      descriptor,
    ]);
    expect(enrolled.stdout).toContain('客户端已登记');
    expect(existsSync(descriptor)).toBe(true);
    const plaintext = JSON.parse(
      await new DpapiProtector().unprotect(readFileSync(descriptor, 'utf8')),
    );
    expect(plaintext.clientId).toMatch(/^client_/);
    expect(plaintext.brokerUrl).toBe(`http://127.0.0.1:${agentPort}`);
    expect(enrolled.stdout).not.toContain(plaintext.secret);
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(3000)]);
  }
}, 30000);
