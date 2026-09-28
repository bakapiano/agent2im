import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixture.js';
import {createServers} from '../src/server.js';
import {Rpc,CodexRuntimeFactory,CodexRuntime} from '../src/adapters/agent/runtime.js';
import {findCodexExecutable} from '../src/adapters/agent/discovery.js';
import {DpapiProtector} from '../src/credentials/protector.js';
import {sleep} from '../src/core/util.js';

it('native original owner keeps executing while Broker relay registers, queues and returns IM results',async()=>{
 mkdirSync('.test-data',{recursive:true});const dir=mkdtempSync(resolve('.test-data/native-relay-')),home=join(dir,'home');mkdirSync(home);
 async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
 const f=await fixture(':memory:',{portalPort:await freePort(),agentPort:await freePort()},new CodexRuntimeFactory());f.broker.config.workspaces={};
 await f.inbound('/sessions');await f.approveAll();const client=f.broker.enroll('native relay','test');
 const descriptor=join(dir,'client.dpapi');writeFileSync(descriptor,await new DpapiProtector().protect(JSON.stringify({brokerUrl:`http://127.0.0.1:${f.broker.config.agentPort}`,clientId:client.client_id,secret:client.secret})));
 const servers=await createServers(f.broker,'test-install','test-bootstrap');await servers.listen();
 let calls=0,hold=false,next:{name:string;args:any}|undefined;
 const model=createServer(async(req,res)=>{
  let raw='';try{for await(const chunk of req)raw+=chunk;}catch{return;}let input:any;try{input=JSON.parse(raw);}catch{res.writeHead(404).end();return;}
  const n=++calls,ns=input.tools?.find((t:any)=>t.name?.includes('agent_to_im')),job=f.store.list('job').find(j=>j.state==='queued_native');
  let chosen=next;next=undefined;
  if(!chosen&&job&&JSON.stringify(input.input).includes(job.id))chosen={name:'send_message_to_user',args:{session_id:job.sessionId,job_id:job.id,text:'IM job completed in original owner',purpose:'result',idempotency_key:'result-'+job.id}};
  const fn=chosen?(ns?.tools?.find((t:any)=>t.name===chosen.name)??input.tools?.find((t:any)=>t.name?.endsWith(chosen.name))):undefined;
  const item=chosen&&fn?{id:`fc_${n}`,type:'function_call',call_id:`call_${n}`,name:fn.name,...(ns?.type==='namespace'?{namespace:ns.name}:{}),arguments:JSON.stringify(chosen.args),status:'completed'}:{id:`msg_${n}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'native relay fixture',annotations:[]}]};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`event: response.created\ndata: ${JSON.stringify({type:'response.created',response:{id:`r${n}`,status:'in_progress',output:[]}})}\n\n`);if(hold)return;
  for(const e of [{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:`r${n}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();
 });
 await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
 writeFileSync(join(home,'config.toml'),`model="fixture-model"\nmodel_provider="fixture"\nweb_search="disabled"\n[features]\nshell_tool=false\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${(model.address() as any).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.agent-to-im]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([resolve('dist/cli.js'),'mcp','--descriptor',descriptor])}\nenv_vars=["CODEX_HOME"]\nrequired=true\ndefault_tools_approval_mode="approve"\n`);
 const owner=new Rpc(findCodexExecutable(),home),events:any[]=[];owner.events.on('notification',e=>events.push(e));
 try{
  await owner.connect();const ownerPid=owner.processId;
  const {thread}=await owner.call('thread/start',{cwd:dir,model:'fixture-model',modelProvider:'fixture',sandbox:'read-only',approvalPolicy:'never'});
  async function turn(text:string,tool?:{name:string;args:any}){next=tool;const started=await owner.call('turn/start',{threadId:thread.id,input:[{type:'text',text}]});const deadline=Date.now()+25000;while(Date.now()<deadline&&!events.some(e=>e.method==='turn/completed'&&e.params.turn.id===started.turn.id))await sleep(50);expect(events.some(e=>e.method==='turn/completed'&&e.params.turn.id===started.turn.id)).toBe(true);return started.turn.id;}
  await turn('Seed native history');
  await turn('Connect using MCP',{name:'register',args:{title:'native queue relay',idempotency_key:'register',activate:true}});
  const session=f.store.list('session')[0];expect(session?.threadId).toBe(thread.id);expect(f.store.list('request')).toHaveLength(1);
  const link=f.store.list('runtime')[0];expect(link.owner.pid).toBe(ownerPid);const relay=f.broker.runtimes.get(link.id) as CodexRuntime;expect(relay.processId).not.toBe(ownerPid);
  expect((await owner.call('thread/loaded/list',{})).data).toContain(thread.id);
  await turn('Send through MCP',{name:'send_message_to_user',args:{session_id:session.id,text:'relay connected',idempotency_key:'notice'}});await f.broker.tick();expect(f.im.sent.some(o=>o.text.includes('relay connected'))).toBe(true);
  const waiting=turn('Ask through MCP',{name:'wait_for_user_message',args:{session_id:session.id,mode:'ask',prompt:'Continue?',request_key:'q',timeout_seconds:15}});
  const deadline=Date.now()+18000;while(!f.store.list('wait').length&&Date.now()<deadline)await sleep(50);await f.broker.tick();const question=f.store.list('wait')[0];expect(question).toBeTruthy();await f.inbound(`/reply ${question.shortId} yes`);await waiting;
  expect(f.store.list('wait')[0].state).toBe('answered');
  await f.inbound('Run inside the original CLI');await f.broker.tick();const job=f.store.list('job')[0];const finish=Date.now()+25000;
  while(f.store.get('job',job.id)?.state!=='completed'&&Date.now()<finish)await sleep(50);await f.broker.tick();
  expect(f.store.get('job',job.id)?.state).toBe('completed');expect(f.im.sent.some(o=>o.purpose==='result'&&o.text.includes('original owner'))).toBe(true);
  expect(owner.processId).toBe(ownerPid);expect((await owner.call('thread/loaded/list',{})).data).toContain(thread.id);
  const status=await f.broker.status(session);expect(status.native).toMatchObject({controlMode:'queue_relay',executionState:'unobserved',status:'owner_online'});
  hold=true;const active=await owner.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'hold for scoped stop'}]});
  await owner.call('thread/goal/set',{threadId:thread.id,objective:'stop test',status:'active'});
  await owner.call('thread/queue/add',{threadId:thread.id,clientUserMessageId:randomUUID(),input:[{type:'text',text:'queued test'}]});
  const stopped=await f.broker.stop(session.id) as any;expect(stopped.complete).toBe(false);expect(stopped.cancelledNativeQueue).toBe(1);expect(stopped.residuals.length).toBeGreaterThan(0);
  expect((await owner.call('thread/goal/get',{threadId:thread.id})).goal).toBeNull();expect((await owner.call('thread/queue/list',{threadId:thread.id})).data).toHaveLength(0);
  await owner.call('turn/interrupt',{threadId:thread.id,turnId:active.turn.id});hold=false;
  await turn('Original terminal continues after integration');
  expect((await owner.call('thread/read',{threadId:thread.id,includeTurns:true})).thread.turns.length).toBeGreaterThan(3);
 }finally{await owner.close();await f.close();await servers.close();model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));}
},90000);
