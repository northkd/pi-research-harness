import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchCollaborationService, createResearchCollaborationStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-collaboration-service.mjs';

const owner = { iss: 'test-issuer', sub: 'north' };
const ownerKey = JSON.stringify([owner.iss, owner.sub]);
const charterHash = 'sha256:' + 'a'.repeat(64), adoptionId = 'adopt-' + 'b'.repeat(24);

function fixture(t, additions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-collaboration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  let time = new Date('2026-11-16T01:00:00.000Z'), serial = 0;
  const rows = [session('main-a'), session('main-b'), session('manual-peer')];
  function session(id, extra = {}) { return { id, cwd, status: 'idle', principalOwner: owner, name: id, model: 'test/model', resWorkflow: { canonicalCwd: cwd, via: 'manual', joinedAt: time.toISOString() }, ...extra }; }
  const access = { cwd, ownerKey, write: true, revalidate: async () => {}, canReadHistory: async row => row.principalOwner?.iss === owner.iss && row.principalOwner?.sub === owner.sub };
  const detached = [], suspended = [], prompts = [];
  const store = createResearchCollaborationStore(path.join(root, 'private'));
  const deps = {
    store, listSessions: () => rows, now: () => time, mintId: () => `fixture-${++serial}`,
    connection: async () => ({ adopted: true }),
    verifySelected: async parent => ({ cwd, ownerKey, adoptionId, charterHash, parent }),
    join: async (_access, id) => { rows.find(row => row.id === id).resWorkflow = { canonicalCwd: cwd, via: 'manual', joinedAt: time.toISOString() }; },
    detach: async (_access, id) => { detached.push(id); delete rows.find(row => row.id === id).resWorkflow; },
    suspendSessions: async (ids, reason, tenureId) => suspended.push({ ids, reason, tenureId }),
    sendMainTask: async (...args) => { prompts.push(args); return true; },
    ...additions,
  };
  let service = createResearchCollaborationService(deps);
  const snapshot = () => service.snapshot(access);
  const act = async (body, atRevision) => service.mutate(access, { expectedRevision: atRevision ?? (await snapshot()).revision, ...body }, { principal: owner });
  const select = id => act({ action: 'select-main', sessionId: id });
  const native = body => service.native(access, body, { principal: owner });
  const nativeRequest = (requestId, extra = {}) => ({ sessionId: 'main-a', requestId, attemptId: `attempt-${requestId}`, role: 'review', ...extra });
  function child(id, parentId, tenureId) { const row = session(id, { researchSession: { parentSessionId: parentId, workflowCwd: cwd, role: 'review', createdAt: time.toISOString(), adoptionId, charterHash, ...(tenureId ? { tenureId } : {}) } }); rows.push(row); return row; }
  return { root, cwd, rows, access, store, deps, snapshot, act, select, native, nativeRequest, child, detached, suspended, prompts, get service() { return service; }, restart() { service = createResearchCollaborationService(deps); }, later() { time = new Date(time.getTime() + 1000); } };
}

test('current main is explicit, persisted, unique, and not inferred from same-folder sessions', async t => {
  const f = fixture(t);
  const empty = await f.snapshot();
  assert.equal(empty.currentMainSessionId, null); assert.deepEqual(empty.tenures, []);
  assert.throws(() => f.service.assertDispatchAllowed({ parent: f.rows[0], verified: { cwd: f.cwd, ownerKey, adoptionId, charterHash } }), /main-not-selected/);
  const first = await f.select('main-a');
  assert.equal(first.currentMainSessionId, 'main-a');
  assert.deepEqual(first.tenures[0].sessionIds, ['main-a']);
  assert.equal(first.tenures.filter(row => row.status === 'current').length, 1);
  f.restart(); assert.equal((await f.snapshot()).currentTenureId, first.currentTenureId);
  assert.deepEqual((await f.select('main-a')).tenures.map(row => row.id), [first.currentTenureId]);
  assert.deepEqual(first.limitMaximums, { maxMultiAgents: 8, maxSubagents: 32 });
});

