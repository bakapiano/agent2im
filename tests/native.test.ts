import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { CodexRuntime, CodexRuntimeFactory } from '../src/adapters/agent/runtime.js';
import { sleep } from '../src/core/util.js';
import { fixture } from './fixture.js';
import { createServers } from '../src/server.js';
import { DpapiProtector } from '../src/credentials/protector.js';
const exe=process.env.AGENT_IM_CODEX_EXE??join(process.env.APPDATA??'','npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
class TestRpc {
  ws!:WebSocket;seq=0;pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();events:any[]=[];
  async connect(endpoint:string){this.ws=new WebSocket(endpoint);await once(this.ws,'open');this.ws.on('message',b=>{const m=JSON.parse(String(b));if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id)!;this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else this.events.push(m);});await this.call('initialize',{clientInfo:{name:'isolated_acceptance',version:'1'},capabilities:{experimentalApi:true}});this.ws.send(JSON.stringify({method:'initialized'}));}
  call(method:string,params:any={}):Promise<any>{const id=++this.seq;return Promise.race([new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));}),sleep(15000).then(()=>{throw new Error(`Timeout: ${method}`);})]);}
  close(){this.ws?.close();}
}
it('real Codex: attach existing thread, witness actual MCP, native queue and stop retain history',async()=>{
  expect(existsSync(exe),'Codex CLI fixture executable').toBe(true);
  mkdirSync('.test-data',{recursive:true});const temp=mkdtempSync(resolve('.test-data/native-'));const codexHome=join(temp,'codex-home');mkdirSync(codexHome);const work=join(temp,'workspace');mkdirSync(work);
  async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
  const portalPort=await freePort();const agentPort=await freePort();const f=await fixture(':memory:',{portalPort,agentPort},new CodexRuntimeFactory());f.broker.config.workspaces.project=work;
  await f.inbound('/sessions');await f.approveAll();const alias=f.store.list('conversation')[0].alias!;const client=f.broker.enroll('native-integration','fixture-user');
  const servers=await createServers(f.broker,'native-fixture-installation','native-fixture-bootstrap');await servers.listen();
  const descriptorPath=join(temp,'native-client.dpapi');const protector=new DpapiProtector();const descriptor={brokerUrl:`http://127.0.0.1:${agentPort}`,clientId:client.client_id,secret:client.secret};
  writeFileSync(descriptorPath,await protector.protect(JSON.stringify(descriptor)));
  let requestCount=0;let hold=false;let nextCall:{name:string;args:unknown}|undefined;let tools:any[]=[];const seenRequests:any[]=[];const registerArgs={connection_alias:alias,title:'native-fixture',idempotency_key:'native-register',activate:true};
  const mockFailures:unknown[]=[];
  const mock=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];
    try { for await(const c of req)chunks.push(c); }
    catch(error) {
      // Native turn interruption can cancel a request while its body is still
      // arriving. Consume only this expected transport cancellation.
      if (!(req.destroyed && (error as NodeJS.ErrnoException).code === 'ECONNRESET')) mockFailures.push(error);
      return;
    }
    let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(404).end();return;}
    seenRequests.push({url:req.url,body});tools=body.tools??tools;requestCount++;
    const ns=tools.find(t=>t.type==='namespace'&&t.name?.includes('agent_to_im'));const selected=nextCall;nextCall=undefined;const fn=selected?(ns?.tools?.find((t:any)=>t.name===selected.name)??tools.find(t=>t.name?.includes(selected.name))):undefined;
    const item=selected&&fn?{id:`fc_native_${requestCount}`,type:'function_call',name:fn.name,...(ns?{namespace:ns.name}:{}),call_id:`call_native_${requestCount}`,arguments:JSON.stringify(selected.args),status:'completed'}:{id:`msg_${requestCount}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'isolated native fixture completed',annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const event=(type:string,data:any)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    event('response.created',{response:{id:`resp_${requestCount}`,object:'response',status:'in_progress',output:[]}});
    if(hold)return;
    event('response.output_item.added',{output_index:0,item});
    event('response.output_item.done',{output_index:0,item});
    event('response.completed',{response:{id:`resp_${requestCount}`,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  });await new Promise<void>(r=>mock.listen(0,'127.0.0.1',r));const mockPort=(mock.address() as any).port;
  const reserved=createServer();await new Promise<void>(r=>reserved.listen(0,'127.0.0.1',r));const wsPort=(reserved.address() as any).port;await new Promise<void>(r=>reserved.close(()=>r()));
  const args=['app-server','--listen',`ws://127.0.0.1:${wsPort}`,'-c','model="fixture-model"','-c','model_provider="fixture"','-c',`model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${mockPort}/v1",wire_api="responses",requires_openai_auth=false}`,'-c','web_search="disabled"','-c','features.shell_tool=false','-c',`mcp_servers.agent-to-im={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(resolve('dist/cli.js'))},"mcp","--descriptor",${JSON.stringify(descriptorPath)}],startup_timeout_sec=20,default_tools_approval_mode="approve"}`];
  // Minimal environment: no inherited provider keys, user Codex config, or auth storage.
  const child=spawn(exe,args,{cwd:work,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,USERPROFILE:temp,LOCALAPPDATA:temp,APPDATA:temp,CODEX_HOME:codexHome},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>{log+=String(b);});child.stderr.on('data',b=>{log+=String(b);});
  const rpc=new TestRpc();let runtime:CodexRuntime|undefined;
  try {
    for(let i=0;i<100&&!log.includes('Listening');i++){if(child.exitCode!==null)throw new Error(log);await sleep(50);if(i>10)break;}
    await rpc.connect(`ws://127.0.0.1:${wsPort}`);
    const started=await rpc.call('thread/start',{cwd:work,model:'fixture-model',modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only'});const threadId=started.thread.id;
    await rpc.call('turn/start',{threadId,input:[{type:'text',text:'Seed persisted history'}]});
    const seedDeadline=Date.now()+25000;while(Date.now()<seedDeadline&&!rpc.events.some(e=>e.method==='turn/completed'))await sleep(100);
    expect(rpc.events.some(e=>e.method==='turn/completed'),JSON.stringify({log,events:rpc.events,requests:seenRequests})).toBe(true);
    const attached=await f.broker.attach(client.client_id,{endpoint:`ws://127.0.0.1:${wsPort}`,threadId,homeId:codexHome,cwd:work,workspace:'project',serverName:'agent-to-im'});
    writeFileSync(descriptorPath,await protector.protect(JSON.stringify({...descriptor,runtimeId:attached.runtime_id})));
    runtime=new CodexRuntime({id:'runtime-native',clientId:'native-client',endpoint:`ws://127.0.0.1:${wsPort}`,threadId,homeId:codexHome,cwd:work,workspace:'fixture',serverName:'agent-to-im',createdAt:Date.now()});
    const snapshot=await runtime.connect();expect(snapshot.threadId).toBe(threadId);
    const nativeEvents:any[]=[];runtime.onEvent(e=>nativeEvents.push(e));
    nextCall={name:'register',args:registerArgs};const turn=await rpc.call('turn/start',{threadId,input:[{type:'text',text:'Run fixture MCP registration'}]});
    const deadline=Date.now()+25000;while(Date.now()<deadline&&!nativeEvents.some(e=>e.method==='turn/completed'))await sleep(100);
    expect(nativeEvents.some(e=>e.method==='turn/completed'),JSON.stringify({log,requests:seenRequests.map(r=>({url:r.url,tools:r.body.tools?.map((t:any)=>t.name)})),events:nativeEvents})).toBe(true);
    expect(nativeEvents.some(e=>e.params?.item?.type==='mcpToolCall'),JSON.stringify({log,tools:tools.map(t=>({name:t.name,type:t.type})),events:nativeEvents,requests:requestCount})).toBe(true);
    const witness=await runtime.witness('register',registerArgs,'attempt-native');expect(witness.threadId).toBe(threadId);expect(witness.turnId).toBe(turn.turn.id);
    await expect(runtime.witness('send_message_to_user',{},'attempt-native')).rejects.toMatchObject({code:'THREAD_CONTEXT_UNVERIFIED'});
    const pending=f.store.list('request').filter(r=>r.subjectKind==='agent');expect(pending).toHaveLength(1);expect(f.store.list('session')).toHaveLength(0);await f.approveAll();
    async function runCall(name:string,args:unknown){nextCall={name,args};const t=await rpc.call('turn/start',{threadId,input:[{type:'text',text:`fixture ${name}`}]});const until=Date.now()+10000;while(Date.now()<until&&!rpc.events.some(e=>e.method==='turn/completed'&&e.params.turn.id===t.turn.id))await sleep(30);expect(rpc.events.some(e=>e.method==='turn/completed'&&e.params.turn.id===t.turn.id)).toBe(true);}
    await runCall('register',registerArgs);const session=f.store.list('session')[0];expect(session?.threadId).toBe(threadId);
    await runCall('send_message_to_user',{session_id:session.id,text:'actual native MCP output',idempotency_key:'actual-send'});await f.broker.tick();expect(f.im.sent.some(o=>o.text.includes('actual native MCP output')),JSON.stringify({outbox:f.store.list('outbox'),session:f.store.list('session'),mcp:nativeEvents.filter(e=>e.params?.item?.type==='mcpToolCall')})).toBe(true);
    const asked=runCall('wait_for_user_message',{session_id:session.id,mode:'ask',request_key:'actual-wait',prompt:'Actual native question?',timeout_seconds:5});const waitDeadline=Date.now()+5000;while(!f.store.list('wait').length&&Date.now()<waitDeadline)await sleep(30);await f.broker.tick();const question=f.store.list('wait')[0];expect(question).toBeTruthy();await f.inbound(`/reply ${question.shortId} actual native answer`);await asked;expect(f.store.list('wait')[0].state).toBe('answered');
    await f.inbound('actual IM-origin task');await f.broker.tick();const job=f.store.list('job')[0];const jobDeadline=Date.now()+5000;while(f.store.get('job',job.id)?.state!=='completed'&&Date.now()<jobDeadline)await sleep(30);expect(f.store.get('job',job.id)?.state).toBe('completed');await f.broker.tick();expect(f.im.sent.some(o=>o.purpose==='result')).toBe(true);
    await expect(runtime.witness('send_message_to_user',{},'fabricated')).rejects.toMatchObject({code:'THREAD_CONTEXT_UNVERIFIED'});
    hold=true;await rpc.call('turn/start',{threadId,input:[{type:'text',text:'Keep this isolated turn active for stop verification'}]});
    await rpc.call('thread/goal/set',{threadId,objective:'Isolated stop acceptance fixture',status:'active'});
    const q=await rpc.call('thread/queue/add',{threadId,clientUserMessageId:randomUUID(),input:[{type:'text',text:'queued native task'}]});expect(q.queuedSubmission.id).toBeTruthy();expect((await rpc.call('thread/queue/list',{threadId})).data).toHaveLength(1);
    const stopped=await runtime.stop();expect(stopped,JSON.stringify(stopped)).toMatchObject({complete:true,scope:'tracked_resources',cancelledNativeQueue:1});
    expect((await rpc.call('thread/goal/get',{threadId})).goal??null).toBeNull();
    const read=await rpc.call('thread/read',{threadId,includeTurns:true});expect(read.thread.id).toBe(threadId);expect(read.thread.turns.length).toBeGreaterThan(0);
    const resumed=await rpc.call('thread/resume',{threadId});expect(resumed.thread.id).toBe(threadId);expect(requestCount).toBeGreaterThanOrEqual(2);
  } finally {await runtime?.close();rpc.close();await f.broker.close();await servers.close();f.store.close();child.kill();await Promise.race([once(child,'exit'),sleep(3000)]);mock.closeAllConnections();await new Promise<void>(r=>mock.close(()=>r()));}
  expect(mockFailures).toEqual([]);
},60000);
