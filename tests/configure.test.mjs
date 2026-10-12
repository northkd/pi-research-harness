import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {configure,makeSettings,makeMcp,repositoryRoot} from '../scripts/configure.mjs';

test('portable settings load this package without copying real auth or model defaults',async()=>{
 const template=JSON.parse(await fs.readFile(path.join(repositoryRoot,'config/settings.example.json'),'utf8'));
 const settings=makeSettings(template,'/example/repository');
 assert.equal(settings.defaultProvider,undefined);
 assert.equal(settings.defaultModel,undefined);
 assert.ok(settings.packages.includes('/example/repository'));
 assert.deepEqual(settings.extensions,['-builtin:mcp']);
 assert.equal(settings.subagents.agentOverrides['research-agy'].thinking,false);
 assert.equal(makeMcp('/example/repository','/example/agent').mcpServers['pi-dashboard'],undefined);
});

test('configure creates only a fresh directory and refuses to overwrite existing settings',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pi-release-config-'));
 const agent=path.join(temp,'agent');
 try{
  const result=await configure(repositoryRoot,agent);
  assert.equal(result.configured,true);
  const names=await fs.readdir(agent);
  assert.ok(names.includes('settings.json'));
  assert.ok(names.includes('models.example.json'));
  assert.ok(!names.includes('auth.json'));
  assert.ok(!names.includes('models.json'));
  assert.ok(!names.includes('sessions'));
  const old=await fs.readFile(path.join(agent,'settings.json'),'utf8');
  await assert.rejects(configure(repositoryRoot,agent),{code:'EEXIST'});
  assert.equal(await fs.readFile(path.join(agent,'settings.json'),'utf8'),old);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('dry-run has no filesystem side effects and optional MCP endpoints stay loopback',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pi-release-dry-'));
 const agent=path.join(temp,'absent');
 try{
  const result=await configure(repositoryRoot,agent,{dashboard:true,browser:true,image:true,dryRun:true});
  assert.equal(result.settings.extensions.at(-1),path.join(repositoryRoot,'extensions/image-generation.ts'));
  assert.equal(result.mcp.mcpServers['pi-dashboard'].url,'http://127.0.0.1:8000/mcp');
  assert.ok(result.mcp.mcpServers['research-browser'].args.includes('--browserUrl=http://127.0.0.1:9222'));
  await assert.rejects(fs.stat(agent),{code:'ENOENT'});
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
