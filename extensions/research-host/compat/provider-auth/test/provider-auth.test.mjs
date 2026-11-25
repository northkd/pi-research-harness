import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createProviderAuthApi } from '../index.mjs';
import { loadSelectedPi } from '../runtime.mjs';

const selectedPi=await loadSelectedPi();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){const value=await check();if(value)return value;await pause(5);}throw new Error('fixture state did not settle');}
async function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-auth-fixture-'));const agentDir=path.join(root,'agent');fs.mkdirSync(agentDir,{mode:0o700});
  const changes=[];
  const api=await createProviderAuthApi({agentDir,selectedPi,authenticate:()=>true,onCredentialsChanged:async event=>{changes.push(event);},getCatalogue:async()=>[],...options});
  t.after(()=>{api.dispose();fs.rmSync(root,{recursive:true,force:true});});
  const request=(method,suffix,body)=>api.handle({method,pathname:'/api/provider-auth'+suffix,body,request:{}});
  const write=data=>fs.writeFileSync(api.authFile,JSON.stringify(data),{mode:0o600});
  return {root,agentDir,api,changes,request,write};
}
function provider(id,login){return {id,name:'Local fixture',getModels:()=>[],stream(){throw new Error('no model work');},streamSimple(){throw new Error('no model work');},
  auth:{apiKey:{name:'Fixture API key',check:async({credential})=>credential?.key?{type:'api_key',source:'stored'}:undefined,resolve:async({credential})=>credential?.key?{auth:{apiKey:credential.key}}:undefined},
    oauth:{name:'Local fixture login',isSubscription:true,login,refresh:async()=>{throw new Error('fixture refresh was not requested');},toAuth:async credential=>({apiKey:credential.access})}}};}
const token=()=>({type:'oauth',access:'SYNTHETIC_ACCESS_NOT_REAL',refresh:'SYNTHETIC_REFRESH_NOT_REAL',expires:Date.now()+3600000});

test('actual managed Pi OAuth metadata loads without auth writes, model requests, or token refresh',async t=>{
  const f=await fixture(t,{getCatalogue:undefined});let fetches=0;const original=globalThis.fetch;globalThis.fetch=async()=>{fetches++;throw new Error('external request forbidden in fixture');};t.after(()=>{globalThis.fetch=original;});
  const meta=await f.request('GET','/providers');assert.equal(meta.statusCode,200);assert.ok(meta.body.some(row=>row.id==='openai'));
  assert.ok(meta.body.every(row=>typeof row.name==='string'&&!('auth'in row)));
  assert.equal((await f.request('GET','/handlers')).body.ids.includes('anthropic'),true);
  const status=await f.request('GET','/status');assert.equal(status.statusCode,200);assert.ok(Array.isArray(status.body));
  assert.equal(fs.existsSync(f.api.authFile),false);assert.equal(fetches,0);assert.equal(f.api.runtimeVersion,selectedPi.version);
});

test('API key writes use native lock/format and status never resolves command keys or exposes full keys',async t=>{
  const f=await fixture(t);const marker=path.join(f.root,'command-ran');const resolver=path.join(f.root,'resolve-key.cjs');
  fs.writeFileSync(resolver,`require('fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('SYNTHETIC_COMMAND_RESULT');`);
  const key='!node '+resolver;assert.equal((await f.request('PUT','/api-key',{provider:'unknown-local-provider',key})).body.ok,true);
  assert.equal(fs.statSync(f.api.authFile).mode&0o777,0o600);
  const status=await f.request('GET','/status');assert.equal(status.statusCode,200);assert.equal(fs.existsSync(marker),false);assert.equal(JSON.stringify(status).includes(key),false);
  await assert.rejects(()=>f.api.resolveCredential('unknown-local-provider'),{code:'provider-auth-command-resolution-required'});
  assert.equal(fs.existsSync(marker),false);
  const resolved=await f.api.resolveCredential('unknown-local-provider',{allowCommand:true});assert.equal(resolved.key,'SYNTHETIC_COMMAND_RESULT');assert.equal(fs.existsSync(marker),true);
  assert.equal((await f.request('DELETE','/unknown-local-provider')).body.ok,true);assert.deepEqual(await f.api.credentials.list(),[]);
});

test('native Pi config-value templates resolve for deliberate probes while metadata stays redacted',async t=>{
  const f=await fixture(t);process.env.PI_PROVIDER_AUTH_FIXTURE_VALUE='fixture-environment-value';t.after(()=>delete process.env.PI_PROVIDER_AUTH_FIXTURE_VALUE);
  await f.request('PUT','/api-key',{provider:'fixture-env',key:'prefix-${PI_PROVIDER_AUTH_FIXTURE_VALUE}'});
  assert.equal((await f.api.resolveCredential('fixture-env')).key,'prefix-fixture-environment-value');
  const result=await f.request('GET','/status');assert.equal(JSON.stringify(result).includes('fixture-environment-value'),false);
});

