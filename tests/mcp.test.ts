import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture } from './fixture.js';
import { createServers } from '../src/server.js';
import { DpapiProtector } from '../src/credentials/protector.js';
import { sleep } from '../src/core/util.js';
it('real MCP stdio sidecar calls all four public tools through authenticated HTTP',async()=>{
  const f=await fixture(':memory:',{portalPort:20643,agentPort:20642});const servers=await createServers(f.broker,'fixture-install','fixture-bootstrap');await servers.listen();const a=await f.connect();
  mkdirSync('.test-data',{recursive:true});const temp=mkdtempSync(resolve('.test-data/mcp-'));const descriptor=join(temp,'client.dpapi');
  writeFileSync(descriptor,await new DpapiProtector().protect(JSON.stringify({brokerUrl:'http://127.0.0.1:20642',clientId:a.caller.clientId,secret:a.caller.secret,runtimeId:a.caller.runtimeId})));
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'mcp','--descriptor',descriptor],stderr:'pipe'});const client=new Client({name:'test-client',version:'1'});
  try{
    await client.connect(transport);const listed=await client.listTools();expect(listed.tools.map(t=>t.name)).toEqual(['register','send_message_to_user','wait_for_user_message','configure_im_channel']);
    const decode=(r:any)=>JSON.parse(r.content[0].text);
    expect(decode(await client.callTool({name:'register',arguments:a.registerArgs}))).toMatchObject({ok:true,data:{session_id:a.session.id}});
    expect(decode(await client.callTool({name:'configure_im_channel',arguments:{operation:'inspect',provider:'feishu'}}))).toMatchObject({ok:true,data:{provider:'feishu'}});
    expect(decode(await client.callTool({name:'send_message_to_user',arguments:{session_id:a.session.id,text:'MCP outbound',idempotency_key:'mcp-out'}}))).toMatchObject({ok:true,data:{delivery_status:'queued'}});
    const waiting=client.callTool({name:'wait_for_user_message',arguments:{session_id:a.session.id,mode:'ask',prompt:'MCP question',request_key:'mcp-q',timeout_seconds:3}});
    const deadline=Date.now()+2000;while(!f.store.list('wait').length&&Date.now()<deadline)await sleep(30);await f.broker.tick();const q=f.store.list('wait')[0];expect(q).toBeTruthy();await f.inbound(`/reply ${q.shortId} MCP answer`);
    expect(decode(await waiting)).toMatchObject({ok:true,data:{status:'answered',reply:{text:'MCP answer'}}});
    const invalid=await client.callTool({name:'register',arguments:{connection_alias:'bad',title:'bad',idempotency_key:'bad',admin:true}});expect(invalid.isError).toBe(true);
  } finally {await client.close();await f.broker.close();await servers.close();f.store.close();}
},30000);
