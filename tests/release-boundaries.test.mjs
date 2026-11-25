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

test('published package provides the Dashboard launcher and retains the standalone host',async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 assert.ok(manifest.pi.extensions.includes('./extensions/research-host/native-extension.mjs'));
 for(const expected of ['bin/pi-research-host','extensions/research-host/server.mjs','extensions/research-host/API.md']) await fs.access(path.join(root,expected));
 await fs.access(path.join(root,'bin/pi-research-dashboard'));
 const config=JSON.parse(await fs.readFile(path.join(root,'config/dashboard-v020.json'),'utf8'));
 for (const file of Object.keys(config.files)) await fs.access(path.join(root,'patches/dashboard-v0.20/overlay',file));
});
