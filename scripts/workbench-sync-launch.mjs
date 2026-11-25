import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
export function makeSyncConfig({home,agentDir,repo,token,dashboardPort}){
 if(![home,agentDir,repo].every(p=>typeof p==='string'&&path.isAbsolute(p)))throw Error('absolute paths required');
 if(typeof token!=='string'||token.length<16||token.length>8192)throw Error('local token unavailable');
 if(!Number.isInteger(dashboardPort)||dashboardPort<1||dashboardPort>65535)throw Error('invalid dashboard port');
 return{bindHost:'127.0.0.1',port:18767,dashboardOrigin:`http://127.0.0.1:${dashboardPort}`,proxyToken:token,
  privateDir:path.join(home,'.local/share/pi-research-harness/workbench-sync'),adoptionDir:path.join(home,'.pi/dashboard/res-workflow'),
  configurationFile:path.join(repo,'extensions/research-loop/stage-role-skill.json'),agentDir:path.join(agentDir,'agents'),sessionRoots:[path.join(agentDir,'sessions')]};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length>1||args[0]&&args[0]!=='--dry-run')throw Error('Usage: pi-research-workbench-sync [--dry-run]');
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),home=fs.realpathSync(os.homedir());
 const agent=path.resolve(process.env.PI_RESEARCH_AGENT_DIR||path.join(home,'.local/share/pi-research-harness/agent'));
 const port=Number(process.env.PI_DASHBOARD_PORT||8000),tokenFile=path.join(home,'.pi/dashboard/local/token');
 if(args[0]==='--dry-run'){console.log(JSON.stringify({dashboardOrigin:`http://127.0.0.1:${port}`,bind:'127.0.0.1:18767',agentDir:agent,tokenFile,startsService:false},null,2));}
 else {
  try{
   const stat=fs.lstatSync(tokenFile);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw Error('private dashboard token required');
   const token=fs.readFileSync(tokenFile,'utf8').trim();const config=makeSyncConfig({home,agentDir:agent,repo,token,dashboardPort:port});
   const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pi-workbench-config-'));const file=path.join(temp,'config.json');fs.writeFileSync(file,JSON.stringify(config),{flag:'wx',mode:0o600});
   const child=spawn(process.execPath,[path.join(repo,'extensions/research-loop/scripts/run-workbench-sync.mjs'),'--config',file],{stdio:'inherit',env:process.env});
   const cleanup=()=>fs.rmSync(temp,{recursive:true,force:true});let done=false;
   for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(!done)child.kill(signal);});
   child.once('error',()=>{if(!done){done=true;cleanup();console.error('workbench sync failed to start');process.exitCode=1;}});
   child.once('exit',(code,signal)=>{if(!done){done=true;cleanup();process.exitCode=code??(signal?1:0);}});
  }catch(error){console.error(error.message);process.exitCode=1;}
 }
}
