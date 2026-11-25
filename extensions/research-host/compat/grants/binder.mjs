import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createNativePathGate } from './native.mjs';
import { NATIVE_GRANT_RECEIPT, NATIVE_GRANT_PREFIX } from './transport.mjs';
import { DEFAULT_AGENT_PATH_GATE, Suppression } from './upstream.mjs';

/** Bind the original gate to Pi's actual extension tool and TUI APIs. */
export function registerNativePathGate(pi,{request,configFile,getConfig,log=()=>{}}={}) {
  if(typeof pi.on!=='function'||typeof request!=='function')throw new TypeError('native path gate registration dependencies required');
  let current;
  const suppression=new Suppression();
  const configPath=configFile??(process.env.PI_RESEARCH_HOST_DIR?path.join(process.env.PI_RESEARCH_HOST_DIR,'config.json'):null);
  const readConfig=state=>{
    if(getConfig)return getConfig();
    try { const value=JSON.parse(fs.readFileSync(configPath,'utf8')).agentPathGate;if(value&&typeof value==='object')return {...DEFAULT_AGENT_PATH_GATE,...value}; }catch{/* use last authenticated config */}
    return state.config??DEFAULT_AGENT_PATH_GATE;
  };
  const same=(state,ctx)=>current===state&&state.sessionId===ctx.sessionManager.getSessionId()&&state.sessionFile===ctx.sessionManager.getSessionFile()&&state.cwd===ctx.cwd;
  const identity=state=>({sessionId:state.sessionId,sessionFile:state.sessionFile,cwd:state.cwd});
  async function call(state,suffix,data={},retry=true){
    if(!same(state,state.ctx))throw new Error('native-path-session-changed');
    if(!state.channel && suffix!=='connect')await connect(state);
    let response;
    try{response=await request(NATIVE_GRANT_PREFIX+suffix,{...identity(state),...(suffix==='connect'?{}:{channel:state.channel}),...data});}
    catch(error){
      if(suffix!=='connect'&&retry&&same(state,state.ctx)){
        state.channel=undefined;await connect(state);return call(state,suffix,data,false);
      }
      throw error;
    }
    if(!same(state,state.ctx)||response?.success!==true)throw new Error('native-path-host-unavailable');
    return response.data;
  }
  async function connect(state){
    if(typeof state.sessionFile!=='string'||!path.isAbsolute(state.sessionFile)||!state.sessionId)throw new Error('native-path-persistence-unavailable');
    const data=await call(state,'connect');
    if(data?.sessionId!==state.sessionId||typeof data.channel!=='string'||!path.isAbsolute(data.storeFile??''))throw new Error('native-path-host-identity-invalid');
    state.channel=data.channel;state.config=data.config;state.grantStoreFile=data.storeFile;
    return data;
  }
  function receipt(state,prompt,kind,args,answer){
    if(!same(state,state.ctx)||typeof pi.appendEntry!=='function')throw new Error('native-path-control-unconfirmed');
    pi.appendEntry(NATIVE_GRANT_RECEIPT,{...identity(state),channel:state.channel,promptId:args.id,nonce:prompt.nonce,
      kind,path:args.metadata.path,subject:args.metadata.subject,answer});
  }
  async function setup(state){
    let data;
    try{data=await connect(state);}catch{
      let settings={};try{settings=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{/* use the original local store default */}
      const storeFile=process.env.PI_ACCESS_GRANTS_STORE||settings.accessGrantsFile||path.join(os.homedir(),'.pi/dashboard/access-grants.json');
      data={storeFile:path.resolve(storeFile),config:readConfig(state)};
    }
    const prompter={
      async select(args){
        const prompt=state.channel?await call(state,'prompt',{kind:'select',promptId:args.id,path:args.metadata.path,subject:args.metadata.subject}):null;
        const controller=new AbortController();state.open.set(args.id,controller);
        try{
          const answer=await state.ctx.ui.select(args.title,args.options,{signal:controller.signal});
          if(!same(state,state.ctx)||controller.signal.aborted)return undefined;
          if(prompt)receipt(state,prompt,'select',args,answer??null);state.selection=args.id;
          return answer;
        }finally{state.open.delete(args.id);}
      },
      async confirm(args){
        const prompt=await call(state,'prompt',{kind:'confirm',promptId:args.id,path:args.metadata.path,subject:args.metadata.subject,selectPromptId:state.selection});
        const controller=new AbortController();state.open.set(args.id,controller);
        try{
          const answer=await state.ctx.ui.confirm(args.title,args.message,{signal:controller.signal});
          if(!same(state,state.ctx)||controller.signal.aborted)return false;
          receipt(state,prompt,'confirm',args,answer===true);
          return answer===true;
        }finally{state.open.delete(args.id);}
      },
      cancel(id){state.open.get(id)?.abort();void call(state,'cancel',{promptId:id}).catch(()=>{});},
    };
    state.storeFile=data.storeFile;
    state.gate=createNativePathGate({storeFile:data.storeFile,getSessionId:()=>state.sessionId,getCwd:()=>state.cwd,
      getSessionDir:()=>typeof state.sessionFile==='string'?path.dirname(state.sessionFile):undefined,getConfig:()=>readConfig(state),prompter,
      requestGrant:async ({promptId})=>call(state,'commit',{promptId}),grantStoreMatch:()=>!!state.channel&&state.grantStoreFile===state.storeFile,
      yoloSupported:()=>!!state.channel,fullAccessSupported:()=>true,
      yoloDecide:async args=>{const result=await call(state,'decide',args);if(result.config)state.config=result.config;return result.verdict;},
      log,notify:message=>state.ctx.ui.notify?.(message,'warning'),suppression});
    state.gate.onSessionStart();
    try{
      const piModule=await import('@earendil-works/pi-coding-agent');
      state.gate.setPiResources({agentDir:piModule.getAgentDir?.(),docsDir:piModule.getDocsPath?.()});
    }catch{/* supplied resources still cover the configured agent directory */}
    return state.gate;
  }
  const close=()=>{if(current)for(const controller of current.open.values())controller.abort();current=undefined;};
  pi.on('session_start',async(_event,ctx)=>{
    close();const state={ctx,cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),open:new Map()};
    current=state;
    try{await setup(state);}catch{/* tool calls retry after the host's session registration */}
  });
  pi.on('session_shutdown',close);
  pi.on('before_agent_start',(event,ctx)=>{if(current&&same(current,ctx))current.gate?.onBeforeAgentStart(event);});
  pi.on('tool_call',async(event,ctx)=>{
    if(!['read','write','edit'].includes(event.toolName))return;
    const state=current;
    if(!state||!same(state,ctx))return {block:true,reason:'path-gate: session identity is unavailable'};
    try{
      state.ctx=ctx;
      if(!state.gate)await setup(state);
      if(!state.channel&&state.sessionFile&&!state.connecting){
        state.connecting=connect(state).catch(()=>{}).finally(()=>{state.connecting=undefined;});
      }
      return await state.gate.handler(event,ctx);
    }catch{return {block:true,reason:'path-gate: host authorization is unavailable'};}
  });
  return {dispose:close,get current(){return current;}};
}
