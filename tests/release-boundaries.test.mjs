import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('undo extension rejects busy command without deferred wait',async()=>{
 const source=await fs.readFile(path.join(root,'extensions/undo-last.ts'),'utf8');
 assert.doesNotMatch(source,/await ctx\.waitForIdle\(/);
 assert.match(source,/if \(!ctx\.isIdle\(\)\)\s*\{[^}]*return;/);
});

test('optional image extension requires an environment credential',async()=>{
 const source=await fs.readFile(path.join(root,'extensions/image-generation.ts'),'utf8');
 assert.match(source,/const API_KEY = process\.env\.CLIPROXY_API_KEY;/);
 assert.match(source,/if \(!API_KEY\)/);
 assert.doesNotMatch(source,/CLIPROXY_API_KEY\s*\|\|/);
});

test('historical three patches retain their boundary; current development has a separate fourth patch',async()=>{
 const frontend=await fs.readFile(path.join(root,'patches/dashboard/0001-deployed-frontend.patch'),'utf8');
 const bridge=await fs.readFile(path.join(root,'patches/dashboard/0002-deployed-native-bridge.patch'),'utf8');
 assert.match(frontend,/撤销并编辑/);
 assert.match(bridge,/native_subagents_snapshot/);
 assert.doesNotMatch(bridge,/session_branch_begin|retryOf|BranchRetryTail|HistoryReplacement/);
 const runtime=await fs.readFile(path.join(root,'patches/dashboard/0003-deployed-runtime-config.patch'),'utf8');
 assert.doesNotMatch(runtime,/session_branch_begin|retryOf|BranchRetryTail|HistoryReplacement/);
 assert.match(runtime,/readContextWindowOverrides/);
 const snapshot=JSON.parse(await fs.readFile(path.join(root,'config/snapshot.json'),'utf8'));
 assert.ok(Object.keys(snapshot.backendHashes).length>=9);
 assert.equal(snapshot.dashboardPatchOrder.length,4);
 assert.equal(snapshot.dashboardPatchOrder[3],'patches/dashboard/0004-current-development.patch');
 const development=await fs.readFile(path.join(root,snapshot.dashboardPatchOrder[3]),'utf8');
 assert.match(development,/goal-turn-budget\.ts/);
 assert.match(development,/packages\/speed-plugin\/src\/server\/stats\.ts/);
 assert.match(development,/session_branch_begin/);
 assert.ok(Object.keys(snapshot.sourceHashes).length>100);
 assert.equal(snapshot.upstream.commit,'04985091706cb77d5e2f73bbf8b906966e9d97c7');
 assert.ok(snapshot.limitations.some(s=>s.includes('development')));
});
