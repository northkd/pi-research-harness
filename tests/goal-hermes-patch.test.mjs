import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {applyGoalHermesPatch} from '../scripts/apply-goal-hermes-patch.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hermes-patch-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'npm/node_modules/@test/goal');
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: '@test/goal', version: '0.1.0'}));
  const files = {};
  let patch = '';
  for (const name of ['engine.ts', 'state.ts']) {
    fs.writeFileSync(path.join(root, name), 'before\n');
    files[name] = {beforeSha256: sha('before\n'), afterSha256: sha('after\n')};
    patch += `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-before\n+after\n`;
  }
  const patchFile = path.join(dir, 'change.patch');
  fs.writeFileSync(patchFile, patch);
  const metadata = {package: '@test/goal', version: '0.1.0', files, patchSha256: sha(patch)};
  return {dir, root, patchFile, metadata};
}

test('dry-run has no writes, explicit apply checks all files and repeated apply is idempotent', t => {
  const f = fixture(t);
  assert.deepEqual(applyGoalHermesPatch(f.dir, f), {patched: false, wouldApply: true, files: 2});
  assert.equal(fs.readFileSync(path.join(f.root, 'engine.ts'), 'utf8'), 'before\n');
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, checkOnly: true}), /absent/);
  assert.equal(applyGoalHermesPatch(f.dir, {...f, apply: true}).appliedNow, true);
  assert.equal(fs.readFileSync(path.join(f.root, 'state.ts'), 'utf8'), 'after\n');
  assert.deepEqual(applyGoalHermesPatch(f.dir, {...f, apply: true}), {patched: true, appliedNow: false});
  assert.deepEqual(applyGoalHermesPatch(f.dir, {...f, checkOnly: true}), {patched: true, appliedNow: false});
});

test('partially patched or locally edited files refuse the entire mutation', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'engine.ts'), 'after\n');
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, apply: true}), /unknown or partially/);
  assert.equal(fs.readFileSync(path.join(f.root, 'state.ts'), 'utf8'), 'before\n');
  fs.writeFileSync(path.join(f.root, 'engine.ts'), 'local edit\n');
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, apply: true}), /unknown or partially/);
});

test('wrong package version, changed patch and symlink source refuse before writes', t => {
  const f = fixture(t);
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, metadata: {...f.metadata, version: '9.0.0'}, apply: true}), /version/);
  fs.appendFileSync(f.patchFile, '\n');
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, apply: true}), /checksum/);
  fs.unlinkSync(path.join(f.root, 'state.ts'));
  fs.symlinkSync(path.join(f.root, 'engine.ts'), path.join(f.root, 'state.ts'));
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, apply: true}), /unsafe/);
  assert.equal(fs.readFileSync(path.join(f.root, 'engine.ts'), 'utf8'), 'before\n');
});

test('a complete previous Goal release upgrades, while mixed inventories cannot', t => {
  const f = fixture(t);
  let patch = '';
  const files = {};
  for (const name of Object.keys(f.metadata.files)) {
    fs.writeFileSync(path.join(f.root, name), 'previous\n');
    files[name] = sha('previous\n');
    patch += `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-previous\n+after\n`;
  }
  fs.writeFileSync(f.patchFile, patch);
  f.metadata.upgrades = [{files, patchSha256: sha(patch)}];
  assert.equal(applyGoalHermesPatch(f.dir, {...f, apply: true}).appliedNow, true);
  assert.equal(applyGoalHermesPatch(f.dir, {...f, checkOnly: true}).patched, true);
  fs.writeFileSync(path.join(f.root, 'state.ts'), 'previous\n');
  assert.throws(() => applyGoalHermesPatch(f.dir, {...f, apply: true}), /unknown or partially/);
});

test('released Goal patches authenticate their complete source and upgrade inventories', () => {
  const repo = new URL('../', import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(new URL('config/goal-hermes-patch.json', repo), 'utf8'));
  for (const release of [metadata, ...(metadata.upgrades ?? [])]) {
    assert.equal(sha(fs.readFileSync(new URL(release.patch, repo))), release.patchSha256);
    assert.deepEqual(Object.keys(release.files).sort(), Object.keys(metadata.files).sort());
  }
});
