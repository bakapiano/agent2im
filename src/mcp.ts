import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { toolDefinitions, validateTool } from './core/validation.js';
import { errorBody } from './core/errors.js';
export interface Descriptor { brokerUrl:string; clientId:string; secret:string; runtimeId?:string }
export async function runMcp(readDescriptor:()=>Promise<Descriptor>) {
  const server=new Server({name:'agent-to-im',version:'0.2.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions.map(({name,description,annotations,inputSchema})=>({name,description,annotations,inputSchema:inputSchema as any}))}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    let result:any;
    try {validateTool(request.params.name,request.params.arguments);const d=await readDescriptor();const url=new URL(d.brokerUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Invalid broker endpoint');
      const response=await fetch(`${d.brokerUrl}/rpc/tool`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${d.clientId}:${d.secret}`},body:JSON.stringify({name:request.params.name,args:request.params.arguments,runtime_id:d.runtimeId,attempt_id:randomUUID()}),signal:AbortSignal.any([extra.signal,AbortSignal.timeout(350_000)])});result=await response.json();
    }catch(e){result=errorBody(e);if(result.error.code==='INTERNAL_ERROR')result={ok:false,error:{code:'BROKER_UNAVAILABLE',message:'请检查本机 Broker 和客户端描述文件。',retryable:true}};}
    return {content:[{type:'text',text:JSON.stringify(result)}],isError:!result.ok};
  });await server.connect(new StdioServerTransport());return server;
}
