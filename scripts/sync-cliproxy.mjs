import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
function readJson(file, fallback) {
 try {const st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('symlink configuration rejected');if(!st.isFile())throw Error('configuration is not a file');return JSON.parse(fs.readFileSync(file,'utf8'));}
 catch(e){if(e.code==='ENOENT')return fallback;throw e;}
}
function writeJson(file,value){
 const temp=path.join(path.dirname(file),`.cliproxy-${crypto.randomUUID()}.tmp`);
 try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export async function syncCliProxy({agentDir,apiKey,baseUrl='http://127.0.0.1:8317/v1',fetcher=fetch,setDefault=false}){
 if(!path.isAbsolute(agentDir)||!fs.statSync(agentDir).isDirectory()||fs.lstatSync(agentDir).isSymbolicLink())throw Error('existing absolute agent directory required');
 if(typeof apiKey!=='string'||!apiKey)throw Error('PI_RESEARCH_PROXY_API_KEY is required');
 const url=new URL(baseUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='/v1')throw Error('loopback CLIProxyAPI /v1 endpoint required');
 const base=url.origin+'/v1';const response=await fetcher(base+'/models',{headers:{Authorization:`Bearer ${apiKey}`},redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error(`CLIProxyAPI returned HTTP ${response.status}`);
 const payload=await response.json(),ids=[...new Set((Array.isArray(payload.data)?payload.data:[]).map(row=>row?.id).filter(id=>typeof id==='string'&&id.length>0&&id.length<=256&&!/[\x00-\x1f]/.test(id)))].sort();
 if(!ids.length)throw Error('CLIProxyAPI returned no model IDs');
 const modelsFile=path.join(agentDir,'models.json'),models=readJson(modelsFile,{providers:{}});
 if(!models||typeof models!=='object'||Array.isArray(models))throw Error('invalid models configuration');
 models.providers??={};if(typeof models.providers!=='object'||Array.isArray(models.providers))throw Error('invalid providers configuration');
 models.providers.cliproxy={name:'Local CLIProxyAPI',baseUrl:base,apiKey:'$PI_RESEARCH_PROXY_API_KEY',api:'openai-completions',models:ids.map(id=>({id,name:id}))};
 let settings,settingsFile;if(setDefault){settingsFile=path.join(agentDir,'settings.json');settings=readJson(settingsFile,{});if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('invalid settings configuration');settings.defaultProvider='cliproxy';if(!ids.includes(settings.defaultModel))settings.defaultModel=ids[0];}
 writeJson(modelsFile,models);if(settingsFile)writeJson(settingsFile,settings);
 return{modelCount:ids.length,defaultUpdated:setDefault};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),setDefault=args.includes('--set-default');const rest=args.filter(v=>v!=='--set-default');
 if(rest.length!==1||!path.isAbsolute(rest[0]))throw Error('Usage: node scripts/sync-cliproxy.mjs ABSOLUTE_AGENT_DIR [--set-default]');
 syncCliProxy({agentDir:rest[0],apiKey:process.env.PI_RESEARCH_PROXY_API_KEY,baseUrl:process.env.PI_RESEARCH_PROXY_BASE_URL||undefined,setDefault}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