test('a saved key invalidates the actual Pi runtime and becomes its request auth without network',async t=>{
  const f=await fixture(t);f.api.registerOAuthProvider(provider('fixture-runtime',async()=>token()));
  const before=await f.api.loadRuntime();assert.equal(await before.getAuth('fixture-runtime'),undefined);
  const saved=await f.request('PUT','/api-key',{provider:'fixture-runtime-api',key:'SYNTHETIC_NATIVE_REQUEST_KEY'});assert.equal(saved.body.ok,true);
  const after=await f.api.loadRuntime();assert.notEqual(before,after);
  const resolved=await after.getAuth('fixture-runtime');assert.equal(resolved.auth.apiKey,'SYNTHETIC_NATIVE_REQUEST_KEY');
  assert.equal(f.changes.at(-1).provider,'fixture-runtime');
});

test('a custom Radius gateway never offers the default Radius OAuth handler',async t=>{
  const f=await fixture(t);fs.writeFileSync(path.join(f.agentDir,'models.json'),JSON.stringify({providers:{radius:{oauth:'radius',baseUrl:'http://127.0.0.1:1/v1'}}}));
  const meta=await f.request('GET','/providers');assert.equal(meta.statusCode,200);assert.equal(meta.body.some(row=>row.id==='radius'),false);
  const login=await f.request('POST','/start',{provider:'radius'});assert.equal(login.statusCode,409);assert.equal(fs.existsSync(f.api.authFile),false);
});

test('provider-owned OAuth manual input persists only a real completed credential and not the submitted code',async t=>{
  const f=await fixture(t);let seen;
  f.api.registerOAuthProvider(provider('fixture-login',async interaction=>{
    interaction.notify({type:'auth_url',url:'http://127.0.0.1/fixture-authorize?state=local-state'});
    seen=await interaction.prompt({type:'manual_code',message:'Paste the local fixture code'});return token();
  }));
  const started=await f.request('POST','/start',{provider:'fixture-login'});assert.equal(started.statusCode,200);assert.equal(started.body.status,'pending');assert.ok(started.body.authUrl);
  const flowId=started.body.flowId;assert.equal(started.body.pending.kind,'manual_code');
  assert.equal((await f.request('POST',`/flow/${flowId}/input`,{value:'PRIVATE_FIXTURE_CODE'})).statusCode,202);
  const complete=await until(async()=>{const out=await f.request('GET',`/flow/${flowId}`);return out.body.status==='complete'&&out;});
  assert.equal(complete.body.refreshStatus,'complete');assert.equal(seen,'PRIVATE_FIXTURE_CODE');
  const bytes=fs.readFileSync(f.api.authFile,'utf8');assert.equal(bytes.includes('PRIVATE_FIXTURE_CODE'),false);
  assert.equal(JSON.stringify(await f.request('GET','/status')).includes('SYNTHETIC_ACCESS_NOT_REAL'),false);
  assert.equal((await f.api.credentials.read('fixture-login')).type,'oauth');assert.equal(f.changes.length,1);
  assert.equal((await f.request('PUT','/api-key',{provider:'fixture-login-api',key:'fixture-key'})).statusCode,409);
  const wrong=await f.request('DELETE','/fixture-login-api');assert.equal(wrong.statusCode,409);assert.equal(wrong.body.vars.storedType,'oauth');
  assert.equal((await f.request('DELETE','/fixture-login')).body.ok,true);assert.equal((await f.api.credentials.list()).length,0);
});

test('cancelling and superseding a login closes its local callback listener before replacement',async t=>{
  const f=await fixture(t);let active=0,max=0;const listeners=[];
  f.api.registerOAuthProvider(provider('fixture-listener',async interaction=>{
    const server=createServer((_request,response)=>response.end('fixture'));listeners.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));active++;max=Math.max(max,active);
    try{interaction.notify({type:'auth_url',url:`http://127.0.0.1:${server.address().port}/login`});await interaction.prompt({type:'manual_code',message:'Local callback or manual code'});return token();}
    finally{await new Promise(resolve=>server.close(resolve));active--;}
  }));
  const first=await f.request('POST','/start',{provider:'fixture-listener'});assert.equal(active,1);
  const second=await f.request('POST','/start',{provider:'fixture-listener'});assert.equal(second.statusCode,200);assert.equal(max,1);
  assert.equal((await f.request('GET',`/flow/${first.body.flowId}`)).body.error,'Cancelled');
  assert.equal((await f.request('DELETE',`/flow/${second.body.flowId}`)).statusCode,204);
  await until(()=>active===0);assert.ok(listeners.every(server=>!server.listening));assert.equal(fs.existsSync(f.api.authFile),false);
});

