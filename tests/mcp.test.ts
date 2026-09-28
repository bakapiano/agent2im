import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture } from './fixture.js';
import { createServers } from '../src/server.js';
import { DpapiProtector } from '../src/credentials/protector.js';
import { sleep } from '../src/core/util.js';
import {createServer} from 'node:http';
it('MCP initialization and tool listing leave Broker startup idle',async()=>{
 let requests=0;const probe=createServer((_,reply)=>{requests++;reply.end('{"ok":true}');});
 await new Promise<void>(done=>probe.listen(0,'127.0.0.1',done));const port=(probe.address() as {port:number}).port;
 mkdirSync('.test-data',{recursive:true});const temp=mkdtempSync(resolve('.test-data/mcp-idle-')),descriptor=join(temp,'client.dpapi');
 writeFileSync(descriptor,await new DpapiProtector().protect(JSON.stringify({brokerUrl:`http://127.0.0.1:${port}`,clientId:'test',secret:'test'})));
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'mcp','--descriptor',descriptor],stderr:'pipe'}),client=new Client({name:'idle-test',version:'1'});
 try{await client.connect(transport);expect((await client.listTools()).tools).toHaveLength(4);expect(requests).toBe(0);}finally{await client.close();await new Promise<void>(done=>probe.close(()=>done()));}
});
it('real MCP stdio sidecar lists four tools and configures channels through authenticated HTTP',async()=>{
  const f=await fixture(':memory:',{portalPort:20643,agentPort:20642});const servers=await createServers(f.broker,'fixture-install','fixture-bootstrap');await servers.listen();const a=await f.connect();
  mkdirSync('.test-data',{recursive:true});const temp=mkdtempSync(resolve('.test-data/mcp-'));const descriptor=join(temp,'client.dpapi');
  writeFileSync(descriptor,await new DpapiProtector().protect(JSON.stringify({brokerUrl:'http://127.0.0.1:20642',clientId:a.caller.clientId,secret:a.caller.secret})));
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'mcp','--descriptor',descriptor],stderr:'pipe'});const client=new Client({name:'test-client',version:'1'});
  try{
    await client.connect(transport);const listed=await client.listTools();expect(listed.tools.map(t=>t.name)).toEqual(['register','send_message_to_user','wait_for_user_message','configure_im_channel']);
    const decode=(r:any)=>JSON.parse(r.content[0].text);
    expect((await client.callTool({name:'register',arguments:a.registerArgs})).isError).toBe(true);
    expect(decode(await client.callTool({name:'configure_im_channel',arguments:{operation:'inspect',provider:'feishu'}}))).toMatchObject({ok:true,data:{provider:'feishu'}});
    const invalid=await client.callTool({name:'register',arguments:{connection_alias:'bad',title:'bad',idempotency_key:'bad',admin:true}});expect(invalid.isError).toBe(true);
  } finally {await client.close();await f.broker.close();await servers.close();f.store.close();}
},30000);
