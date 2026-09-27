import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { CodexRuntime } from '../src/adapters/agent/runtime.js';

/** Protocol fixture: validates resource-tree logic, not OS process termination. */
async function treeFixture(options:{failedTerminal?:boolean;lateChild?:boolean}={}) {
  const socket=new WebSocketServer({host:'127.0.0.1',port:0});await once(socket,'listening');
  const threads=new Map<string,any>();const queues=new Map<string,string[]>();const terminals=new Map<string,string[]>();const goals=new Set<string>();const calls:Array<{method:string;params:any}>=[];
  function add(id:string,parent?:string){threads.set(id,{id,parentThreadId:parent,cwd:resolve('.'),status:{type:'active'},turns:[{id:`turn-${id}`,status:'inProgress'}]});queues.set(id,[`${id}-q1`,`${id}-q2`]);terminals.set(id,[`${id}-p1`,`${id}-p2`]);goals.add(id);}
  add('unrelated');add('grandchild','child');add('root');add('child','root');
  const page=(items:string[],cursor?:string)=>{const remainder=cursor?items.filter(x=>x>cursor):items;return {data:remainder.slice(0,1),nextCursor:remainder.length>1?remainder[0]:null};};
  socket.on('connection',ws=>ws.on('message',buffer=>{
    const message=JSON.parse(String(buffer));if(message.id===undefined)return;
    const {method,params:p}=message;calls.push({method,params:p});let result:any={};let error:any;
    if(method==='initialize')result={};
    else if(method==='thread/loaded/list'){
      const ids=[...threads.keys()];const offset=Number(p.cursor??0);result={data:ids.slice(offset,offset+2),nextCursor:offset+2<ids.length?String(offset+2):null};
    }
    else if(method==='thread/resume'||method==='thread/read')result={thread:threads.get(p.threadId)};
    else if(method==='thread/queue/list'){const q=page(queues.get(p.threadId)??[],p.cursor);result={...q,data:q.data.map(id=>({id}))};}
    else if(method==='thread/queue/delete')queues.set(p.threadId,(queues.get(p.threadId)??[]).filter(id=>id!==p.queuedSubmissionId));
    else if(method==='thread/goal/clear'){
      goals.delete(p.threadId);result={cleared:true};
      if(options.lateChild&&p.threadId==='root')add('late-child','root');
    }
    else if(method==='thread/goal/get')result={goal:goals.has(p.threadId)?{objective:'fixture'}:null};
    else if(method==='turn/interrupt'){const t=threads.get(p.threadId);t.status={type:'idle'};t.turns[0].status='interrupted';}
    else if(method==='thread/backgroundTerminals/list'){const q=page(terminals.get(p.threadId)??[],p.cursor);result={...q,data:q.data.map(processId=>({processId}))};}
    else if(method==='thread/backgroundTerminals/terminate'){
      if(options.failedTerminal&&p.threadId==='child')error={code:-32000,message:'fixture process termination rejected'};
      else terminals.set(p.threadId,(terminals.get(p.threadId)??[]).filter(id=>id!==p.processId));
    }
    else error={code:-32601,message:`Unexpected method ${method}`};
    ws.send(JSON.stringify({id:message.id,...(error?{error}:{result})}));
  }));
  const runtime=new CodexRuntime({id:'tree-runtime',clientId:'fixture',endpoint:`ws://127.0.0.1:${(socket.address() as any).port}`,threadId:'root',homeId:'fixture',cwd:resolve('.'),workspace:'fixture',serverName:'agent-to-im',createdAt:Date.now()});
  await runtime.connect();
  return {runtime,calls,threads,queues,terminals,goals,async close(){await runtime.close();for(const client of socket.clients)client.terminate();await new Promise<void>(r=>socket.close(()=>r()));}};
}

it('stop follows descendants through pagination and cancels only the owned subtree',async()=>{
  const f=await treeFixture();try{
    const report=await f.runtime.stop();expect(report).toMatchObject({complete:true,interruptedTurns:3,cancelledNativeQueue:6,terminatedTerminals:6,residuals:[]});
    expect(f.calls.filter(c=>c.method==='turn/interrupt').map(c=>c.params.threadId)).toEqual(['grandchild','child','root']);
    for(const id of ['root','child','grandchild']){expect(f.queues.get(id)).toEqual([]);expect(f.terminals.get(id)).toEqual([]);expect(f.goals.has(id)).toBe(false);}
    expect(f.threads.get('unrelated').status.type).toBe('active');expect(f.queues.get('unrelated')).toHaveLength(2);expect(f.terminals.get('unrelated')).toHaveLength(2);expect(f.goals.has('unrelated')).toBe(true);
  }finally{await f.close();}
});
it('terminal cancellation failure produces an incomplete report and preserves residual evidence',async()=>{
  const f=await treeFixture({failedTerminal:true});try{const report=await f.runtime.stop();expect(report.complete).toBe(false);expect(report.residuals.some(r=>r.resourceId==='terminals:child')).toBe(true);expect(f.terminals.get('child')).toHaveLength(2);expect(f.threads.get('root').status.type).toBe('idle');}finally{await f.close();}
});
it('new descendants appearing during stop keep completion unverified',async()=>{
  const f=await treeFixture({lateChild:true});try{const report=await f.runtime.stop();expect(report.complete).toBe(false);expect(report.residuals.some(r=>r.resourceId==='late-child')).toBe(true);expect(f.threads.get('late-child').status.type).toBe('active');}finally{await f.close();}
});
