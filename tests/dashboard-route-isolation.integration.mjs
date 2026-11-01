import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { createRequire } from 'node:module';import { pathToFileURL } from 'node:url';
const dashboard=path.resolve(process.env.PI_RESEARCH_DASHBOARD_SOURCE || '.runtime/dashboard-source');
const require=createRequire(path.join(dashboard,'package.json'));const Fastify=require('fastify');
const {registerResWorkflowRoutes}=await import(pathToFileURL(path.join(dashboard,'packages/server/src/routes/res-workflow-routes.ts')).href);

test('workbench proxy enforces workspace access and preserves remote identity',async(t)=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pi-proxy-'));const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);const savedHome=process.env.HOME;process.env.HOME=root;t.after(()=>{process.env.HOME=savedHome;fs.rmSync(root,{recursive:true,force:true})});
 const tokenDir=path.join(root,'.pi/dashboard/local');fs.mkdirSync(tokenDir,{recursive:true});fs.writeFileSync(path.join(tokenDir,'token'),'fixture-transport-key');
 const app=Fastify();t.after(()=>app.close());const owner={iss:'fixture',sub:'owner'};app.addHook('onRequest',async req=>{req.principal=owner;});
 const service={connection:async()=>({adopted:true}),dispose(){}};let known=[cwd];registerResWorkflowRoutes(app,{networkGuard:async()=>{},knownCwds:()=>known,history:()=>[{id:'s',cwd,principalOwner:owner}],historyRoots:()=>[],researchLoopRoot:'/unused',isResolverActive:()=>true,service});
 const savedFetch=globalThis.fetch;const seen=[];globalThis.fetch=async(url,opts)=>{seen.push({url:String(url),headers:opts.headers});return new Response(JSON.stringify({success:true,data:'synthetic'}),{status:200});};t.after(()=>{globalThis.fetch=savedFetch});
 const query=encodeURIComponent(cwd);const r=await app.inject({method:'GET',url:`/api/res-workflow/workbench-sync?cwd=${query}`,headers:{cookie:'session=synthetic','x-forwarded-for':'198.51.100.5'}});
 assert.equal(r.statusCode,200,r.body);assert.equal(seen.length,1);assert.equal(seen[0].headers['x-pi-caller-local'],'0');assert.equal(seen[0].headers.cookie,'session=synthetic');assert.equal(seen[0].headers['x-pi-local-token'],'fixture-transport-key');
 const bad=await app.inject({method:'GET',url:`/api/res-workflow/workbench-sync?cwd=${query}&path=/elsewhere`});assert.equal(bad.statusCode,400);assert.equal(seen.length,1);
 const dpop=await app.inject({method:'GET',url:`/api/res-workflow/workbench-sync?cwd=${query}`,headers:{dpop:'fake'}});assert.equal(dpop.statusCode,403);assert.equal(seen.length,1);
 known=[];const denied=await app.inject({method:'GET',url:`/api/res-workflow/workbench-sync?cwd=${query}`});assert.ok([403,404].includes(denied.statusCode));assert.equal(seen.length,1);
});

test('dashboard can find the explicitly configured research-loop backend and refuses invalid paths',async(t)=>{
 const {resolveInstalledResearchLoopRoot}=await import(pathToFileURL(path.join(dashboard,'packages/server/src/res-workflow/adoption-service.ts')).href);
 const previous=process.env.PI_RESEARCH_LOOP_ROOT;t.after(()=>{if(previous===undefined)delete process.env.PI_RESEARCH_LOOP_ROOT;else process.env.PI_RESEARCH_LOOP_ROOT=previous;});
 const real=path.resolve('extensions/research-loop');process.env.PI_RESEARCH_LOOP_ROOT=real;assert.equal(await resolveInstalledResearchLoopRoot(),fs.realpathSync(real));
 process.env.PI_RESEARCH_LOOP_ROOT=path.join(real,'missing');await assert.rejects(resolveInstalledResearchLoopRoot(),/research-backend-unavailable/);
});
