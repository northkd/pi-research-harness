import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {installSkills} from '../scripts/install-skills.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function manifest() {
  try {return JSON.parse(fs.readFileSync(path.join(root, 'config/skill-provenance.json'), 'utf8'));}
  catch (error) {throw new Error('Cannot read checked skill manifest', {cause: error});}
}

test('all released skill files have matching SHA256 and preserve original licenses', () => {
  const m = manifest();
  assert.ok(m.inventory.filter(row => row.status.startsWith('source-vendored')).length >= 88);
  for (const row of m.files) {
    assert.ok(['MIT', 'Apache-2.0'].includes(row.license));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, row.path))).digest('hex'), row.sha256, row.path);
  }
  assert.match(fs.readFileSync(path.join(root, 'vendor/licenses/aris.MIT.txt'), 'utf8'), /wanshuiyin/);
  assert.equal(m.files.length,401);
  assert.equal(m.externalLicensedDependencies.length,2);
  for(const file of m.externalLicensedDependencies){
    assert.equal(file.license,'LPPL-1.3');
    assert.equal(fs.existsSync(path.join(root,file.path)),false);
  }
});

test('skill installer copies to a fresh explicit directory, verifies bytes and never overwrites', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'released-skills-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const dest = path.join(temp, 'skills');
  assert.equal(installSkills(dest, {dryRun: true}).dryRun, true);
  assert.equal(fs.existsSync(dest), false);
  const result = installSkills(dest);
  assert.ok(result.files > 300);
  assert.equal(fs.readFileSync(path.join(dest, 'paper-writing/SKILL.md'), 'utf8'), fs.readFileSync(path.join(root, 'vendor/skills/aris/paper-writing/SKILL.md'), 'utf8'));
  const executable = 'playwright/scripts/playwright_cli.sh';
  assert.ok(fs.statSync(path.join(dest, executable)).mode & 0o100);
  assert.throws(() => installSkills(dest), /nonempty/);
});

test('skill installation rejects hash drift before writing', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'released-skills-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const m = manifest();
  m.files[0].sha256 = 'bad';
  assert.throws(() => installSkills(path.join(temp, 'skills'), {manifest: m}), /hash mismatch/);
  assert.equal(fs.existsSync(path.join(temp, 'skills')), false);
});
