import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Broker, Caller } from './broker.js';
import { AppError, ensure, errorBody } from './core/errors.js';
import { hash, now, sameSecret, token } from './core/util.js';
import { validateTool } from './core/validation.js';
import type { Resources, Scope } from './core/model.js';
const scrypt=promisify(scryptCallback);
const ajv=new Ajv2020({strict:false});
const string={type:'string',minLength:1,maxLength:16384};
const schemas:Record<string,any>={
  bootstrap:{password:{type:'string',minLength:12,maxLength:1024},bootstrap_token:string}, login:{password:{type:'string',minLength:1,maxLength:1024}},
  credential:{secret:string,purpose:{enum:['feishu','codex']}},
  enroll:{name:{type:'string',minLength:1,maxLength:120}},
  attach:{client_id:string,endpoint:string,thread_id:string,home_id:string,cwd:string,workspace:string,server_name:string,credential_ref:string},
  decision:{revision:{type:'integer',minimum:1},scopes:{type:'array',items:{type:'string'},minItems:1},resources:{type:'object',additionalProperties:false,required:['conversations','workspaces','sessions','futureSessions'],properties:{conversations:{type:'array',items:string},workspaces:{type:'array',items:string},sessions:{type:'array',items:string},futureSessions:{type:'boolean'}}}},
  revision:{revision:{type:'integer',minimum:1}}, tool:{name:string,args:{type:'object'},runtime_id:string,attempt_id:string},
};
function body(request:FastifyRequest,name:string,optional:string[]=[]):any {
  const properties=schemas[name];const validate=ajv.compile({type:'object',additionalProperties:false,properties,required:Object.keys(properties).filter(k=>!optional.includes(k))});
  ensure(validate(request.body),'INVALID_ARGUMENTS','请求参数无效。');return request.body;
}
function base(port:number):FastifyInstance {
  const app=Fastify({logger:false,bodyLimit:32_768,requestTimeout:370_000});
  app.setErrorHandler((error,request,reply)=>{const status=error instanceof AppError?error.status:(error as any).statusCode??500;reply.code(status).send(errorBody(error));});
  app.addHook('onRequest',async(request,reply)=>{
    ensure(request.headers.host===`127.0.0.1:${port}`,'HOST_FORBIDDEN','请通过本机回环地址访问。',403);
    const origin=request.headers.origin;ensure(!origin||origin===`http://127.0.0.1:${port}`,'ORIGIN_FORBIDDEN','请求来源无效。',403);
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });return app;
}
export async function createServers(broker:Broker,installationSecret:string,bootstrapToken:string) {
  const {store,config}=broker;const portal=base(config.portalPort);const agent=base(config.agentPort);
  await portal.register(cookie);
  const attempts=new Map<string,{count:number,until:number}>();
  function rate(key:string,limit=10){let row=attempts.get(key);if(!row||row.until<now()){row={count:0,until:now()+60_000};attempts.set(key,row);}ensure(++row.count<=limit,'RATE_LIMITED','操作频繁，请稍后重试。',429);}
  function admin(request:FastifyRequest,mutation=false) {
    const sid=(request as any).cookies?.ati_admin;const session=typeof sid==='string'?store.get('adminSession',hash(sid)):undefined;
    ensure(session&&session.expiresAt>now(),'ADMIN_UNAUTHORIZED','请登录本地管理端。',401);
    if(mutation)ensure(request.headers.origin===`http://127.0.0.1:${config.portalPort}`&&typeof request.headers['x-csrf-token']==='string'&&sameSecret(request.headers['x-csrf-token'],session.csrf),'CSRF_FORBIDDEN','请刷新页面后重试。',403);
    return session;
  }
  function authOrigin(request:FastifyRequest){ensure(request.headers.origin===`http://127.0.0.1:${config.portalPort}`,'ORIGIN_FORBIDDEN','请从本地管理页面提交。',403);rate('login');}
  async function passwordHash(password:string,salt:string){return (await scrypt(password,salt,64) as Buffer).toString('hex');}
  async function signIn(reply:any){const secret=token();const session={id:hash(secret),csrf:token(),createdAt:now(),expiresAt:now()+8*3600_000};store.put('adminSession',session);reply.setCookie('ati_admin',secret,{httpOnly:true,sameSite:'strict',path:'/',maxAge:8*3600});return {ok:true,data:{csrf:session.csrf}};}
  portal.get('/api/auth',async request=>{const configured=!!store.setting('adminPassword');try{const session=admin(request);return {ok:true,data:{configured,authenticated:true,csrf:session.csrf}};}catch{return {ok:true,data:{configured,authenticated:false}};}});
  portal.post('/api/bootstrap',async(request,reply)=>{
    authOrigin(request);const b=body(request,'bootstrap');ensure(!store.setting('adminPassword'),'ADMIN_CONFIGURED','管理员已配置。',409);ensure(sameSecret(b.bootstrap_token,bootstrapToken),'BOOTSTRAP_UNAUTHORIZED','初始设置令牌无效。',403);
    const salt=randomBytes(16).toString('hex');const derived=await passwordHash(b.password,salt);
    // Compare again after asynchronous KDF to ensure one administrator wins.
    ensure(!store.setting('adminPassword'),'ADMIN_CONFIGURED','管理员已配置。',409);store.setSetting('adminPassword',{salt,hash:derived});store.audit('admin.initialized','web-admin','local');return signIn(reply);
  });
  portal.post('/api/login',async(request,reply)=>{authOrigin(request);const b=body(request,'login');const saved=store.setting<{salt:string;hash:string}>('adminPassword');ensure(saved&&sameSecret(await passwordHash(b.password,saved.salt),saved.hash),'LOGIN_FAILED','管理员凭据无效。',401);return signIn(reply);});
  portal.post('/api/logout',async(request,reply)=>{const s=admin(request,true);store.remove('adminSession',s.id);reply.clearCookie('ati_admin',{path:'/'});return {ok:true};});
  portal.get('/api/state',async request=>{admin(request);return {ok:true,data:{channels:broker.channels.list(),requests:store.list('request'),grants:store.list('grant'),conversations:store.list('conversation'),sessions:store.list('session'),workspaces:config.workspaces,audit:store.auditList(),runtime_links:store.list('runtime').map(r=>({id:r.id,clientId:r.clientId,threadId:r.threadId,workspace:r.workspace,connected:broker.runtimes.has(r.id)}))}};});
  portal.post('/api/credentials',async request=>{admin(request,true);rate('credential',30);const b=body(request,'credential');const ref=await broker.vault.save(b.secret,b.purpose);store.audit('credential.saved','web-admin',ref,{purpose:b.purpose});return {ok:true,data:{credential_ref:ref}};});
  portal.post('/api/channels',async request=>{admin(request,true);validateTool('configure_im_channel',request.body);return {ok:true,data:await broker.channels.execute(request.body as any)};});
  portal.post<{Params:{id:string}}>('/api/requests/:id/approve',async request=>{admin(request,true);const b=body(request,'decision');return {ok:true,data:broker.policy.approve(request.params.id,b.revision,b.scopes as Scope[],b.resources as Resources)};});
  portal.post<{Params:{id:string}}>('/api/requests/:id/deny',async request=>{admin(request,true);const b=body(request,'revision');broker.policy.deny(request.params.id,b.revision);return {ok:true};});
  portal.post<{Params:{id:string}}>('/api/grants/:id/revoke',async request=>{admin(request,true);const b=body(request,'revision');broker.policy.revoke(request.params.id,b.revision);return {ok:true};});
  portal.get<{Params:{id:string}}>('/api/sessions/:id',async request=>{admin(request);const s=store.get('session',request.params.id);ensure(s,'SESSION_NOT_FOUND','会话不存在。',404);return {ok:true,data:await broker.status(s)};});
  if(existsSync(join(config.webRoot,'index.html'))) {await portal.register(staticFiles,{root:config.webRoot});portal.get('/',async(_,reply)=>reply.sendFile('index.html'));}
  else portal.get('/',async()=>({message:'请运行 pnpm build 生成 Web Portal。'}));
  function local(request:FastifyRequest){ensure(!request.headers.origin&&typeof request.headers.authorization==='string'&&sameSecret(request.headers.authorization,`Bearer ${installationSecret}`),'INSTALLATION_UNAUTHORIZED','本地安装身份无效。',401);}
  agent.get('/health',async()=>({ok:true,version:'0.2.0'}));
  agent.post('/local/enroll',async request=>{local(request);const b=body(request,'enroll');return {ok:true,data:broker.enroll(b.name,'local-os-user')};});
  agent.post('/local/attach',async request=>{local(request);const b=body(request,'attach',['credential_ref']);return {ok:true,data:await broker.attach(b.client_id,{endpoint:b.endpoint,threadId:b.thread_id,homeId:b.home_id,cwd:b.cwd,workspace:b.workspace,serverName:b.server_name,credentialRef:b.credential_ref})};});
  agent.post('/rpc/tool',async(request,reply)=>{
    ensure(!request.headers.origin,'AGENT_AUDIENCE_ONLY','Agent RPC 使用本地进程身份。',403);rate('rpc',600);
    const b=body(request,'tool',['runtime_id']);const authorization=request.headers.authorization??'';const split=authorization.match(/^Bearer ([^:]+):(.+)$/);ensure(split,'CLIENT_UNAUTHORIZED','客户端凭据缺失。',401);
    const caller:Caller={clientId:split[1],secret:split[2],runtimeId:b.runtime_id,attemptId:b.attempt_id};const controller=new AbortController();const onClose=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.on('close',onClose);
    try{return {ok:true,data:await broker.tool(b.name,b.args,caller,controller.signal)};}finally{reply.raw.off('close',onClose);}
  });
  return {portal,agent,async listen(){await portal.listen({host:'127.0.0.1',port:config.portalPort});try{await agent.listen({host:'127.0.0.1',port:config.agentPort});}catch(e){await portal.close();throw e;}},async close(){await Promise.all([portal.close(),agent.close()]);}};
}
