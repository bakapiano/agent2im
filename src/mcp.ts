import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { toolDefinitions, validateTool } from './core/validation.js';
import { AppError, errorBody } from './core/errors.js';
import { discoverNative } from './adapters/agent/discovery.js';
import { appVersion, buildId } from './core/build.js';
import {ensureBrokerStarted} from './broker-start.js';
import {dirname} from 'node:path';
export interface Descriptor { brokerUrl:string; clientId:string; secret:string }
export async function runMcp(readDescriptor:()=>Promise<Descriptor>,installation?:{descriptorPath:string;cliPath:string}) {
  const server=new Server({name:'agent-to-im',version:`${appVersion}+${buildId}`},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions.map(({name,description,annotations,inputSchema})=>({name,description,annotations,inputSchema:inputSchema as any}))}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    let result:any;
    try {validateTool(request.params.name,request.params.arguments);const d=await readDescriptor();const url=new URL(d.brokerUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Invalid broker endpoint');
      if(installation){let ready=false;try{ready=(await fetch(`${d.brokerUrl}/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{}if(!ready)await ensureBrokerStarted(dirname(installation.descriptorPath),installation.cliPath);}
      const nativeContext=request.params.name==='configure_im_channel'?undefined:await discoverNative(request.params._meta);
      const response=await fetch(`${d.brokerUrl}/rpc/tool`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${d.clientId}:${d.secret}`},body:JSON.stringify({name:request.params.name,args:request.params.arguments,native_context:nativeContext,attempt_id:randomUUID()}),signal:AbortSignal.any([extra.signal,AbortSignal.timeout(350_000)])});result=await response.json();
    }catch(e){result=errorBody(e);}
    return {content:[{type:'text',text:JSON.stringify(result)}],isError:!result.ok};
  });await server.connect(new StdioServerTransport());return server;
}
