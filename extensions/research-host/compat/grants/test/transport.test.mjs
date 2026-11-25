import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrantAuthority, createNativeGrantTransport, registerNativePathGate } from '../index.mjs';
import { NATIVE_GRANT_PREFIX, NATIVE_GRANT_RECEIPT } from '../transport.mjs';
import { createHostHttpServer, authenticateRequest } from '../../../http.mjs';

async function fixture(t,{http=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-grants-transport-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'cwd'),sessionsDir=path.join(root,'sessions');for(const dir of[cwd,sessionsDir])fs.mkdirSync(dir);
  const row={id:'true-header-id',cwd,sessionFile:path.join(sessionsDir,'different-basename-id.jsonl'),live:true,driver:'pi'};
  fs.writeFileSync(row.sessionFile,JSON.stringify({type:'session',id:row.id,cwd,timestamp:new Date().toISOString()})+'\n');
  const grants=createGrantAuthority({storeFile:path.join(root,'grants.json')});let mode={mode:'default',revision:1};
  const token='a'.repeat(48);const transport=createNativeGrantTransport({grants,sessionsDir,sessions:{getSession:id=>id===row.id?row:null},
    authenticate:request=>request?.testAuth===true||authenticateRequest(request,token),authorizeSession:async()=>true,
    readSessionAccessMode:async()=>mode,getConfig:()=>({enabled:true,timeoutSeconds:2})});
  const identity={sessionId:row.id,cwd,sessionFile:row.sessionFile};
  const invoke=async(suffix,body,request={testAuth:true})=>transport.handle({method:'POST',pathname:NATIVE_GRANT_PREFIX+suffix,body:{...identity,...body},request});
  const append=(prompt,kind,fields,answer)=>fs.appendFileSync(row.sessionFile,JSON.stringify({type:'custom',customType:NATIVE_GRANT_RECEIPT,
    id:crypto.randomUUID(),data:{...identity,...fields,kind,nonce:prompt.body.data.nonce,answer}})+'\n');
  let request;
  if(http){
    const server=createHostHttpServer({token,handle:input=>transport.handle(input)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    request=async(pathname,body)=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}`+pathname,{method:'POST',headers:{'Content-Type':'application/json','x-pi-local-token':token},body:JSON.stringify(body)});
      const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{code:data.error});return data;
    };
  }
  return {root,cwd,row,identity,grants,transport,invoke,append,request,setMode:value=>{mode=value;}};
}

test('native transport requires authenticated exact session/file/cwd and ignores caller approval booleans',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.invoke('connect',{},{}),{code:'research-host-auth-required'});
  await assert.rejects(()=>f.invoke('connect',{sessionId:'filename-id'}),{code:'native-path-session-mismatch'});
  const connected=await f.invoke('connect',{}),channel=connected.body.data.channel;
  await assert.rejects(()=>f.invoke('decide',{channel,cwd:f.root,path:'/outside/a',access:'r',tool:'read'}),{code:'native-path-session-mismatch'});
  await assert.rejects(()=>f.invoke('commit',{channel,promptId:'x',approved:true}),{code:'native-path-request-invalid'});
  assert.equal(f.grants.list().length,0);
});

test('native persisted grant consumes matching select and positive confirm receipts once',async t=>{
  const f=await fixture(t),channel=(await f.invoke('connect',{})).body.data.channel;
  const subject=path.join(os.homedir(),'pi-research-grant-fixture-not-created'),target=path.join(subject,'new.txt');
  const fields={channel,promptId:'select-one',path:target,subject};
  const selection=await f.invoke('prompt',{...fields,kind:'select'});
  await assert.rejects(()=>f.invoke('prompt',{...fields,promptId:'confirm-one',kind:'confirm',selectPromptId:'select-one'}),{code:'native-path-answer-unconfirmed'});
  f.append(selection,'select',fields,`Always allow ${subject}…`);
  const confirmFields={...fields,promptId:'confirm-one'};
  const confirm=await f.invoke('prompt',{...confirmFields,kind:'confirm',selectPromptId:'select-one'});
  await assert.rejects(()=>f.invoke('commit',{channel,promptId:'confirm-one'}),{code:'native-path-answer-unconfirmed'});
  f.append(confirm,'confirm',confirmFields,true);
  const result=await f.invoke('commit',{channel,promptId:'confirm-one'});assert.equal(result.body.data.ok,true);assert.equal(f.grants.list()[0].via,'agent-prompt');
  await assert.rejects(()=>f.invoke('commit',{channel,promptId:'confirm-one'}),{code:'native-path-prompt-expired'});
  assert.equal(fs.existsSync(subject),false);
});

test('native confirmation false and cancelled prompts remain ungranted',async t=>{
  const f=await fixture(t),channel=(await f.invoke('connect',{})).body.data.channel;
  const subject=path.join(os.homedir(),'pi-research-grant-fixture-not-created'),target=path.join(subject,'a.txt');
  const fields={channel,promptId:'s',path:target,subject};const s=await f.invoke('prompt',{...fields,kind:'select'});f.append(s,'select',fields,`Always allow ${subject}…`);
  const cFields={...fields,promptId:'c'};const c=await f.invoke('prompt',{...cFields,kind:'confirm',selectPromptId:'s'});f.append(c,'confirm',cFields,false);
  await assert.rejects(()=>f.invoke('commit',{channel,promptId:'c'}),{code:'native-path-confirm-unconfirmed'});
  await f.invoke('cancel',{channel,promptId:'c'});await assert.rejects(()=>f.invoke('commit',{channel,promptId:'c'}),{code:'native-path-confirm-unconfirmed'});
  assert.equal(f.grants.list().length,0);
});

test('native proof nonce and canonical target changes cannot redirect a confirmed grant',async t=>{
  const f=await fixture(t),channel=(await f.invoke('connect',{})).body.data.channel;
  const subject=path.join(f.root,'outside');fs.mkdirSync(subject);const target=path.join(subject,'a.txt');fs.writeFileSync(target,'fixture');
  const fields={channel,promptId:'s',path:target,subject};const s=await f.invoke('prompt',{...fields,kind:'select'});
  f.append({body:{data:{nonce:'wrong'}}},'select',fields,`Always allow ${subject}…`);
  await assert.rejects(()=>f.invoke('prompt',{...fields,promptId:'c',kind:'confirm',selectPromptId:'s'}),{code:'native-path-answer-unconfirmed'});
  f.append(s,'select',fields,`Always allow ${subject}…`);
  const confirmFields={...fields,promptId:'c'};const c=await f.invoke('prompt',{...confirmFields,kind:'confirm',selectPromptId:'s'});f.append(c,'confirm',confirmFields,true);
  fs.renameSync(subject,subject+'-old');fs.symlinkSync(f.cwd,subject);
  await assert.rejects(()=>f.invoke('commit',{channel,promptId:'c'}),{code:'native-path-subject-changed'});
  assert.equal(f.grants.list().length,0);
});

test('host outage preserves local tool roots and configured persistent grants; no-session never attempts host persistence',async t=>{
  const f=await fixture(t),handlers=new Map();let attempts=0;
  const subject=path.join(os.homedir(),'pi-research-grant-fixture-not-created');
  fs.writeFileSync(f.grants.storeFile,JSON.stringify({version:1,grants:[{subject,scope:'project',grantedAt:1,origin:'old'}]}));
  const configFile=path.join(f.root,'config.json');fs.writeFileSync(configFile,JSON.stringify({accessGrantsFile:f.grants.storeFile}));
  const binder=registerNativePathGate({on:(name,fn)=>handlers.set(name,fn)},{request:async()=>{attempts++;throw new Error('fixture outage');},configFile});t.after(()=>binder.dispose());
  const ctx={cwd:f.cwd,hasUI:false,sessionManager:{getSessionId:()=>f.row.id,getSessionFile:()=>f.row.sessionFile},ui:{notify(){}}};
  await handlers.get('session_start')({},ctx);assert.equal(attempts,1);
  for(const toolName of['read','write','edit']){
    assert.equal(await handlers.get('tool_call')({toolName,input:{path:path.join(f.cwd,'new-file')}},ctx),undefined);
    assert.equal(await handlers.get('tool_call')({toolName,input:{path:path.join(subject,'new-file')}},ctx),undefined);
  }
  assert.equal((await handlers.get('tool_call')({toolName:'read',input:{path:path.join(os.homedir(),'.ssh','not-created')}},ctx)).block,true);
  const noSession={...ctx,sessionManager:{getSessionId:()=> 'memory-session',getSessionFile:()=>undefined}};
  await handlers.get('session_shutdown')();
  await handlers.get('session_start')({},noSession);
  for(const toolName of['read','write','edit'])assert.equal(await handlers.get('tool_call')({toolName,input:{path:path.join(f.cwd,'in-root')}},noSession),undefined);
  assert.ok(attempts>=1);const before=attempts;
  assert.equal(await handlers.get('tool_call')({toolName:'read',input:{path:path.join(f.cwd,'in-root')}},noSession),undefined);assert.equal(attempts,before);
});

test('workspace full-access is consulted per call, including read/write sensitive paths',async t=>{
  const f=await fixture(t),channel=(await f.invoke('connect',{})).body.data.channel;
  const req={channel,path:path.join(os.homedir(),'.ssh','not-created'),access:'w',tool:'write'};
  assert.equal((await f.invoke('decide',req)).body.data.verdict,'decline');f.setMode({mode:'full-access',revision:2});
  assert.equal((await f.invoke('decide',req)).body.data.verdict,'auto-allow');f.setMode({mode:'default',revision:3});
  assert.equal((await f.invoke('decide',req)).body.data.verdict,'decline');assert.equal(f.grants.list().length,0);
});

test('registered native binder uses actual select/confirm API answers and authenticated HTTP before persistence',async t=>{
  const f=await fixture(t,{http:true}),handlers=new Map();const prompts=[];let choice='always',confirm=true;
  const pi={on:(name,fn)=>handlers.set(name,fn),appendEntry:(customType,data)=>fs.appendFileSync(f.row.sessionFile,JSON.stringify({type:'custom',customType,data,id:crypto.randomUUID()})+'\n')};
  const ctx={cwd:f.cwd,hasUI:true,sessionManager:{getSessionId:()=>f.row.id,getSessionFile:()=>f.row.sessionFile},
    ui:{select:async(title,options)=>{prompts.push({title,options});return choice==='always'?options[1]:'Deny';},confirm:async()=>confirm,notify(){}}};
  const binder=registerNativePathGate(pi,{request:f.request});t.after(()=>binder.dispose());await handlers.get('session_start')({},ctx);
  assert.ok(binder.current.gate);const target=path.join(os.homedir(),'pi-research-grant-fixture-not-created/new.txt');
  const call={toolName:'write',toolCallId:'real-ui-call',input:{path:target,content:'not executed'}};
  assert.equal(await handlers.get('tool_call')(call,ctx),undefined);assert.equal(f.grants.list().length,1);assert.equal(prompts.length,1);
  assert.equal(await handlers.get('tool_call')(call,ctx),undefined);assert.equal(prompts.length,1);
  f.grants.revoke(path.dirname(target),'project');choice='deny';const denied=await handlers.get('tool_call')(call,ctx);assert.equal(denied.block,true);assert.equal(f.grants.list().length,0);
  f.setMode({mode:'full-access',revision:9});assert.equal(await handlers.get('tool_call')(call,{...ctx,hasUI:false}),undefined);
  f.setMode({mode:'default',revision:10});assert.equal((await handlers.get('tool_call')(call,{...ctx,hasUI:false})).block,true);
  f.transport.dispose();f.setMode({mode:'full-access',revision:11});
  assert.equal(await handlers.get('tool_call')(call,{...ctx,hasUI:false}),undefined,'host channel restart is rebound before applying mode');
});
