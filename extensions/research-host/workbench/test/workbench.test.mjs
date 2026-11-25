import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../index.mjs';
import { createWorkbenchPolicies } from '../policies/index.mjs';
import { createResWorkflowService } from '../../adoption/index.mjs';

const repository = process.env.PI_RESEARCH_TEST_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
const researchLoopRoot = path.join(repository, 'research-loop');
const { configureResearch, charterHash } = await import(path.join(researchLoopRoot, 'src/adoption.mjs'));
const digest = value => createHash('sha256').update(value).digest('hex');
const LOCAL_OPERATOR = Object.freeze({ iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 }); };

async function fixture(t, { owner, realm = ['host', 'inert-operator'] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'research-host-workbench-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'), privateDir = path.join(base, 'private');
  fs.mkdirSync(cwd); fs.mkdirSync(privateDir);
  configureResearch(cwd, { objective: 'Synthetic migration proof', successCriteria: ['Preserve current evidence'] });
  const sessionFile = path.join(base, 'sessions', 'parent.jsonl');
  const parent = { id: 'parent', cwd, sessionFile, status: 'idle', ...(owner ? { principalOwner: owner } : {}) };
  const rows = [parent];
  write(sessionFile, { type: 'session', id: parent.id, cwd, version: 3 });
  const marker = { canonicalCwd: cwd, joinedAt: '2026-10-30T01:00:00.000Z', via: 'manual' };
  const metadata = { cwd, ...(owner ? { principalOwner: owner } : {}), pluginRefs: { 'res-workflow': { resWorkflow: marker } } };
  write(sessionFile.replace(/\.jsonl$/, '.meta.json'), metadata);
  parent.pluginRefs = metadata.pluginRefs; parent.resWorkflow = marker;
  const ownerKey = JSON.stringify(owner ? [owner.iss, owner.sub] : realm);
  const scope = path.join(privateDir, digest(ownerKey), digest(cwd));
  const adoptionId = 'adopt-0123456789abcdef01234567', confirmationHash = 'sha256:' + 'a'.repeat(64);
  write(path.join(scope, 'adopted.json'), { confirmed: true, id: adoptionId, confirmationHash });
  write(path.join(scope, adoptionId + '.json'), { schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, adoption: { id: adoptionId, cwd, status: 'confirmed' } });
  write(path.join(cwd, '.pi/research-loop/adoptions', adoptionId, 'confirmation.json'), { schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash: charterHash(cwd), autoRun: false });
  const workbench = await createWorkbench({
    researchLoopRoot, privateDir,
    getSession: id => rows.find(row => row.id === id), listSessions: () => rows,
    updateSession(id, patch) { const row = rows.find(item => item.id === id); for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete row[key]; else row[key] = value; } },
    localOperatorPrincipal: LOCAL_OPERATOR, isLocalOperator: principal => principal === LOCAL_OPERATOR,
  });
  return { base, cwd, privateDir, parent, rows, workbench, ownerKey, adoptionId, scope };
}

test('legacy local realm keeps exact scope after independent host admission', async t => {
  for (const realm of [['host', 'inert-operator'], ['urn:pi-dashboard:local-operator', 'local-operator']]) {
    const f = await fixture(t, { realm });
    const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
    assert.equal(access.ownerKey, JSON.stringify(realm));
    assert.equal((await f.workbench.connection(access)).adopted, true);
    const verified = await f.workbench.verifyParent({ parent: f.parent, principal: LOCAL_OPERATOR });
    assert.equal(verified.ownerKey, JSON.stringify(realm));
    assert.equal(verified.charterHash, charterHash(f.cwd));
  }
});

test('named owner cannot read another realm or forge the local operator object', async t => {
  const alice = { iss: 'synthetic', sub: 'alice' }, bob = { iss: 'synthetic', sub: 'bob' };
  const f = await fixture(t, { owner: alice });
  await assert.rejects(f.workbench.accessFor(f.cwd, { principal: bob, write: true }), { code: 'workspace-not-found' });
  await assert.rejects(f.workbench.accessFor(f.cwd, { principal: { ...LOCAL_OPERATOR }, write: true }), { code: 'workspace-not-found' });
  await assert.rejects(f.workbench.verifyParent({ parent: f.parent, principal: bob }), { code: 'research-session-parent-not-found' });
  await assert.rejects(f.workbench.verifyParent({ parent: f.parent }), { code: 'research-session-parent-not-found' });
  const access = await f.workbench.accessFor(f.cwd, { principal: alice, write: true });
  assert.equal(access.ownerKey, JSON.stringify(['synthetic', 'alice']));
  assert.equal((await f.workbench.verifyParent({ parent: f.parent, principal: alice })).adoptionId, f.adoptionId);
});

