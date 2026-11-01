import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const WORKBENCH_SCHEMA = 'res-workflow.workbench-observation.v1';
const STAGES = new Set(['1-idea', '2-experiment', '3-review', '4-summary', '5-writing']);
const STATUSES = new Set(['registered','active','idle','streaming','ended','queued','started','running','completed','complete','failed','blocked','paused','stopped','cancelled','waiting','unknown','pending','partial','stopping','rejected']);
const TERMINAL = new Set(['complete','completed','failed','stopped','cancelled','rejected','ended']);
const ACTIONS = new Set(['configure','status','log','claim','narrow','advise','dead-ends','report','stage','review-round','review-gate','stage-map','run','claim-gate','publish']);
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const token = (value, max=256) => typeof value === 'string' && value.length > 0 && value.length <= max && !['__proto__','constructor','prototype'].includes(value) && /^[A-Za-z0-9_./:@+()[\]-]+$/.test(value) ? value : undefined;
const iso = value => (typeof value === 'string' || typeof value === 'number') && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const cleanText = (value, max=1200) => typeof value === 'string' && value.trim() && !value.includes('DO-NOT-KEEP') ? value.trim().slice(0, Math.min(max, 1200)) : undefined;
const model = (provider,id) => token(id) ? token(token(provider)&&!id.startsWith(provider+'/')?provider+'/'+id:id) : undefined;
const safeAbsolute=value=>typeof value==='string'&&value.length<=4096&&!value.includes('\0')&&path.isAbsolute(value)&&path.resolve(value)===value?value:undefined;
const inside = (root,file) => file===root || file.startsWith(root+path.sep);
function noLinks(file) { let current=path.parse(file).root; for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){ current=path.join(current,part); const st=fs.lstatSync(current); if(st.isSymbolicLink())throw Error('source-link-refused'); } }
export function readVerified(file, max=2*1024*1024) {
  noLinks(file); const before=fs.lstatSync(file); if(!before.isFile()||before.size>max)throw Error('source-type-or-size');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
  try { const opened=fs.fstatSync(fd); if(opened.dev!==before.dev||opened.ino!==before.ino||!opened.isFile())throw Error('source-changed'); if(opened.size>max)throw Error('source-size');const bytes=Buffer.alloc(opened.size);let used=0;while(used<bytes.length){const n=fs.readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}const text=bytes.subarray(0,used).toString('utf8'); const after=fs.fstatSync(fd),named=fs.lstatSync(file); if(after.dev!==named.dev||after.ino!==named.ino||after.size!==opened.size||text.length>max)throw Error('source-changed'); return text; } finally{fs.closeSync(fd);}
}
const json = (file,max) => JSON.parse(readVerified(file,max));
function privateDir(dir) { fs.mkdirSync(dir,{recursive:true,mode:0o700});noLinks(dir);fs.chmodSync(dir,0o700); }
function durable(file,value) { privateDir(path.dirname(file));const tmp=path.join(path.dirname(file),'.'+path.basename(file)+'.'+randomUUID()+'.tmp');const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('checkpoint-capacity');const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);} }
function walk(root,accept,max=4096,depth=4) { const found=[];let visited=0;const visit=(dir,remaining)=>{noLinks(dir);for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(++visited>max)return;if(item.isSymbolicLink())continue;const file=path.join(dir,item.name);if(item.isDirectory()&&remaining)visit(file,remaining-1);else if(item.isFile()&&accept(item.name))found.push(file);}};try{visit(root,depth);}catch{}return{found,truncated:visited>max}; }
function participation(row) { const ref=row.resWorkflow??row.pluginRefs?.['res-workflow']?.resWorkflow;return object(ref)&&typeof ref.canonicalCwd==='string'&&iso(ref.joinedAt)&&['manual','adoption','spawn'].includes(ref.via)?ref:undefined; }
export function parentIdentity(row) { const ref=participation(row);return digest([row.id,row.sessionFile,row.principalOwner?.iss??null,row.principalOwner?.sub??null,ref?.canonicalCwd,ref?.joinedAt]); }
function ownerAllows(ownerKey,row) { let owner;try{owner=JSON.parse(ownerKey);}catch{return false;}if(!Array.isArray(owner)||owner.length!==2)return false;if(owner[0]==='urn:pi-dashboard:local-operator')return true;if(owner[0]==='host'&&owner[1]==='inert-operator')return !row.principalOwner;return row.principalOwner?.iss===owner[0]&&row.principalOwner?.sub===owner[1]; }
function eligible(row,scope) { const ref=participation(row);if(!token(row.id,128)||row.originDeviceId||row.pluginHidden||row.archiveOnEnd||!ref||ref.canonicalCwd!==scope.cwd||!ownerAllows(scope.ownerKey,row)||!path.isAbsolute(row.sessionFile??''))return false;try{return fs.realpathSync(row.cwd)===scope.cwd;}catch{return false;} }

