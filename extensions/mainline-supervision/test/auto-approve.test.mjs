// Pure synthetic persistence checks. No Pi host, model, network or project data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_APPROVE_SCHEMA, autoApproveDefault, autoApproveExplicitlyDisabled,
  autoApproveStatePath, readAutoApproveState, writeAutoApproveState } from '../src/auto-approve.mjs';

const base = () => fs.mkdtempSync(path.join(process.env.PI_RESEARCH_TEST_TMP || os.tmpdir(), 'auto-approve-'));
const cleanup = dirs => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); };

test('default is on; explicit env/options false is honored', () => {
  assert.equal(autoApproveDefault({}, {}), true);
  assert.equal(autoApproveDefault({ PI_RESEARCH_AUTO_APPROVE_SUPERVISION: '1' }, {}), true);
  assert.equal(autoApproveDefault({ PI_RESEARCH_AUTO_APPROVE_SUPERVISION: '0' }, {}), false);
  assert.equal(autoApproveDefault({ PI_RESEARCH_AUTO_APPROVE_SUPERVISION: 'false' }, {}), false);
  assert.equal(autoApproveDefault({}, { autoApprove: false }), false);
  assert.equal(autoApproveExplicitlyDisabled({ PI_RESEARCH_AUTO_APPROVE_SUPERVISION: '0' }, {}), true);
  assert.equal(autoApproveExplicitlyDisabled({}, { autoApprove: false }), true);
  assert.equal(autoApproveExplicitlyDisabled({}, {}), false);
});

test('state path requires an absolute project directory', () => {
  assert.equal(autoApproveStatePath(undefined), undefined);
  assert.equal(autoApproveStatePath(''), undefined);
  assert.equal(autoApproveStatePath('relative/project'), undefined);
  assert.equal(autoApproveStatePath('/project'), path.join('/project', '.pi/mainline-supervision/auto-approve.json'));
});

test('write/read roundtrip is per-cwd, private and leaves no temp file', t => {
  const a = base(), b = base(), dirs = [a, b];
  t.after(() => cleanup(dirs));
  assert.equal(readAutoApproveState(a).status, 'absent');
  assert.deepEqual(writeAutoApproveState(a, false), { persisted: true });
  assert.deepEqual(writeAutoApproveState(b, true), { persisted: true });
  assert.deepEqual(readAutoApproveState(a), { status: 'restored', autoApprove: false });
  assert.deepEqual(readAutoApproveState(b), { status: 'restored', autoApprove: true });
  const file = autoApproveStatePath(a);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: AUTO_APPROVE_SCHEMA, autoApprove: false });
  assert.deepEqual(writeAutoApproveState(a, true), { persisted: true });
  assert.deepEqual(readAutoApproveState(a), { status: 'restored', autoApprove: true });
});

test('malformed, wrong-schema and oversized state are rejected', t => {
  const dirs = [base(), base(), base()];
  t.after(() => cleanup(dirs));
  for (const [i, body] of ['{not json', JSON.stringify({ schema: 'other', autoApprove: true }), 'x'.repeat(2048)].entries()) {
    const file = autoApproveStatePath(dirs[i]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const result = readAutoApproveState(dirs[i]);
    assert.equal(result.status, 'invalid');
    assert.ok(result.error);
  }
  const extra = base(); t.after(() => cleanup([extra]));
  const file = autoApproveStatePath(extra);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: AUTO_APPROVE_SCHEMA, autoApprove: true, extra: 1 }));
  assert.equal(readAutoApproveState(extra).status, 'invalid');
});

test('symlinked settings file or parent is unsafe for read and write', t => {
  const root = base(), target = base(), dirs = [root, target];
  t.after(() => cleanup(dirs));
  const real = path.join(target, 'auto-approve.json');
  fs.writeFileSync(real, JSON.stringify({ schema: AUTO_APPROVE_SCHEMA, autoApprove: true }));
  const file = autoApproveStatePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(real, file);
  assert.equal(readAutoApproveState(root).status, 'unsafe');
  const write = writeAutoApproveState(root, false);
  assert.equal(write.persisted, false);
  assert.match(write.error, /not a regular file/);

  const root2 = base(), target2 = base(), dirs2 = [root2, target2];
  t.after(() => cleanup(dirs2));
  fs.mkdirSync(path.join(target2, 'state'), { recursive: true });
  fs.writeFileSync(path.join(target2, 'state', 'auto-approve.json'), JSON.stringify({ schema: AUTO_APPROVE_SCHEMA, autoApprove: false }));
  fs.mkdirSync(path.join(root2, '.pi'), { recursive: true });
  fs.symlinkSync(path.join(target2, 'state'), path.join(root2, '.pi', 'mainline-supervision'));
  assert.equal(readAutoApproveState(root2).status, 'unsafe');
  assert.equal(writeAutoApproveState(root2, true).persisted, false);
});

test('write failures are returned, not reported as success', t => {
  const blockedParent = base(), dirAsState = base(), dirs = [blockedParent, dirAsState];
  t.after(() => cleanup(dirs));
  fs.mkdirSync(path.join(blockedParent, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(blockedParent, '.pi', 'mainline-supervision'), 'not a directory');
  const parentFailure = writeAutoApproveState(blockedParent, true);
  assert.equal(parentFailure.persisted, false);
  assert.ok(parentFailure.error);

  const dirFile = autoApproveStatePath(dirAsState);
  fs.mkdirSync(dirFile, { recursive: true });
  const dirFailure = writeAutoApproveState(dirAsState, true);
  assert.equal(dirFailure.persisted, false);
  assert.match(dirFailure.error, /not a regular file/);

  assert.deepEqual(writeAutoApproveState(dirAsState, 'yes'), { persisted: false, error: 'Auto-approve value must be boolean' });
});
