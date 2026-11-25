import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbenchSyncServer } from '../extensions/research-loop/src/workbench-sync-server.mjs';

const transportToken='fake-transport-key';
function fixture(observation={executions:[]}) {
  const calls=[];
  const observedSessions=[];
  const fetcher=async (url,options)=>{
    calls.push({url,headers:options.headers});
    return new Response(JSON.stringify(url.includes('/api/sessions/archived')
      ? {success:true,data:{items:[{id:'archived-session'}]}}
      : url.includes('/api/sessions')
        ? {success:true,data:[{id:'visible-session'}]}
        : {adopted:true,cwd:'/demo',adoption:{id:'demo'},research:{'state.json':JSON.stringify({charter:{objective:'example',successCriteria:[]}})}}));
  };
  const collector={readForCaller:(_binding,sessions)=>{observedSessions.push(sessions.map(row=>row.id));return observation;}};
  const server=createWorkbenchSyncServer({collector,dashboardOrigin:'http://127.0.0.1:8000',proxyToken:transportToken,fetcher});
  const request=headers=>new Promise(resolve=>{
    const res={statusCode:200,destroyed:false,setHeader(){},end(body){resolve({status:this.statusCode,body:JSON.parse(body)})}};
    server.emit('request',{method:'GET',url:'/api/res-workflow/workbench-sync?cwd=%2Fdemo',headers},res);
  });
  return {calls,request,observedSessions};
}
test('remote caller identity is forwarded without local operator token',async()=>{
  const {calls,request,observedSessions}=fixture();
  const result=await request({'x-pi-local-token':transportToken,'x-pi-caller-local':'0',cookie:'session=synthetic'});
  assert.equal(result.status,200);
  assert.equal(calls.length,6);
  assert.ok(calls.every(c=>!('x-pi-local-token' in c.headers) && c.headers.cookie==='session=synthetic' && c.headers['x-forwarded-for']));
  assert.deepEqual(observedSessions,[['archived-session','visible-session'],['archived-session','visible-session']]);
});
test('explicit verified local caller can use the local credential',async()=>{
  const {calls,request}=fixture();
  const result=await request({'x-pi-local-token':transportToken,'x-pi-caller-local':'1'});
  assert.equal(result.status,200);
  assert.ok(calls.every(c=>c.headers['x-pi-local-token']===transportToken));
});
test('missing or invalid caller classification and invalid transport credential fail closed',async()=>{
  for(const headers of [{},{'x-pi-local-token':transportToken},{'x-pi-local-token':transportToken,'x-pi-caller-local':'bad'}]){
    const {calls,request}=fixture(); const result=await request(headers);
    assert.ok([400,401,403].includes(result.status)); assert.equal(calls.length,0);
  }
});
test('DPoP-bound requests are rejected instead of silently downgraded',async()=>{
  const {calls,request}=fixture(); const result=await request({'x-pi-local-token':transportToken,'x-pi-caller-local':'0',dpop:'synthetic-proof'});
  assert.equal(result.status,403);assert.equal(calls.length,0);
});
test('large workbenches retain their execution and dispatch links',async()=>{
  const executions=Array.from({length:100},(_,i)=>({id:'child-'+i,prompt:'题'.repeat(8000),output:'result'.repeat(4000)}));
  const relations=executions.map(row=>({fromExecutionId:'main',toExecutionId:row.id}));
  const {request}=fixture({executions,relations,coverage:{partial:false,reasons:[]}});
  const result=await request({'x-pi-local-token':transportToken,'x-pi-caller-local':'1'});
  assert.equal(result.status,200);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body))<=512*1024);
  assert.equal(result.body.executions.length,executions.length);
  assert.deepEqual(result.body.relations,relations);
  assert.ok(result.body.coverage.reasons.includes('execution-text-capacity'));
});