test('target revision changes block dispatch until explicit CAS rebinding', async t => {
  const f = await fixture(t);
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  const before = await f.workbench.charterBinding(access);
  configureResearch(f.cwd, { objective: 'Explicitly replaced synthetic target', successCriteria: ['New evidence required'] });
  await assert.rejects(f.workbench.verifyParent({ parent: f.parent, principal: LOCAL_OPERATOR }), { code: 'research-workbench-charter-binding-stale' });
  const stale = await f.workbench.charterBinding(access);
  assert.equal(stale.status, 'stale');
  const current = await f.workbench.updateCharterBinding(access, {
    adoptionId: f.adoptionId, expectedBindingRevision: before.bindingRevision,
    expectedBoundCharterHash: before.boundCharterHash, expectedCharterHash: stale.currentCharterHash,
    requestId: 'synthetic-rebind',
  });
  assert.equal(current.status, 'current');
  assert.equal((await f.workbench.verifyParent({ parent: f.parent, principal: LOCAL_OPERATOR })).charterHash, stale.currentCharterHash);
});

test('private persisted spawn restores local identity and preserves immutable readOnly', async t => {
  const f = await fixture(t);
  const child = { id: 'child', cwd: f.cwd, sessionFile: path.join(f.base, 'sessions/child.jsonl'), status: 'idle' };
  f.rows.push(child);
  write(child.sessionFile, { type: 'session', id: child.id, cwd: child.cwd, version: 3 });
  write(child.sessionFile.replace(/\.jsonl$/, '.meta.json'), { cwd: child.cwd, retainField: 'untouched' });
  const provenance = { schema: 'pi-research-session.v1', parentSessionId: 'parent', creatorSessionId: 'parent', creatorAgent: 'research_session', role: 'research-worker', task: 'Synthetic read-only proof', stage: '2-experiment', charterHash: charterHash(f.cwd), adoptionId: f.adoptionId, workflowCwd: f.cwd, spawnToken: 'synthetic-token', rootSessionId: 'parent', depth: 1, readOnly: true, createdAt: '2026-10-30T01:00:00.000Z', origin: 'research_session', relation: 'dispatch' };
  const ref = await f.workbench.prepareSpawn(f.cwd, { principal: LOCAL_OPERATOR, write: true }, { ownerKey: f.ownerKey, researchSession: provenance });
  assert.equal(ref.resWorkflowBinding.hostLocalOperator, true);
  await f.workbench.registerSpawn(child.id, { cwd: f.cwd, sessionFile: child.sessionFile }, JSON.parse(JSON.stringify(ref)));
  assert.equal(child.researchSession.readOnly, true);
  const meta = JSON.parse(fs.readFileSync(child.sessionFile.replace(/\.jsonl$/, '.meta.json')));
  assert.equal(meta.retainField, 'untouched');
  assert.equal(meta.researchSession.readOnly, true);
  assert.equal(meta.pluginRefs['res-workflow'].researchSession.readOnly, true);
  const changed = structuredClone(ref); delete changed.researchSession.readOnly;
  await assert.rejects(f.workbench.registerSpawn(child.id, { cwd: f.cwd, sessionFile: child.sessionFile }, changed), { code: 'research-session-readonly-cannot-relax' });
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  await f.workbench.detach(access, child.id);
  const detached = JSON.parse(fs.readFileSync(child.sessionFile.replace(/\.jsonl$/, '.meta.json')));
  assert.equal(detached.researchSession.readOnly, true);
  assert.equal(detached.pluginRefs['res-workflow'].resWorkflow, undefined);
});