test('cancelled late credentials and timed-out quiet login cannot persist',async t=>{
  const f=await fixture(t,{startTimeoutMs:25});let finish;
  f.api.registerOAuthProvider(provider('fixture-late',async interaction=>{interaction.notify({type:'device_code',userCode:'LOCAL-CODE',verificationUri:'http://127.0.0.1/local'});return new Promise(resolve=>{finish=()=>resolve(token());});}));
  const start=await f.request('POST','/start',{provider:'fixture-late'});await f.request('DELETE',`/flow/${start.body.flowId}`);finish();
  await until(async()=>(await f.request('GET',`/flow/${start.body.flowId}`)).body.error==='Cancelled');assert.equal(fs.existsSync(f.api.authFile),false);
  let cancelled=false;f.api.registerOAuthProvider(provider('fixture-quiet',interaction=>new Promise((_resolve,reject)=>interaction.signal.addEventListener('abort',()=>{cancelled=true;reject(new Error('Cancelled'));},{once:true}))));
  assert.equal((await f.request('POST','/start',{provider:'fixture-quiet'})).statusCode,504);await until(()=>cancelled);assert.equal(fs.existsSync(f.api.authFile),false);
});

test('secret prompts are supported and provider errors cannot echo submitted secret values',async t=>{
  const f=await fixture(t);f.api.registerOAuthProvider(provider('fixture-secret',async interaction=>{const value=await interaction.prompt({type:'secret',message:'Local one-time secret'});throw new Error('Rejected '+value);}));
  const start=await f.request('POST','/start',{provider:'fixture-secret'});assert.equal(start.body.pending.kind,'secret');
  await f.request('POST',`/flow/${start.body.flowId}/input`,{value:'DO_NOT_ECHO_THIS_FIXTURE_SECRET'});
  const failed=await until(async()=>{const result=await f.request('GET',`/flow/${start.body.flowId}`);return result.body.status==='error'&&result;});
  assert.equal(JSON.stringify(failed).includes('DO_NOT_ECHO_THIS_FIXTURE_SECRET'),false);assert.match(failed.body.error,/withheld/);assert.equal(fs.existsSync(f.api.authFile),false);
});

test('native parallel writers preserve all providers and corrupt, symlink, or public stores are refused',async t=>{
  const f=await fixture(t);await f.request('PUT','/api-key',{provider:'initial',key:'fixture'});
  const native=selectedPi.sdk.AuthStorage.create(f.api.authFile);
  await Promise.all([f.request('PUT','/api-key',{provider:'one',key:'fixture-one'}),f.request('PUT','/api-key',{provider:'two',key:'fixture-two'}),native.modify('native',async()=>({type:'api_key',key:'fixture-native'}))]);
  assert.deepEqual((await f.api.credentials.list()).map(row=>row.providerId).sort(),['initial','native','one','two']);
  const broken='{ "private": "DO_NOT_ECHO_CORRUPT_FIXTURE';fs.writeFileSync(f.api.authFile,broken);
  const refused=await f.request('PUT','/api-key',{provider:'one',key:'new-fixture'});assert.equal(refused.statusCode,503);assert.equal(JSON.stringify(refused).includes('DO_NOT_ECHO'),false);assert.equal(fs.readFileSync(f.api.authFile,'utf8'),broken);
  fs.unlinkSync(f.api.authFile);const other=path.join(f.root,'other.json');fs.writeFileSync(other,'{}',{mode:0o600});fs.symlinkSync(other,f.api.authFile);
  assert.equal((await f.request('PUT','/api-key',{provider:'one',key:'fixture'})).statusCode,503);assert.equal(fs.readFileSync(other,'utf8'),'{}');
  fs.unlinkSync(f.api.authFile);fs.writeFileSync(f.api.authFile,'{}',{mode:0o644});assert.equal((await f.request('PUT','/api-key',{provider:'one',key:'fixture'})).statusCode,503);
});

test('unknown stored OAuth remains visible/removable and missing extension login is an explicit failure',async t=>{
  const f=await fixture(t);f.write({'unregistered-plugin':token()});
  const status=await f.request('GET','/status');assert.equal(status.body.find(row=>row.id==='unregistered-plugin').authenticated,true);
  const failed=await f.request('POST','/start',{provider:'unregistered-plugin'});assert.equal(failed.statusCode,409);assert.equal(failed.body.code,'provider-auth-login-unavailable');
  assert.equal((await f.request('DELETE','/unregistered-plugin')).body.ok,true);
  assert.equal((await f.request('GET','/radius/mcp')).statusCode,503);
});

test('authentication blocks access and refresh failure reports that the credential was actually saved',async t=>{
  const denied=await fixture(t,{authenticate:()=>false});assert.equal((await denied.request('PUT','/api-key',{provider:'one',key:'fixture'})).statusCode,403);assert.equal(fs.existsSync(denied.api.authFile),false);
  const f=await fixture(t,{onCredentialsChanged:async()=>{throw new Error('SYNTHETIC_INTERNAL_SECRET');}});
  const saved=await f.request('PUT','/api-key',{provider:'one',key:'fixture-key'});assert.equal(saved.statusCode,503);assert.equal(saved.body.credentialApplied,true);assert.equal(JSON.stringify(saved).includes('SYNTHETIC_INTERNAL_SECRET'),false);
  assert.equal((await f.api.credentials.read('one')).key,'fixture-key');
});
