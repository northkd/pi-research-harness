import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fail } from '../../http.mjs';
import { readTranscriptPage } from '../../transcript.mjs';
import { buildOptions, isUngrantableSubject, realpathNearestAncestor, DEFAULT_AGENT_PATH_GATE } from './upstream.mjs';

export const NATIVE_GRANT_RECEIPT = 'pi-research:path-access-answer';
export const NATIVE_GRANT_PREFIX = '/internal/native/path-gate/';
const text = value => typeof value==='string' && value.length>0 && value.length<=4096 && !value.includes('\0');
const opaque = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const reply = data => ({statusCode:200,body:{success:true,data}});
const exact = (body,keys) => {if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!keys.includes(key)))fail(400,'native-path-request-invalid');};

/** Mounted only inside the authenticated local host. A commit consumes a
 * positive native TUI receipt from the exact session transcript, not a caller's
 * approval boolean. Channels and prompts are sealed to their original identity. */
export function createNativeGrantTransport({grants,sessions,sessionsDir,authenticate,authorizeSession,
  readSessionAccessMode,getConfig=()=>DEFAULT_AGENT_PATH_GATE,decideAgentPath,home,now=Date.now}={}) {
  if(!grants?.evaluatePath || !sessions?.getSession || typeof authenticate!=='function' || typeof authorizeSession!=='function' || !path.isAbsolute(sessionsDir??''))throw new TypeError('native grant transport dependencies required');
  const channels=new Map();
  const ttl=20*60*1000;
  function prune(){for(const [key,state]of channels)if(now()-state.at>=ttl)channels.delete(key);}
  function config(){
    const value=getConfig()??{};
    return {enabled:typeof value.enabled==='boolean'?value.enabled:true,timeoutSeconds:Number.isFinite(value.timeoutSeconds)&&value.timeoutSeconds>0?value.timeoutSeconds:120};
  }
  async function identity(body) {
    if(!opaque(body.sessionId) || !text(body.sessionFile) || !text(body.cwd) || !path.isAbsolute(body.sessionFile) || !path.isAbsolute(body.cwd))fail(400,'native-path-session-invalid');
    const row=sessions.getSession(body.sessionId);
    if(!row || row.id!==body.sessionId || row.sessionFile!==body.sessionFile || row.cwd!==body.cwd || row.originDeviceId || row.driver&&row.driver!=='pi' || row.live===false)fail(409,'native-path-session-mismatch');
    if(await authorizeSession(row)!==true)fail(403,'native-path-session-denied');
    return row;
  }
  async function bound(body){
    const row=await identity(body);prune();
    const state=channels.get(body.channel);
    if(!state || state.sessionId!==row.id || state.sessionFile!==row.sessionFile || state.cwd!==row.cwd)fail(409,'native-path-channel-invalid');
    state.at=now();
    return {row,state};
  }
  async function proof(row,state,prompt) {
    if(!prompt || prompt.state!=='pending' || now()>=prompt.expiresAt)fail(409,'native-path-prompt-expired');
    const page=await readTranscriptPage(row,{limit:200},{sessionsDir});
    const matches=page.entries.filter(entry=>entry.type==='custom' && entry.customType===NATIVE_GRANT_RECEIPT
      && entry.data?.channel===state.channel && entry.data?.promptId===prompt.promptId && entry.data?.nonce===prompt.nonce);
    if(matches.length!==1)fail(409,'native-path-answer-unconfirmed');
    const data=matches[0].data;
    if(data.sessionId!==row.id || data.cwd!==row.cwd || data.sessionFile!==row.sessionFile || data.kind!==prompt.kind || data.path!==prompt.path || data.subject!==prompt.subject)fail(409,'native-path-answer-mismatch');
    return data.answer;
  }
  const tuple=['sessionId','cwd','sessionFile','channel'];
  return {
    async handle(input) {
      const pathname=input.pathname??input.url?.pathname;
      if(!pathname?.startsWith(NATIVE_GRANT_PREFIX))return null;
      if(input.method!=='POST')fail(405,'method-not-allowed');
      let authenticated=false;
      try{authenticated=await authenticate(input.request);}catch{/* malformed callers have no local authority */}
      if(authenticated!==true)fail(401,'research-host-auth-required');
      const body=input.body;
      if(pathname===NATIVE_GRANT_PREFIX+'connect') {
        exact(body,['sessionId','cwd','sessionFile']);const row=await identity(body);prune();
        for(const [key,value]of channels)if(value.sessionId===row.id)channels.delete(key);
        if(channels.size>=256)channels.delete(channels.keys().next().value);
        const channel=randomBytes(32).toString('base64url');
        channels.set(channel,{channel,sessionId:row.id,cwd:row.cwd,sessionFile:row.sessionFile,at:now(),prompts:new Map()});
        return reply({sessionId:row.id,channel,storeFile:grants.storeFile,config:config()});
      }
      const {row,state}=await bound(body??{});
      if(pathname===NATIVE_GRANT_PREFIX+'decide') {
        exact(body,[...tuple,'path','access','tool']);
        if(!text(body.path)||!path.isAbsolute(body.path)||!['read','write','edit'].includes(body.tool)||body.access!==(body.tool==='read'?'r':'w'))fail(400,'native-path-request-invalid');
        const mode=await readSessionAccessMode?.(row);
        let verdict='decline';
        if(mode?.mode==='full-access')verdict='auto-allow';
        else if(mode?.revision===null&&decideAgentPath&&!isUngrantableSubject(body.path,{homedir:home})) {
          const legacy=await decideAgentPath(body.path,row);
          verdict=legacy==='auto-allow'?'auto-allow':legacy==='refused-by-prior-refusal'?'refused':'decline';
        }
        return reply({verdict,config:config()});
      }
      if(pathname===NATIVE_GRANT_PREFIX+'prompt') {
        exact(body,[...tuple,'kind','promptId','path','subject','selectPromptId']);
        if(!opaque(body.promptId)||!['select','confirm'].includes(body.kind)||!text(body.path)||!path.isAbsolute(body.path)||!text(body.subject)||!path.isAbsolute(body.subject))fail(400,'native-path-prompt-invalid');
        for(const [key,value]of state.prompts)if(now()>=value.expiresAt)state.prompts.delete(key);
        if(state.prompts.has(body.promptId))fail(409,'native-path-prompt-duplicate');
        const sameKind=[...state.prompts.values()].filter(prompt=>prompt.kind===body.kind);
        if(sameKind.length>=32)state.prompts.delete(sameKind[0].promptId);
        const real=realpathNearestAncestor(body.path);
        let subject=path.dirname(real);try{if(fs.statSync(real).isDirectory())subject=real;}catch{/* future file */}
        if(subject!==body.subject)fail(409,'native-path-subject-changed');
        let denialId;
        if(body.kind==='select'){
          const denied=await grants.evaluatePath(real,[row.cwd],{site:'native-path-gate',session:row.id,subjectKind:subject===real?'directory':'file'});
          denialId=denied.remedy?.denialId;
        }else{
          const selection=state.prompts.get(body.selectPromptId);
          if(!selection || selection.kind!=='select' || selection.path!==body.path || selection.subject!==body.subject)fail(409,'native-path-select-unconfirmed');
          const answer=await proof(row,state,selection);
          const offer=buildOptions({subject,grantable:!isUngrantableSubject(subject,{homedir:home}),sensitive:false,storeMatch:true});
          if(!offer.alwaysLabel || answer!==offer.alwaysLabel)fail(409,'native-path-select-unconfirmed');
          selection.state='used';denialId=selection.denialId;
          if(!denialId)fail(409,'native-path-denial-unavailable');
        }
        const prompt={promptId:body.promptId,kind:body.kind,path:body.path,subject,denialId,nonce:randomUUID(),expiresAt:now()+config().timeoutSeconds*1000,state:'pending'};
        state.prompts.set(body.promptId,prompt);
        return reply({nonce:prompt.nonce});
      }
      if(pathname===NATIVE_GRANT_PREFIX+'cancel') {
        exact(body,[...tuple,'promptId']);state.prompts.delete(body.promptId);return reply({cancelled:true});
      }
      if(pathname===NATIVE_GRANT_PREFIX+'commit') {
        exact(body,[...tuple,'promptId']);const prompt=state.prompts.get(body.promptId);
        if(!prompt || prompt.kind!=='confirm' || await proof(row,state,prompt)!==true)fail(409,'native-path-confirm-unconfirmed');
        prompt.state='used';
        const real=realpathNearestAncestor(prompt.path);
        let subject=path.dirname(real);try{if(fs.statSync(real).isDirectory())subject=real;}catch{/* future file */}
        if(subject!==prompt.subject)fail(409,'native-path-subject-changed');
        const result=await grants.createFromDenial({denialId:prompt.denialId,subject,session:row.id,scope:'project',via:'agent-prompt'},async()=>true);
        return reply(result);
      }
      fail(404,'native-path-route-not-found');
    },
    dispose(){channels.clear();},
  };
}