test('membership writes reject read-only admission and unsafe sidecar', async t => {
  const f = await fixture(t);
  const readonly = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: false });
  await assert.rejects(f.workbench.join(readonly, f.parent.id), { code: 'res-workflow-write-required' });
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  const sidecar = f.parent.sessionFile.replace(/\.jsonl$/, '.meta.json');
  fs.unlinkSync(sidecar); fs.symlinkSync(path.join(f.scope, 'adopted.json'), sidecar);
  await assert.rejects(f.workbench.join(access, f.parent.id), { code: 'participant-metadata-unsafe' });
});

test('recorded session path can differ from its native header session id', async t => {
  const f = await fixture(t);
  assert.notEqual(path.basename(f.parent.sessionFile, '.jsonl'), 'native-runtime-id');
  f.parent.id = 'native-runtime-id';
  write(f.parent.sessionFile, { type: 'session', id: f.parent.id, cwd: f.cwd, version: 3 });
  const verified = await f.workbench.verifyParent({ parent: f.parent, principal: LOCAL_OPERATOR });
  assert.equal(verified.ownerKey, f.ownerKey);
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  assert.equal((await f.workbench.join(access, f.parent.id)).sessionId, 'native-runtime-id');
  assert.equal(f.parent.sessionFile, path.join(f.base, 'sessions', 'parent.jsonl'));
});

function policies(f) {
  return createWorkbenchPolicies({
    researchLoopRoot, privateDir: f.privateDir, connection: f.workbench.connection,
    accessModeStoreDir: path.join(f.base, 'modes'), taskPermissionStoreDir: path.join(f.base, 'permissions'),
  });
}

test('access mode controls persist in new host state and affect the native session projection', async t => {
  const f = await fixture(t), controls = policies(f), mode = controls['access-mode'];
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  assert.equal((await mode.read(access)).mode, 'default');
  const request = { cwd: f.cwd, mode: 'full-access', expectedRevision: null, requestId: 'synthetic-mode-update' };
  assert.equal(mode.validate(request), true);
  const updated = await mode.update(access, request);
  assert.equal(updated.mode, 'full-access');
  assert.equal((await controls.readSessionAccessMode(f.parent)).revision, updated.revision);
  assert.equal((await policies(f)['access-mode'].read(access)).mode, 'full-access');
  assert.equal((await mode.update(access, request)).revision, updated.revision);
  await assert.rejects(mode.update(access, { ...request, mode: 'default', requestId: 'synthetic-mode-conflict' }), { code: 'access-mode-revision-conflict' });
  assert.equal(mode.validate({ ...request, mode: 'elevated' }), false);
  await assert.rejects(mode.update({ ...access, write: false }, request), { code: 'access-mode-write-required' });
});

test('task authorization retains native scope decisions, revocation and ownership', async t => {
  const f = await fixture(t), controls = policies(f), permissions = controls['task-permissions'];
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  assert.equal((await permissions.read(access)).status, 'unconfigured');
  const request = { cwd: f.cwd, expectedRevision: null, requestId: 'synthetic-grant-update', action: 'authorize', confirmed: true,
    task: 'Synthetic authorized scope', durationHours: 24, additionalRoots: [],
    capabilities: { localExecution: true, delegation: false, publicResearch: true, projectDependencies: false } };
  assert.equal(permissions.validate(request), true);
  const updated = await permissions.update(access, request);
  assert.equal(updated.status, 'active');
  assert.equal(await controls.decideTaskPath(f.parent, path.join(f.cwd, 'result.txt'), 'w', 'write'), 'auto-allow');
  assert.equal(await controls.decideTaskPath(f.parent, path.join(f.base, 'outside.txt'), 'w', 'write'), 'task-blocked');
  await assert.rejects(controls.assertTaskDelegation(f.parent), { code: 'task-permissions-delegation-out-of-scope' });
  await assert.rejects(permissions.read({ ...access, ownerKey: JSON.stringify(['synthetic', 'other-owner']) }), { code: 'task-permissions-not-adopted' });
  const revoked = await permissions.update(access, { cwd: f.cwd, expectedRevision: updated.revision, requestId: 'synthetic-grant-revoke', action: 'revoke', confirmed: true });
  assert.equal(revoked.status, 'revoked');
  assert.equal(await controls.decideTaskPath(f.parent, path.join(f.cwd, 'result.txt'), 'w', 'write'), 'task-blocked');
  assert.equal(permissions.validate({ ...request, confirmed: false }), false);
});

