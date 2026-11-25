import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGrantAuthority, isGrantAdmitted, decidePathAccess, createPathGateHandler,
  GrantCache, canonicalSubject } from '../index.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'research-grants-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),cwd=path.join(home,'project'),outside=path.join(home,'other/sub');
  for(const dir of [cwd,outside])await fs.mkdir(dir,{recursive:true});
  const file=path.join(outside,'a.txt');await fs.writeFile(file,'fixture');
  const storeFile=path.join(root,'state/access-grants.json');
  return {root,home,cwd,outside,file,storeFile};
}
async function deny(authority,f,opts={}){return authority.evaluatePath(f.file,[f.cwd],{site:'test',session:'owner-session',...opts});}

test('loads legacy v1 project grants with provenance and without rewriting the file',async t=>{
  const f=await fixture(t);await fs.mkdir(path.dirname(f.storeFile),{recursive:true});
  const data=JSON.stringify({version:1,grants:[{subject:f.outside,scope:'project',grantedAt:1,origin:'old',via:'agent-prompt'},
    {subject:f.cwd,scope:'session',grantedAt:2,origin:'expired'}]});await fs.writeFile(f.storeFile,data);
  const a=createGrantAuthority(f);assert.deepEqual(a.list(),[{subject:f.outside,scope:'project',grantedAt:1,origin:'old',via:'agent-prompt'}]);
  assert.equal((await deny(a,f)).viaGrant,true);assert.equal(await fs.readFile(f.storeFile,'utf8'),data);
  assert.equal(a.revoke(f.outside,'project'),true);assert.equal((await deny(a,f)).allowed,false);
});
test('a live exact-session denial and explicit approval are required; sibling is never named',async t=>{
  const f=await fixture(t),a=createGrantAuthority(f),d=await deny(a,f);
  const input={denialId:d.remedy.denialId,subject:d.remedy.subject,session:'owner-session'};
  assert.equal((await a.createFromDenial({...input,session:'other'},async()=>true)).reason,'unknown-denial');
  assert.equal((await a.createFromDenial({...input,subject:f.cwd},async()=>true)).reason,'unnamed');
  assert.equal((await a.createFromDenial(input,true)).reason,'approval-required');
  assert.equal((await a.createFromDenial(input,async()=>false)).reason,'approval-required');
  const r=await a.createFromDenial(input,async row=>{assert.equal(row.subject,f.outside);return true;});assert.equal(r.ok,true);
  assert.deepEqual(await deny(a,f),{allowed:true,viaGrant:true});
  assert.equal(await isGrantAdmitted(path.join(f.home,'other/sibling.txt'),a.subjects()),false);
  assert.equal((await a.createFromDenial(input,async()=>true)).reason,'unknown-denial');
});
test('session grants disappear on restart; project cap cannot be evicted by session grants',async t=>{
  const f=await fixture(t);await fs.mkdir(path.dirname(f.storeFile),{recursive:true});
  const grants=Array.from({length:205},(_,i)=>({subject:path.join(f.outside,String(i)),scope:'project',grantedAt:i,origin:'old'}));
  await fs.writeFile(f.storeFile,JSON.stringify({version:1,grants}));const a=createGrantAuthority(f);assert.equal(a.list().length,200);
  const d=await deny(a,f);assert.equal((await a.createFromDenial({denialId:d.remedy.denialId,subject:f.outside,scope:'session',session:'owner-session'},async()=>true)).ok,true);
  assert.equal(a.list().length,201);assert.equal(a.subjects({persistedOnly:true}).length,200);
  assert.equal(createGrantAuthority(f).list().length,200);assert.equal(await isGrantAdmitted(f.file,createGrantAuthority(f).subjects()),false);
});

