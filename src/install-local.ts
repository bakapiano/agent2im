import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensure } from './core/errors.js';
import { findCodexExecutable } from './adapters/agent/discovery.js';
export interface LocalInstallation {buildId:string;cliPath:string;nodePath:string;descriptor:string;dataDir:string;nativeExecutable:string;projectRoot:string;}

const sha=(content:Buffer|string)=>createHash('sha256').update(content).digest('hex');
function atomic(path:string,content:string){mkdirSync(dirname(path),{recursive:true});const temp=`${path}.${randomUUID()}.tmp`;writeFileSync(temp,content,{mode:0o600});renameSync(temp,path);}
export function renderMcpConfig(text:string,install:LocalInstallation):string {
  const nl=text.includes('\r\n')?'\r\n':'\n';
  const lines=text.split(/\r?\n/);const matches=lines.map((line,index)=>/^\s*\[mcp_servers\.(?:agent-to-im|"agent-to-im"|'agent-to-im')\]\s*(?:#.*)?$/.test(line)?index:-1).filter(i=>i>=0);
  ensure(matches.length<2,'CONFIG_AMBIGUOUS','MCP 配置包含重复 server 节，请先核对。');
  const values:Record<string,string>={command:JSON.stringify(install.nodePath),args:JSON.stringify([install.cliPath,'mcp','--descriptor',install.descriptor]),startup_timeout_sec:'15',tool_timeout_sec:'360'};
  if(!matches.length)return text.replace(/\s*$/,'')+nl+nl+'[mcp_servers.agent-to-im]'+nl+Object.entries(values).map(([key,value])=>`${key} = ${value}`).join(nl)+nl+'required = false'+nl+'env_vars = ["CODEX_HOME"]'+nl;
  const start=matches[0]+1;let end=start;while(end<lines.length&&!/^\s*\[/.test(lines[end]))end++;
  const section=lines.slice(start,end);
  const envIndex=section.findIndex(line=>/^\s*env_vars\s*=/.test(line));
  if(envIndex===-1)section.push('env_vars = ["CODEX_HOME"]');
  else{
    const match=section[envIndex].match(/^(\s*env_vars\s*=\s*)\[([^\]]*)\](\s*(?:#.*)?)$/);
    ensure(match,'CONFIG_MULTILINE_UNSUPPORTED','请将本项目 env_vars 配置为单行数组后重试安装。');
    if(!/(?:"CODEX_HOME"|'CODEX_HOME')/.test(match[2]))section[envIndex]=`${match[1]}[${match[2].trim()}${match[2].trim()?', ':''}"CODEX_HOME"]${match[3]}`;
  }
  for(const [key,value]of Object.entries(values)){
    const indexes=section.map((line,index)=>new RegExp(`^\\s*${key}\\s*=`).test(line)?index:-1).filter(i=>i>=0);
    ensure(indexes.length<2,'CONFIG_AMBIGUOUS',`MCP 配置 ${key} 重复。`);
    if(indexes.length){const i=indexes[0];ensure(!/\[\s*$/.test(section[i]),'CONFIG_MULTILINE_UNSUPPORTED','请将本项目 MCP 的 args 配置为单行数组后重试安装。');section[i]=`${key} = ${value}`;}else section.push(`${key} = ${value}`);
  }
  return [...lines.slice(0,start),...section,...lines.slice(end)].join(nl);
}
interface BackupEntry{path:string;beforeSha?:string;afterSha:string;backup?:string;}
export interface InstallOptions{projectRoot:string;dataDir:string;codexHome:string;nodePath?:string;nativeExecutable?:string;}
function within(root:string,path:string){const rel=relative(resolve(root),resolve(path));return !rel.startsWith('..')&&!isAbsolute(rel);}
export function installLocal(options:InstallOptions){
  const projectRoot=resolve(options.projectRoot),dataDir=resolve(options.dataDir),codexHome=resolve(options.codexHome);
  const build=JSON.parse(readFileSync(join(projectRoot,'dist/build.json'),'utf8'));ensure(/^[a-f0-9]{16}$/.test(build.buildId),'BUILD_INVALID','请先构建当前项目。');
  const compiled=readFileSync(join(projectRoot,'dist/cli.js'));ensure(sha(compiled)===build.cliSha256,'BUILD_INVALID','构建文件与校验记录不一致。');
  const release=join(dataDir,'releases',build.buildId);const cliPath=join(release,'dist/cli.js');
  const install:LocalInstallation={buildId:build.buildId,cliPath,nodePath:options.nodePath??process.execPath,descriptor:join(dataDir,'client-a.dpapi'),dataDir,nativeExecutable:options.nativeExecutable??findCodexExecutable(),projectRoot};
  ensure(existsSync(install.descriptor)&&existsSync(install.nativeExecutable),'INSTALL_PREREQUISITE','安装需要本地客户端身份和 Codex CLI。');
  const configPath=join(codexHome,'config.toml');const original=existsSync(configPath)?readFileSync(configPath,'utf8'):'';
  const manifest=join(dataDir,'active-install.json');
  const changes:Array<{path:string;content:string}>=[{path:configPath,content:renderMcpConfig(original,install)}];
  for(const name of ['connect-to-im','configure-im-channel'])for(const relative of ['SKILL.md','agents/openai.yaml']){
    changes.push({path:join(codexHome,'skills',name,relative),content:readFileSync(join(projectRoot,'skills',name,relative),'utf8')});
  }
  // Switch the routing manifest last; existing processes keep their immutable build.
  changes.push({path:manifest,content:JSON.stringify(install,null,2)});
  for(const change of changes)ensure(within(codexHome,change.path)||within(dataDir,change.path),'INSTALL_PATH_INVALID','安装目标路径无效。');
  if(existsSync(release)){ensure(existsSync(cliPath)&&sha(readFileSync(cliPath))===build.cliSha256,'RELEASE_CONFLICT','已有发布目录与构建校验不一致。');}
  else{
    mkdirSync(release,{recursive:true});for(const dir of ['dist','skills'])cpSync(join(projectRoot,dir),join(release,dir),{recursive:true});
    // ESM module identity plus dependency resolution through the project parent.
    writeFileSync(join(release,'package.json'),JSON.stringify({name:'agent-to-im-local-release',type:'module',private:true}));
    symlinkSync(join(projectRoot,'node_modules'),join(release,'node_modules'),process.platform==='win32'?'junction':'dir');
  }
  const changed=changes.filter(c=>!existsSync(c.path)||readFileSync(c.path,'utf8')!==c.content);
  if(!changed.length)return {buildId:build.buildId,changed:0,cliPath};
  const backupDir=join(dataDir,'install-backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));mkdirSync(backupDir,{recursive:true});
  const entries:BackupEntry[]=changed.map((c,i)=>{const old=existsSync(c.path)?readFileSync(c.path):undefined;const backup=old?join(backupDir,`${i}.bak`):undefined;if(old&&backup)writeFileSync(backup,old,{mode:0o600});return {path:c.path,beforeSha:old?sha(old):undefined,afterSha:sha(c.content),backup};});
  writeFileSync(join(backupDir,'manifest.json'),JSON.stringify({buildId:build.buildId,codexHome,dataDir,entries},null,2),{mode:0o600});
  for(let i=0;i<changed.length;i++){
    const c=changed[i],entry=entries[i];const current=existsSync(c.path)?sha(readFileSync(c.path)):undefined;
    ensure(current===entry.beforeSha,'INSTALL_CONCURRENT_EDIT','安装期间文件发生变化，请保留备份并重新检查。');atomic(c.path,c.content);
  }
  return {buildId:build.buildId,changed:changed.length,cliPath,backupDir};
}
/** Explicit rollback only; later user edits are preserved by hash preconditions. */
export function rollbackLocal(backupDir:string,dataDir:string){
  backupDir=resolve(backupDir);dataDir=resolve(dataDir);
  ensure(within(join(dataDir,'install-backups'),backupDir)&&backupDir!==join(dataDir,'install-backups'),'ROLLBACK_PATH_INVALID','请选择该数据目录中的一次安装备份。');
  const info=JSON.parse(readFileSync(join(backupDir,'manifest.json'),'utf8')) as {codexHome:string;dataDir:string;entries:BackupEntry[]};
  ensure(resolve(info.dataDir)===dataDir,'ROLLBACK_PATH_INVALID','备份属于其他安装目录。');
  for(const entry of info.entries){
    ensure(within(info.codexHome,entry.path)||within(dataDir,entry.path),'ROLLBACK_PATH_INVALID','备份目标超出安装范围。');
    ensure(existsSync(entry.path)&&sha(readFileSync(entry.path))===entry.afterSha,'ROLLBACK_CONCURRENT_EDIT','文件在安装后发生变化，回滚已暂停以保留修改。');
    if(entry.backup)ensure(within(backupDir,entry.backup)&&sha(readFileSync(entry.backup))===entry.beforeSha,'ROLLBACK_BACKUP_INVALID','备份校验失败。');
  }
  for(const [index,entry]of [...info.entries].reverse().entries()){
    if(entry.backup)atomic(entry.path,readFileSync(entry.backup,'utf8'));
    else renameSync(entry.path,join(backupDir,`rolled-back-${index}.saved`));
  }
  return {restored:info.entries.length,backupDir};
}
