import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { RuntimeLink, Job } from '../../core/model.js';
import { AppError, ensure } from '../../core/errors.js';
import { digest, now, sleep } from '../../core/util.js';

export interface RuntimeSnapshot { threadId: string; cwd: string; status: string; activeTurns: string[]; activeFlags?: string[]; }
export interface RuntimeNotification { method: string; params: Record<string, any> }
export interface RuntimeWitness { threadId: string; turnId: string; itemId: string }
export interface RuntimeStop { complete: boolean; scope: 'tracked_resources'; interruptedTurns: number; cancelledNativeQueue: number; terminatedTerminals: number; residuals: Array<{ resourceId: string; reason: string }> }
export interface LiveRuntime {
  connect(): Promise<RuntimeSnapshot>;
  inspect(): Promise<RuntimeSnapshot>;
  submit(job: Job): Promise<{ queueId: string }>;
  cancelQueued(queueId: string): Promise<void>;
  stop(): Promise<RuntimeStop>;
  witness(tool: string, args: unknown, attemptId: string): Promise<RuntimeWitness>;
  onEvent(listener: (event: RuntimeNotification) => void): void;
  close(): Promise<void>;
}
export interface RuntimeFactory { create(link: RuntimeLink, authToken?: string): LiveRuntime }

class Rpc {
  socket?: WebSocket;
  private serial = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly events = new EventEmitter();
  constructor(private endpoint: string, private authToken?: string) {}
  async connect() {
    const url = new URL(this.endpoint);
    ensure(url.protocol === 'ws:' && ['127.0.0.1','[::1]'].includes(url.hostname) && !url.username && !url.password, 'RUNTIME_ENDPOINT_INVALID', '首期 App Server 地址须为本机回环 WebSocket。');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint, { headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}, handshakeTimeout: 5000 });
      this.socket = socket;
      socket.once('open', () => resolve()); socket.once('error', () => reject(new AppError('RUNTIME_UNREACHABLE','无法连接 App Server。',503)));
      socket.on('message', buffer => {
        try {
          const message = JSON.parse(String(buffer));
          if (message.id !== undefined && (message.result !== undefined || message.error)) {
            const item = this.pending.get(message.id); if (!item) return; this.pending.delete(message.id); clearTimeout(item.timer);
            if (message.error) item.reject(new AppError('NATIVE_RPC_ERROR', `Codex ${String(message.error.code)}: ${String(message.error.message).slice(0,180)}`, 502)); else item.resolve(message.result);
          } else if (message.method) this.events.emit('notification', message);
        } catch { this.events.emit('protocol-error'); }
      });
      socket.on('close', () => {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AppError('RUNTIME_DISCONNECTED','App Server 已断开。',503)); }
        this.pending.clear(); this.events.emit('notification',{method:'connection/closed',params:{}});
      });
    });
    await this.call('initialize', {clientInfo:{name:'agent_to_im',title:'Agent to IM',version:'0.2.0'},capabilities:{experimentalApi:true}});
    this.socket!.send(JSON.stringify({method:'initialized'}));
  }
  call(method: string, params: unknown = {}, timeout = 10_000): Promise<any> {
    ensure(this.socket?.readyState === WebSocket.OPEN, 'RUNTIME_UNREACHABLE','App Server 未连接。',503);
    const requestId = ++this.serial;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new AppError('NATIVE_RPC_TIMEOUT','原生调用超时，需要核对结果。',504)); },timeout);
      this.pending.set(requestId,{resolve,reject,timer});
      this.socket!.send(JSON.stringify({id:requestId,method,params}), error => {if(error){clearTimeout(timer);this.pending.delete(requestId);reject(error);}});
    });
  }
  async close() { this.socket?.close(); }
}

