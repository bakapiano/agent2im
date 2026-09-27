import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.js';

export interface SecretProtector { protect(value: string): Promise<string>; unprotect(value: string): Promise<string> }
export class DpapiProtector implements SecretProtector {
  private run(operation: 'protect' | 'unprotect', input: string): Promise<string> {
    if (process.platform !== 'win32') throw new AppError('SECRET_BACKEND_UNAVAILABLE', '此部署配置要求 Windows DPAPI。');
    const script = `Add-Type -AssemblyName System.Security; $raw = [Console]::In.ReadToEnd(); $bytes = [Convert]::FromBase64String($raw); if ($env:AGENT_IM_SECRET_ACTION -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) } else { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) }; [Console]::Out.Write([Convert]::ToBase64String($result))`;
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_IM_SECRET_ACTION: operation },
      });
      let output = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.resume();
      const timeout = setTimeout(() => { child.kill(); reject(new AppError('SECRET_BACKEND_TIMEOUT', '凭据后端超时。')); }, 15_000);
      child.on('error', () => { clearTimeout(timeout); reject(new AppError('SECRET_BACKEND_UNAVAILABLE', '凭据后端无法启动。')); });
      child.on('exit', code => { clearTimeout(timeout); if (code === 0) resolve(output.trim()); else reject(new AppError('SECRET_BACKEND_ERROR', '凭据加密/解密失败。')); });
      child.stdin.end(input);
    });
  }
  async protect(value: string) { return 'dpapi:' + await this.run('protect', Buffer.from(value).toString('base64')); }
  async unprotect(value: string) {
    if (!value.startsWith('dpapi:')) throw new AppError('SECRET_FORMAT_INVALID', '凭据格式不匹配。');
    return Buffer.from(await this.run('unprotect', value.slice(6)), 'base64').toString('utf8');
  }
}

/** Explicit test dependency, never selected by the production CLI. */
export class EphemeralTestProtector implements SecretProtector {
  constructor(private key = randomBytes(32)) {}
  async protect(value: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  async unprotect(value: string) {
    const b = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0,12));
    decipher.setAuthTag(b.subarray(12,28)); return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
  }
}