/** Private adoption pointers and persisted joined metadata; no browser must be open. */
export function discoverWorkbenchScopes(options) {
  const scopes=[];const catalog=walk(options.adoptionRoot,name=>name==='adopted.json',2048,2);
  for(const file of catalog.found)try{
    const pointer=json(file,16384);if(pointer.confirmed!==true||!/^adopt-[a-f0-9]{24}$/.test(pointer.id??''))continue;
    const op=json(path.join(path.dirname(file),pointer.id+'.json'),4*1024*1024);
    if(op.schema!=='pi-res-workflow-operation.v1'||op.detachedAt||op.adoption?.status!=='confirmed'||op.adoption.id!==pointer.id||typeof op.ownerKey!=='string'||!path.isAbsolute(op.cwd??''))continue;
    const cwd=fs.realpathSync(op.cwd);if(cwd!==op.cwd||path.basename(path.dirname(file))!==digest(cwd)||path.basename(path.dirname(path.dirname(file)))!==digest(op.ownerKey))continue;
    const state=json(path.join(cwd,'.pi/research-loop/state.json'),256*1024);if(!object(state.charter)||typeof state.charter.objective!=='string'||!Array.isArray(state.charter.successCriteria))continue;
    scopes.push({cwd,ownerKey:op.ownerKey,adoptionId:pointer.id,charterHash:'sha256:'+digest(state.charter),frozenAt:iso(state.charter.frozenAt),stage:STAGES.has(state.stage)?state.stage:undefined,proofFile:file,operationFile:path.join(path.dirname(file),pointer.id+'.json')});
  }catch{}
  return scopes;
}
function discoverParents(options,scope) {const parents=[];let partial=false;for(const root of options.historyRoots){const result=walk(root,name=>name.endsWith('.meta.json'),options.maxHistoryEntries??4096,4);partial||=result.truncated;for(const file of result.found)try{const meta=json(file,128*1024),ref=participation(meta);if(!ref||ref.canonicalCwd!==scope.cwd)continue;const sessionFile=file.replace(/\.meta\.json$/,'.jsonl');const header=readHeader(sessionFile);const row={...meta,id:header.id,cwd:meta.cwd??header.cwd,sessionFile,resWorkflow:ref};if(eligible(row,scope)&&header.cwd&&fs.realpathSync(header.cwd)===scope.cwd)parents.push({...row,metaFile:file,header});}catch{}}return{parents,partial};}
function readHeader(file){noLinks(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));try{if(!fs.fstatSync(fd).isFile())throw Error('source-type');const b=Buffer.alloc(16384);const n=fs.readSync(fd,b,0,b.length,0);const end=b.subarray(0,n).indexOf(10);if(end<0)throw Error('header-incomplete');const h=JSON.parse(b.subarray(0,end).toString());if(h.type!=='session'||!token(h.id,128))throw Error('header-invalid');return{type:'session',id:h.id,cwd:h.cwd,timestamp:iso(h.timestamp),...(typeof h.parentSession==='string'?{parentSession:h.parentSession}:{})};}finally{fs.closeSync(fd);}}
const issueCode=error=>new Set(['source-link-refused','source-type','source-record-too-large','source-rotation-unverified','source-prefix-changed','source-changed','checkpoint-capacity','source-capacity']).has(error?.message)?error.message:'source-unavailable';
const emptyUsage=()=>({responses:0,inputTokens:0,outputTokens:0,inheritedExcluded:0});
function initial(scope) {return{schema:'pi-workbench-sync-checkpoint.v1',scope,parents:{},sources:{},native:{},calls:{},seenResponses:{},actions:[],configuration:undefined,configurationSource:undefined,issues:[],updatedAt:new Date(0).toISOString()};}
function sourceKey(file){return digest(file);}
function sourceIdentity(stat,header){return[stat.dev,stat.ino,header.id].join(':');}
function normalizeConfiguration(options,scope) {try{const raw=json(options.stageMap,256*1024),stages={};for(const [name,entry]of Object.entries(raw.stages??{})){if(!STAGES.has(name)||!object(entry))continue;const role=rawRole=>{const r=typeof rawRole==='string'?{role:rawRole}:rawRole;if(!object(r)||!token(r.role,128))return;const out={role:r.role};if(Array.isArray(r.skills))out.skills=r.skills.filter(s=>token(s,128)).slice(0,64);for(const field of ['purpose','note'])if(typeof r[field]==='string'&&r[field].length<=1000&&!/[\x00-\x1f]/.test(r[field]))out[field]=r[field];for(const root of [...(options.agentRoots??[]),path.join(scope.cwd,'.pi/agents')])try{const text=readVerified(path.join(root,r.role+'.md'),64*1024),front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);const m=front?.[1].match(/^model:\s*(.+)$/m)?.[1]?.trim();if(token(m))out.model=m;}catch{}return out;};const value={};if(Array.isArray(entry.roles))value.roles=entry.roles.map(role).filter(Boolean).slice(0,64);const sequential=role(entry.sequentialRole);if(sequential)value.sequentialRole=sequential;stages[name]=value;}const configuration={stages};return{configuration,configurationSource:{kind:'stage-map',sha256:digest(configuration)}};}catch{return{};}}
function sourceEntries(options,file,cursor,header){noLinks(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));try{const stat=fs.fstatSync(fd);if(!stat.isFile())throw Error('source-type');const identity=sourceIdentity(stat,header);let offset=cursor?.offset??0;if(cursor&&cursor.identity!==identity||stat.size<offset)throw Error('source-rotation-unverified');if(offset&&cursor.anchor){const b=Buffer.alloc(Math.min(128,offset));fs.readSync(fd,b,0,b.length,offset-b.length);if(digest(b.toString('base64'))!==cursor.anchor)throw Error('source-prefix-changed');}let budget=Math.min(options.bytesPerSource??4*1024*1024,stat.size-offset),data,end;do{const b=Buffer.alloc(budget);const n=fs.readSync(fd,b,0,b.length,offset);data=b.subarray(0,n);end=data.lastIndexOf(10);if(end>=0||budget>=stat.size-offset)break;if(budget>=8*1024*1024)throw Error('source-record-too-large');budget=Math.min(budget*2,stat.size-offset,8*1024*1024);}while(true);if(end<0)return{entries:[],cursor:cursor??{identity,offset:0},partial:stat.size>offset};const entries=data.subarray(0,end+1).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));offset+=end+1;const anchor=Buffer.alloc(Math.min(128,offset));if(anchor.length)fs.readSync(fd,anchor,0,anchor.length,offset-anchor.length);const after=fs.lstatSync(file);if(after.dev!==stat.dev||after.ino!==stat.ino)throw Error('source-changed');return{entries,cursor:{identity,offset,anchor:digest(anchor.toString('base64'))},partial:stat.size>offset};}finally{fs.closeSync(fd);}}
function collectEntries(state,source,entries,scope){const root=state.parents[source.rootParentId];for(const entry of entries){if(entry.type!=='message'||!object(entry.message)||!token(entry.id,128))continue;const message=entry.message,at=iso(entry.timestamp);
  if(message.role==='user'){
    const rawUser=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.find(b=>b?.type==='text')?.text:undefined;
    const userText=cleanText(rawUser,32768);
    if(userText){
      if(!source.execution.prompt)source.execution.prompt=userText;
      else if(!source.hasFirstUserPrompt&&!source.execution.prompt.includes(userText.slice(0,24))){
        source.execution.prompt=(source.execution.prompt+'\n\n[首条指令] '+userText.slice(0,800)).slice(0,1200);
      }
      source.hasFirstUserPrompt=true;
    }
  }else if(message.role==='assistant'){
    const rawAsst=typeof message.content==='string'?message.content.trim():Array.isArray(message.content)?message.content.filter(b=>b?.type==='text'&&typeof b?.text==='string'&&b.text.trim()).map(b=>b.text.trim()).join('\n'):undefined;
    const asstText=cleanText(rawAsst,32768);
    if(asstText)source.execution.output=asstText;
    if(source.execution.kind==='pi-session'){
      if(token(message.model)&&token(message.provider))source.execution.observedModel=model(message.provider,message.model);
      if(at)source.execution.lastActivityAt=at;
    }
  }
  if(!source.header.timestamp){state.issues.push('source-creation-time-unverified');continue;}if(at&&source.header.timestamp&&at<iso(source.header.timestamp)){if(message.role==='assistant')root.usage.inheritedExcluded++;continue;}if(!at){state.issues.push('response-time-unverified');continue;}if(at&&scope.frozenAt&&at<scope.frozenAt)continue;if(!source.usageSince){state.issues.push('response-lineage-time-unverified');continue;}if(at<source.usageSince)continue;
  if(message.role==='assistant'){
    if(token(message.model)&&token(message.provider)&&object(message.usage)){
      const key=digest(entry.id);if(state.seenResponses[key])root.usage.inheritedExcluded++;else if(Object.keys(state.seenResponses).length>=100000)state.issues.push('response-dedup-capacity');else{state.seenResponses[key]=source.rootParentId;root.usage.responses++;root.usage.inputTokens+=count(message.usage.input);root.usage.outputTokens+=count(message.usage.output);}
      source.execution.observedModel=model(message.provider,message.model);
    }
    if(at)source.execution.lastActivityAt=at;
    for(const block of Array.isArray(message.content)?message.content:[]){if(block?.type!=='toolCall'||!token(block.id,128)||!token(block.name,128))continue;const args=object(block.arguments)?block.arguments:{};if(Object.keys(source.pending).length>=512&&!source.pending[block.id]){state.issues.push('tool-call-capacity');continue;}if(block.name==='subagent'&&!['status','wait','list','stop','inspect','artifacts','remove'].includes(args.action)&&(token(args.agent,128)||Array.isArray(args.tasks)||Array.isArray(args.chain)||typeof args.workflow==='string')){
      const rawP=typeof args.prompt==='string'?args.prompt:typeof args.task==='string'?args.task:typeof args.description==='string'?args.description:typeof args.instruction==='string'?args.instruction:typeof args.mission==='string'?args.mission:undefined;
      const pText=cleanText(rawP,32768);
      state.calls??={};state.calls[block.id]={toolCallId:block.id,eventId:'tool-call-'+digest([source.header.id,entry.id,block.id]),sourceSessionId:source.header.id,rootParentId:source.rootParentId,parentIdentity:source.parentIdentity,status:'registered',startedAt:at,results:[],...(token(args.agent,128)?{role:args.agent}:{}),...(STAGES.has(args.phase)?{stage:args.phase}:{}),...(pText?{prompt:pText}:{})};
      const keys=Object.keys(state.calls);for(const key of keys.slice(0,Math.max(0,keys.length-256)))delete state.calls[key];
    }source.pending[block.id]={tool:block.name,...(block.name==='research_loop'&&ACTIONS.has(args.action)?{action:args.action,...(args.action==='stage'&&STAGES.has(args.stage)?{stage:args.stage}:{}),...(token(args.claimId??args.id,128)?{claimId:args.claimId??args.id}:{})}:{})};source.execution.currentTool=block.name;}
  }else if(message.role==='toolResult'&&token(message.toolCallId,128)){
    const call=state.calls?.[message.toolCallId];if(call&&call.parentIdentity===source.parentIdentity){
      const details=object(message.details)?message.details:{};
      call.nativeRunId=token(details.runId??details.asyncId,128);
      call.status=message.isError===true?'failed':call.nativeRunId?'registered':'completed';
      if(call.status!=='registered')call.endedAt=at;
      const rawO=typeof message.content==='string'?message.content:typeof details.output==='string'?details.output:typeof details.summary==='string'?details.summary:typeof details.result==='string'?details.result:undefined;
      const oText=cleanText(rawO,32768);
      if(oText)call.output=oText;
      if(message.isError===true){const errText=cleanText(typeof message.content==='string'?message.content:'Execution error',4096);if(errText)call.error=errText;}
      call.results=(Array.isArray(details.results)?details.results:[]).slice(0,64).filter(object).map(r=>({...(token(r.agent,128)?{agent:r.agent}:{}),...(token(r.runId,128)?{runId:r.runId}:{}),...(safeAbsolute(r.sessionFile)?{sessionFile:r.sessionFile}:{}),state:r.exitCode===0?'completed':r.exitCode!==undefined?'failed':message.isError===true?'failed':'completed'}));if(call.results.length){call.status=call.results.every(r=>r.state==='failed')?'failed':call.results.some(r=>r.state==='failed')?'partial':'completed';call.endedAt=at;}
    }const pending=source.pending[message.toolCallId];if(pending?.action==='stage'&&pending.stage&&message.isError!==true)source.execution.stage=pending.stage;if(pending?.action&&at){const id='action-'+digest([source.header.id,entry.id,pending.action]);if(!state.actions.some(a=>a.id===id))state.actions.push({id,action:pending.action,at,status:message.isError===true?'failed':'completed',...(pending.claimId?{claimId:pending.claimId}:{}),rootParentId:source.rootParentId,parentIdentity:source.parentIdentity});state.actions=state.actions.slice(-128);}
    delete source.pending[message.toolCallId];source.execution.currentTool=Object.values(source.pending).at(-1)?.tool??null;if(at)source.execution.lastActivityAt=at;
  }
}}
function nativeMetadata(raw,step=false) {
  if(!object(raw))return{};
  const out={};
  for(const field of ['runId','sessionId','mode','state','status','agent','phase','stage','parentWorkflowRunId','parentRunId','workflowKey','childId'])if(token(raw[field],256))out[field]=raw[field];
  // Native producers use either a Pi UUID or the exact originating session file.
  // Keep a bounded canonical-form path only; admission below still requires an exact proven key.
  if(typeof raw.sessionId==='string'&&path.isAbsolute(raw.sessionId)){if(safeAbsolute(raw.sessionId))out.sessionId=raw.sessionId;else delete out.sessionId;}
  for(const field of ['cwd','sessionFile'])if(safeAbsolute(raw[field]))out[field]=raw[field];
  for(const field of ['startedAt','endedAt','lastActivityAt'])if(iso(raw[field]))out[field]=iso(raw[field]);
  if(token(raw.currentTool,128))out.currentTool=raw.currentTool;
  for(const field of ['description','prompt','mission','output','summary','error']){const cleaned=cleanText(raw[field],32768);if(cleaned)out[field]=cleaned;}
  if(Array.isArray(raw.recentOutput)){const cleaned=raw.recentOutput.slice(-30).map(s=>cleanText(String(s),2048)).filter(Boolean);if(cleaned.length)out.recentOutput=cleaned;}
  if(object(raw.activity))out.activity={...(token(raw.activity.currentTool,128)?{currentTool:raw.activity.currentTool}:{}),...(iso(raw.activity.lastActivityAt)?{lastActivityAt:iso(raw.activity.lastActivityAt)}:{})};
  if(object(raw.resolvedModel)&&token(raw.resolvedModel.provider)&&token(raw.resolvedModel.model))out.resolvedModel={provider:raw.resolvedModel.provider,model:raw.resolvedModel.model};
  if(Array.isArray(raw.agents))out.agents=raw.agents.filter(value=>token(value,128)).slice(0,8);
  if(!step&&Array.isArray(raw.steps)){out.steps=raw.steps.slice(0,128).map(value=>nativeMetadata(value,true));if(raw.steps.length>128)out.truncated=true;}
  if(!step&&Array.isArray(raw.nestedChildren)&&raw.nestedChildren.length)out.nestedChildren=[{}];
  return out;
}
function collectNative(options,state,parents) {
  const roots=new Map(parents.map(p=>[p.id,p])),sessionProofs=new Map(),runProofs=new Map(),candidates=[],seenFiles=new Set(),processed=new Set();let metadataBytes=0;
  for(const parent of parents){const proof={rootParentId:parent.id,executionId:'session-'+parent.id,file:parent.sessionFile,sessionId:parent.id,rootRunId:undefined};sessionProofs.set(parent.id,proof);sessionProofs.set(parent.sessionFile,proof);}
  const addFiles=(directory,depth=1)=>{
    const files=walk(directory,name=>name==='status.json',options.maxNativeEntries??2048,depth);
    if(files.truncated)state.issues.push('native-discovery-capacity');
    const ranked=files.found.flatMap(file=>{try{return[{file,mtime:fs.statSync(file).mtimeMs}];}catch{state.issues.push('native-source-unavailable');return[];}}).sort((a,b)=>b.mtime-a.mtime);
    for(const {file} of ranked){
      if(seenFiles.has(file))continue;seenFiles.add(file);
      if(candidates.length>=512){state.issues.push('native-discovery-capacity');break;}
      try{
        const stat=fs.statSync(file);if(stat.uid!==process.getuid()||(stat.mode&0o022)!==0)throw Error('owner');
        const jsonRaw=json(file,4*1024*1024);
        if(Array.isArray(jsonRaw.steps)&&jsonRaw.steps[0]){
          const s0=jsonRaw.steps[0];
          if(!jsonRaw.description&&s0.description)jsonRaw.description=s0.description;
          if(!jsonRaw.prompt&&s0.prompt)jsonRaw.prompt=s0.prompt;
          if(!jsonRaw.error&&s0.error)jsonRaw.error=s0.error;
          if(!jsonRaw.recentOutput&&s0.recentOutput)jsonRaw.recentOutput=s0.recentOutput;
          if(!jsonRaw.output&&s0.output)jsonRaw.output=s0.output;
        }
        const raw=nativeMetadata(jsonRaw);
        if(!token(raw.runId,128)||path.basename(path.dirname(file))!==raw.runId)throw Error('identity');
        const bytes=Buffer.byteLength(JSON.stringify(raw));if(metadataBytes+bytes>2*1024*1024){state.issues.push('native-metadata-capacity');continue;}
        metadataBytes+=bytes;if(raw.truncated)state.issues.push('native-step-capacity');candidates.push({file,stat,raw});
      }catch{state.issues.push('native-source-unavailable');}
    }
  };
  for(const root of options.nativeRoots??[])addFiles(root);
  const upsert=(key,execution,context,source)=>{
    const parent=roots.get(context.rootParentId);if(!parent)return;
    const previous=state.native[key];
    if(previous?.parentIdentity===parentIdentity(parent)&&TERMINAL.has(previous.execution.status)&&!TERMINAL.has(execution.status)){execution.status=previous.execution.status;if(previous.execution.endedAt)execution.endedAt=previous.execution.endedAt;execution.currentTool=null;}
    if(previous?.parentIdentity===parentIdentity(parent)){
      if(!execution.observedModel&&previous.execution.observedModel)execution.observedModel=previous.execution.observedModel;
      if(!execution.stage&&previous.execution.stage)execution.stage=previous.execution.stage;
      if(!execution.prompt&&previous.execution.prompt)execution.prompt=previous.execution.prompt;
      if(!execution.output&&previous.execution.output)execution.output=previous.execution.output;
      if(!execution.recentOutput&&previous.execution.recentOutput)execution.recentOutput=previous.execution.recentOutput;
      if(!execution.error&&previous.execution.error)execution.error=previous.execution.error;
    }
    if(TERMINAL.has(execution.status))execution.currentTool=null;
    const eventId=source.kind==='tool-call'?source.eventId:'native-status-'+digest([source.runId,source.key??null,context.sessionId,scopeKeyForProof(state.scope)]);
    state.native[key]={rootParentId:parent.id,parentIdentity:parentIdentity(parent),sourceKind:source.kind,sourceFile:source.file,sourceIdentity:source.stat?[source.stat.dev,source.stat.ino,source.stat.size,source.stat.mtimeMs].join(':'):undefined,execution,relation:{id:'edge-'+digest([execution.parentExecutionId,execution.id]),fromExecutionId:execution.parentExecutionId,toExecutionId:execution.id,kind:'dispatch',evidence:{source:source.kind==='tool-call'?'tool-call':'native-status',eventId}}};
    return state.native[key];
  };
  const project=(raw,id,parentId,nativeRunId)=>{
    const out={id,kind:'native-subagent',parentExecutionId:parentId,status:STATUSES.has(raw.state??raw.status)?raw.state??raw.status:'unknown'};
    if(token(nativeRunId,128))out.nativeRunId=nativeRunId;
    if(token(raw.agent,128))out.role=raw.agent;else if(raw.agents?.length===1&&token(raw.agents[0],128))out.role=raw.agents[0];
    // Native model is initialized from configuration before launch. Only resolvedModel
    // or a verified assistant response below proves a model actually answered.
    const actual=object(raw.resolvedModel)?model(raw.resolvedModel.provider,raw.resolvedModel.model):undefined;
    if(actual)out.observedModel=actual;
    const stage=raw.phase??raw.stage;if(STAGES.has(stage))out.stage=stage;
    const activity=object(raw.activity)?raw.activity:raw;
    if(token(activity.currentTool,128))out.currentTool=activity.currentTool;
    for(const field of ['startedAt','endedAt','lastActivityAt']){const at=iso(raw[field]??activity[field]);if(at)out[field]=at;}
    const pVal=cleanText(raw.description,32768)??cleanText(raw.prompt,32768)??cleanText(raw.mission,32768);
    if(pVal)out.prompt=pVal;
    const oVal=cleanText(raw.output,32768)??cleanText(raw.summary,32768);
    if(oVal)out.output=oVal;
    if(Array.isArray(raw.recentOutput)&&raw.recentOutput.length){const cleaned=raw.recentOutput.slice(-30).map(s=>cleanText(String(s),2048)).filter(Boolean);if(cleaned.length)out.recentOutput=cleaned;}
    const eVal=cleanText(raw.error,4096);
    if(eVal)out.error=eVal;
    return out;
  };
  const child=(file,context,execution,dispatchAt)=>{
    const parent=roots.get(context.rootParentId);
    if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file){state.issues.push('native-child-response-coverage-unverified');return;}
    try{
      noLinks(file);const canonical=fs.realpathSync(file);if(!options.historyRoots.some(root=>{try{return inside(fs.realpathSync(root),canonical);}catch{return false;}}))throw Error('root');
      const header=readHeader(file);if(fs.realpathSync(header.cwd)!==state.scope.cwd)throw Error('cwd');
      let lineage=header.parentSession===context.file;
      if(!lineage&&header.parentSession!==undefined)throw Error('contradictory-parent');if(!lineage)try{const meta=json(file.replace(/\.jsonl$/,'.meta.json'),128*1024);lineage=!meta.originDeviceId&&meta.principalOwner?.iss===parent.principalOwner?.iss&&meta.principalOwner?.sub===parent.principalOwner?.sub&&!!parent.principalOwner&&(meta.id===undefined||meta.id===header.id)&&fs.realpathSync(meta.cwd??header.cwd)===state.scope.cwd;}catch{}
      if(!lineage)throw Error('parent');
      execution.sessionId=header.id;
      const proof={...context,file,sessionId:header.id,executionId:execution.id};sessionProofs.set(header.id,proof);sessionProofs.set(canonical,proof);
      const joined=iso(participation(parent).joinedAt),started=iso(dispatchAt);
      if(!joined||!started){state.issues.push('response-lineage-time-unverified');return proof;}
      const key=sourceKey(file),previous=state.sources[key],source={...previous,file,rootParentId:parent.id,parentIdentity:parentIdentity(parent),header,usageSince:[joined,started].sort().at(-1),pending:previous?.pending??{},execution};
      const batch=sourceEntries(options,file,source.cursor,header);collectEntries(state,source,batch.entries,state.scope);source.cursor=batch.cursor;state.sources[key]=source;if(batch.partial)state.issues.push('catchup-pending');
      return proof;
    }catch{state.issues.push('native-child-response-coverage-unverified');}
  };
  const executionIdForRun=(runId,context)=>{
    const parent=roots.get(context.rootParentId),identity=parent&&parentIdentity(parent),key='run:'+runId;
    const existing=state.native[key];
    if(existing?.rootParentId===context.rootParentId&&existing.parentIdentity===identity)return existing.execution.id;
    const call=Object.values(state.calls??{}).find(c=>c.nativeRunId===runId&&c.rootParentId===context.rootParentId&&c.parentIdentity===identity);
    const provisional=call&&state.native['call:'+call.toolCallId];
    if(provisional?.rootParentId===context.rootParentId&&provisional.parentIdentity===identity){
      state.native[key]={...provisional,execution:{...provisional.execution,nativeRunId:runId}};
      delete state.native['call:'+call.toolCallId];
      return provisional.execution.id;
    }
    return 'native-'+runId;
  };
  for(let pass=0;pass<9;pass++){
    let progress=false;
    for(const candidate of [...candidates]){
      if(processed.has(candidate.file))continue;
      const {raw,file,stat}=candidate;
      if(raw.cwd!==state.scope.cwd||!['single','parallel','chain','workflow'].includes(raw.mode))continue;
      let context=sessionProofs.get(raw.sessionId);
      const declaredParent=raw.parentWorkflowRunId??raw.parentRunId;
      if(declaredParent){const declared=runProofs.get(declaredParent);if(!declared)continue;if(context&&context.rootParentId!==declared.rootParentId)continue;context=context??(raw.sessionId===declared.sessionId?declared:undefined);if(!context)continue;context={...context,executionId:declared.executionId};}
      if(!context)continue;
      processed.add(file);progress=true;
      const id=executionIdForRun(raw.runId,context),execution=project(raw,id,context.executionId,raw.runId);
      const record=upsert('run:'+raw.runId,execution,context,{kind:'native-status',file,stat,runId:raw.runId});if(!record)continue;
      const current=record.execution,rootRunId=context.rootRunId??raw.runId;
      const ownContext={...context,rootRunId,executionId:current.id};
      if(raw.sessionFile){const proof=child(raw.sessionFile,ownContext,current,raw.startedAt);if(proof)Object.assign(ownContext,proof);}
      runProofs.set(raw.runId,{...ownContext,executionId:current.id});
      for(const [index,step]of (Array.isArray(raw.steps)?raw.steps:[]).entries()){
        if(!object(step))continue;
        if(step.parentWorkflowRunId&&step.parentWorkflowRunId!==raw.runId){state.issues.push('native-step-parent-mismatch');continue;}
        const key=token(step.workflowKey,128)??token(step.childId,128)??'index:'+index;
        const actualRun=token(step.runId,128),selfStep=raw.mode==='single'&&raw.steps.length===1,stepId=selfStep?current.id:actualRun?'native-'+actualRun:'step-'+raw.runId+'-'+digest(key).slice(0,24);
        const row=project(step,stepId,selfStep?current.parentExecutionId:current.id,selfStep?raw.runId:actualRun),storageKey=selfStep?'run:'+raw.runId:actualRun?'run:'+actualRun:'step:'+raw.runId+':'+key;
        const result=upsert(storageKey,row,selfStep?context:ownContext,{kind:'native-status',file,stat,runId:raw.runId,key});if(!result)continue;
        const proof=selfStep&&step.sessionFile===raw.sessionFile&&ownContext.sessionId!==context.sessionId?(result.execution.sessionId=ownContext.sessionId,ownContext):step.sessionFile?child(step.sessionFile,ownContext,result.execution,step.startedAt??raw.startedAt):undefined;
        if(!step.sessionFile&&['running','completed','complete'].includes(row.status))state.issues.push('native-child-response-coverage-unverified');
        if(actualRun)runProofs.set(actualRun,{...(proof??ownContext),executionId:result.execution.id,rootRunId});
      }
      if(Array.isArray(raw.nestedChildren)&&raw.nestedChildren.length)state.issues.push('native-nested-summary-requires-header-proof');
      for(const root of options.nativeRoots??[])addFiles(path.join(path.dirname(root),'nested-subagent-runs',rootRunId),2);
    }
    if(!progress)break;
    if(pass===8&&candidates.some(c=>!processed.has(c.file)))state.issues.push('native-depth-capacity');
  }
  if(candidates.some(c=>!processed.has(c.file)&&sessionProofs.has(c.raw.sessionId)))state.issues.push('native-lineage-unverified');
  for(const call of Object.values(state.calls??{})){
    const parent=roots.get(call.rootParentId);if(!parent||call.parentIdentity!==parentIdentity(parent))continue;
    if(call.nativeRunId){const proven=state.native['run:'+call.nativeRunId];if(proven?.rootParentId===call.rootParentId&&proven.parentIdentity===call.parentIdentity){delete state.native['call:'+call.toolCallId];continue;}}
    const context=sessionProofs.get(call.sourceSessionId);if(!context)continue;
    const id='subagent-'+call.toolCallId,row={id,kind:'native-subagent',parentExecutionId:context.executionId,status:call.status,...(call.role?{role:call.role}:{}),...(call.stage?{stage:call.stage}:{}),...(call.nativeRunId?{nativeRunId:call.nativeRunId}:{}),...(call.startedAt?{startedAt:call.startedAt}:{}),...(call.endedAt?{endedAt:call.endedAt}:{}),...(call.prompt?{prompt:call.prompt}:{}),...(call.output?{output:call.output}:{}),...(call.error?{error:call.error}:{})};
    const record=upsert('call:'+call.toolCallId,row,context,{kind:'tool-call',file:context.file,eventId:call.eventId});if(!record)continue;
    for(const [index,result]of call.results.entries()){
      const actual=token(result.runId,128),childId=call.results.length===1?record.execution.id:actual?'native-'+actual:'subagent-'+call.toolCallId+'-'+index;
      const childRow=call.results.length===1?record.execution:project(result,childId,record.execution.id,actual);
      if(result.agent)childRow.role=result.agent;
      const childRecord=call.results.length===1?record:upsert('call-result:'+call.toolCallId+':'+index,childRow,context,{kind:'tool-call',file:context.file,eventId:call.eventId});
      if(childRecord&&result.sessionFile)child(result.sessionFile,context,childRecord.execution,call.startedAt);
    }
  }
  for(const parent of parents){
    const subRoot=parent.sessionFile.replace(/\.jsonl$/,'');
    const context=sessionProofs.get(parent.id);if(!context)continue;
    const pIdentity=parentIdentity(parent);
    let subWalk;try{if(!fs.existsSync(subRoot)||!fs.lstatSync(subRoot).isDirectory())continue;subWalk=walk(subRoot,name=>name==='session.jsonl',256,3);}catch{continue;}
    for(const childFile of subWalk.found)try{
      noLinks(childFile);
      const stat=fs.lstatSync(childFile);if(!stat.isFile())continue;
      const sIdentity=[stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':');
      const subKey='subsession:'+sourceKey(childFile);
      const cached=state.native[subKey];
      if(cached&&cached.parentIdentity===pIdentity&&cached.sourceIdentity===sIdentity)continue;
      const fd=fs.openSync(childFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      let headText='',tailText='';
      try{
        const headLen=Math.min(stat.size,65536);
        const hb=Buffer.alloc(headLen);fs.readSync(fd,hb,0,headLen,0);headText=hb.toString('utf8');
        if(stat.size>65536){
          const tailLen=Math.min(stat.size-65536,65536);
          const tb=Buffer.alloc(tailLen);fs.readSync(fd,tb,0,tailLen,stat.size-tailLen);tailText=tb.toString('utf8');
        }
      }finally{fs.closeSync(fd);}
      const parseLines=txt=>txt.split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
      const headLines=parseLines(headText);
      const tailLines=tailText?parseLines(tailText.slice(tailText.indexOf('\n')+1)):headLines;
      const header=headLines[0];if(!object(header)||header.type!=='session'||!token(header.id,128))continue;
      const info=headLines.find(l=>object(l)&&l.type==='session_info'&&typeof l.name==='string'&&l.name.startsWith('subagent-'));
      if(!info)continue;
      const m=info.name.match(/^subagent-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/);
      const role=token(m?.[1],128);
      const runId=token(m?.[2],128)??token(path.basename(path.dirname(path.dirname(childFile))),128);
      const mc=headLines.find(l=>object(l)&&l.type==='model_change'&&token(l.provider)&&token(l.modelId));
      const uMsg=headLines.find(l=>object(l)&&l.message?.role==='user');
      const aMsgs=[...headLines,...tailLines].filter(l=>object(l)&&l.message?.role==='assistant');
      const lastA=aMsgs.at(-1);
      const obsModel=(lastA?.message&&token(lastA.message.provider)&&token(lastA.message.model))?model(lastA.message.provider,lastA.message.model):mc?model(mc.provider,mc.modelId):undefined;
      const uRaw=typeof uMsg?.message?.content==='string'?uMsg.message.content:Array.isArray(uMsg?.message?.content)?uMsg.message.content.find(b=>b?.type==='text')?.text:undefined;
      const aRaw=typeof lastA?.message?.content==='string'?lastA.message.content:Array.isArray(lastA?.message?.content)?lastA.message.content.filter(b=>b?.type==='text'&&typeof b?.text==='string').map(b=>b.text.trim()).join('\n'):undefined;
      const pText=cleanText(uRaw,4096),oText=cleanText(aRaw,4096);
      const startedAt=iso(header.timestamp),endedAt=iso(lastA?.timestamp??info.timestamp);
      const existing=Object.values(state.native).find(r=>r.rootParentId===parent.id&&r!==cached&&(r.execution.sessionId===header.id||(runId&&r.execution.nativeRunId===runId)));
      if(existing){
        if(role&&!existing.execution.role)existing.execution.role=role;
        if(obsModel&&!existing.execution.observedModel)existing.execution.observedModel=obsModel;
        if(pText&&!existing.execution.prompt)existing.execution.prompt=pText;
        if(oText&&!existing.execution.output)existing.execution.output=oText;
        if(startedAt&&!existing.execution.startedAt)existing.execution.startedAt=startedAt;
        if(endedAt&&!existing.execution.endedAt)existing.execution.endedAt=endedAt;
        if(endedAt&&!existing.execution.lastActivityAt)existing.execution.lastActivityAt=endedAt;
        continue;
      }
      const row={
        id:'subagent-'+(runId??header.id),
        kind:'native-subagent',
        parentExecutionId:context.executionId,
        sessionId:header.id,
        status:'completed',
        ...(runId?{nativeRunId:runId}:{}),
        ...(role?{role}:{}),
        ...(obsModel?{observedModel:obsModel}:{}),
        ...(startedAt?{startedAt}:{}),
        ...(endedAt?{endedAt,lastActivityAt:endedAt}:{}),
        ...(pText?{prompt:pText}:{}),
        ...(oText?{output:oText}:{})
      };
      upsert(subKey,row,context,{kind:'native-status',file:childFile,stat,runId:runId??header.id});
    }catch{}
  }
}
function scopeKeyForProof(scope){return[scope.adoptionId,scope.charterHash];}

