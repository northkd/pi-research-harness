import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {syncCliProxy} from '../scripts/sync-cliproxy.mjs';
test('catalog synchronization preserves other providers and stores only an environment reference',async t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cliproxy-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'models.json'),JSON.stringify({providers:{existing:{models:[]}}}));const seen=[];
 const result=await syncCliProxy({agentDir:dir,apiKey:'test-key',fetcher:async(url,opts)=>{seen.push({url,opts});return new Response(JSON.stringify({data:[{id:'model-b'},{id:'model-a'},{id:'model-a'}]}));}});
 const config=JSON.parse(fs.readFileSync(path.join(dir,'models.json'),'utf8'));assert.equal(result.modelCount,2);assert.ok(config.providers.existing);assert.equal(config.providers.cliproxy.apiKey,'$PI_RESEARCH_PROXY_API_KEY');assert.doesNotMatch(JSON.stringify(config),/test-key/);assert.deepEqual(config.providers.cliproxy.models.map(m=>m.id),['model-a','model-b']);assert.equal(seen[0].url,'http://127.0.0.1:8317/v1/models');
});
test('remote endpoints, invalid catalog and symlinked configuration fail without writes',async t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cliproxy-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 await assert.rejects(syncCliProxy({agentDir:dir,apiKey:'test-key',baseUrl:'https://example.invalid/v1'}),/loopback/);await assert.rejects(syncCliProxy({agentDir:dir,apiKey:'test-key',fetcher:async()=>new Response('{"data":[]}') }),/no model/);
 fs.symlinkSync('/dev/null',path.join(dir,'models.json'));await assert.rejects(syncCliProxy({agentDir:dir,apiKey:'test-key',fetcher:async()=>new Response('{"data":[{"id":"demo"}]}')}),/symlink/);
});
