import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOAuthFlowStore, _buildAuthStatus, buildRuntimeCatalogue } from './flow-store.mjs';
import { loadSelectedPi } from './runtime.mjs';
import { createCredentialStorage, providerId, fail, credentialConflict } from './storage.mjs';

const PREFIX='/api/provider-auth';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const response=(body,statusCode=200)=>({statusCode,body});
const exact=(body,keys)=>{if(!object(body)||Object.keys(body).some(key=>!keys.includes(key)))fail('provider-auth-request-invalid');};
const FLOW_HINT={anthropic:'auth_code',openai:'auth_code','openai-codex':'auth_code',openrouter:'auth_code',radius:'auth_code'};
const timeout=(promise,ms)=>{let timer;return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]).finally(()=>clearTimeout(timer));};
function readConfig(file){
  let descriptor;try{descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const info=fs.fstatSync(descriptor);if(!info.isFile()||info.size>1024*1024)fail('provider-auth-config-unsafe',503);
    const value=JSON.parse(fs.readFileSync(descriptor,'utf8').replace(/^\uFEFF/,''));if(!object(value))fail('provider-auth-config-invalid',503);return value;
  }catch(error){if(error.code==='ENOENT')return {};throw error;}finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}

/** Provider-owned OAuth flows and native Pi credential transactions. Runtime
 * loading and listing perform no login, token refresh, or model requests. */
