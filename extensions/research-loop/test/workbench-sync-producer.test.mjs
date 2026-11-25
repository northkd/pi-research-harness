import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { test,after } from 'node:test';
import { createWorkbenchSyncCollector,digest } from '../src/workbench-sync.mjs';

const roots=[];after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});};
const runId='00000000-1111-4222-8333-444444444444';
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-producer-'));roots.push(root);
 const cwd=path.join(root,'5-筛选结果分析'),historyRoot=path.join(root,'sessions'),parentFile=path.join(historyRoot,'a'.repeat(90),'b'.repeat(90),'--科研-筛选结果分析--','2026-10-30T01-59-12-925Z_parent-uuid.jsonl');
 const charter={objective:'Synthetic producer metadata',successCriteria:['Metadata matches'],frozenAt:'2026-10-30T00:00:00.000Z'},ownerKey=JSON.stringify(['fixture','alice']),adoptionId='adopt-'+'a'.repeat(24),adoptionRoot=path.join(root,'adoptions'),nativeRoot=path.join(root,'native');
 write(path.join(cwd,'.pi/research-loop/state.json'),{charter});const dir=path.join(adoptionRoot,digest(ownerKey),digest(cwd));write(path.join(dir,'adopted.json'),{id:adoptionId,confirmed:true});write(path.join(dir,adoptionId+'.json'),{schema:'pi-res-workflow-operation.v1',ownerKey,cwd,adoption:{id:adoptionId,status:'confirmed'}});
 const ref={canonicalCwd:cwd,joinedAt:'2026-10-30T00:00:00.000Z',via:'manual'},row={id:'parent-uuid',cwd,sessionFile:parentFile,principalOwner:{iss:'fixture',sub:'alice'},resWorkflow:ref,status:'streaming'};
 write(parentFile,JSON.stringify({type:'session',id:row.id,cwd,timestamp:'2026-10-30T01:59:12.925Z'})+'\n');write(parentFile.replace('.jsonl','.meta.json'),{cwd,principalOwner:row.principalOwner,pluginRefs:{'res-workflow':{resWorkflow:ref}}});
 const childFile=parentFile.slice(0,-6)+'/'+runId+'/run-0/session.jsonl';write(childFile,JSON.stringify({type:'session',id:'child-uuid',cwd,parentSession:parentFile,timestamp:'2026-10-30T08:07:45.319Z'})+'\n');
 const statusFile=path.join(nativeRoot,runId,'status.json'),status={runId,sessionId:parentFile,cwd,mode:'single',state:'failed',startedAt:1793347665319,lastUpdate:1793349470217,sessionFile:childFile,steps:[{agent:'research-numerics',status:'failed',sessionFile:childFile,resolvedModel:{provider:'cliproxy',model:'gpt-6.1-sol(max)[1m]'}}],error:'DO-NOT-KEEP',output:'DO-NOT-KEEP'};
 const options={stateDir:path.join(root,'state'),adoptionRoot,historyRoots:[historyRoot],nativeRoots:[nativeRoot],stageMap:path.join(root,'map.json')};write(options.stageMap,{stages:{}});
 return{root,cwd,row,parentFile,childFile,status,statusFile,options,binding:{cwd,adoptionId,charterHash:'sha256:'+digest(charter)}};
}
test('actual single producer with Unicode parent-file identity, no step runId/index, and resolvedModel.model projects failed once',async()=>{
 const f=fixture();assert.ok(f.parentFile.length>256);write(f.statusFile,f.status);const c=createWorkbenchSyncCollector(f.options);try{await c.tick();const v=c.readForCaller(f.binding,[f.row]),rows=v.executions.filter(e=>e.kind==='native-subagent');assert.equal(rows.length,1);assert.equal(rows[0].nativeRunId,runId);assert.equal(rows[0].status,'failed');assert.equal(rows[0].sessionId,'child-uuid');assert.equal(rows[0].role,'research-numerics');assert.equal(rows[0].observedModel,'cliproxy/gpt-6.1-sol(max)[1m]');assert.equal(v.relations.length,1);assert.equal(JSON.stringify(v).includes('DO-NOT-KEEP'),false);}finally{c.close();}
});
test('the UUID producer parent form remains supported',async()=>{
 const f=fixture();write(f.statusFile,{...f.status,sessionId:f.row.id});const c=createWorkbenchSyncCollector(f.options);try{await c.tick();assert.equal(c.readForCaller(f.binding,[f.row]).executions.find(e=>e.nativeRunId===runId)?.status,'failed');}finally{c.close();}
});
test('same-cwd copied header files and noncanonical path aliases cannot establish a parent',async()=>{
 for(const kind of ['copy','alias']){const f=fixture(),copy=path.join(path.dirname(f.parentFile),'other-parent.jsonl');write(copy,fs.readFileSync(f.parentFile,'utf8'));write(f.statusFile,{...f.status,sessionId:kind==='copy'?copy:path.dirname(f.parentFile)+'/./'+path.basename(f.parentFile)});const c=createWorkbenchSyncCollector(f.options);try{await c.tick();const v=c.readForCaller(f.binding,[f.row]);assert.equal(v.executions.filter(e=>e.kind==='native-subagent').length,0);assert.equal(v.relations.length,0);}finally{c.close();}}
});
test('persisted accepted foreground request is upgraded in place to the proven failed run without duplicate nodes or edges',async()=>{
 const f=fixture(),call={type:'message',id:'call-entry',timestamp:'2026-10-30T08:00:00Z',message:{role:'assistant',content:[{type:'toolCall',id:'launch-tool',name:'subagent',arguments:{agent:'research-numerics',async:true}}]}},result={type:'message',id:'result-entry',timestamp:'2026-10-30T08:00:01Z',message:{role:'toolResult',toolCallId:'launch-tool',toolName:'subagent',details:{mode:'single',runId,asyncId:runId,asyncDir:path.dirname(f.statusFile),results:[]}}};fs.appendFileSync(f.parentFile,JSON.stringify(call)+'\n'+JSON.stringify(result)+'\n');let c=createWorkbenchSyncCollector(f.options);await c.tick();const original=c.readForCaller(f.binding,[f.row]);assert.equal(original.executions.length,2);const originalId=original.executions[1].id;assert.equal(original.executions[1].status,'registered');c.close();
 write(f.statusFile,f.status);c=createWorkbenchSyncCollector(f.options);try{for(let i=0;i<3;i++){await c.tick();const v=c.readForCaller(f.binding,[f.row]),rows=v.executions.filter(e=>e.nativeRunId===runId);assert.equal(v.executions.length,2);assert.equal(rows.length,1);assert.equal(rows[0].id,originalId);assert.equal(rows[0].status,'failed');assert.equal(v.relations.length,1);assert.equal(v.relations[0].toExecutionId,originalId);}}finally{c.close();}
});
