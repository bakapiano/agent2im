import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => Date.now();
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function sameSecret(a: string, b: string): boolean {
  const aa = Buffer.from(hash(a));
  const bb = Buffer.from(hash(b));
  return timingSafeEqual(aa, bb);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => hash(canonical(value));
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function parseCommand(text: string) {
  const m = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1].toLowerCase(), args: m[2]?.trim() ?? '' } : undefined;
}
