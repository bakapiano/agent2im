import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/db/store.js';

it('current schema preserves insertion order and reopens', () => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/store-current-'));
  const file = join(dir, 'broker.sqlite');
  let store = new Store(file);
  store.setSetting('z', 1);
  store.setSetting('a', 2);
  store.setSetting('z', 3);
  store.close();
  store = new Store(file);
  try {
    expect(store.sqlite.pragma('user_version', { simple: true })).toBe(5);
    expect(store.list('setting')).toEqual([
      { id: 'z', value: 3 },
      { id: 'a', value: 2 },
    ]);
  } finally {
    store.close();
  }
});
it.each([1, 2, 3, 4, 999])('schema %i is rejected explicitly', (version) => {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(resolve('.test-data/schema-rejected-'));
  const file = join(dir, 'broker.sqlite');
  const db = new Database(file);
  db.pragma('user_version=' + version);
  db.close();
  const before = readFileSync(file);
  expect(() => new Store(file)).toThrow(/数据库格式/);
  expect(readFileSync(file)).toEqual(before);
});
