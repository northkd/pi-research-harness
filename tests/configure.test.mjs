import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {configure,makeSettings,makeMcp,repositoryRoot} from '../scripts/configure.mjs';

test('portable settings load this package without copying real auth or model defaults',async()=>{
 const template=JSON.parse(await fs.readFile(path.join(repositoryRoot,'config/settings.example.json'),'utf8'));
 const settings=makeSettings(template,'/example/repository');
 assert.equal(settings.defaultProvider,undefined);
 assert.equal(settings.defaultModel,undefined);
 assert.ok(settings.packages.includes('/example/repository'));
 assert.deepEqual(settings.extensions,['-builtin:mcp']);
 assert.equal(settings.subagents.agentOverrides['research-agy'].thinking,false);
 for (const role of ['scout','researcher','reviewer','evidence-auditor','worker','oracle','delegate']) {
  const override = settings.subagents.agentOverrides[role];
  assert.equal(override.advertise,true,role);
  assert.equal(override.thinking,'max',role);
  assert.equal(Object.hasOwn(override,'model'),false,role);
 }
 assert.deepEqual(settings.subagents.agentOverrides['research-theory'],{inheritSkills:false,skills:[],defaultContext:'fresh'});
 assert.deepEqual(settings.compaction,{enabled:true,reserveTokens:16384,keepRecentTokens:20000});
 assert.equal(makeMcp('/example/repository','/example/agent').mcpServers['pi-dashboard'],undefined);
});

test('portable settings retain optional bundled skill filters',async()=>{
 const template=JSON.parse(await fs.readFile(path.join(repositoryRoot,'config/settings.example.json'),'utf8'));
 const settings=makeSettings(template,'/example/repository',{bundledSkills:true});
 assert.ok(settings.skills.includes('/example/repository/vendor/skills/aris'));
 assert.ok(settings.skills.includes('-/example/repository/vendor/skills/aris/paper-writing/SKILL.md'));
});

test('installer optional dry-run forwards only known flags without writing settings',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pi-install-flags-'));
 const agent=path.join(temp,'absent');
 try{
  const result=spawnSync('bash',[path.join(repositoryRoot,'scripts/install.sh'),'--dry-run','--with-browser','--with-bundled-skills'],{encoding:'utf8',env:{...process.env,PI_RESEARCH_AGENT_DIR:agent}});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Pi Research Dashboard/);
  assert.match(result.stdout,/dashboardPluginBridges/);
  const host=spawnSync('bash',[path.join(repositoryRoot,'scripts/install.sh'),'--dry-run','--host-only'],{encoding:'utf8',env:{...process.env,PI_RESEARCH_AGENT_DIR:agent}});
  assert.equal(host.status,0,host.stderr);
  assert.doesNotMatch(host.stdout,/dashboardPluginBridges/);
  assert.match(result.stdout,/vendor\/skills\/aris/);
  await assert.rejects(fs.stat(agent),{code:'ENOENT'});
  assert.equal(spawnSync('bash',[path.join(repositoryRoot,'scripts/install.sh'),'--unknown']).status,2);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
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
  const result=await configure(repositoryRoot,agent,{browser:true,image:true,dryRun:true});
  assert.equal(result.settings.extensions.at(-1),path.join(repositoryRoot,'extensions/image-generation.ts'));
  assert.equal(result.mcp.mcpServers['pi-dashboard'],undefined);
  const browserArgs=result.mcp.mcpServers['research-browser'].args;
  assert.equal(browserArgs[0],path.join(repositoryRoot,'.runtime/browser-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'));
  assert.ok(browserArgs.includes('--browserUrl=http://127.0.0.1:9222'));
  assert.ok(browserArgs.includes('--no-usage-statistics'));
  assert.ok(browserArgs.includes('--no-performance-crux'));
  const example=JSON.parse(await fs.readFile(path.join(repositoryRoot,'config/mcp.example.json'),'utf8'));
  assert.ok(example.mcpServers['research-browser'].args[0].endsWith('/build/src/bin/chrome-devtools-mcp.js'));
  await assert.rejects(fs.stat(agent),{code:'ENOENT'});
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
