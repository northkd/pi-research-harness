import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { charterHash } from '../extensions/research-loop/src/adoption.mjs';
import { readTaskPermissions, updateTaskPermissions, taskPermissionPathDecision, taskPermissionAllowsOperation, recordTaskPermissionBlock, resolveTaskPermissionPath } from '../extensions/research-loop/src/task-permissions.mjs';
import { readTaskPermissionContext } from '../extensions/research-loop/src/task-permission-context.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const NOW = 1780000000000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'task-permissions-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const cwd = path.join(root, 'project'), storeDir = path.join(root, 'grants'), privateDir = path.join(root, 'adoptions'), data = path.join(root, 'data'), outside = path.join(root, 'outside');
  for (const p of [cwd, data, outside]) fs.mkdirSync(p);
  json(path.join(cwd, '.pi/research-loop/state.json'), { schema: 'pi-research-state.v1', charter: { revision: 1, objective: 'Synthetic unattended run', successCriteria: ['Return measured results'] } });
  const b = { cwd, storeDir, charterHash: charterHash(cwd), ownerKey: JSON.stringify(['host', 'inert-operator']) };
  const req = { ...b, confirmed: true, action: 'authorize', expectedRevision: null, requestId: 'synthetic-request-1', task: 'Run the synthetic tests and report', durationHours: 24, capabilities: { localExecution: true, delegation: true, publicResearch: true, projectDependencies: false }, additionalRoots: [data], now: NOW };
  function join(id, owner) {
    const sessionFile = path.join(root, id + '.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd }) + '\n');
    json(sessionFile.slice(0, -6) + '.meta.json', { ...(owner ? { principalOwner: owner } : {}), resWorkflow: { canonicalCwd: cwd, joinedAt: '2026-01-01T00:00:00.000Z', via: 'adoption' } });
    const adoptionId = 'adopt-' + hash(cwd).slice(0, 24), confirmationHash = 'sha256:' + hash('confirmation');
    const ownerKey = owner ? JSON.stringify([owner.iss, owner.sub]) : b.ownerKey;
    const location = path.join(privateDir, hash(ownerKey), hash(cwd));
    json(path.join(location, 'adopted.json'), { confirmed: true, id: adoptionId, confirmationHash });
    json(path.join(location, adoptionId + '.json'), { schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, adoption: { id: adoptionId, cwd, status: 'confirmed' } });
    json(path.join(cwd, '.pi/research-loop/adoptions', adoptionId, 'confirmation.json'), { schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash: b.charterHash, autoRun: false });
    return { cwd, sessionManager: { getSessionId: () => id, getSessionFile: () => sessionFile } };
  }
  return { root, cwd, data, outside, storeDir, privateDir, b, req, join };
}
test('grant lasts 24 hours without activity renewal; exact replay, revision CAS and revoke', t => {
  const f = fixture(t);
  assert.equal(readTaskPermissions({ ...f.b, now: NOW }).status, 'unconfigured');
  const grant = updateTaskPermissions(f.req);
  assert.equal(grant.status, 'active');
  assert.equal(readTaskPermissions({ ...f.b, now: NOW + 13 * 3600000 }).status, 'active');
  assert.deepEqual(updateTaskPermissions({ ...f.req, now: NOW + 10 }), grant);
  assert.throws(() => updateTaskPermissions({ ...f.req, requestId: 'synthetic-request-2' }), /revision-conflict/);
  assert.throws(() => updateTaskPermissions({ ...f.req, task: 'changed' }), /request-conflict/);
  assert.equal(readTaskPermissions({ ...f.b, now: NOW + 24 * 3600000 }).status, 'expired');
  const revoked = updateTaskPermissions({ ...f.b, action: 'revoke', confirmed: true, expectedRevision: grant.revision, requestId: 'synthetic-revoke-1', now: NOW + 20 });
  assert.equal(revoked.status, 'revoked');
  assert.equal(taskPermissionPathDecision(revoked, path.join(f.data, 'x')), null);
  assert.equal(taskPermissionAllowsOperation(revoked, { toolName: 'bash', input: { command: 'python run.py' } }), false);
});
test('path scope follows existing and dangling symlinks; explicit extra-root reads vs writes', t => {
  const f = fixture(t), grant = updateTaskPermissions(f.req);
  assert.equal(taskPermissionPathDecision(grant, path.join(f.data, 'future/result.txt')), 'allow');
  assert.equal(taskPermissionPathDecision(grant, path.join(f.outside, 'result.txt')), 'out-of-scope');
  fs.symlinkSync(f.outside, path.join(f.data, 'escape'));
  assert.equal(taskPermissionPathDecision(grant, path.join(f.data, 'escape/result.txt')), 'out-of-scope');
  fs.symlinkSync(path.join(f.outside, 'future'), path.join(f.data, 'dangling'));
  assert.equal(resolveTaskPermissionPath(path.join(f.data, 'dangling/result.txt')), path.join(f.outside, 'future/result.txt'));
  assert.equal(taskPermissionPathDecision(grant, path.join(f.data, 'dangling/result.txt')), 'out-of-scope');
  const readOnly = { ...grant, capabilities: { ...grant.capabilities, localExecution: false } };
  assert.equal(taskPermissionPathDecision(readOnly, path.join(f.data, 'read.txt'), 'r'), 'allow');
  assert.equal(taskPermissionPathDecision(readOnly, path.join(f.data, 'write.txt'), 'w'), 'out-of-scope');
  assert.throws(() => updateTaskPermissions({ ...f.req, requestId: 'synthetic-system-root', expectedRevision: grant.revision, additionalRoots: ['/etc'] }), /invalid-root/);
});
test('operator identity, charter change and host-private grant store cannot silently widen scope', t => {
  const f = fixture(t), grant = updateTaskPermissions(f.req);
  assert.throws(() => readTaskPermissions({ ...f.b, ownerKey: 'different' }), /owner-mismatch/);
  const file = path.join(f.storeDir, hash(f.cwd) + '.json');
  const linked = path.join(f.root, 'linked-grants'); fs.symlinkSync(f.storeDir, linked);
  assert.throws(() => readTaskPermissions({ ...f.b, storeDir: linked }), /unavailable/);
  fs.linkSync(file, path.join(f.root, 'hardlink'));
  assert.throws(() => readTaskPermissions(f.b), /unavailable/);
  fs.unlinkSync(path.join(f.root, 'hardlink'));
  json(path.join(f.cwd, '.pi/research-loop/state.json'), { charter: { revision: 2, objective: 'Changed', successCriteria: ['Changed'] } });
  assert.throws(() => readTaskPermissions(f.b), /scope-mismatch/);
  assert.equal(readTaskPermissions({ ...f.b, charterHash: charterHash(f.cwd), now: NOW }).status, 'scope-changed');
  assert.equal(grant.inheritance, 'joined-workbench-descendants');
});
test('soft-confirmation scope permits computation and delegation, excludes publication, private-model export and global installs', t => {
  const f = fixture(t), grant = updateTaskPermissions(f.req);
  const op = (toolName, input) => taskPermissionAllowsOperation(grant, { toolName, input });
  assert.equal(op('bash', { command: 'python run_experiment.py' }), true);
  assert.equal(op('research_session', { action: 'spawn' }), true);
  assert.equal(op('research_dispatch', { action: 'plan', tasks: [] }), true);
  assert.equal(taskPermissionAllowsOperation({ ...grant, capabilities: { ...grant.capabilities, delegation: false } }, { toolName: 'research_dispatch', input: { action: 'plan' } }), false);
  for (const action of ['status', 'report', 'atomic', 'cancel']) assert.equal(taskPermissionAllowsOperation({ ...grant, capabilities: { ...grant.capabilities, delegation: false } }, { toolName: 'research_dispatch', input: { action } }), true);
  assert.equal(op('web_search', { query: 'public dataset' }), true);
  for (const name of ['feynman_review', 'hf_jobs', 'send_email', 'mainline_supervision']) assert.equal(op(name, {}), false, name);
  for (const command of ['git push origin main', 'sudo apt install foo', 'npm install foo', 'python -m pip install foo', 'ssh host run.sh', 'docker push image', 'gh pr create']) assert.equal(op('bash', { command }), false, command);
  const deps = { ...grant, capabilities: { ...grant.capabilities, projectDependencies: true } };
  assert.equal(taskPermissionAllowsOperation(deps, { toolName: 'bash', input: { command: 'python -m pip install -r requirements.txt' } }), true);
  assert.equal(taskPermissionAllowsOperation(deps, { toolName: 'bash', input: { command: 'npm install -g foo' } }), false);
  assert.equal(op('parallel', { tool_uses: [{ recipient_name: 'functions.bash', parameters: { command: 'python run.py' } }, { recipient_name: 'functions.research_session', parameters: { action: 'spawn' } }] }), true);
  assert.equal(op('parallel', { tool_uses: [{ recipient_name: 'functions.bash', parameters: { command: 'git push' } }] }), false);
});
test('real verified participants share grant; unjoined, principal mismatch and stale charter do not inherit', t => {
  const f = fixture(t);
  updateTaskPermissions({ ...f.req, now: Date.now() });
  const opts = { storeDir: f.storeDir, privateDir: f.privateDir };
  const parent = f.join('parent'), child = f.join('child');
  for (const ctx of [parent, child]) {
    const context = readTaskPermissionContext(ctx, opts);
    assert.equal(context?.profile.status, 'active');
    assert.equal(context.binding.cwd, f.cwd); // verifier projects no cwd: this asserts actual integration.
    assert.equal(taskPermissionPathDecision(context.profile, path.join(f.data, 'file.txt')), 'allow');
  }
  const stranger = f.join('stranger', { iss: 'test', sub: 'other' });
  assert.equal(readTaskPermissionContext(stranger, opts)?.unavailable, true);
  json(child.sessionManager.getSessionFile().slice(0, -6) + '.meta.json', {});
  assert.equal(readTaskPermissionContext(child, opts), null);
  json(path.join(f.cwd, '.pi/research-loop/state.json'), { charter: { revision: 2, objective: 'Changed', successCriteria: ['Changed'] } });
  assert.equal(readTaskPermissionContext(parent, opts), null);
});
test('blockers are deduplicated and bounded without renewing authorization or its revision', t => {
  const f = fixture(t), grant = updateTaskPermissions(f.req);
  for (let i = 0; i < 3; i++) recordTaskPermissionBlock({ ...f.b, now: NOW + i, code: 'file-access-out-of-scope', tool: 'write', target: f.outside });
  const current = readTaskPermissions({ ...f.b, now: NOW + 10 });
  assert.equal(current.blockers[0].hits, 3);
  assert.equal(current.revision, grant.revision);
  assert.equal(current.expiresAt, grant.expiresAt);
});

test('long diagnostic targets cannot poison the stored grant or prevent revocation', t => {
  const f = fixture(t), grant = updateTaskPermissions(f.req);
  for (let i = 0; i < 25; i++) recordTaskPermissionBlock({ ...f.b, now: NOW + i, code: 'file-access-out-of-scope', tool: 'write', target: '/' + i + '/' + '長'.repeat(4096) });
  const current = readTaskPermissions({ ...f.b, now: NOW + 30 });
  assert.equal(current.status, 'active');
  assert.equal(current.blockers.length, 20);
  assert.equal(current.revision, grant.revision);
  assert.ok(fs.statSync(path.join(f.storeDir, hash(f.cwd) + '.json')).size <= 64 * 1024);
  assert.equal(updateTaskPermissions({ ...f.b, action: 'revoke', confirmed: true, expectedRevision: grant.revision, requestId: 'revoke-after-long-targets', now: NOW + 40 }).status, 'revoked');
});
