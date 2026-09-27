import { expect, it } from 'vitest';
import { fixture } from './fixture.js';
import { sleep } from '../src/core/util.js';

it.each(['expired','answered'] as const)('a %s question is removed from the pending delivery queue',async(end)=>{
  const f=await fixture();try{
    const a=await f.connect();const controller=new AbortController();controller.abort();
    await f.broker.tool('wait_for_user_message',{session_id:a.session.id,mode:'ask',request_key:'late',prompt:'Never deliver this ended question',timeout_seconds:1},a.caller,controller.signal);
    const w=f.store.list('wait')[0];
    if(end==='expired'){w.expiresAt=Date.now()-1;f.store.put('wait',w);}
    else await f.inbound(`/reply ${w.shortId} Already answered`);
    await f.broker.tick();
    expect(f.store.get('wait',w.id)?.state).toBe(end);
    expect(f.store.get('outbox',w.outboxId)?.state).toBe('cancelled');
    expect(f.im.sent.some(o=>o.id===w.outboxId)).toBe(false);
  }finally{await f.close();}
});

it('question deadline is rechecked after an earlier delivery blocks the worker',async()=>{
  const f=await fixture();let release!:()=>void;try{
    const a=await f.connect();await f.broker.tick();const controller=new AbortController();controller.abort();
    await f.broker.tool('send_message_to_user',{session_id:a.session.id,text:'first',idempotency_key:'first'},a.caller);
    await f.broker.tool('wait_for_user_message',{session_id:a.session.id,mode:'ask',request_key:'ttl',prompt:'Second',timeout_seconds:1},a.caller,controller.signal);
    f.im.sendGate=new Promise<void>(r=>{release=r;});const sentBefore=f.im.sent.length;
    const pumping=f.broker.tick();while(f.im.sent.length===sentBefore)await sleep(10);
    expect(f.im.sent.at(-1)?.text).toContain('first');
    const w=f.store.list('wait')[0];w.expiresAt=Date.now()-1;f.store.put('wait',w);release();await pumping;
    expect(f.im.sent.some(o=>o.id===w.outboxId)).toBe(false);expect(f.store.get('wait',w.id)?.state).toBe('expired');
  }finally{release?.();await f.close();}
});

it.each(['/status','/sessions'] as const)('%s reply keeps its resource scope until actual delivery',async(command)=>{
  const f=await fixture();try{
    const a=await f.connect('Private A');const b=await f.connect('Allowed B',false);await f.broker.tick();
    await f.inbound(command,{messageId:'scoped-control'});
    const inbound=f.store.list('inbox').find(i=>i.platformMessageId==='scoped-control')!;
    const receipt=f.store.list('outbox').find(o=>o.businessKey===`control:${inbound.id}`)!;expect(receipt).toMatchObject({state:'queued'});expect(receipt.text).toContain('Private A');
    // Simulate Web revoking a broad grant while leaving a narrower valid grant.
    const g=f.store.list('grant').find(g=>g.subject.startsWith('im:'))!;
    f.store.put('grant',{...g,id:'narrow-fixture',resources:{...g.resources,sessions:[b.session.id],futureSessions:false}});
    f.broker.policy.revoke(g.id,g.revision);await f.broker.tick();
    expect(f.im.sent.some(o=>o.id===receipt.id)).toBe(false);expect(f.store.get('outbox',receipt.id)?.state).toBe('cancelled');
    expect(f.store.get('session',a.session.id)?.conversationId).toBe(b.session.conversationId);
  }finally{await f.close();}
});

it('durable task dispatch follows input acceptance order rather than random UUID order',async()=>{
  const f=await fixture();try{
    const a=await f.connect();await f.inbound('first accepted');await f.inbound('second accepted');
    const jobs=f.store.list('job');const first=jobs.find(j=>j.prompt==='first accepted')!;const second=jobs.find(j=>j.prompt==='second accepted')!;
    f.store.remove('job',first.id);f.store.remove('job',second.id);
    // Force UUID lexical order to disagree with acceptance/insertion order.
    f.store.put('job',{...first,id:'job_ffffffff-ffff-ffff-ffff-ffffffffffff'});
    f.store.put('job',{...second,id:'job_00000000-0000-0000-0000-000000000000'});
    await f.broker.tick();expect(a.runtime.jobs.map(j=>j.prompt)).toEqual(['first accepted','second accepted']);
  }finally{await f.close();}
});

it('a cancelled MCP transport preserves the open question for a later resume',async()=>{
  const f=await fixture();try{
    const a=await f.connect();const controller=new AbortController();const waiting=f.broker.tool('wait_for_user_message',{session_id:a.session.id,mode:'ask',request_key:'resume-after-close',prompt:'Keep question',timeout_seconds:2},a.caller,controller.signal);
    const until=Date.now()+1000;while(!f.store.list('wait').length&&Date.now()<until)await sleep(10);controller.abort();expect(await waiting).toMatchObject({status:'waiting'});
    const w=f.store.list('wait')[0];await f.broker.tick();await f.inbound(`/reply ${w.shortId} durable answer`);
    expect(await f.broker.tool('wait_for_user_message',{session_id:a.session.id,mode:'resume',request_key:'resume-after-close',timeout_seconds:1},a.caller)).toMatchObject({status:'answered',reply:{text:'durable answer'}});
  }finally{await f.close();}
});

it('status reconciles an expired wait with the current native runtime state',async()=>{
  const f=await fixture();try{const a=await f.connect();const controller=new AbortController();controller.abort();
    await f.broker.tool('wait_for_user_message',{session_id:a.session.id,mode:'ask',request_key:'status-expiry',prompt:'Expired question',timeout_seconds:1},a.caller,controller.signal);
    const w=f.store.list('wait')[0];w.expiresAt=Date.now()-1;f.store.put('wait',w);
    expect(await f.broker.status(a.session)).toMatchObject({state:'ready',waiting_questions:[]});
    a.runtime.active=true;expect(await f.broker.status(a.session)).toMatchObject({state:'running'});
    await f.broker.stop(a.session.id);expect(await f.broker.status(a.session)).toMatchObject({state:'stopped',control_epoch:2});
  }finally{await f.close();}
});
