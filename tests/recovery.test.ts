import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture, FakeAgents, FakeIm } from './fixture.js';
import { Store } from '../src/db/store.js';
import { Broker } from '../src/broker.js';
import { Vault } from '../src/credentials/vault.js';
import { EphemeralTestProtector } from '../src/credentials/protector.js';
import { sleep } from '../src/core/util.js';
it('SQLite restart preserves grants, selection, answered wait, and uncertain delivery',async()=>{
  mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/restart-'));const filename=join(dir,'broker.sqlite');const f=await fixture(filename);const a=await f.connect();
  const waiting=f.broker.tool('wait_for_user_message',{session_id:a.session.id,mode:'ask',request_key:'persist',prompt:'persist question',timeout_seconds:1},a.caller);await sleep(30);await f.inbound(`/reply ${f.store.list('wait')[0].shortId} persistent answer`);expect(await waiting).toMatchObject({status:'answered'});
  const o=f.store.list('outbox')[0];o.state='sending';f.store.put('outbox',o);const granted=f.store.list('grant').map(g=>g.id);const config=f.broker.config;await f.close();
  const store=new Store(filename);const broker=new Broker(store,new Vault(store,f.protector),config,new FakeIm(),new FakeAgents());
  try {await broker.start();expect(store.list('grant').map(g=>g.id)).toEqual(granted);expect(store.setting(`selection:${a.session.conversationId}`)).toBe(a.session.id);expect(store.list('wait')[0]).toMatchObject({state:'answered',reply:{text:'persistent answer'}});expect(store.get('outbox',o.id)?.state).toBe('unknown');}finally{await broker.close();store.close();}
});
it('stop epoch and wait cancellation happen immediately while native dispatch awaits receipt',async()=>{
  const f=await fixture();try{const a=await f.connect();let release!:()=>void;a.runtime.submitGate=new Promise<void>(r=>{release=r;});await f.inbound('task');const pumping=f.broker.tick();const deadline=Date.now()+2000;while(!a.runtime.jobs.length&&Date.now()<deadline)await sleep(20);
    const stopping=f.broker.stop(a.session.id);expect(f.store.get('session',a.session.id)).toMatchObject({state:'stopping',epoch:2});release();await pumping;expect(await stopping).toMatchObject({complete:true});expect(f.store.list('job')[0].state).toBe('cancelled');expect(a.runtime.cancelled).toHaveLength(1);
  }finally{await f.close();}
});
it('revocation cancels native accepted jobs on the next worker pass',async()=>{const f=await fixture();try{const a=await f.connect();await f.inbound('task');await f.broker.tick();const g=f.store.list('grant').find(g=>g.subject.startsWith('im:'))!;f.broker.policy.revoke(g.id,g.revision);await f.broker.tick();expect(a.runtime.stops).toBe(1);expect(f.store.list('job')[0].state).toBe('cancelled');}finally{await f.close();}});
it('grant revocation during native submit fences and stops potentially consumed work',async()=>{
  const f=await fixture();try{const a=await f.connect();let release!:()=>void;a.runtime.submitGate=new Promise<void>(r=>{release=r;});await f.inbound('task');const pumping=f.broker.tick();const deadline=Date.now()+2000;while(!a.runtime.jobs.length&&Date.now()<deadline)await sleep(20);const g=f.store.list('grant').find(g=>g.subject.startsWith('im:'))!;f.broker.policy.revoke(g.id,g.revision);release();await pumping;const until=Date.now()+1000;while(!a.runtime.stops&&Date.now()<until)await sleep(20);expect(a.runtime.stops).toBe(1);expect(f.store.list('job')[0].state).toBe('cancelled');}finally{await f.close();}
});
it.each(['stopped','stop_incomplete','stopping'] as const)('restart preserves the %s dispatch fence',async(state)=>{
  mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/fence-'));const filename=join(dir,'broker.sqlite');const f=await fixture(filename);const a=await f.connect();
  const session=f.store.get('session',a.session.id)!;session.state=state;session.epoch=2;f.store.put('session',session);const config=f.broker.config;await f.close();
  const store=new Store(filename);const broker=new Broker(store,new Vault(store,f.protector),config,new FakeIm(),new FakeAgents());
  try{await broker.start();expect(store.get('session',session.id)).toMatchObject({state:state==='stopping'?'stop_incomplete':state,epoch:2});if(state==='stopping')expect(store.list('stop').at(-1)?.report).toMatchObject({complete:false});}
  finally{await broker.close();store.close();}
});
it.each(['stopped','stop_incomplete','stopping'] as const)('runtime disconnect preserves the %s dispatch fence',async(state)=>{
  const f=await fixture();try{const a=await f.connect();const s=f.store.get('session',a.session.id)!;s.state=state;f.store.put('session',s);a.runtime.emit('connection/closed',{});expect(f.store.get('session',s.id)?.state).toBe(state);expect(f.broker.runtimes.has(s.runtimeId)).toBe(false);}finally{await f.close();}
});
it('MCP call begun before stop cannot enter a reopened session epoch',async()=>{
  const f=await fixture();let release!:()=>void;try{const a=await f.connect();a.runtime.inspectEntered=false;a.runtime.inspectGate=new Promise<void>(r=>{release=r;});
    const pending=f.broker.tool('send_message_to_user',{session_id:a.session.id,text:'stale message',idempotency_key:'stale'},a.caller).then(value=>({value}),error=>({error}));
    const deadline=Date.now()+1000;while(!a.runtime.inspectEntered&&Date.now()<deadline)await sleep(10);expect(a.runtime.inspectEntered).toBe(true);
    await f.broker.stop(a.session.id);await f.inbound('new task');expect(f.store.get('session',a.session.id)?.state).toBe('ready');release();
    expect(await pending).toMatchObject({error:{code:'STALE_CONTROL_EPOCH'}});expect(f.store.list('outbox').some(o=>o.text.includes('stale message'))).toBe(false);
  }finally{release?.();await f.close();}
});
it('late events from a replaced IM connection retain their old trust boundary',async()=>{
  const f=await fixture();try{const oldHandler=f.im.handler!;const secret=await f.vault.save('replacement-secret','feishu');
    await f.broker.channels.execute({operation:'upsert',provider:'feishu',channel_alias:f.channel.alias,display_name:'replacement',app_id:'cli_replacement',credential_ref:secret,expected_revision:3,idempotency_key:'replace'});
    await f.broker.channels.execute({operation:'validate',channel_id:f.channel.id,expected_revision:4,idempotency_key:'replace-validate'});
    await f.broker.channels.execute({operation:'set_enabled',channel_id:f.channel.id,enabled:true,expected_revision:5,idempotency_key:'replace-enable'});
    await oldHandler({eventId:'old-event',messageId:'old-message',tenantId:'old-tenant',userId:'old-user',chatId:'old-chat',chatType:'p2p',text:'old callback',receivedAt:Date.now()});
    expect(f.store.list('conversation')).toHaveLength(0);expect(f.store.list('request')).toHaveLength(0);
  }finally{await f.close();}
});