export async function createProviderAuthApi(options={}){
  const agentDir=path.resolve(options.agentDir??process.env.PI_CODING_AGENT_DIR??path.join(os.homedir(),'.pi/agent'));
  if(typeof options.authenticate!=='function')throw new TypeError('provider auth requires authenticated local host');
  const selected=options.selectedPi??await loadSelectedPi({agentDir,managedInstallRoot:options.managedInstallRoot});
  const storage=createCredentialStorage({sdk:selected.sdk,agentDir,authFile:options.authFile});
  let runtimePromise;const registered=new Map();
  async function loadRuntime(){
    if(!runtimePromise)runtimePromise=(async()=>{
      const loaded=options.loadRuntime?await options.loadRuntime({credentials:storage.credentials,agentDir,selectedPi:selected}):
        await selected.sdk.ModelRuntime.create({credentials:storage.credentials,modelsPath:path.join(agentDir,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
      const runtime=loaded?.runtime??loaded;
      if(typeof runtime?.getProviders!=='function')fail('provider-auth-runtime-unavailable',503);
      const custom=options.readProviders?await options.readProviders():readConfig(path.join(agentDir,'providers.json')).providers??{};
      for(const [id,config]of Object.entries(custom))runtime.registerProvider?.(id,config);
      for(const provider of registered.values())runtime.registerNativeProvider?.(provider);
      return runtime;
    })().catch(error=>{runtimePromise=undefined;throw error;});
    return runtimePromise;
  }
  const invalidateRuntime=()=>{runtimePromise=undefined;};
  const updates=new Map();
  async function changed(provider,type,action){
    invalidateRuntime();const update={provider,type,action,status:'pending'};updates.set(provider,update);
    try{await options.onCredentialsChanged?.({provider,type,action});update.status='complete';}
    catch{update.status='error';throw Object.assign(new Error('provider-auth-refresh-unconfirmed'),{code:'provider-auth-refresh-unconfirmed',statusCode:503,credentialApplied:true});}
  }
  const flows=createOAuthFlowStore({startTimeoutMs:options.startTimeoutMs,getDeviceId:options.getDeviceId??(()=>selected.sdk.SettingsManager.create(options.cwd??agentDir,agentDir).getOrCreateDeviceId())});
  const stopPrune=flows.startFlowPruneTimer();const starts=new Map();
  async function registry(){
    const runtime=await loadRuntime();
    return runtime.getProviders().filter(provider=>typeof provider?.auth?.oauth?.login==='function'&&!(provider.id==='radius'&&radiusOverridden())).map(provider=>({
      id:provider.id,name:provider.auth.oauth.name||provider.name||provider.id,flowType:FLOW_HINT[provider.id]??'device_code',
      subscription:provider.auth.oauth.isSubscription===true,auth:provider.auth.oauth,
    }));
  }
  function radiusOverridden(){
    try{
      const raw=fs.readFileSync(path.join(agentDir,'models.json'),'utf8').replace(/^\uFEFF/,'');
      const jsonc=raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g,match=>match[0]==='"'?match:'').replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,(match,tail)=>tail??match);
      const radius=JSON.parse(jsonc)?.providers?.radius;
      if(radius?.oauth!=='radius'||typeof radius.baseUrl!=='string'||!radius.baseUrl)return false;
      let gateway=radius.baseUrl.replace(/\/v1\/?$/u,'');if(!/^https?:\/\//iu.test(gateway))gateway='https://'+gateway;
      return gateway.replace(/\/+$/u,'')!=='https://radius.pi.dev';
    }catch{return false;}
  }
  function oauthIds(entries,data){return new Set([...entries.map(entry=>entry.id),...Object.entries(data).filter(([,value])=>value.type==='oauth').map(([id])=>id)]);}
  const resolveId=(id,ids)=>{providerId(id);return id.endsWith('-api')&&ids.has(id.slice(0,-4))?id.slice(0,-4):id;};
  function flowStatus(flow){
    const value=flows.toFlowStatus(flow);
    if(value.error&&/(?:access_token|refresh_token|authorization\s*[:=]|Bearer\s|"(?:access|refresh)"\s*:)/i.test(value.error))value.error='Provider sign-in failed (sensitive error details withheld)';
    if(flow.cancelled&&flow.status==='pending')value.cancellationRequested=true;
    if(flow.status==='complete')value.refreshStatus=updates.get(flow.provider)?.status??'complete';
    return value;
  }
  async function begin(provider,entry,{preAnswers=[],openBrowser=false}={}){
    const run=async()=>{
      for(const flow of flows.pendingFlowsFor(provider)){flows.cancelFlow(flow);await timeout(flow.settled,flows.SUPERSEDE_SETTLE_TIMEOUT_MS);}
      const current=storage.snapshot()[provider];if(current&&current.type!=='oauth')credentialConflict(current.type);
      const started=flows.startFlow({provider,loginFlow:entry.auth,preAnswers,
        writeCredential:async(id,credential)=>{await storage.write(id,credential);},
        notifyBridges:()=>{void changed(provider,'oauth','login').catch(()=>{});},
        ...(openBrowser&&options.openBrowser?{openInBrowser:options.openBrowser}:{}),
      });
      const result=await timeout(Promise.race([started.firstEvent.then(()=> 'step'),started.settled.then(()=> 'settled')]),flows.FLOW_START_TIMEOUT_MS);
      if(result==='timeout'){flows.cancelFlow(started.flow);flows.deleteFlow(started.flow.id);fail('provider-auth-start-timeout',504);}
      if(result==='settled'&&started.flow.status!=='complete'){
        const status=flowStatus(started.flow);flows.deleteFlow(started.flow.id);
        return response({error:status.error??'Provider sign-in failed',code:'provider-auth-login-failed'},500);
      }
      return response(flowStatus(started.flow));
    };
    const next=(starts.get(provider)??Promise.resolve()).then(run,run);starts.set(provider,next.then(()=>{},()=>{}));return next;
  }
  async function status(){
    const [entries,runtime]=await Promise.all([registry(),loadRuntime()]);const data=storage.snapshot();
    const custom=options.readProviders?await options.readProviders():readConfig(path.join(agentDir,'providers.json')).providers??{};
    const catalogue=options.getCatalogue?await options.getCatalogue():await buildRuntimeCatalogue(runtime,{customIds:Object.keys(custom),authData:data,env:options.env??process.env});
    const known=new Set(catalogue.map(entry=>entry.id));
    for(const [id,value]of Object.entries(data))if(value.type==='api_key'&&!known.has(id))catalogue.push({id,displayName:id,configured:true,source:'stored'});
    return _buildAuthStatus(catalogue,data,entries);
  }
  function legacyIds(){
    const id='azure-openai-responses',locations=[];const isLegacy=value=>typeof value==='string'&&(value===id||value.startsWith(id+'/'));
    const data=storage.snapshot();if(Object.hasOwn(data,id))locations.push('auth.json');
    for(const [name,scan]of [['settings.json',value=>{
      if(isLegacy(value.defaultProvider))locations.push('settings.json:defaultProvider');
      if(Array.isArray(value.enabledModels)&&value.enabledModels.some(isLegacy))locations.push('settings.json:enabledModels');
      if(object(value.modelThinkingLevels)&&Object.keys(value.modelThinkingLevels).some(isLegacy))locations.push('settings.json:modelThinkingLevels');
    }],['models.json',value=>{if(object(value.providers)&&Object.hasOwn(value.providers,id))locations.push('models.json:providers');}]]){
      try{scan(readConfig(path.join(agentDir,name)));}catch{/* unreadable file contributes no location */}
    }
    return {legacyProviderIds:locations.length?[{legacyId:id,newId:'azure',locations}]:[]};
  }
  async function handle(input){
    const pathname=input.pathname??input.url?.pathname;
    if(pathname!==PREFIX&&!pathname?.startsWith(PREFIX+'/'))return null;
    let allowed=false;try{allowed=await options.authenticate(input.request,input.context);}catch{/* no local authority */}
    if(allowed!==true)return response({error:'provider-auth-forbidden',code:'provider-auth-forbidden'},403);
    try{
      flows.pruneFlows();const {method,body}=input;
      if(method==='GET'&&pathname===PREFIX+'/providers')return response((await registry()).map(({auth,...entry})=>entry));
      if(method==='GET'&&pathname===PREFIX+'/handlers')return response({ids:(await registry()).map(entry=>entry.id)});
      if(method==='GET'&&pathname===PREFIX+'/status')return response(await status());
      if(method==='GET'&&pathname===PREFIX+'/catalogue-ready'){const runtime=await loadRuntime();return response({ready:true,fallback:runtime.getProviders().length>0});}
      if(method==='GET'&&pathname===PREFIX+'/legacy-provider-ids')return response(legacyIds());
      if(pathname===PREFIX+'/radius/mcp'){
        if(!options.radiusMcp)return response({error:'provider-auth-radius-mcp-unavailable',code:'provider-auth-radius-mcp-unavailable'},503);
        if(method==='GET')return options.radiusMcp.status();if(method==='POST')return options.radiusMcp.configure();
      }
      if(method==='PUT'&&pathname===PREFIX+'/api-key'){
        exact(body,['provider','key','env']);providerId(body.provider);
        if(typeof body.key!=='string'||!body.key||body.key.length>65536||body.key==='***'||body.key==='****')fail('provider-auth-key-required');
        const entries=await registry(),data=storage.snapshot(),provider=resolveId(body.provider,oauthIds(entries,data));
        await storage.write(provider,{type:'api_key',key:body.key,...(body.env!==undefined?{env:body.env}:{})});await changed(provider,'api_key','save');return response({ok:true});
      }
      if(method==='POST'&&pathname===PREFIX+'/start'){
        exact(body,['provider','enterpriseDomain','openBrowser']);providerId(body.provider);
        if(body.enterpriseDomain!==undefined&&typeof body.enterpriseDomain!=='string'||body.openBrowser!==undefined&&typeof body.openBrowser!=='boolean')fail('provider-auth-request-invalid');
        const entry=(await registry()).find(entry=>entry.id===body.provider);
        if(!entry)return response({error:'No OAuth login handler is registered for this provider. Its Pi extension must register its OAuth provider in the host runtime.',code:'provider-auth-login-unavailable'},409);
        return await begin(body.provider,entry,{preAnswers:typeof body.enterpriseDomain==='string'?[body.enterpriseDomain]:[],openBrowser:body.openBrowser===true});
      }
      const flowMatch=new RegExp('^'+PREFIX+'/flow/([A-Za-z0-9_-]{1,160})(/input)?$').exec(pathname);
      if(flowMatch){
        const flow=flows.getFlow(flowMatch[1]);if(!flow)fail('provider-auth-flow-not-found',404);
        if(method==='GET'&&!flowMatch[2])return response(flowStatus(flow));
        if(method==='DELETE'&&!flowMatch[2]){flows.cancelFlow(flow);return response({},204);}
        if(method==='POST'&&flowMatch[2]){
          exact(body,['value']);if(typeof body.value!=='string'||body.value.length>16384)fail('provider-auth-input-invalid');
          if(!flow.resolveInput)fail('provider-auth-no-input-pending',409);
          if(flow.pending?.kind==='select'&&!flow.pending.options.some(option=>option.id===body.value))fail('provider-auth-input-invalid');
          flow.resolveInput(body.value);return response({ok:true},202);
        }
      }
      const removeMatch=new RegExp('^'+PREFIX+'/([^/]+)$').exec(pathname);
      if(method==='DELETE'&&removeMatch){
        const raw=decodeURIComponent(removeMatch[1]);providerId(raw);const entries=await registry(),data=storage.snapshot(),ids=oauthIds(entries,data),provider=resolveId(raw,ids),expected=ids.has(raw)?'oauth':'api_key';
        await storage.remove(provider,expected);await changed(provider,expected,'delete');return response({ok:true});
      }
      fail('provider-auth-route-not-found',404);
    }catch(error){
      const known=typeof error?.code==='string'&&/^(?:provider-auth-[a-z-]+|provider_auth\.credential_type_conflict)$/.test(error.code);
      return response({error:known?error.code:'provider-auth-operation-unavailable',code:known?error.code:'provider-auth-operation-unavailable',
        ...(error.vars?{vars:error.vars}:{}),...(error.credentialApplied?{credentialApplied:true}:{})},known?error.statusCode??503:503);
    }
  }
  return {handle,status,credentials:storage.credentials,resolveCredential:storage.resolveCredential,loadRuntime,invalidateRuntime,
    runtimeVersion:selected.version,authFile:storage.authFile,
    registerOAuthProvider(provider){providerId(provider?.id);if(typeof provider?.auth?.oauth?.login!=='function')throw new TypeError('provider-owned OAuth login required');registered.set(provider.id,provider);invalidateRuntime();},
    dispose(){stopPrune();flows.abortAllFlows();},
    capabilities:()=>({credentialWritesImplemented:true,oauthFlowsImplemented:true,runtimeVersion:selected.version,pluginOAuth:'requires registration in the host runtime',radiusMcp:!!options.radiusMcp}),
  };
}
