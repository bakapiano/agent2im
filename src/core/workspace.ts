import { isAbsolute, resolve } from 'node:path';
import { ensure } from './errors.js';
import { hash } from './util.js';

export function nativePath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) path = '\\\\' + path.slice(8);
  else if (path.startsWith('\\\\?\\')) path = path.slice(4);
  ensure(isAbsolute(path), 'THREAD_CONTEXT_UNVERIFIED', '原生工作目录必须为绝对路径。', 403);
  return resolve(path);
}
export function sameWorkspace(a: string, b: string) {
  return nativePath(a).toLowerCase() === nativePath(b).toLowerCase();
}
/** Optional display labels for native working directories. */
export function workspaceLabel(cwd: string, aliases: Record<string, string>): string {
  const path = nativePath(cwd);
  return (
    Object.entries(aliases).find(([, value]) => sameWorkspace(value, path))?.[0] ??
    `cwd-${hash(path.toLowerCase()).slice(0, 16)}`
  );
}