export function maintainWorkbenchStorage(options,activeScopes=[],reserveBytes=0) {
  const active=new Set(activeScopes.map(s=>path.join(options.stateDir,digest(s.ownerKey),digest([s.cwd,s.adoptionId,s.charterHash])))),partitions=[];
  let bytes=0,removed=0;
  for(const owner of fs.readdirSync(options.stateDir,{withFileTypes:true})){
    if(!owner.isDirectory()||!/^[a-f0-9]{64}$/.test(owner.name))continue;
    const ownerDir=path.join(options.stateDir,owner.name);noLinks(ownerDir);
    for(const entry of fs.readdirSync(ownerDir,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue;
      const dir=path.join(ownerDir,entry.name),file=path.join(dir,'checkpoint.json');
      try{
        noLinks(dir);const names=fs.readdirSync(dir),stamps={};let size=0;
        for(const name of names){const st=fs.lstatSync(path.join(dir,name));size+=st.size;stamps[name]=[st.dev,st.ino,st.size,st.mtimeMs].join(':');}
        bytes+=size;
        // Unknown/private files count against the quota but are never garbage-collected.
        if(names.some(name=>!['checkpoint.json','pending.json'].includes(name)))continue;
        let checkpoint;try{checkpoint=json(file,16*1024*1024);}catch(error){if(error.code!=='ENOENT')continue;checkpoint=json(path.join(dir,'pending.json'),16*1024*1024).state;}
        const s=checkpoint.scope;
        if(checkpoint.schema!=='pi-workbench-sync-checkpoint.v1'||digest(s.ownerKey)!==owner.name||digest([s.cwd,s.adoptionId,s.charterHash])!==entry.name)continue;
        for(const name of names){const st=fs.lstatSync(path.join(dir,name));if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o600)throw Error('private-partition-type');}
        let live=active.has(dir);
        if(!live)try{const proof=path.join(options.adoptionRoot,digest(s.ownerKey),digest(s.cwd),'adopted.json'),pointer=json(proof,16384),state=json(path.join(s.cwd,'.pi/research-loop/state.json'),256*1024);live=pointer.confirmed===true&&pointer.id===s.adoptionId&&'sha256:'+digest(state.charter)===s.charterHash;}catch(error){live=error.code!=='ENOENT';}
        partitions.push({dir,names,bytes:size,live,mtime:Math.max(...names.map(name=>fs.statSync(path.join(dir,name)).mtimeMs)),stamps});
      }catch{}
    }
  }
  const limit=options.maxStateBytes??64*1024*1024,maxInactive=options.maxInactivePartitions??32;
  const inactive=partitions.filter(p=>!p.live).sort((a,b)=>a.mtime-b.mtime);
  while(inactive.length>maxInactive||bytes+reserveBytes>limit){
    const old=inactive.shift();if(!old)break;
    let unchanged=true;for(const name of old.names){const st=fs.lstatSync(path.join(old.dir,name));if([st.dev,st.ino,st.size,st.mtimeMs].join(':')!==old.stamps[name])unchanged=false;}
    if(!unchanged)continue;
    for(const name of old.names)fs.unlinkSync(path.join(old.dir,name));fs.rmdirSync(old.dir);bytes-=old.bytes;removed++;
  }
  if(bytes+reserveBytes>limit)throw Error('collector-storage-capacity');
  return{bytes,partitions:partitions.length-removed};
}

