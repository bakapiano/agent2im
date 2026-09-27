import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from './db/store.js';
import { DpapiProtector } from './credentials/protector.js';
import { Vault } from './credentials/vault.js';
import { Broker } from './broker.js';
import { FeishuFactory } from './adapters/im/feishu.js';
import { CodexRuntimeFactory } from './adapters/agent/runtime.js';
import { createServers } from './server.js';
import { runMcp, type Descriptor } from './mcp.js';
import { token } from './core/util.js';
import { ensure, errorBody } from './core/errors.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},workspace:{type:'string',multiple:true},'portal-port':{type:'string'},'agent-port':{type:'string'},descriptor:{type:'string'},name:{type:'string'},endpoint:{type:'string'},thread:{type:'string'},home:{type:'string'},cwd:{type:'string'},'workspace-alias':{type:'string'},'server-name':{type:'string'},'credential-ref':{type:'string'}}});
const command=positionals[0]??'help';const dataDir=resolve(values['data-dir']??join(process.env.LOCALAPPDATA??process.cwd(),'agent-to-im'));
const protector=new DpapiProtector();const settingsFile=join(dataDir,'settings.json');
function restrict(path:string) {
  if(process.platform==='win32'){const result=spawnSync('icacls.exe',[path,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{windowsHide:true,stdio:'pipe'});ensure(result.status===0,'ACL_FAILED','数据目录权限设置失败。');}
}
async function protectedWrite(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,await protector.protect(JSON.stringify(value)),{mode:0o600});}
async function protectedRead<T>(path:string):Promise<T>{return JSON.parse(await protector.unprotect(readFileSync(path,'utf8')));}
async function main() {
  if(command==='help'){console.log('agent-to-im serve --workspace alias=D:\\project\nagent-to-im enroll --name codex --descriptor <file>\nagent-to-im attach --descriptor <file> --endpoint ws://127.0.0.1:PORT --thread <ID> --home <Codex-home> --cwd <workspace> --workspace-alias <alias>\nagent-to-im mcp --descriptor <file>\nagent-to-im doctor\n公共参数：--data-dir <dir>');return;}
  if(command==='mcp'){ensure(values.descriptor,'DESCRIPTOR_REQUIRED','请指定 --descriptor。');const path=resolve(values.descriptor);await runMcp(()=>protectedRead<Descriptor>(path));return;}
  if(command==='serve'){
    mkdirSync(dataDir,{recursive:true,mode:0o700});restrict(dataDir);
    const saved=existsSync(settingsFile)?JSON.parse(readFileSync(settingsFile,'utf8')):{};
    const workspaces:Record<string,string>={...saved.workspaces};for(const item of values.workspace??[]){const index=item.indexOf('=');ensure(index>0,'WORKSPACE_INVALID','使用 --workspace alias=absolute-path');const alias=item.slice(0,index);ensure(/^[\w-]+$/.test(alias),'WORKSPACE_INVALID','工作区别名格式无效。');workspaces[alias]=resolve(item.slice(index+1));}
    const settings={workspaces,portalPort:Number(values['portal-port']??saved.portalPort??17643),agentPort:Number(values['agent-port']??saved.agentPort??17642)};
    ensure(Object.keys(workspaces).length,'WORKSPACE_REQUIRED','首次启动请指定 --workspace alias=path。');
    for(const p of [settings.portalPort,settings.agentPort])ensure(Number.isInteger(p)&&p>=1024&&p<=65535,'PORT_INVALID','端口范围为 1024–65535。');ensure(settings.portalPort!==settings.agentPort,'PORT_INVALID','两个受众使用独立端口。');
    writeFileSync(settingsFile,JSON.stringify(settings,null,2),{mode:0o600});
    const installFile=join(dataDir,'installation.dpapi');if(!existsSync(installFile))await protectedWrite(installFile,{secret:token()});const installation=await protectedRead<{secret:string}>(installFile);
    const bootstrap=token();const store=new Store(join(dataDir,'broker.sqlite'));const vault=new Vault(store,protector);
    const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
    const broker=new Broker(store,vault,{...settings,dataDir,portalHost:'127.0.0.1',webRoot:join(projectRoot,'dist','web')},new FeishuFactory(),new CodexRuntimeFactory());
    const servers=await createServers(broker,installation.secret,bootstrap);await servers.listen();await broker.start();
    console.log(`Portal: http://127.0.0.1:${settings.portalPort}\nAgent RPC: http://127.0.0.1:${settings.agentPort}`);if(!store.setting('adminPassword'))console.log(`首次设置令牌（仅本次进程有效）：${bootstrap}`);
    let closing=false;const close=async()=>{if(closing)return;closing=true;await broker.close();await servers.close();store.close();};process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());return;
  }
  ensure(existsSync(settingsFile),'SETUP_REQUIRED','请先运行 serve 初始化本地服务。');const settings=JSON.parse(readFileSync(settingsFile,'utf8'));const brokerUrl=`http://127.0.0.1:${settings.agentPort}`;
  if(command==='doctor'){const response=await fetch(`${brokerUrl}/health`,{signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({node:process.version,dataDir,broker:await response.json(),portal:`http://127.0.0.1:${settings.portalPort}`}));return;}
  const installation=await protectedRead<{secret:string}>(join(dataDir,'installation.dpapi'));
  const post=async(path:string,data:unknown)=>{const r=await fetch(`${brokerUrl}${path}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${installation.secret}`},body:JSON.stringify(data)});const b=await r.json() as any;ensure(b.ok,b.error?.code??'RPC_FAILED',b.error?.message??'操作失败');return b.data;};
  ensure(values.descriptor,'DESCRIPTOR_REQUIRED','请指定 --descriptor 保护文件路径。');const descriptorPath=resolve(values.descriptor);
  if(command==='enroll'){ensure(!existsSync(descriptorPath),'DESCRIPTOR_EXISTS','描述文件已存在，请选择新文件名。');const result=await post('/local/enroll',{name:values.name??'Codex CLI'});await protectedWrite(descriptorPath,{brokerUrl,clientId:result.client_id,secret:result.secret});console.log(`客户端已登记；保护文件：${descriptorPath}`);return;}
  if(command==='attach'){const d=await protectedRead<Descriptor>(descriptorPath);ensure(values.endpoint&&values.thread&&values.home&&values.cwd&&values['workspace-alias'],'ATTACH_ARGUMENTS_REQUIRED','attach 需要 endpoint/thread/home/cwd/workspace-alias。');const result=await post('/local/attach',{client_id:d.clientId,endpoint:values.endpoint,thread_id:values.thread,home_id:resolve(values.home),cwd:resolve(values.cwd),workspace:values['workspace-alias'],server_name:values['server-name']??'agent-to-im',credential_ref:values['credential-ref']});await protectedWrite(descriptorPath,{...d,runtimeId:result.runtime_id});console.log(JSON.stringify(result));return;}
  throw new Error('未知命令，请运行 help。');
}
main().catch(error=>{console.error(JSON.stringify(errorBody(error)));process.exitCode=1;});