test('budget control keeps existing unlimited behavior while preserving historical CAS journals', async t => {
  const f = await fixture(t), controls = policies(f), budget = controls['research-budget'];
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  const initial = await budget.read(access);
  assert.deepEqual(initial.limits, { attempts: null, modelRequests: null });
  const request = { cwd: f.cwd, expectedRevision: null, requestId: 'synthetic-budget-update', limits: { attempts: 2, modelRequests: 3 } };
  assert.equal(budget.validate(request), true);
  const saved = await budget.update(access, request);
  assert.deepEqual(saved.limits, { attempts: null, modelRequests: null });
  assert.equal(saved.enforcement.attempts, false);
  assert.equal(saved.enforcement.modelRequests, false);
  assert.equal((await policies(f)['research-budget'].read(access)).revision, saved.revision);
  assert.equal((await budget.update(access, request)).revision, saved.revision);
  await assert.rejects(budget.update(access, { ...request, requestId: 'synthetic-budget-conflict' }), { code: 'research-budget-revision-conflict' });
  assert.equal(budget.validate({ ...request, limits: { attempts: -1, modelRequests: 3 } }), false);
});

test('known main checkout still admits its verified linked worktree', async t => {
  const f = await fixture(t);
  const run = args => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: 'pipe' });
  run(['init', '--quiet']);
  fs.writeFileSync(path.join(f.cwd, 'seed.txt'), 'Synthetic checkout admission\n');
  run(['add', 'seed.txt']);
  run(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic checkout']);
  const linked = path.join(f.base, 'linked-checkout');
  run(['worktree', 'add', '--quiet', '-b', 'synthetic-linked', linked]);
  const access = await f.workbench.accessFor(linked, { principal: LOCAL_OPERATOR, write: true });
  assert.equal(access.cwd, fs.realpathSync(linked));
  await access.revalidate();
  await assert.rejects(f.workbench.accessFor(path.join(f.cwd, '.git'), { principal: LOCAL_OPERATOR, write: true }), { code: 'cwd-not-allowed' });
});

test('legacy lead rebind and rejoin preserve goal, approvals, transcripts and scientific bytes', async t => {
  const f = await fixture(t);
  f.parent.id = 'native-runtime-id';
  const initialHash = charterHash(f.cwd);
  const approval = { type: 'custom', customType: 'research-dispatch-scope-approval', data: {
    schema: 'pi-research-dispatch-scope-approval.v1', approved: true, source: 'native-ui',
    scope: JSON.stringify([f.cwd, null, f.parent.id, f.adoptionId, initialHash]), at: '2026-10-30T01:00:00.000Z',
  } };
  fs.writeFileSync(f.parent.sessionFile, JSON.stringify({ type: 'session', id: f.parent.id, cwd: f.cwd, version: 3 }) + '\n' + JSON.stringify(approval) + '\n', { mode: 0o600 });
  const service = createResWorkflowService({ privateDir: f.privateDir, researchLoopRoot, history: () => f.rows, historyRoots: () => [path.dirname(f.parent.sessionFile)], joinParticipant: f.workbench.join });
  t.after(() => service.dispose());
  f.workbench.setConnection(service.connection);
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  const before = await service.charterBinding(access, f.parent.id);
  assert.equal(before.session.status, 'joined');
  const operationPath = path.join(f.scope, f.adoptionId + '.json');
  const pointerPath = path.join(f.scope, 'adopted.json');
  const operationBytes = fs.readFileSync(operationPath), pointerBytes = fs.readFileSync(pointerPath);
  const sessionBytes = fs.readFileSync(f.parent.sessionFile);
  configureResearch(f.cwd, { objective: 'Human-confirmed revised synthetic goal', successCriteria: ['Retain previous evidence and approvals'] });
  const scienceFile = path.join(f.cwd, '.pi/research-loop/state.json'), scientificBytes = fs.readFileSync(scienceFile);
  const stale = await service.charterBinding(access, f.parent.id);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.session.status, 'joined');
  assert.equal(stale.session.error, 'research-workbench-charter-binding-stale');
  const request = { cwd: f.cwd, adoptionId: f.adoptionId, expectedBindingRevision: before.bindingRevision,
    expectedBoundCharterHash: before.boundCharterHash, expectedCharterHash: stale.currentCharterHash, requestId: 'synthetic-existing-target-rebind' };
  const updated = await service.updateCharterBinding(access, request);
  assert.equal(updated.status, 'current');
  assert.equal(updated.adoptionId, f.adoptionId);
  assert.equal((await service.updateCharterBinding(access, request)).bindingRevision, updated.bindingRevision);
  await f.workbench.join(access, f.parent.id);
  const current = await service.charterBinding(access, f.parent.id);
  assert.equal(current.session.status, 'joined');
  assert.equal(current.session.error, undefined);
  assert.equal((await f.workbench.verifyParent({ parent: f.parent, principal: LOCAL_OPERATOR })).charterHash, updated.currentCharterHash);
  assert.deepEqual(fs.readFileSync(f.parent.sessionFile), sessionBytes);
  assert.deepEqual(fs.readFileSync(scienceFile), scientificBytes);
  assert.deepEqual(fs.readFileSync(operationPath), operationBytes);
  assert.deepEqual(fs.readFileSync(pointerPath), pointerBytes);
  const entries = fs.readFileSync(f.parent.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries[1], approval);
  assert.equal(fs.existsSync(path.join(f.cwd, '.pi/research-loop/auto-run.json')), false);
});