test('main switch freezes recorded model/title snapshots and keeps descendants in old tenure', async t => {
  const f = fixture(t);
  const first = await f.select('main-a'), oldId = first.currentTenureId;
  const child = f.child('multi-a', 'main-a', oldId); f.child('deep-a', 'multi-a', oldId);
  await f.snapshot(); f.later(); const second = await f.select('main-b');
  assert.deepEqual(second.tenures[0].sessionIds, ['main-a', 'multi-a', 'deep-a']);
  assert.deepEqual(second.tenures[1].sessionIds, ['main-b']);
  child.model = 'different/model'; child.name = 'renamed';
  assert.equal((await f.snapshot()).tenures[0].snapshots['multi-a'].model, 'test/model');
  assert.equal(second.tenures[0].snapshots['main-a'].origin, 'user-selected');
  assert.equal(second.tenures[0].snapshots['main-a'].parentSessionId, undefined);
  assert.equal(second.tenures[0].snapshots['multi-a'].origin, 'agent-dispatch');
  assert.equal(second.tenures[0].snapshots['multi-a'].parentSessionId, 'main-a');
  f.child('late-a', 'main-a', oldId);
  const late = await f.snapshot();
  assert.ok(late.tenures[0].sessionIds.includes('late-a')); assert.ok(!late.tenures[1].sessionIds.includes('late-a'));
  assert.throws(() => f.service.assertDispatchAllowed({ parent: child, verified: { cwd: f.cwd, ownerKey, adoptionId, charterHash } }), /historical-main|not-current-descendant/);
  assert.deepEqual(f.suspended[0].ids, ['main-a', 'multi-a', 'deep-a']);
});

test('the same session promoted again gets a new tenure and does not absorb old children', async t => {
  const f = fixture(t); const old = await f.select('main-a');
  f.child('old-child', 'main-a', old.currentTenureId); await f.snapshot();
  f.later(); await f.select('main-b'); f.later(); const again = await f.select('main-a');
  assert.notEqual(again.currentTenureId, old.currentTenureId); assert.equal(again.tenures.length, 3);
  assert.deepEqual(again.tenures[2].sessionIds, ['main-a']);
});

test('a former child promoted to main is a new root, not subordinate to its old creator', async t => {
  const f = fixture(t); const a = await f.select('main-a');
  const promoted = f.child('former-worker', 'main-a', a.currentTenureId); await f.snapshot();
  f.later(); await f.select(promoted.id);
  const policy = f.service.getSchedulingPolicy({ parent: promoted, verified: { cwd: f.cwd, ownerKey, adoptionId, charterHash } });
  assert.equal(policy.mainSessionId, promoted.id); assert.equal(policy.isMainAgent, true);
  assert.doesNotThrow(() => f.service.assertDispatchAllowed({ parent: promoted, verified: { cwd: f.cwd, ownerKey, adoptionId, charterHash } }));
});

test('limits use revision CAS, reject out-of-range values and survive restart', async t => {
  const f = fixture(t); const initial = await f.select('main-a');
  const next = await f.act({ action: 'limits', maxMultiAgents: 6, maxSubagents: 8 }, initial.revision);
  assert.deepEqual(next.limits, { maxMultiAgents: 6, maxSubagents: 8 });
  await assert.rejects(f.act({ action: 'limits', maxMultiAgents: 2, maxSubagents: 1 }, initial.revision), /revision-conflict/);
  for (const invalid of [0, 9, 1.5, '4']) await assert.rejects(f.act({ action: 'limits', maxMultiAgents: invalid, maxSubagents: 3 }), /limits-invalid/);
  f.restart(); assert.deepEqual((await f.snapshot()).limits, next.limits);
});

test('unauthorized, remote, ended and invented main selections fail without mutation', async t => {
  const f = fixture(t);
  f.rows.push({ ...f.rows[0], id: 'foreign', principalOwner: { iss: owner.iss, sub: 'other' } });
  f.rows.push({ ...f.rows[0], id: 'remote', originDeviceId: 'remote' });
  f.rows.push({ ...f.rows[0], id: 'ended', status: 'ended' });
  for (const id of ['foreign', 'remote', 'ended', 'invented']) await assert.rejects(f.select(id));
  assert.equal((await f.snapshot()).revision, 0);
});

test('explicit selection joins an eligible unjoined session, but discovery never does', async t => {
  const f = fixture(t); delete f.rows[0].resWorkflow;
  assert.equal((await f.snapshot()).currentMainSessionId, null);
  const result = await f.select('main-a'); assert.equal(result.currentMainSessionId, 'main-a'); assert.ok(f.rows[0].resWorkflow);
});

