import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {makeSyncConfig} from '../scripts/workbench-sync-launch.mjs';
test('workbench synchronization uses loopback, isolated paths and the supplied local token',()=>{
 const cfg=makeSyncConfig({home:'/tmp/example-home',agentDir:'/tmp/example-agent',repo:'/tmp/example-repo',token:'fixture-transport-key',dashboardPort:18005});
 assert.equal(cfg.bindHost,'127.0.0.1');assert.equal(cfg.port,18767);assert.equal(cfg.dashboardOrigin,'http://127.0.0.1:18005');assert.equal(cfg.agentDir,'/tmp/example-agent/agents');assert.deepEqual(cfg.sessionRoots,['/tmp/example-agent/sessions']);assert.equal(cfg.proxyToken,'fixture-transport-key');assert.ok(path.isAbsolute(cfg.privateDir));
});
test('rejects incomplete, nonabsolute or malformed launcher configuration',()=>{
 assert.throws(()=>makeSyncConfig({home:'relative',agentDir:'/tmp/a',repo:'/tmp/b',token:'fixture-transport-key',dashboardPort:8000}));
 assert.throws(()=>makeSyncConfig({home:'/tmp/h',agentDir:'/tmp/a',repo:'/tmp/b',token:'short',dashboardPort:8000}));
 assert.throws(()=>makeSyncConfig({home:'/tmp/h',agentDir:'/tmp/a',repo:'/tmp/b',token:'fixture-transport-key',dashboardPort:99999}));
});
