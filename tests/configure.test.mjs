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
 assert.equal(settings.subagents.agentOverrides['reviewer'].thinking,'max');
 assert.deepEqual(settings.subagents.agentOverrides['research-theory'],{inheritSkills:false,skills:[],defaultContext:'fresh'});
 assert.deepEqual(settings.compaction,{enabled:true,reserveTokens:16384,keepRecentTokens:20000});
 assert.equal(makeMcp('/example/repository','/example/agent').mcpServers['pi-dashboard'],undefined);
});

test('opt-in dashboard plugin bridges match portable source checkout, not author paths',async()=>{
 const template=JSON.parse(await fs.readFile(path.join(repositoryRoot,'config/settings.example.json'),'utf8'));
 const settings=makeSettings(template,'/example/repository',{dashboard:true,dashboardPlugins:true,bundledSkills:true});
 assert.ok(settings.skills.includes('/example/repository/vendor/skills/aris'));
 assert.ok(settings.skills.includes('-/example/repository/vendor/skills/aris/paper-writing/SKILL.md'));
 assert.equal(Object.keys(settings.dashboardPluginBridges).length,4);
 assert.ok(settings.dashboardPluginBridges['dashboard-flows-anthropic-bridge'].endsWith('/packages/flows-anthropic-bridge-plugin/src/bridge/index.ts'));
 for(const [name,source] of Object.entries(settings.dashboardPluginBridges)){
  assert.ok(settings.packages.includes(source));
  assert.equal(settings._dashboardManagedPackages[source],name);
 }
 assert.throws(()=>makeSettings(template,'/example/repository',{dashboardPlugins:true}),/require dashboard/);
});

test('installer optional dry-run forwards only known flags without writing settings',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pi-install-flags-'));
 const agent=path.join(temp,'absent');
 try{
  const result=spawnSync('bash',[path.join(repositoryRoot,'scripts/install.sh'),'--dry-run','--with-dashboard-plugins','--with-browser','--with-bundled-skills'],{encoding:'utf8',env:{...process.env,PI_RESEARCH_AGENT_DIR:agent}});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/dashboardPluginBridges/);
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
  const result=await configure(repositoryRoot,agent,{dashboard:true,browser:true,image:true,dryRun:true});
  assert.equal(result.settings.extensions.at(-1),path.join(repositoryRoot,'extensions/image-generation.ts'));
  assert.equal(result.mcp.mcpServers['pi-dashboard'].url,'http://127.0.0.1:8000/mcp');
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
