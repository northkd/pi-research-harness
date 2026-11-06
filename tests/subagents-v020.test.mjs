import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {applySubagentsV020} from '../scripts/apply-subagents-v020.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-sub-v020-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const p=path.join(root,'npm/node_modules/pi-subagents');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'package.json'),JSON.stringify({name:'pi-subagents',version:'0.79.2'}));fs.writeFileSync(path.join(p,'a.js'),'old-a\n');fs.writeFileSync(path.join(p,'b.js'),'old-b\n');const patch='--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old-a\n+new-a\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-old-b\n+new-b\n';const patchPath=path.join(root,'change.patch');fs.writeFileSync(patchPath,patch);const metadata={package:'pi-subagents',version:'0.79.2',patchSha256:sha(patch),files:{'a.js':{beforeSha256:sha('old-a\n'),afterSha256:sha('new-a\n')},'b.js':{beforeSha256:sha('old-b\n'),afterSha256:sha('new-b\n')}}};return{root,p,metadata,patchPath};}
test('checks both files, applies the authenticated patch and is idempotent',t=>{const f=fixture(t);assert.equal(applySubagentsV020(f.root,f).appliedNow,true);assert.equal(fs.readFileSync(path.join(f.p,'b.js'),'utf8'),'new-b\n');assert.equal(applySubagentsV020(f.root,{...f,checkOnly:true}).appliedNow,false);});
test('refuses partial states and tampered patches before mutation',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.p,'a.js'),'new-a\n');assert.throws(()=>applySubagentsV020(f.root,f),/partial|unknown/);assert.equal(fs.readFileSync(path.join(f.p,'b.js'),'utf8'),'old-b\n');fs.writeFileSync(path.join(f.p,'a.js'),'old-a\n');fs.appendFileSync(f.patchPath,'tampered');assert.throws(()=>applySubagentsV020(f.root,f),/patch digest/);});

function upgradeFixture(t) {
  const f = fixture(t);
  const newFilePatch = '--- /dev/null\n+++ b/guard.mjs\n@@ -0,0 +1 @@\n+guard\n';
  fs.appendFileSync(f.patchPath, newFilePatch);
  f.metadata.patchSha256 = sha(fs.readFileSync(f.patchPath));
  f.metadata.files['guard.mjs'] = {beforeSha256: null, afterSha256: sha('guard\n')};
  const upgradePath = path.join(f.root, 'upgrade.patch');
  const upgrade = '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-legacy-a\n+new-a\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-legacy-b\n+new-b\n' + newFilePatch;
  fs.writeFileSync(upgradePath, upgrade);
  f.metadata.upgrades = [{patch: upgradePath, patchSha256: sha(upgrade), files: {
    'a.js': sha('legacy-a\n'), 'b.js': sha('legacy-b\n'), 'guard.mjs': null,
  }}];
  return {...f, upgradePath};
}

test('fresh install authenticates newly introduced helper source and remains idempotent', t => {
  const f = upgradeFixture(t);
  assert.equal(applySubagentsV020(f.root, f).appliedNow, true);
  assert.equal(fs.readFileSync(path.join(f.p, 'guard.mjs'), 'utf8'), 'guard\n');
  assert.equal(applySubagentsV020(f.root, {...f, checkOnly: true}).appliedNow, false);
});

test('upgrades a complete previous patch without resetting the installed package', t => {
  const f = upgradeFixture(t);
  fs.writeFileSync(path.join(f.p, 'a.js'), 'legacy-a\n');
  fs.writeFileSync(path.join(f.p, 'b.js'), 'legacy-b\n');
  assert.throws(() => applySubagentsV020(f.root, {...f, checkOnly: true}), /required patch absent/);
  assert.equal(applySubagentsV020(f.root, {...f, patchPath: f.upgradePath}).appliedNow, true);
  assert.equal(applySubagentsV020(f.root, {...f, checkOnly: true}).appliedNow, false);
});

test('mixed upstream, previous and current states are rejected before mutation', t => {
  const f = upgradeFixture(t);
  fs.writeFileSync(path.join(f.p, 'a.js'), 'legacy-a\n');
  assert.throws(() => applySubagentsV020(f.root, f), /partial or unknown/);
  assert.equal(fs.readFileSync(path.join(f.p, 'b.js'), 'utf8'), 'old-b\n');
  fs.writeFileSync(path.join(f.p, 'b.js'), 'legacy-b\n');
  fs.writeFileSync(path.join(f.p, 'guard.mjs'), 'guard\n');
  assert.throws(() => applySubagentsV020(f.root, f), /partial or unknown/);
});

test('wrong version, symlinked new helper and modified upgrade patch are rejected', t => {
  const f = upgradeFixture(t);
  fs.writeFileSync(path.join(f.p, 'package.json'), JSON.stringify({name: 'pi-subagents', version: '0.79.3'}));
  assert.throws(() => applySubagentsV020(f.root, f), /version mismatch/);
  fs.writeFileSync(path.join(f.p, 'package.json'), JSON.stringify({name: 'pi-subagents', version: '0.79.2'}));
  fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.p, 'guard.mjs'));
  assert.throws(() => applySubagentsV020(f.root, f), /symlink rejected/);
  fs.unlinkSync(path.join(f.p, 'guard.mjs'));
  fs.writeFileSync(path.join(f.p, 'a.js'), 'legacy-a\n');
  fs.writeFileSync(path.join(f.p, 'b.js'), 'legacy-b\n');
  fs.appendFileSync(f.upgradePath, 'tampered');
  assert.throws(() => applySubagentsV020(f.root, {...f, patchPath: f.upgradePath}), /patch digest mismatch/);
});

test('failed and false-success patch commands cannot report a successful installation', t => {
  const f = upgradeFixture(t);
  assert.throws(() => applySubagentsV020(f.root, {...f, run: () => ({status: 1})}), /patch command failed/);
  assert.throws(() => applySubagentsV020(f.root, {...f, run: () => ({status: 0})}), /patched source digest mismatch/);
});
