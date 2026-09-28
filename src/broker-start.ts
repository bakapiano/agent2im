import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { closeSync, openSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { AppError, ensure } from './core/errors.js';
import { sleep } from './core/util.js';

async function healthy(port:number){try{return (await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}}
export async function ensureBrokerStarted(dataDir:string,cliPath:string):Promise<{started:boolean}>{
 const settings=JSON.parse(readFileSync(join(dataDir,'settings.json'),'utf8'));const port=settings.agentPort;
 ensure(Number.isInteger(port)&&port>=1024&&port<=65535,'PORT_INVALID','本地 Broker 配置端口无效。');
 if(await healthy(port))return {started:false};
 const lockPath=join(dataDir,'broker-start.lock');let lock:number|undefined;
 try{lock=openSync(lockPath,'wx',0o600);writeFileSync(lock,JSON.stringify({pid:process.pid,at:Date.now()}));}
 catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   let owner:{pid:number;at:number}|undefined;try{owner=JSON.parse(readFileSync(lockPath,'utf8'));}catch{}
   let alive=true;if(owner&&Number.isInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(e){alive=(e as NodeJS.ErrnoException).code!=='ESRCH';}
   if(owner&&!alive){unlinkSync(lockPath);return ensureBrokerStarted(dataDir,cliPath);}
   const deadline=Date.now()+15000;while(Date.now()<deadline){if(await healthy(port))return {started:false};await sleep(100);}
   throw new AppError('BROKER_START_BUSY','已有启动操作尚未完成，请查看本地诊断。');
 }
 try{
   if(await healthy(port))return {started:false};
   const out=openSync(join(dataDir,'broker.stdout.log'),'a',0o600),err=openSync(join(dataDir,'broker.stderr.log'),'a',0o600);
   let startupError:unknown;let child;
   try{child=spawn(process.execPath,[cliPath,'serve','--data-dir',dataDir],{cwd:dataDir,detached:true,windowsHide:true,stdio:['ignore',out,err]});child.on('error',error=>{startupError=error;});child.unref();}
   finally{closeSync(out);closeSync(err);}
   const deadline=Date.now()+15000;
   while(Date.now()<deadline){if(await healthy(port))return {started:true};if(startupError||child?.exitCode!==null)break;await sleep(100);}
   throw new AppError('BROKER_START_FAILED','本地 Broker 自动启动失败，请查看 .local/broker.stderr.log。');
 }finally{if(lock!==undefined)closeSync(lock);if(existsSync(lockPath))unlinkSync(lockPath);}
}
