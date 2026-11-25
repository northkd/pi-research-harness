import os from 'node:os';
import path from 'node:path';
import { RootsProvider, GrantCache, createPathGateHandler, forbiddenGrantSubjects,
  isUngrantableSubject, DEFAULT_AGENT_PATH_GATE, resolveAgentPathGate } from './upstream.mjs';

/** Transport-neutral original gate. The native host supplies its authenticated
 * grant request and TUI select/confirm adapter; this module never writes grants. */
export function createNativePathGate({storeFile,home=os.homedir(),getSessionId,getCwd,getSessionDir,
  prompter,requestGrant,getConfig=()=>DEFAULT_AGENT_PATH_GATE,grantStoreMatch=()=>false,
  getResources,log=()=>{},notify,yoloSupported,fullAccessSupported,yoloDecide,reportRefusal,suppression}={}) {
  if(!storeFile || !path.isAbsolute(storeFile) || typeof getSessionId!=='function' || typeof getCwd!=='function' || !prompter) throw new TypeError('native gate dependencies required');
  const resources={agentDir:process.env.PI_CODING_AGENT_DIR||path.join(home,'.pi/agent'),skillDirs:[],contextFiles:[]};
  const roots=new RootsProvider({getCwd,getSessionDir:()=>getSessionDir?.(),getPiResources:()=>getResources?.()??resources});
  const grants=new GrantCache({file:storeFile});
  const counters={inRoot:0,asked:0,blocked:0,yoloAllowed:0};
  const handler=createPathGateHandler({
    getConfig:()=>resolveAgentPathGate(getConfig()), getRoots:(g,checkout,cwd)=>roots.roots(g,checkout,cwd),
    getGrants:()=>grants.get().filter(subject=>path.isAbsolute(subject)&&!isUngrantableSubject(subject,{homedir:home})),
    getSensitiveDirs:()=>forbiddenGrantSubjects({homedir:home}).sensitive,
    isUngrantable:subject=>isUngrantableSubject(subject,{homedir:home}), prompter,
    grantStoreMatch,requestGrant:requestGrant??(async()=>({ok:false,error:'grant-service-unavailable'})),
    sessionId:getSessionId,log,notify,counters,yoloSupported,fullAccessSupported,yoloDecide,reportRefusal,suppression,
  });
  return {handler,counters,onSessionStart:()=>roots.startProbe(),onBeforeAgentStart(event){
    const opts=event?.systemPromptOptions;
    if(!opts)return;
    resources.skillDirs=(opts.skills??[]).map(s=>s.baseDir).filter(Boolean);
    resources.contextFiles=(opts.contextFiles??[]).map(f=>f.path).filter(Boolean);
  },setPiResources(value){for(const key of ['agentDir','docsDir','skillDirs','contextFiles'])if(value?.[key]!==undefined)resources[key]=value[key];}};
}
