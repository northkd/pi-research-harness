// Filesystem fixtures only: source helper names must not authorize configuration, data or symlink writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainlineStore } from '../src/core.mjs';
import { operationDecision } from '../src/policy.mjs';
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-source-path-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new MainlineStore(cwd);
  const state = { enabled: true, authorized: false, coreRevision: 1, branchRestrictions: [], operationGrants: [] };
  return { cwd, store, decide: value => operationDecision(store, state, { toolName: 'write', input: { path: value, content: '# synthetic source only\n' } }) };
}
test('only approved final Python helper names avoid embedded models false positives', t => {
  const { store, decide } = fixture(t);
  for (const value of ['materials/NaBOF2/prepare_models.py', 'materials/Na3Cr2P2O8F3/test_saved_models.py',
    'materials/NaMg3Si4O11F/prepare_conditional_models.py',
    'materials/Na3Ca3Zr2Si4O15F3/prepare_conditional_models.py',
    'materials/Na3MgMoO3F3/prepare_conditional_models.py']) {
    assert.equal(store.scopePath(value), value);
    assert.equal(decide(value).allow, true, value);
  }
});
test('model configuration, weights, sensitive directories and other ambiguous model leaves stay protected', t => {
  const { store, decide } = fixture(t);
  for (const value of ['models.json', 'model.yaml', 'models.py', 'models/', 'model_weights.bin', 'test_saved_models.json',
    'notes/my_models.json', 'notes/models/config.json', 'prepare_models.py/output.txt', 'prepare_models.py/',
    '.pi/models.json', '.env', 'secrets/prepare_models.py', 'credentials/test_saved_models.py', 'raw/prepare_models.py',
    'trajectories/test_saved_models.py', '../prepare_models.py', '/tmp/test_saved_models.py',
    'prepare_conditional_models.json', 'prepare_conditional_models.py/output.txt',
    'prepare_conditional_models.py/', 'raw/prepare_conditional_models.py',
    'secrets/prepare_conditional_models.py', 'models/prepare_conditional_models.py',
    '../prepare_conditional_models.py', '/tmp/prepare_conditional_models.py']) {
    assert.throws(() => store.scopePath(value), undefined, value);
    const decision = decide(value); assert.equal(decision.allow, false, value); assert.equal(decision.hard, true, value);
  }
});
test('approved helper name does not permit symlink ancestor or target', t => {
  const { cwd, store, decide } = fixture(t);
  fs.mkdirSync(path.join(cwd, 'local'));
  fs.symlinkSync(path.join(cwd, 'local'), path.join(cwd, 'linked'));
  fs.symlinkSync(path.join(cwd, 'local'), path.join(cwd, 'test_saved_models.py'));
  fs.symlinkSync(path.join(cwd, 'local'), path.join(cwd, 'prepare_conditional_models.py'));
  for (const value of ['linked/prepare_models.py', 'test_saved_models.py',
    'linked/prepare_conditional_models.py', 'prepare_conditional_models.py']) {
    assert.throws(() => store.scopePath(value), /Symlink/, value);
    assert.equal(decide(value).hard, true, value);
  }
});
