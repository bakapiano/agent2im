import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { and, eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Kind, Kinds } from '../core/model.js';
import { AppError } from '../core/errors.js';

const records = sqliteTable('records', {
  kind: text('kind').notNull(), id: text('id').notNull(), body: text('body', { mode: 'json' }).$type<unknown>().notNull(),
  revision: integer('revision').notNull().default(1),
  sequence: integer('sequence').notNull(),
}, t => [primaryKey({ columns: [t.kind, t.id] })]);

/** Typed document rows with transactional unique claims; no generic write HTTP API. */
export class Store {
  readonly sqlite: Database.Database;
  readonly db: ReturnType<typeof drizzle>;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(filename);
    this.sqlite.pragma('journal_mode = WAL'); this.sqlite.pragma('foreign_keys = ON'); this.sqlite.pragma('busy_timeout = 5000');
    const version = this.sqlite.pragma('user_version', { simple: true }) as number;
    if (version > 2) { this.sqlite.close(); throw new AppError('DATABASE_VERSION_UNSUPPORTED', '数据库版本高于当前程序，请使用兼容版本。'); }
    this.sqlite.transaction(() => {
      this.sqlite.exec(`CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), revision INTEGER NOT NULL DEFAULT 1, sequence INTEGER NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS unique_claims (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));
      CREATE TABLE IF NOT EXISTS audit_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL CHECK(json_valid(details)));
      `);
      const columns = this.sqlite.pragma('table_info(records)') as Array<{ name: string }>;
      if (!columns.some(c => c.name === 'sequence')) {
        this.sqlite.exec('ALTER TABLE records ADD COLUMN sequence INTEGER; UPDATE records SET sequence=rowid;');
      }
      this.sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS records_sequence ON records(sequence); PRAGMA user_version = 2;');
    })();
    this.db = drizzle(this.sqlite);
  }
  get<K extends Kind>(kind: K, id: string): Kinds[K] | undefined {
    return this.db.select({ body: records.body }).from(records).where(and(eq(records.kind, kind), eq(records.id, id))).get()?.body as Kinds[K] | undefined;
  }
  list<K extends Kind>(kind: K): Kinds[K][] {
    return this.db.select({ body: records.body }).from(records).where(eq(records.kind, kind)).orderBy(records.sequence).all().map(x => x.body as Kinds[K]);
  }
  put<K extends Kind>(kind: K, value: Kinds[K]): void {
    this.sqlite.prepare('INSERT INTO records(kind,id,body,sequence) VALUES(?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM records)) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, revision=records.revision+1').run(kind, value.id, JSON.stringify(value));
  }
  remove(kind: Kind, id: string) { this.sqlite.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  setting<T>(key: string): T | undefined { return this.get('setting', key)?.value as T | undefined; }
  setSetting(key: string, value: unknown) { this.put('setting', { id: key, value }); }
  transaction<T>(work: () => T): T { return this.sqlite.transaction(work)(); }
  claim(namespace: string, key: string, proposedValue: string): string {
    this.sqlite.prepare('INSERT OR IGNORE INTO unique_claims(namespace,key,value) VALUES(?,?,?)').run(namespace, key, proposedValue);
    return (this.sqlite.prepare('SELECT value FROM unique_claims WHERE namespace=? AND key=?').get(namespace, key) as { value: string }).value;
  }
  unclaim(namespace: string, key: string, expectedValue: string) {
    this.sqlite.prepare('DELETE FROM unique_claims WHERE namespace=? AND key=? AND value=?').run(namespace, key, expectedValue);
  }
  audit(action: string, subject: string, target: string, details: Record<string, unknown> = {}) {
    this.sqlite.prepare('INSERT INTO audit_events(at,action,subject,target,details) VALUES(?,?,?,?,?)').run(Date.now(), action, subject, target, JSON.stringify(details));
  }
  auditList(limit = 100) { return this.sqlite.prepare('SELECT seq,at,action,subject,target,details FROM audit_events ORDER BY seq DESC LIMIT ?').all(limit); }
  close() { this.sqlite.close(); }
}
