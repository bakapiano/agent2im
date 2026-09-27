import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/db/store.js';

it('v1 migration preserves insertion order, updates and reopen preserve sequence',()=>{
  mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/migration-'));const path=join(dir,'store.sqlite');
  const legacy=new Database(path);
  legacy.exec('CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id)); PRAGMA user_version=1;');
  const add=legacy.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?)');
  add.run('setting','z-first',JSON.stringify({id:'z-first',value:1}));add.run('setting','a-second',JSON.stringify({id:'a-second',value:2}));legacy.close();
  let store=new Store(path);
  try {
    expect(store.sqlite.pragma('user_version',{simple:true})).toBe(2);
    expect(store.list('setting').map(s=>s.id)).toEqual(['z-first','a-second']);
    store.setSetting('z-first',3);store.setSetting('m-third',4);store.sqlite.exec('VACUUM');
  }finally{store.close();}
  store=new Store(path);
  try{expect(store.list('setting')).toEqual([{id:'z-first',value:3},{id:'a-second',value:2},{id:'m-third',value:4}]);}finally{store.close();}
});

it('future schema version is rejected without downgrading its marker',()=>{
  mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/future-schema-'));const path=join(dir,'store.sqlite');
  const db=new Database(path);db.pragma('user_version=999');db.close();
  expect(()=>new Store(path)).toThrowError(/数据库版本/);
  const check=new Database(path);try{expect(check.pragma('user_version',{simple:true})).toBe(999);}finally{check.close();}
});
