import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {applySubagentsPatch} from '../scripts/apply-subagents-patch.mjs';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-patch-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'npm/node_modules/pi-subagents');
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'pi-subagents', version: '0.76.1'}));
  fs.writeFileSync(path.join(root, 'fixture.js'), 'before\n');
  const patchFile = path.join(dir, 'change.patch');
  fs.writeFileSync(patchFile, '--- a/fixture.js\n+++ b/fixture.js\n@@ -1 +1 @@\n-before\n+after\n');
  const metadata = {package: 'pi-subagents', version: '0.76.1', path: 'fixture.js', beforeSha256: hash('before\n'), afterSha256: hash('after\n')};
  return {dir, root, metadata, patchFile};
}

test('patch applies using git with hash verification and is idempotent', t => {
  const f = fixture(t);
  assert.deepEqual(applySubagentsPatch(f.dir, f), {patched: true, appliedNow: true});
  assert.deepEqual(applySubagentsPatch(f.dir, {...f, checkOnly: true}), {patched: true, appliedNow: false});
});

test('wrong bytes, absent patch, or package version cannot silently succeed', t => {
  const f = fixture(t);
  assert.throws(() => applySubagentsPatch(f.dir, {...f, checkOnly: true}), /absent/);
  fs.writeFileSync(path.join(f.root, 'fixture.js'), 'unexpected\n');
  assert.throws(() => applySubagentsPatch(f.dir, f), /unknown source/);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({name: 'pi-subagents', version: '9.0.0'}));
  assert.throws(() => applySubagentsPatch(f.dir, f), /version mismatch/);
});

test('failed or exit-zero-no-op patch commands cannot be accepted', t => {
  const f = fixture(t);
  assert.throws(() => applySubagentsPatch(f.dir, {...f, run: () => ({status: 1})}), /command failed/);
  assert.throws(() => applySubagentsPatch(f.dir, {...f, run: () => ({status: 0})}), /hash mismatch/);
});

test('patch metadata names the real deployed one-line nested-route change', () => {
  let metadata;
  try {metadata = JSON.parse(fs.readFileSync(new URL('../config/subagents-patch.json', import.meta.url), 'utf8'));}
  catch (error) {throw new Error('Cannot read released patch fixture', {cause: error});}
  const patch = fs.readFileSync(new URL('../' + metadata.patch, import.meta.url), 'utf8');
  assert.equal(metadata.version, '0.76.1');
  assert.match(patch, /createNestedRoute\(effectiveAsync \? asyncRunId : runId\)/);
  assert.equal(spawnSync('git', ['--version']).status, 0);
});
