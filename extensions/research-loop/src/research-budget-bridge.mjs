import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { bindResearchBudgetRuntime, isResearchBudgetRuntime } from './research-budget-runtime.mjs';

export const RESEARCH_BUDGET_RPC_KEY=Symbol.for('pi-research-budget-rpc.v1');
export const RESEARCH_BUDGET_REQUIRED_ID='research-budget-v1';
const RPC_REQUEST='subagents:rpc:v1:request';
function fail(code){throw new Error(code);}
function registry(){const old=globalThis[RESEARCH_BUDGET_RPC_KEY];if(old===undefined)return globalThis[RESEARCH_BUDGET_RPC_KEY]=new Map();if(!(old instanceof Map))fail('research-budget-bridge-unavailable');return old;}
function rpc(pi,method,params,requestId='research-budget-'+randomUUID()){
  return new Promise((resolve,reject)=>{
    const reply='subagents:rpc:v1:reply:'+requestId;
    const off=pi.events.on(reply,value=>{if(value?.requestId!==requestId)return;clearTimeout(timer);off();value.success?resolve(value.data):reject(new Error('research-budget-rpc-failed'));});
    const timer=setTimeout(()=>{off();reject(new Error('research-budget-rpc-unconfirmed'));},30000);timer.unref?.();
    pi.events.emit(RPC_REQUEST,{version:1,requestId,method,...(params?{params}:{}),source:{extension:'research-loop'}});
  });
}
function extensionText(descriptor){return `import { createResearchBudgetChildExtension, bindScopedResearchRuntime } from ${JSON.stringify(import.meta.url)};\nconst descriptor=Object.freeze(${JSON.stringify(descriptor)});\nexport const researchBudgetScope=descriptor;\nexport const bindResearchModelRuntime=(runtime,metadata)=>bindScopedResearchRuntime(runtime,descriptor,{...metadata,extensionFile:import.meta.filename});\nexport default createResearchBudgetChildExtension(descriptor);\n`;}

/** Mandatory startup throws are collected by native child-session before its first prompt. */
export function createResearchBudgetChildExtension(descriptor){return pi=>{
  pi.on('session_start',(_event,ctx)=>{
    if(ctx.cwd!==descriptor.cwd||!isResearchBudgetRuntime(ctx.modelRegistry,descriptor))fail('research-budget-bridge-unavailable-open-new-session');
  });
};}
export async function bindScopedResearchRuntime(runtime,descriptor,metadata={}){
  if(metadata.cwd!==descriptor.cwd)fail('research-budget-scope-mismatch');
  const store=await import('./research-budget.mjs');
  const proxy=await bindResearchBudgetRuntime(runtime,descriptor,{store,signal:metadata.signal,role:metadata.role});
  const extensionSha256=createHash('sha256').update(fs.readFileSync(metadata.extensionFile)).digest('hex');
  store.attestResearchBudgetScope({...descriptor,extensionSha256,physicalTransport:'sse-http'});
  return proxy;
}

/** Only an explicit research_loop run calls this; saving budget never calls it. */
export async function spawnBudgetedResearchWorkflow({pi,ctx,cwd,charterHash,launchId,params,store:providedStore}){
  const store=providedStore??await import('./research-budget.mjs');
  const parentSessionId=ctx.sessionManager.getSessionId();
  if(ctx.cwd!==cwd||typeof parentSessionId!=='string'||!parentSessionId)fail('research-budget-scope-mismatch');
  const budget=store.readResearchBudget({cwd,charterHash});
  if(!Number.isSafeInteger(budget.limits.attempts)||!Number.isSafeInteger(budget.limits.modelRequests))fail('research-budget-not-configured');
  if(budget.usage.attempts>=budget.limits.attempts)fail('research-budget-attempts-exhausted');
  const ping=await rpc(pi,'ping');
  if(ping?.researchBudgetProtocol!==1)fail('research-budget-bridge-unavailable-open-new-session');
  const scopeId='research-'+launchId;
  const scope=store.createResearchBudgetScope({cwd,charterHash,scopeId,parentSessionId});
  const descriptor={schema:'pi-research-budget-scope.v1',cwd,charterHash,scopeId,parentSessionId};
  store.installResearchBudgetScopeExtension({...descriptor,source:extensionText(descriptor)});
  const requestId='research-budget-'+randomUUID();let claimed=false;
  const map=registry();
  map.set(requestId,{version:1,method:'spawn',async bindContext(actualCtx,registerRequiredChildExtensions,signal){
    if(actualCtx.cwd!==cwd||actualCtx.sessionManager.getSessionId()!==parentSessionId||claimed)fail('research-budget-scope-mismatch');
    claimed=true;
    const registration=registerRequiredChildExtensions({sessionId:parentSessionId,extensions:[{id:RESEARCH_BUDGET_REQUIRED_ID,path:scope.extensionFile}],requireForAllRunners:true});
    try{
      const modelRegistry=await bindScopedResearchRuntime(actualCtx.modelRegistry,descriptor,{cwd,signal,extensionFile:scope.extensionFile,role:'workflow-host'});
      const scopedContext=new Proxy(actualCtx,{get(target,key){return key==='modelRegistry'?modelRegistry:Reflect.get(target,key,target);}});
      return {ctx:scopedContext,dispose:()=>registration.dispose()};
    }catch(error){registration.dispose();throw error;}
  }});
  try{
    const result=await rpc(pi,'spawn',{...params,args:{...params.args,researchBudget:{version:1,scopeId,extension:scope.extensionFile}}},requestId);
    if(!claimed)fail('research-budget-bridge-unavailable-open-new-session');
    return result;
  }finally{map.delete(requestId);}
}