/** Sole collector writer. Only host-private files are mutated; project scientific records remain untouched. */
export function createWorkbenchSyncCollector(options) {
  privateDir(options.stateDir);
  const lock=path.join(options.stateDir,'writer.lock'),takeover=path.join(options.stateDir,'takeover.lock');
  let lockFd;
  try { lockFd=fs.openSync(lock,'wx',0o600); }
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const before=fs.lstatSync(lock),text=readVerified(lock,1024),prior=JSON.parse(text);
    if(!Number.isSafeInteger(prior.pid)||prior.pid<1)throw Error('collector-lock-invalid');
    try { process.kill(prior.pid,0); throw Error('collector-already-running'); }
    catch(probe) { if(probe.code!=='ESRCH')throw Error('collector-already-running'); }
    try { fs.mkdirSync(takeover,{mode:0o700}); } catch { throw Error('collector-takeover-busy'); }
    try {
      const current=fs.lstatSync(lock);
      if(current.dev!==before.dev||current.ino!==before.ino||readVerified(lock,1024)!==text)throw Error('collector-lock-changed');
      fs.unlinkSync(lock);lockFd=fs.openSync(lock,'wx',0o600);
    } finally { fs.rmdirSync(takeover); }
  }
  const lockOwned=fs.fstatSync(lockFd),lockText=JSON.stringify({pid:process.pid,token:randomUUID()});
  fs.writeFileSync(lockFd,lockText);fs.fsyncSync(lockFd);
  const ownsLock=()=>{const named=fs.lstatSync(lock);if(named.dev!==lockOwned.dev||named.ino!==lockOwned.ino||readVerified(lock,1024)!==lockText)throw Error('collector-lock-lost');};
  let scopes=[],closed=false;const runtimeIssues=new Map(),lastSuccessfulTickAt=new Map();
  const location=scope=>path.join(options.stateDir,digest(scope.ownerKey),digest([scope.cwd,scope.adoptionId,scope.charterHash]));
  const load=scope=>{const dir=location(scope),file=path.join(dir,'checkpoint.json'),wal=path.join(dir,'pending.json');privateDir(dir);let s;try{s=json(file,16*1024*1024);}catch(error){if(error.code==='ENOENT')s=initial(scope);else throw error;}if(s.schema!=='pi-workbench-sync-checkpoint.v1'||s.scope.ownerKey!==scope.ownerKey||s.scope.charterHash!==scope.charterHash)throw Error('checkpoint-scope-invalid');if(fs.existsSync(wal)){const pending=json(wal,16*1024*1024);if(pending.state?.schema!=='pi-workbench-sync-checkpoint.v1'||pending.state.scope.ownerKey!==scope.ownerKey||pending.state.scope.charterHash!==scope.charterHash)throw Error('journal-scope-invalid');if(pending.id!==s.lastBatchId){s=pending.state;s.lastBatchId=pending.id;durable(file,s);}fs.unlinkSync(wal);}return s;};
  const commit=(scope,state)=>{ownsLock();maintainWorkbenchStorage(options,scopes,2*Buffer.byteLength(JSON.stringify(state))+256);const dir=location(scope),id=digest(state);durable(path.join(dir,'pending.json'),{id,state});options.fault?.('after-journal');state.lastBatchId=id;durable(path.join(dir,'checkpoint.json'),state);options.fault?.('after-checkpoint');fs.unlinkSync(path.join(dir,'pending.json'));};
  async function tick(){if(closed)return;ownsLock();if(options.refreshNativeRoots)options.nativeRoots=options.refreshNativeRoots();scopes=discoverWorkbenchScopes(options);try{maintainWorkbenchStorage(options,scopes);}catch{for(const scope of scopes)runtimeIssues.set(location(scope),'collector-storage-capacity');return;}for(const scope of scopes){try{runtimeIssues.delete(location(scope));const state=load(scope),before=digest(state);state.scope=scope;state.issues=[];const discovery=discoverParents(options,scope);if(discovery.partial)state.issues.push('history-discovery-capacity');const allowed=new Set(discovery.parents.map(p=>p.id));for(const id of Object.keys(state.parents))if(!allowed.has(id))delete state.parents[id];let admitted=0;const offset=state.nextParent??0,ordered=[...discovery.parents.slice(offset),...discovery.parents.slice(0,offset)];state.nextParent=discovery.parents.length>(options.sourcesPerTick??32)?(offset+(options.sourcesPerTick??32))%discovery.parents.length:0;
      for(const parent of ordered){if(++admitted>(options.sourcesPerTick??32)){state.issues.push('parent-catchup-capacity');break;}const identity=parentIdentity(parent);let previous=state.parents[parent.id];if(previous&&previous.identity!==identity){state.issues.push('parent-identity-changed');delete state.parents[parent.id];for(const k of Object.keys(state.sources))if(state.sources[k].rootParentId===parent.id)delete state.sources[k];for(const k of Object.keys(state.native))if(state.native[k].rootParentId===parent.id)delete state.native[k];previous=undefined;}const root=previous??{identity,sessionFile:parent.sessionFile,usage:emptyUsage(),execution:{id:'session-'+parent.id,kind:'pi-session',sessionId:parent.id,status:'unknown',...(iso(parent.header.timestamp)?{startedAt:iso(parent.header.timestamp)}:{}),...(typeof parent.name==='string'&&parent.name.trim()?{prompt:parent.name.slice(0,32768)}:{}),...(typeof parent.model==='string'&&parent.model.trim()?{observedModel:parent.model}:{})}};
if(!root.execution.prompt&&typeof parent.name==='string'&&parent.name.trim())root.execution.prompt=parent.name.slice(0,32768);
if(!root.execution.observedModel&&typeof parent.model==='string'&&parent.model.trim())root.execution.observedModel=parent.model;root.identity=identity;state.parents[parent.id]=root;const key=sourceKey(parent.sessionFile),old=state.sources[key];const source={...old,file:parent.sessionFile,rootParentId:parent.id,parentIdentity:identity,header:parent.header,usageSince:iso(participation(parent).joinedAt),pending:old?.pending??{},execution:root.execution};try{const batch=sourceEntries(options,parent.sessionFile,source.cursor,parent.header);collectEntries(state,source,batch.entries,scope);source.cursor=batch.cursor;state.sources[key]=source;if(batch.partial)state.issues.push('catchup-pending');}catch(e){state.issues.push(issueCode(e));}}
      collectNative(options,state,discovery.parents);for(const record of Object.values(state.native)){try{noLinks(record.sourceFile);const st=fs.lstatSync(record.sourceFile);if(record.sourceKind!=='tool-call'&&[st.dev,st.ino,st.size,st.mtimeMs].join(':')!==record.sourceIdentity)throw Error('native-source-changed');}catch{state.issues.push('native-source-unavailable');if(!TERMINAL.has(record.execution.status)){record.execution.status='unknown';record.execution.currentTool=null;}}}const orderedNative=Object.entries(state.native).filter(([,r])=>state.parents[r.rootParentId]?.identity===r.parentIdentity).sort((a,b)=>(Number(!TERMINAL.has(b[1].execution.status))-Number(!TERMINAL.has(a[1].execution.status)))||(b[1].execution.lastActivityAt??b[1].execution.endedAt??b[1].execution.startedAt??'').localeCompare(a[1].execution.lastActivityAt??a[1].execution.endedAt??a[1].execution.startedAt??''));
      const byExecution=new Map(orderedNative.map(item=>[item[1].execution.id,item])),kept=new Map();
      for(const item of orderedNative){const chain=[],seen=new Set();let current=item;while(current&&!kept.has(current[0])&&chain.length<9&&!seen.has(current[0])){chain.unshift(current);seen.add(current[0]);current=byExecution.get(current[1].execution.parentExecutionId);}if(kept.size+chain.length>128){state.issues.push('native-retention-capacity');continue;}for(const ancestor of chain)kept.set(ancestor[0],ancestor[1]);}state.native=Object.fromEntries(kept);
      const nativeFiles=new Set(Object.values(state.native).map(r=>r.execution.sessionId).filter(Boolean));for(const k of Object.keys(state.sources)){const s=state.sources[k];if(!state.parents[s.rootParentId]||s.execution.kind==='native-subagent'&&!nativeFiles.has(s.header.id))delete state.sources[k];}if(Object.keys(state.sources).length>1024)throw Error('source-capacity');Object.assign(state,normalizeConfiguration(options,scope));state.issues=[...new Set(state.issues)].slice(0,32);const fresh=discoverParents(options,scope).parents;const freshMap=new Map(fresh.map(p=>[p.id,parentIdentity(p)]));for(const id of Object.keys(state.parents))if(freshMap.get(id)!==state.parents[id].identity)delete state.parents[id];if(!discoverWorkbenchScopes(options).some(s=>s.ownerKey===scope.ownerKey&&s.cwd===scope.cwd&&s.adoptionId===scope.adoptionId&&s.charterHash===scope.charterHash))continue;if(digest(state)!==before){state.updatedAt=new Date().toISOString();commit(scope,state);}lastSuccessfulTickAt.set(location(scope),iso(options.now?.()??Date.now()));
    }catch(error){runtimeIssues.set(location(scope),error.message==='collector-storage-capacity'?'collector-storage-capacity':'collector-scope-unavailable');options.onError?.('collector-scope-unavailable');}}}
  function readForCaller(binding,sessions){ownsLock();const scope=scopes.find(s=>s.cwd===binding.cwd&&s.adoptionId===binding.adoptionId&&s.charterHash===binding.charterHash);if(!scope)throw Error('collector-scope-not-ready');const heartbeatAt=lastSuccessfulTickAt.get(location(scope));if(!heartbeatAt)throw Error('collector-no-successful-tick');const state=load(scope),parents=new Map();if(runtimeIssues.has(location(scope)))state.issues.push(runtimeIssues.get(location(scope)));for(const row of sessions)if(eligible(row,scope)){if(state.parents[row.id]?.identity===parentIdentity(row))parents.set(row.id,row);else state.issues.push('joined-parent-source-not-ready');}const executions=[],relations=[],usage=emptyUsage();for(const [id,row]of parents){const p=state.parents[id];const execution={...p.execution,status:STATUSES.has(row.status)?row.status:'unknown'};if(row.hostPressure?.state==='degraded'||row.hostPressure?.state==='unresponsive'){execution.status='unknown';execution.currentTool=null;}if(execution.status!=='unknown'&&token(row.currentTool,128))execution.currentTool=row.currentTool;else if(row.currentTool===null||row.status==='ended')execution.currentTool=null;if(iso(row.endedAt))execution.endedAt=iso(row.endedAt);if(executions.length<128)executions.push(execution);else if(!state.issues.includes('parent-projection-capacity'))state.issues.push('parent-projection-capacity');for(const k of Object.keys(usage))usage[k]+=p.usage[k];}for(const record of Object.values(state.native)){const row=parents.get(record.rootParentId);if(!row||record.parentIdentity!==parentIdentity(row)||executions.length>=256||!executions.some(e=>e.id===record.execution.parentExecutionId))continue;const execution={...record.execution};if((row.status==='ended'||row.hostPressure?.state==='degraded'||row.hostPressure?.state==='unresponsive')&&['running','queued','started','active'].includes(execution.status)){execution.status='unknown';execution.currentTool=null;}executions.push(execution);relations.push(record.relation);}const actions=state.actions.filter(a=>parents.has(a.rootParentId)&&a.parentIdentity===parentIdentity(parents.get(a.rootParentId))).map(({rootParentId,parentIdentity,...action})=>action);const content={schema:WORKBENCH_SCHEMA,cwd:scope.cwd,adoptionId:scope.adoptionId,charterHash:scope.charterHash,coverage:{partial:state.issues.length>0,reasons:[...new Set(state.issues)].slice(0,32),parentSessions:parents.size,nativeRuns:executions.filter(e=>e.kind==='native-subagent').length},executions,relations,observedUsage:{...usage,metric:'observed-assistant-responses'},actions,...(state.configuration?{configuration:state.configuration,configurationSource:state.configurationSource}:{})};return{...content,revision:'sha256:'+digest(content),updatedAt:state.updatedAt,heartbeatAt};}
  return{tick,readForCaller,close(){if(closed)return;closed=true;let owned=false;try{ownsLock();owned=true;}catch{}try{fs.closeSync(lockFd);}catch{}if(owned)try{fs.unlinkSync(lock);}catch{}}};
}
