import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = path.join(root, 'extensions/mainline-supervision');

test('root Pi package discovers supervision once without opt-in model execution', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.pi.extensions.filter(p => p.includes('mainline-supervision')).length, 1);
  assert.ok(pkg.pi.extensions.includes('./extensions/mainline-supervision/src/index.ts'));
  const role = await fs.readFile(path.join(root, 'agents/research-mainline-supervisor.md'), 'utf8');
  assert.match(role, /tools: read, grep, find, ls/);
  assert.match(role, /defaultContext: fresh/);
  assert.match(role, /inheritProjectContext: false/);
  assert.doesNotMatch(role, /^model:/m);
});

test('missing exact local supervisor model refuses setup with no fallback', () => {
  const env = { ...process.env }; delete env.PI_RESEARCH_SUPERVISOR_MODEL;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import {MainlineStore, MODEL} from './extensions/mainline-supervision/src/core.mjs';
    const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-config-'));
    try { if(MODEL!=='') throw Error('Unexpected default');
      try {new MainlineStore(cwd).configure({coreText:'Synthetic only',authorized:true});process.exitCode=1;}
      catch(error){if(!error.message.includes('PI_RESEARCH_SUPERVISOR_MODEL'))throw error;}
    } finally {fs.rmSync(cwd,{recursive:true,force:true});}
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('portable source provenance hashes current module bytes, never author runtime state', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'config/mainline-supervision-source.json'), 'utf8'));
  assert.equal(manifest.liveNewModelRoundtrip, 'NOT_RUN');
  assert.equal(manifest.persistentWorkflowHumanAdjudication, 'NOT_IMPLEMENTED');
  for (const entry of manifest.files) {
    assert.ok(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'));
    const bytes = await fs.readFile(path.join(moduleRoot, entry.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.path);
  }
});

test('capture host source manifest refers only to released existing files', async () => {
  const source = await fs.readFile(path.join(moduleRoot, 'src/capture.mjs'), 'utf8');
  const files = source.match(/const HOST_FILES = \[([^\]]+)\]/)[1].match(/'[^']+'/g).map(s => s.slice(1, -1));
  assert.ok(files.includes('src/policy.mjs'));
  assert.ok(!files.includes('scripts/install-local.mjs'));
  for (const name of files) assert.ok((await fs.stat(path.join(moduleRoot, name))).isFile());
});
