import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reviewGate} from '../src/fusion.mjs';
const executor={registeredTools:['mcp.review.real'],mcpReviewTools:{codex:'mcp.review.real'},reviewerObservation:{modelId:'gpt-6-astra',family:'review',effort:'ultra'},authorObservation:{modelId:'author',family:'author'}};
const response={status:'completed',ok:true,state:'completed',threadId:'thread',responseId:'r1',verdict:'accepted',text:'review'};
test('duplicate review responses cannot satisfy two rounds',()=>{
 const r=reviewGate({backend:'mcp',executor,requiredRounds:2,responses:[response,{...response}]});
 assert.equal(r.verdict,'blocked');assert.equal(r.acceptanceCandidate,false);
});
test('multi-round review requires non-empty distinct response IDs',()=>{
 for(const id of [undefined,'','   ',' r1 ']){
  const r=reviewGate({backend:'mcp',executor,requiredRounds:2,responses:[response,{...response,responseId:id}]});
  assert.equal(r.verdict,'blocked');
 }
 const r=reviewGate({testOnly:true,backend:'mcp',executor,requiredRounds:2,responses:[response,{...response,responseId:'r2'}]});
 assert.equal(r.verdict,'provisional');assert.equal(r.acceptanceCandidate,true);
});
async function execute(run){const source=await readFile(new URL('../workflows/adversarial-review.js',import.meta.url),'utf8');return new Function('args','runs',`return (async()=>{${source}\n})();`)({artifact:'SYNTHETIC'}, {run});}
test('adversarial workflow stops at every failed or empty predecessor',async()=>{
 const keys=['internal','external','author-response','external-rereview'];
 for(let at=0;at<keys.length;at++){
  for(const failure of [{ok:false,state:'cancelled'},{ok:true,output:''},undefined]){
   const calls=[];const r=await execute(async key=>{calls.push(key);return key===keys[at]?failure:{ok:true,output:'synthetic '+key};});
   assert.deepEqual(calls,keys.slice(0,at+1));assert.equal(r.status,'blocked');assert.equal(r.failedStep,keys[at]);
  }
 }
});
test('fresh re-review retains original findings even if author omits them',async()=>{
 const calls=[];const r=await execute(async(key,spec)=>{calls.push({key,task:spec.task});return {ok:true,output:key==='external'?'UNRESOLVED_ORIGINAL_FINDING':key==='author-response'?'AUTHOR_OMITTED_FINDING':'synthetic'};});
 assert.equal(r.status,'provisional');assert.match(calls[3].task,/UNRESOLVED_ORIGINAL_FINDING/);assert.match(calls[3].task,/AUTHOR_OMITTED_FINDING/);assert.match(calls[3].task,/synthetic/);
});
