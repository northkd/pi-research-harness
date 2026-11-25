import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSessionHost } from '../../../session-host/index.mjs';
import { createHostHttpServer, authenticateRequest } from '../../../http.mjs';
import { createGrantAuthority, createNativeGrantTransport } from '../index.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+20000;do{const result=await check();if(result)return result;await pause(25);}while(Date.now()<deadline);throw new Error(label);}

test('installed Pi offline intercepts real built-in read and denies a sensitive target through native UI',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-grants-real-pi-'));
  const cwd=path.join(root,'project'),agent=path.join(root,'agent'),sessionsDir=path.join(root,'history');
  for(const dir of[cwd,agent])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(cwd,'fixture.txt'),'native-path-read-fixture');
  const installAgent=process.env.PI_TEST_AGENT_DIR??path.join(os.homedir(),'.pi/agent');
  const version=fs.readFileSync(path.join(installAgent,'install/current-version'),'utf8').trim();assert.match(version,/^[A-Za-z0-9._+-]+$/);
  const aiStream=path.join(installAgent,'install/releases',version,'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js');
  const binder=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../binder.mjs');
  const extension=path.join(root,'extension.mjs');
  fs.writeFileSync(extension,`import {registerNativePathGate} from ${JSON.stringify(pathToFileURL(binder).href)};
import {AssistantMessageEventStream} from ${JSON.stringify(pathToFileURL(aiStream).href)};
export default function(pi){
  registerNativePathGate(pi,{request:async(pathname,body)=>{const response=await fetch(process.env.PI_GRANT_FIXTURE_BASE+pathname,{method:'POST',headers:{'Content-Type':'application/json','x-pi-local-token':process.env.PI_GRANT_FIXTURE_TOKEN},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;},log:line=>pi.appendEntry('fixture:path-gate-log',{line})});
  pi.registerProvider('research-path-fixture',{api:'research-path-fixture',apiKey:'synthetic-not-a-secret',baseUrl:'http://127.0.0.1',models:[{id:'offline',name:'Offline deterministic path fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024}],streamSimple(model,context){
    const stream=new AssistantMessageEventStream();const last=context.messages.at(-1);let content,stopReason;
    if(last?.role==='toolResult'){content=[{type:'text',text:'fixture complete'}];stopReason='stop';}
    else {const user=context.messages.findLast(message=>message.role==='user');const text=typeof user.content==='string'?user.content:user.content.filter(block=>block.type==='text').map(block=>block.text).join('');const request=JSON.parse(text);content=[{type:'toolCall',id:'fixture-'+crypto.randomUUID(),name:request.tool,arguments:{path:request.path}}];stopReason='toolUse';}
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
    queueMicrotask(()=>{stream.push({type:'start',partial:message});if(stopReason==='toolUse')stream.push({type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message});stream.push({type:'done',reason:stopReason,message});});return stream;}});
}`);
  const token='n'.repeat(48),grants=createGrantAuthority({storeFile:path.join(root,'grants.json')});
  let sessions,transport,started;
  const server=createHostHttpServer({token,handle:input=>transport.handle(input)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    if(started)await sessions.terminate(started.sessionId);sessions?.close();transport?.dispose();
    await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});
  });
  sessions=createSessionHost({stateDir:path.join(root,'host'),sessionsDir,
    piCommand:process.env.PI_RESEARCH_TEST_LAUNCHER??path.join(os.homedir(), '.local/bin/pi'),
    piArgs:['--offline','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','-e',extension],
    env:{HOME:os.homedir(),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_SKIP_VERSION_CHECK:'1',PI_ACCESS_GRANTS_STORE:grants.storeFile,
      PI_GRANT_FIXTURE_BASE:`http://127.0.0.1:${server.address().port}`,PI_GRANT_FIXTURE_TOKEN:token},startupTimeoutMs:20000,pollMs:25});
  transport=createNativeGrantTransport({grants,sessions,sessionsDir,authenticate:req=>authenticateRequest(req,token),authorizeSession:async()=>true,readSessionAccessMode:async()=>({mode:'default',revision:1}),getConfig:()=>({enabled:true,timeoutSeconds:10})});
  started=await sessions.createSession({cwd,sessionId:'native-path-real-offline',model:'research-path-fixture/offline'});
  const events=()=>sessions.readEvents(started.sessionId,{limit:2000}).events.map(row=>row.event);
  const first=await sessions.command(started.sessionId,{type:'prompt',message:JSON.stringify({tool:'read',path:path.join(cwd,'fixture.txt')})});
  assert.equal(first.success,true,JSON.stringify(first));
  const read=await until(()=>events().find(event=>event.type==='tool_execution_end'),'real in-root read did not complete');
  assert.equal(read.isError,false,JSON.stringify(read));assert.match(JSON.stringify(read.result),/native-path-read-fixture/);
  await until(()=>events().find(event=>event.type==='agent_settled'),'in-root turn did not settle');
  const count=events().length;
  await sessions.command(started.sessionId,{type:'prompt',message:JSON.stringify({tool:'read',path:path.join(os.homedir(),'.pi','path-grant-denied-fixture-not-created')})});
  const dialog=await until(()=>events().slice(count).find(event=>event.type==='extension_ui_request'&&event.method==='select'),'sensitive read did not raise native select');
  assert.match(dialog.title,/sensitive location/);assert.deepEqual(dialog.options,['Allow once','Deny']);
  await sessions.respondUI(started.sessionId,{type:'extension_ui_response',id:dialog.id,value:'Deny'});
  const denied=await until(()=>events().slice(count).find(event=>event.type==='tool_execution_end'),'sensitive denial did not settle');
  assert.equal(denied.isError,true);assert.match(JSON.stringify(denied.result),/path-gate: denied/);assert.equal(grants.list().length,0);
  assert.equal(fs.existsSync(grants.storeFile),false);
  const noSessionRun=promisify(execFile)(process.env.PI_RESEARCH_TEST_LAUNCHER??path.join(os.homedir(), '.local/bin/pi'),
    ['--offline','--no-session','--print','--mode','json','--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','-e',extension,'--model','research-path-fixture/offline',JSON.stringify({tool:'read',path:path.join(cwd,'fixture.txt')})],
    {cwd,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_SKIP_VERSION_CHECK:'1',PI_ACCESS_GRANTS_STORE:grants.storeFile,
      PI_GRANT_FIXTURE_BASE:'http://127.0.0.1:1',PI_GRANT_FIXTURE_TOKEN:token},maxBuffer:2*1024*1024,timeout:20000});
  noSessionRun.child.stdin.end();
  const noSession=await noSessionRun;
  const noSessionEvents=noSession.stdout.trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
  const localRead=noSessionEvents.find(event=>event.type==='tool_execution_end');assert.ok(localRead,noSession.stdout+noSession.stderr);
  assert.equal(localRead.isError,false,JSON.stringify(localRead));assert.match(JSON.stringify(localRead.result),/native-path-read-fixture/);
});