export class CodexRuntime implements LiveRuntime {
  private rpc: Rpc;
  private ready = false;
  private witnesses: Array<RuntimeWitness & { tool: string; argsDigest: string; at: number; consumed?: string }> = [];
  private attempts = new Map<string, { witness: RuntimeWitness; digest: string; tool: string }>();
  constructor(private link: RuntimeLink, authToken?: string) {
    this.rpc = new Rpc(link.endpoint,authToken);
    this.rpc.events.on('notification',(event: RuntimeNotification) => {
      const p=event.params ?? {}; const item=p.item;
      if(event.method==='item/started' && item?.type==='mcpToolCall' && item.server===link.serverName) {
        this.witnesses.push({threadId:p.threadId,turnId:p.turnId,itemId:item.id,tool:item.tool,argsDigest:digest(item.arguments ?? {}),at:now()});
        this.witnesses=this.witnesses.filter(w=>now()-w.at<60_000).slice(-200);
      }
      if(event.method==='connection/closed') this.ready=false;
    });
  }
  onEvent(listener: (event: RuntimeNotification)=>void) { this.rpc.events.on('notification',listener); }
  async connect() {
    if(!this.ready) {
      await this.rpc.connect();
      let cursor:string|undefined;let found=false;
      do {const loaded=await this.rpc.call('thread/loaded/list',{cursor});found=loaded.data?.includes(this.link.threadId);cursor=loaded.nextCursor??undefined;} while(!found&&cursor);
      ensure(found,'THREAD_CONTEXT_UNVERIFIED','目标 thread 必须已经在该 App Server 中运行。',409);
      try { await this.rpc.call('thread/resume',{threadId:this.link.threadId,excludeTurns:true}); }
      catch {await this.rpc.close();throw new AppError('THREAD_ATTACH_FAILED','请先在原生会话完成首轮持久化，再附着到同一 App Server。',409);}
      this.ready=true;
    }
    return this.inspect();
  }
  async inspect(): Promise<RuntimeSnapshot> {
    const {thread}=await this.rpc.call('thread/read',{threadId:this.link.threadId,includeTurns:true});
    ensure(thread.id===this.link.threadId,'THREAD_CONTEXT_UNVERIFIED','原生 thread 身份发生变化。',409);
    return {threadId:thread.id,cwd:thread.cwd,status:thread.status?.type ?? 'unknown',activeFlags:thread.status?.activeFlags??[],activeTurns:(thread.turns ?? []).filter((t:any)=>t.status==='inProgress').map((t:any)=>t.id)};
  }
  async submit(job: Job) {
    const queued=await this.rpc.call('thread/queue/add',{threadId:this.link.threadId,clientUserMessageId:job.id,input:[{type:'text',text:`[agent-to-im job_id=${job.id}]\nIM 用户任务：\n${job.prompt}`} ]});
    const queueId=queued.queuedSubmission.id;
    const state=await this.inspect();
    if(state.status==='idle') { try { await this.rpc.call('thread/queue/start',{threadId:this.link.threadId,queuedSubmissionId:queueId}); } catch { /* Queue remains observable; never replace with a steering call. */ } }
    return {queueId};
  }
  async cancelQueued(queueId: string) { await this.rpc.call('thread/queue/delete',{threadId:this.link.threadId,queuedSubmissionId:queueId}); }
  async witness(tool: string,args: unknown,attemptId: string): Promise<RuntimeWitness> {
    const argsDigest=digest(args);const replay=this.attempts.get(attemptId);
    if(replay){ensure(replay.digest===argsDigest&&replay.tool===tool,'THREAD_CONTEXT_UNVERIFIED','调用凭证只能重放同一工具和参数。',403);return replay.witness;}
    const deadline=now()+3000;
    while(now()<deadline) {
      const found=this.witnesses.find(w=>!w.consumed && w.threadId===this.link.threadId && w.tool===tool && w.argsDigest===argsDigest && now()-w.at<20_000);
      if(found) {found.consumed=attemptId;this.attempts.set(attemptId,{witness:found,digest:argsDigest,tool});if(this.attempts.size>500)this.attempts.delete(this.attempts.keys().next().value!);return found;}
      await sleep(25);
    }
    throw new AppError('THREAD_CONTEXT_UNVERIFIED','未观察到该真实 thread 发起对应 MCP 调用，请核对当前会话的 runtime 绑定。',403);
  }
  async stop(): Promise<RuntimeStop> {
    const report: RuntimeStop={complete:false,scope:'tracked_resources',interruptedTurns:0,cancelledNativeQueue:0,terminatedTerminals:0,residuals:[]};
    const threadIds=[this.link.threadId]; const threads=new Map<string,any>();
    try {
      let cursor: string|undefined;
      do {const page=await this.rpc.call('thread/loaded/list',{cursor});for(const threadId of page.data ?? []){const r=await this.rpc.call('thread/read',{threadId,includeTurns:true});threads.set(threadId,r.thread);}cursor=page.nextCursor ?? undefined;}while(cursor);
      let added=true;while(added){added=false;for(const [threadId,t]of threads){if(t.parentThreadId && threadIds.includes(t.parentThreadId) && !threadIds.includes(threadId)){threadIds.push(threadId);added=true;}}}
    } catch { report.residuals.push({resourceId:'native-thread-inventory',reason:'任务树枚举未完成'}); }
    for(const threadId of threadIds.reverse()) {
      try {let cursor:string|undefined;do{const p=await this.rpc.call('thread/queue/list',{threadId,cursor,limit:100});for(const q of p.data ?? []){await this.rpc.call('thread/queue/delete',{threadId,queuedSubmissionId:q.id});report.cancelledNativeQueue++;}cursor=p.nextCursor ?? undefined;}while(cursor);}catch{report.residuals.push({resourceId:`queue:${threadId}`,reason:'原生队列清理未确认'});}
      try { await this.rpc.call('thread/goal/clear',{threadId}); } catch { report.residuals.push({resourceId:`goal:${threadId}`,reason:'持续目标取消未确认'}); }
      try {const {thread}=await this.rpc.call('thread/read',{threadId,includeTurns:true});for(const turn of thread.turns ?? [])if(turn.status==='inProgress'){await this.rpc.call('turn/interrupt',{threadId,turnId:turn.id});report.interruptedTurns++;}}catch{report.residuals.push({resourceId:`turn:${threadId}`,reason:'运行中 turn 取消未确认'});}
      try {let cursor:string|undefined;do{const p=await this.rpc.call('thread/backgroundTerminals/list',{threadId,cursor});for(const t of p.data ?? []){await this.rpc.call('thread/backgroundTerminals/terminate',{threadId,processId:t.processId});report.terminatedTerminals++;}cursor=p.nextCursor ?? undefined;}while(cursor);}catch{report.residuals.push({resourceId:`terminals:${threadId}`,reason:'后台 terminal 清理未确认'});}
    }
    const deadline=now()+5000;
    while(now()<deadline) {
      let busy=false;
      for(const threadId of threadIds) {try{const {thread}=await this.rpc.call('thread/read',{threadId,includeTurns:true});if(thread.status?.type==='active')busy=true;}catch{busy=true;}}
      if(!busy)break; await sleep(100);
    }
    for(const threadId of threadIds) {try{const {thread}=await this.rpc.call('thread/read',{threadId,includeTurns:true});if(thread.status?.type==='active')report.residuals.push({resourceId:threadId,reason:'原生线程仍在运行'});const q=await this.rpc.call('thread/queue/list',{threadId});const b=await this.rpc.call('thread/backgroundTerminals/list',{threadId});if(q.data?.length || b.data?.length)report.residuals.push({resourceId:threadId,reason:'仍存在排队或后台资源'});}catch{report.residuals.push({resourceId:threadId,reason:'停止后核对失败'});}}
    // Detect descendants born while cancellation was in flight. A subsequent stop
    // can act on them; until then the Broker keeps its dispatch fence closed.
    try {
      const after=new Map<string,any>();let cursor:string|undefined;
      do{const page=await this.rpc.call('thread/loaded/list',{cursor});for(const threadId of page.data??[]){const r=await this.rpc.call('thread/read',{threadId,includeTurns:false});after.set(threadId,r.thread);}cursor=page.nextCursor??undefined;}while(cursor);
      const descendants=new Set([this.link.threadId]);let changed=true;
      while(changed){changed=false;for(const [threadId,t] of after)if(t.parentThreadId&&descendants.has(t.parentThreadId)&&!descendants.has(threadId)){descendants.add(threadId);changed=true;}}
      for(const threadId of descendants)if(!threadIds.includes(threadId))report.residuals.push({resourceId:threadId,reason:'停止期间出现新的子会话，需要再次停止核对'});
    }catch{report.residuals.push({resourceId:'post-stop-inventory',reason:'停止后的任务树核对未完成'});}
    for(const threadId of threadIds){try{const result=await this.rpc.call('thread/goal/get',{threadId});if(result.goal)report.residuals.push({resourceId:`goal:${threadId}`,reason:'停止后仍存在原生持续目标'});}catch{report.residuals.push({resourceId:`goal:${threadId}`,reason:'停止后的持续目标核对失败'});}}
    report.complete=report.residuals.length===0;return report;
  }
  async close() { await this.rpc.close();this.ready=false; }
}
export class CodexRuntimeFactory implements RuntimeFactory { create(link: RuntimeLink,authToken?:string){return new CodexRuntime(link,authToken);} }
