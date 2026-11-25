import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test,after } from 'node:test';
import { createWorkbenchSyncCollector,digest } from '../src/workbench-sync.mjs';

const roots=[];after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data),{mode:0o600});};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-heartbeat-'));roots.push(root);
 const options={stateDir:path.join(root,'state'),adoptionRoot:path.join(root,'adoptions'),historyRoots:[path.join(root,'history')],nativeRoots:[],stageMap:path.join(root,'map.json'),now:()=>clock};
 let clock=Date.parse('2030-01-01T00:00:00Z');write(options.stageMap,{stages:{}});
 const f={options,advance:()=>{clock+=10000;return new Date(clock).toISOString();},time:()=>new Date(clock).toISOString()};
 f.add=name=>{const cwd=path.join(root,name),ownerKey=JSON.stringify(['fixture','alice']),adoptionId='adopt-'+digest(name).slice(0,24),charter={objective:'Synthetic heartbeat',successCriteria:['Synthetic check'],frozenAt:'2026-01-01T00:00:00Z'};write(path.join(cwd,'.pi/research-loop/state.json'),{charter});const dir=path.join(options.adoptionRoot,digest(ownerKey),digest(cwd));write(path.join(dir,'adopted.json'),{confirmed:true,id:adoptionId});write(path.join(dir,adoptionId+'.json'),{schema:'pi-res-workflow-operation.v1',ownerKey,cwd,adoption:{id:adoptionId,status:'confirmed'}});const sessionFile=path.join(options.historyRoots[0],name+'.jsonl'),ref={canonicalCwd:cwd,joinedAt:'2026-01-01T00:00:00Z',via:'manual'},row={id:name,cwd,sessionFile,principalOwner:{iss:'fixture',sub:'alice'},resWorkflow:ref,status:'idle'};write(sessionFile,JSON.stringify({type:'session',id:name,cwd,timestamp:'2026-01-01T00:00:01Z'})+'\n');write(sessionFile.replace('.jsonl','.meta.json'),{cwd,principalOwner:row.principalOwner,pluginRefs:{'res-workflow':{resWorkflow:ref}}});return{binding:{cwd,adoptionId,charterHash:'sha256:'+digest(charter)},row};};
 f.start=()=>f.collector=createWorkbenchSyncCollector(options);return f;
}
test('successful unchanged polls renew heartbeat; failed polls and repeated reads cannot renew it',async()=>{
 const f=fixture(),scope=f.add('parent-a');f.start();try{await f.collector.tick();const first=f.collector.readForCaller(scope.binding,[scope.row]);assert.equal(first.heartbeatAt,f.time());f.advance();await f.collector.tick();const unchanged=f.collector.readForCaller(scope.binding,[scope.row]);assert.equal(unchanged.heartbeatAt,f.time());assert.equal(unchanged.revision,first.revision);assert.equal(unchanged.updatedAt,first.updatedAt);f.options.maxStateBytes=1;f.advance();await f.collector.tick();for(let i=0;i<3;i++){const stale=f.collector.readForCaller(scope.binding,[scope.row]);assert.equal(stale.heartbeatAt,unchanged.heartbeatAt);assert.equal(stale.coverage.partial,true);f.advance();}}finally{f.collector.close();}
});
test('a cold worker without a successful poll refuses a fresh observation even with an old checkpoint',async()=>{
 const f=fixture(),scope=f.add('parent-a');f.start();await f.collector.tick();f.collector.close();f.options.maxStateBytes=1;f.advance();f.start();try{await f.collector.tick();assert.throws(()=>f.collector.readForCaller(scope.binding,[scope.row]),/collector-no-successful-tick/);}finally{f.collector.close();}
});
test('a failing scope cannot borrow another scope heartbeat; successful partial reads remain explicitly partial',async()=>{
 const f=fixture(),a=f.add('parent-a'),b=f.add('parent-b');f.start();try{await f.collector.tick();const oldB=f.collector.readForCaller(b.binding,[b.row]).heartbeatAt;fs.appendFileSync(b.row.sessionFile,JSON.stringify({type:'message',id:'new-response',timestamp:'2027-01-01T00:00:00Z',message:{role:'assistant',provider:'synthetic',model:'model',usage:{input:1,output:1},content:[]}})+'\n');f.options.fault=point=>{if(point==='after-journal')throw Error('synthetic scope commit failure');};f.advance();await f.collector.tick();assert.equal(f.collector.readForCaller(a.binding,[a.row]).heartbeatAt,f.time());assert.equal(f.collector.readForCaller(b.binding,[b.row]).heartbeatAt,oldB);delete f.options.fault;fs.appendFileSync(a.row.sessionFile,'{"partial');f.advance();await f.collector.tick();const partial=f.collector.readForCaller(a.binding,[a.row]);assert.equal(partial.heartbeatAt,f.time());assert.equal(partial.coverage.partial,true);}finally{f.collector.close();}
});
test('a failed first scan cannot promote its pending journal timestamp into a successful heartbeat',async()=>{
 const f=fixture(),scope=f.add('parent-a');f.options.fault=point=>{if(point==='after-journal')throw Error('synthetic first scan failure');};f.start();try{await f.collector.tick();assert.throws(()=>f.collector.readForCaller(scope.binding,[scope.row]),/collector-no-successful-tick/);f.advance();assert.throws(()=>f.collector.readForCaller(scope.binding,[scope.row]),/collector-no-successful-tick/);delete f.options.fault;await f.collector.tick();assert.equal(f.collector.readForCaller(scope.binding,[scope.row]).heartbeatAt,f.time());}finally{f.collector.close();}
});