test('approval seals the requested scope and subject before awaiting native control',async t=>{
  const f=await fixture(t),a=createGrantAuthority(f),d=await deny(a,f);
  const input={denialId:d.remedy.denialId,subject:f.outside,scope:'session',session:'owner-session'};
  const result=await a.createFromDenial(input,async()=>{input.scope='project';input.subject=f.cwd;return true;});
  assert.equal(result.ok,true);assert.equal(result.grant.scope,'session');assert.equal(result.grant.subject,f.outside);
  assert.equal(createGrantAuthority(f).list().length,0);
});
test('malformed and unknown versions fail closed; forbidden home and control plane grants are filtered',async t=>{
  const f=await fixture(t);await fs.mkdir(path.dirname(f.storeFile),{recursive:true});
  for(const data of ['{',JSON.stringify({version:2,grants:[{subject:f.outside,scope:'project',grantedAt:1}]}),
    JSON.stringify({version:1,grants:[f.home,path.join(f.home,'.pi'),'/'].map(subject=>({subject,scope:'project',grantedAt:1}))})]){
    await fs.writeFile(f.storeFile,data);assert.equal(createGrantAuthority(f).list().length,0);
  }
});
test('grant canonical subtree does not follow a repointed symlink or widen to sibling repository trees',async t=>{
  const f=await fixture(t);const alias=path.join(f.home,'alias');await fs.symlink(f.outside,alias);const a=createGrantAuthority(f);
  const d=await a.evaluatePath(path.join(alias,'a.txt'),[f.cwd],{session:'s'});
  assert.equal(d.remedy.subject,f.outside);assert.equal((await a.createFromDenial({denialId:d.remedy.denialId,subject:alias,session:'s'},async()=>true)).ok,true);
  assert.equal(await isGrantAdmitted(path.join(alias,'a.txt'),a.subjects()),true);
  await fs.unlink(alias);await fs.symlink(f.cwd,alias);await fs.writeFile(path.join(f.cwd,'a.txt'),'other');
  assert.equal(await isGrantAdmitted(path.join(alias,'a.txt'),a.subjects()),false);
  assert.equal(canonicalSubject(path.join(alias,'a.txt')).canonical,path.join(f.cwd,'a.txt'));
});
test('approval expires while prompt is open and canonical subject replacement cannot redirect approval',async t=>{
  const f=await fixture(t);let clock=1;const a=createGrantAuthority({...f,now:()=>clock});let d=await deny(a,f);
  assert.equal((await a.createFromDenial({denialId:d.remedy.denialId,subject:f.outside,session:'owner-session'},async()=>{clock+=600001;return true;})).reason,'denial-changed');
  d=await deny(a,f);const moved=f.outside+'-old';
  const r=await a.createFromDenial({denialId:d.remedy.denialId,subject:f.outside,session:'owner-session'},async()=>{await fs.rename(f.outside,moved);await fs.symlink(f.cwd,f.outside);return true;});
  assert.equal(r.reason,'denial-changed');assert.equal(a.list().length,0);
});
test('ineligible and quiet sites cannot originate grants and directory denial names exact directory',async t=>{
  const f=await fixture(t),a=createGrantAuthority(f);
  assert.deepEqual(await deny(a,f,{allowGrant:false}),{allowed:false,viaGrant:false});assert.equal(a.denials().length,0);
  assert.equal((await deny(a,f,{quiet:true})).remedy.denialId,undefined);assert.equal(a.denials().length,0);
  const d=await a.evaluatePath(f.outside,[f.cwd],{subjectKind:'directory'});assert.equal(d.remedy.subject,f.outside);
});
test('failed persistence never widens admitted set',async t=>{
  const f=await fixture(t);const blocker=path.join(f.root,'blocker');await fs.writeFile(blocker,'x');
  const a=createGrantAuthority({...f,storeFile:path.join(blocker,'grants.json')});const d=await deny(a,f);
  const r=await a.createFromDenial({denialId:d.remedy.denialId,subject:f.outside,session:'owner-session'},async()=>true);assert.equal(r.reason,'write-failed');assert.equal(a.list().length,0);
});
test('native cache refreshes on revoke and native read/write root semantics stay distinct',async t=>{
  const f=await fixture(t),a=createGrantAuthority(f),d=await deny(a,f);
  await a.createFromDenial({denialId:d.remedy.denialId,subject:f.outside,session:'owner-session'},async()=>true);const cache=new GrantCache({file:f.storeFile});assert.deepEqual(cache.get(),[f.outside]);
  const base={rawPath:f.file,cwd:f.cwd,roots:{workspace:[f.cwd],readOnly:[f.outside],readWrite:[],grants:[]},sensitiveDirs:[],isUngrantable:()=>false};
  assert.equal(decidePathAccess({...base,access:'read'}).verdict,'in-root');assert.equal(decidePathAccess({...base,access:'write'}).verdict,'ask');
  assert.equal(decidePathAccess({...base,access:'write',roots:{...base.roots,grants:cache.get()}}).verdict,'in-root');
  a.revoke(f.outside,'project');assert.deepEqual(cache.get(),[]);
});
test('native handler asks exact directory, confirms persistent approval, and blocks unattended calls',async t=>{
  const f=await fixture(t);let saved;const prompts=[];
  const handler=createPathGateHandler({getConfig:()=>({enabled:true,timeoutSeconds:2}),getRoots:async()=>({workspace:[f.cwd],readOnly:[],readWrite:[],grants:[]}),getGrants:()=>[],getSensitiveDirs:()=>[],isUngrantable:()=>false,
    prompter:{select:async args=>{prompts.push(args);return args.options[1];},confirm:async args=>{prompts.push(args);return true;},cancel(){}},
    grantStoreMatch:()=>true,requestGrant:async args=>{saved=args;return {ok:true};},sessionId:()=> 'native',log(){}});
  const event={toolName:'write',toolCallId:'t',input:{path:f.file,content:'new'}};
  assert.equal((await handler(event,{cwd:f.cwd,hasUI:false})).block,true);
  assert.equal(await handler(event,{cwd:f.cwd,hasUI:true}),undefined);assert.equal(prompts.length,2);assert.equal(saved.subject,f.outside);assert.equal(saved.path,f.file);
  assert.equal(await handler({toolName:'bash',input:{command:'pwd'}},{cwd:f.cwd,hasUI:false}),undefined);
});