test('removing a Multi-agent detaches only its actual subtree and retains transcripts/model provenance', async t => {
  const f = fixture(t); const current = await f.select('main-a');
  const worker = f.child('multi-a', 'main-a', current.currentTenureId);
  f.child('multi-b', 'main-a', current.currentTenureId); f.child('child-a', 'multi-a', current.currentTenureId);
  const result = await f.act({ action: 'detach', sessionId: 'multi-a', tenureId: current.currentTenureId });
  assert.deepEqual(result.detachedSessionIds.sort(), ['child-a', 'multi-a']);
  assert.equal(result.currentMainSessionId, 'main-a'); assert.equal(f.rows.length, 6); assert.ok(worker.researchSession);
  assert.ok(f.rows.find(row => row.id === 'multi-b').resWorkflow);
  assert.deepEqual(result.tenures[0].detachedSessionIds.sort(), ['child-a', 'multi-a']);
  assert.throws(() => f.service.assertParticipationAllowed({ cwd: f.cwd, sessionId: 'late-child', researchSession: { parentSessionId: 'multi-a', tenureId: current.currentTenureId }, via: 'spawn' }), /detached/);
});

test('removing main clears current binding and cascades recorded descendants, not manual peers', async t => {
  const f = fixture(t); const current = await f.select('main-a');
  f.child('multi-a', 'main-a', current.currentTenureId); f.child('child-a', 'multi-a', current.currentTenureId);
  const result = await f.act({ action: 'detach', sessionId: 'main-a', tenureId: current.currentTenureId });
  assert.equal(result.currentMainSessionId, null); assert.equal(result.tenures[0].status, 'removed');
  assert.deepEqual(result.detachedSessionIds.sort(), ['child-a', 'main-a', 'multi-a']);
  assert.ok(f.rows.find(row => row.id === 'manual-peer').resWorkflow);
  f.restart(); assert.ok(f.service.isKnownManaged(f.rows[0]));
});

test('removing an old tenure does not detach the same session selected in a newer tenure', async t => {
  const f = fixture(t); const old = await f.select('main-a');
  f.child('old-worker', 'main-a', old.currentTenureId); await f.snapshot();
  f.later(); await f.select('main-b'); f.later(); const latest = await f.select('main-a');
  const result = await f.act({ action: 'detach', sessionId: 'main-a', tenureId: old.currentTenureId });
  assert.equal(result.currentTenureId, latest.currentTenureId);
  assert.deepEqual(result.detachedSessionIds, ['old-worker']); assert.ok(f.rows[0].resWorkflow);
});

test('removing a historical Multi role marks that tenure while preserving its later current Main role', async t => {
  const f = fixture(t), old = await f.select('main-a');
  const worker = f.child('multi-a', 'main-a', old.currentTenureId);
  f.child('old-sub', 'multi-a', old.currentTenureId); await f.snapshot();
  f.later(); const latest = await f.select(worker.id);
  f.child('new-worker', worker.id, latest.currentTenureId); await f.snapshot();
  const result = await f.act({ action: 'detach', sessionId: worker.id, tenureId: old.currentTenureId });
  assert.equal(result.currentMainSessionId, worker.id);
  assert.equal(result.currentTenureId, latest.currentTenureId);
  assert.deepEqual(result.tenures[0].detachedSessionIds.sort(), ['multi-a', 'old-sub']);
  assert.deepEqual(result.detachedSessionIds, ['old-sub']);
  assert.deepEqual(f.detached, ['old-sub']); assert.ok(worker.resWorkflow);
  assert.ok(f.rows.find(row => row.id === 'new-worker').resWorkflow);
  assert.equal(f.suspended.at(-1).tenureId, old.currentTenureId);
  assert.deepEqual(f.suspended.at(-1).ids.sort(), ['multi-a', 'old-sub']);
  assert.throws(() => f.service.assertParticipationAllowed({ cwd: f.cwd, sessionId: 'late-old-sub', researchSession: { parentSessionId: worker.id, tenureId: old.currentTenureId }, via: 'spawn' }), /detached/);
  assert.doesNotThrow(() => f.service.assertDispatchAllowed({ parent: worker, verified: { cwd: f.cwd, ownerKey, adoptionId, charterHash } }));
  f.restart(); assert.ok((await f.snapshot()).tenures[0].detachedSessionIds.includes(worker.id));
});

test('removal barrier survives metadata failure and blocks late registration before any async cleanup', async t => {
  let inspect;
  const f = fixture(t, { detach: async () => { inspect(); throw new Error('disk unavailable'); } });
  const current = await f.select('main-a');
  inspect = () => assert.throws(() => f.service.assertParticipationAllowed({ cwd: f.cwd, sessionId: 'main-a', via: 'adoption' }), /detached/);
  const result = await f.act({ action: 'detach', sessionId: 'main-a', tenureId: current.currentTenureId });
  assert.ok(result.warnings.length); assert.ok(result.detachedSessionIds.includes('main-a'));
  f.restart(); inspect();
});