test('an old child assignment stays a child and fails stale after lead target rebinding', async t => {
  const f = await fixture(t);
  const child = { id: 'old-assignment-child', cwd: f.cwd, sessionFile: path.join(f.base, 'sessions/old-child.jsonl'), status: 'idle' };
  f.rows.push(child);
  write(child.sessionFile, { type: 'session', id: child.id, cwd: child.cwd, version: 3 });
  write(child.sessionFile.replace(/\.jsonl$/, '.meta.json'), { cwd: child.cwd });
  const provenance = { schema: 'pi-research-session.v1', parentSessionId: f.parent.id, creatorSessionId: f.parent.id, creatorAgent: 'research_session', role: 'research-worker', task: 'Historical synthetic read-only assignment', stage: '2-experiment', charterHash: charterHash(f.cwd), adoptionId: f.adoptionId, workflowCwd: f.cwd, spawnToken: 'old-synthetic-token', rootSessionId: f.parent.id, depth: 1, readOnly: true, createdAt: '2026-10-30T01:00:00.000Z', origin: 'research_session', relation: 'dispatch' };
  const ref = await f.workbench.prepareSpawn(f.cwd, { principal: LOCAL_OPERATOR, write: true }, { ownerKey: f.ownerKey, researchSession: provenance });
  await f.workbench.registerSpawn(child.id, { cwd: f.cwd, sessionFile: child.sessionFile }, structuredClone(ref));
  const oldMetadata = fs.readFileSync(child.sessionFile.replace(/\.jsonl$/, '.meta.json'));
  const access = await f.workbench.accessFor(f.cwd, { principal: LOCAL_OPERATOR, write: true });
  const before = await f.workbench.charterBinding(access);
  configureResearch(f.cwd, { objective: 'A new synthetic target', successCriteria: ['A new bounded assignment'] });
  await f.workbench.updateCharterBinding(access, { adoptionId: f.adoptionId, expectedBindingRevision: before.bindingRevision, expectedBoundCharterHash: before.boundCharterHash, expectedCharterHash: charterHash(f.cwd), requestId: 'synthetic-parent-only-rebind' });
  await assert.rejects(f.workbench.verifyParent({ parent: child, principal: LOCAL_OPERATOR }), { code: 'research-workbench-assignment-stale' });
  await assert.rejects(f.workbench.join(access, child.id, 'spawn', { ...ref, researchSession: { ...provenance, readOnly: undefined } }), { code: 'research-session-readonly-cannot-relax' });
  assert.deepEqual(fs.readFileSync(child.sessionFile.replace(/\.jsonl$/, '.meta.json')), oldMetadata);
  assert.equal(child.researchSession.parentSessionId, f.parent.id);
  assert.equal(child.researchSession.readOnly, true);
});
