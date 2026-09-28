import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename,join,resolve } from 'node:path';
import { homedir } from 'node:os';
import { ensure } from '../../core/errors.js';

export interface HostIdentity {pid:number;createdAt:string;executable:string}
export interface HostProcess extends HostIdentity {parentPid:number;commandLine:string}
export interface NativeContext {threadId:string;homeId:string;owner:HostIdentity}
const execute=promisify(execFile);
export async function parentProcesses(parentPid=process.ppid):Promise<HostProcess[]> {
 const script='$n=[int]$env:AGENT_IM_PARENT_PID;$seen=@{};$items=@();for($i=0;$i -lt 8 -and $n -gt 0;$i++){if($seen.ContainsKey($n)){break};$seen[$n]=$true;$p=Get-CimInstance Win32_Process -Filter "ProcessId=$n" -ErrorAction Stop;if(!$p){break};$items+=@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;executable=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString("o")};$n=[int]$p.ParentProcessId};ConvertTo-Json -InputObject @($items) -Compress';
 const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,env:{...process.env,AGENT_IM_PARENT_PID:String(parentPid)}});
 return JSON.parse(r.stdout);
}
export function nativeThreadId(meta:Record<string,unknown>|undefined):string {
 const threadId=meta?.threadId;
 ensure(typeof threadId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threadId),'THREAD_CONTEXT_UNVERIFIED','当前 MCP 调用需要宿主提供 threadId。',403);
 return threadId;
}
export async function ownerAlive(owner:HostIdentity):Promise<boolean> {
 const script='$p=Get-CimInstance Win32_Process -Filter "ProcessId=$env:AGENT_IM_OWNER_PID" -ErrorAction Stop;if(!$p){[Console]::Out.Write("null")}else{ConvertTo-Json -Compress @{createdAt=$p.CreationDate.ToUniversalTime().ToString("o");executable=[string]$p.ExecutablePath}}';
 const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,env:{...process.env,AGENT_IM_OWNER_PID:String(owner.pid)}});
 const p=JSON.parse(r.stdout);return !!p&&p.createdAt===owner.createdAt&&resolve(p.executable).toLowerCase()===resolve(owner.executable).toLowerCase();
}
export function findCodexExecutable():string {
 const file=join(process.env.APPDATA??'','npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
 ensure(existsSync(file),'CODEX_EXECUTABLE_MISSING','需要本机安装的 Codex CLI。');return file;
}
let host:Promise<HostIdentity>|undefined;
export async function discoverNative(meta:Record<string,unknown>|undefined):Promise<NativeContext> {
 const threadId=nativeThreadId(meta);
 host??=parentProcesses().then(parents=>{const p=parents.find(p=>/^codex(?:\.exe)?$/i.test(basename(p.executable)));ensure(p?.createdAt,'THREAD_CONTEXT_UNVERIFIED','需要可核验的 Codex 宿主进程。',403);return {pid:p.pid,createdAt:p.createdAt,executable:p.executable};});
 return {threadId,homeId:resolve(process.env.CODEX_HOME??join(homedir(),'.codex')),owner:await host};
}