test('disk write failure cannot change current main or live concurrency in memory', async t => {
  const f = fixture(t); await f.select('main-a');
  const original = f.deps.store.write;
  f.deps.store.write = () => { throw new Error('write-failed'); };
  await assert.rejects(f.act({ action: 'limits', maxMultiAgents: 6, maxSubagents: 4 }), /write-failed/);
  assert.deepEqual((await f.snapshot()).limits, { maxMultiAgents: 4, maxSubagents: 3 });
  f.deps.store.write = original;
});

test('native lease admission is atomic across simultaneous callers and idempotent same attempt', async t => {
  const f = fixture(t); await f.select('main-a'); await f.act({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  const a = f.nativeRequest('request-a'), b = f.nativeRequest('request-b');
  const [first, second] = await Promise.all([f.native({ ...a, action: 'subagent-acquire' }), f.native({ ...b, action: 'subagent-acquire' })]);
  assert.equal(first.status, 'acquired'); assert.equal(second.status, 'queued');
  assert.equal((await f.native({ ...a, action: 'subagent-acquire' })).leaseToken, first.leaseToken);
  await assert.rejects(f.native({ ...a, attemptId: 'new-attempt', action: 'subagent-acquire' }), /recovery-required/);
  await f.native({ ...a, action: 'subagent-release', leaseToken: first.leaseToken });
  assert.equal((await f.native({ ...b, action: 'subagent-acquire' })).status, 'acquired');
});

test('live native limit raises admit queued work; lowering never releases or kills a running lease', async t => {
  const f = fixture(t); await f.select('main-a'); await f.act({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  const a = f.nativeRequest('request-a'), b = f.nativeRequest('request-b'), c = f.nativeRequest('request-c');
  const first = await f.native({ ...a, action: 'subagent-acquire' });
  assert.equal((await f.native({ ...b, action: 'subagent-acquire' })).status, 'queued');
  await f.act({ action: 'limits', maxMultiAgents: 4, maxSubagents: 2 });
  const second = await f.native({ ...b, action: 'subagent-acquire' }); assert.equal(second.status, 'acquired');
  await f.act({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  assert.equal((await f.native({ ...c, action: 'subagent-acquire' })).status, 'queued');
  await f.native({ ...a, action: 'subagent-release', leaseToken: first.leaseToken });
  assert.equal((await f.native({ ...c, action: 'subagent-acquire' })).status, 'queued');
  await f.native({ ...b, action: 'subagent-release', leaseToken: second.leaseToken });
  assert.equal((await f.native({ ...c, action: 'subagent-acquire' })).status, 'acquired');
});

test('native queued reorder persists, excludes running leases and uses exact current queue CAS', async t => {
  const f = fixture(t); await f.select('main-a'); await f.act({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  const a = f.nativeRequest('a'), b = f.nativeRequest('b'), c = f.nativeRequest('c');
  const first = await f.native({ ...a, action: 'subagent-acquire' });
  await f.native({ ...b, action: 'subagent-acquire' }); await f.native({ ...c, action: 'subagent-acquire' });
  const before = await f.snapshot(), queue = before.nativeQueue.filter(row => row.status === 'queued');
  await f.act({ action: 'native-reorder', sessionId: 'main-a', taskIds: queue.map(row => row.id).reverse() }, before.revision);
  f.restart(); await f.native({ ...a, action: 'subagent-release', leaseToken: first.leaseToken });
  assert.equal((await f.native({ ...b, action: 'subagent-acquire' })).status, 'queued');
  assert.equal((await f.native({ ...c, action: 'subagent-acquire' })).status, 'acquired');
  await assert.rejects(f.act({ action: 'native-reorder', sessionId: 'main-a', taskIds: [] }, before.revision), /revision-conflict/);
});

test('native leases survive restart without freeing unknown processes; explicit retry needs released attempt', async t => {
  const f = fixture(t); await f.select('main-a');
  const a = f.nativeRequest('request-a'); const first = await f.native({ ...a, action: 'subagent-acquire' });
  f.restart(); assert.equal((await f.native({ ...a, action: 'subagent-acquire' })).leaseToken, first.leaseToken);
  await f.native({ ...a, action: 'subagent-release', leaseToken: first.leaseToken });
  await assert.rejects(f.native({ ...a, action: 'subagent-acquire' }), /attempt-ended/);
  const retry = await f.native({ ...a, attemptId: 'new-attempt', action: 'subagent-acquire' });
  assert.equal(retry.status, 'acquired'); assert.notEqual(retry.leaseToken, first.leaseToken);
});

test('native detach prevents new launches but permits exact-lease cleanup and running heartbeats', async t => {
  const f = fixture(t); const current = await f.select('main-a');
  const a = f.nativeRequest('request-a'); const first = await f.native({ ...a, action: 'subagent-acquire' });
  await f.act({ action: 'detach', sessionId: 'main-a', tenureId: current.currentTenureId });
  assert.equal((await f.native({ ...a, action: 'subagent-acquire' })).leaseToken, first.leaseToken);
  await assert.rejects(f.native({ ...a, action: 'subagent-heartbeat', phase: 'launching', leaseToken: first.leaseToken }), /main-not-selected|detached/);
  assert.equal((await f.native({ ...a, action: 'subagent-heartbeat', phase: 'running', leaseToken: first.leaseToken })).status, 'acquired');
  await assert.rejects(f.native({ ...f.nativeRequest('new-request'), action: 'subagent-acquire' }), /main-not-selected|detached/);
  assert.equal((await f.native({ ...a, action: 'subagent-release', leaseToken: first.leaseToken })).status, 'released');
});

test('native ordinary never-joined sessions remain unmanaged, detached sessions never downgrade', async t => {
  const f = fixture(t); delete f.rows[0].resWorkflow;
  const request = f.nativeRequest('request-a');
  assert.equal((await f.native({ ...request, action: 'subagent-acquire' })).status, 'unmanaged');
  const current = await f.select('main-a'); await f.act({ action: 'detach', sessionId: 'main-a', tenureId: current.currentTenureId });
  await assert.rejects(f.native({ ...request, action: 'subagent-acquire' }), /main-not-selected|detached/);
});

test('queued native cancellation needs no token; an acquired lease always requires its token', async t => {
  const f = fixture(t); await f.select('main-a'); await f.act({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  const a = f.nativeRequest('request-a'), b = f.nativeRequest('request-b');
  await f.native({ ...a, action: 'subagent-acquire' }); await f.native({ ...b, action: 'subagent-acquire' });
  assert.equal((await f.native({ ...b, action: 'subagent-release' })).status, 'released');
  await assert.rejects(f.native({ ...a, action: 'subagent-release' }), /token-invalid/);
});

test('send-main-task is server-targeted, idempotent and rejects changed current/revision', async t => {
  const f = fixture(t); const current = await f.select('main-a');
  const body = { action: 'send-main-task', sessionId: 'main-a', requestId: 'request-one', text: 'Review the supplied evidence.' };
  const first = await f.act(body, current.revision); assert.equal(first.promptReceipt.transmitted, true);
  const second = await f.act(body, current.revision); assert.equal(second.promptReceipt.promptId, first.promptReceipt.promptId); assert.equal(f.prompts.length, 1);
  await f.select('main-b'); await assert.rejects(f.act(body, current.revision), /revision-conflict/);
  await assert.rejects(f.act(body), /main-changed/);
});

test('accepted charter rebind is not blocked by an obsolete main-selection hash', async t => {
  const f = fixture(t); await f.select('main-a');
  assert.doesNotThrow(() => f.service.assertDispatchAllowed({ parent: f.rows[0], verified: { cwd: f.cwd, ownerKey, adoptionId, charterHash: 'sha256:' + 'c'.repeat(64) } }));
});

test('private storage rejects symlink/corrupt metadata and never exposes lease tokens in projections', async t => {
  const f = fixture(t); await f.select('main-a'); const request = f.nativeRequest('request-a');
  const lease = await f.native({ ...request, action: 'subagent-acquire' });
  assert.ok(!JSON.stringify(await f.snapshot()).includes(lease.leaseToken));
  const file = fs.readdirSync(path.join(f.root, 'private')).find(name => name.endsWith('.json'));
  const target = path.join(f.root, 'private', file); fs.writeFileSync(target, '{broken');
  assert.throws(() => createResearchCollaborationStore(path.join(f.root, 'private')).readAll(), /store-invalid/);
  fs.unlinkSync(target); fs.symlinkSync(path.join(f.root, 'outside'), target);
  assert.throws(() => createResearchCollaborationStore(path.join(f.root, 'private')).readAll(), /store-unsafe/);
});
