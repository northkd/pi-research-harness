import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchCommunicationService, createResearchCommunicationStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-communication-service.mjs';
import { createResearchDispatchService } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';
import { ResearchSessionError } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';

const scope = { cwd: '/synthetic/project', ownerKey: 'operator', adoptionId: 'adopt-' + 'a'.repeat(24), charterHash: 'sha256:' + 'b'.repeat(64) };
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-messages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = (id, parentSessionId) => ({ id, status: 'idle', cwd: scope.cwd, scope: { ...scope }, ...(parentSessionId ? { researchSession: { ...scope, workflowCwd: scope.cwd, parentSessionId, rootSessionId: 'lead', spawnToken: 'token-' + id } } : {}) });
  const rows = [row('lead'), row('branch', 'lead'), row('leaf', 'branch'), row('sibling', 'lead'), row('foreign')];
  rows[4].scope.ownerKey = 'other';
  const notifications = [], releases = [], reports = [];
  let milliseconds = Date.parse('2026-11-13T00:00:00Z'), writesFail = false;
  const disk = createResearchCommunicationStore(dir);
  const store = { readAll: disk.readAll, write(record) { if (writesFail) throw new Error('synthetic disk failure'); disk.write(record); } };
  const dependencies = {
    store, getSession: id => rows.find(row => row.id === id), listSessions: () => rows,
    authorize: async ({ sessionId, principal }) => {
      const parent = rows.find(row => row.id === sessionId);
      if (!parent || principal?.sub === 'unrelated') throw new Error('not authorized');
      return { parent, ...parent.scope };
    },
    notifyParent: async (...args) => { notifications.push(args); return true; },
    releaseSession: token => releases.push(token),
    reportAssignment: async (...args) => reports.push(args),
    now: () => new Date(milliseconds), ...options,
  };
  let service = createResearchCommunicationService(dependencies);
  return { rows, notifications, releases, reports, disk,
    call: (sessionId, body) => service.handle({ body: { ...body, sessionId } }),
    service: () => service,
    restart: () => { service.dispose(); service = createResearchCommunicationService(dependencies); },
    advance: () => { milliseconds += 31_000; }, failWrites: value => { writesFail = value; },
  };
}
const request = { action: 'send', requestId: 'request-input', kind: 'request', summary: 'Need a scoped method decision', evidence: ['results/receipt.json'] };

test('routine progress and partial checkpoints persist without waking or filling the actionable inbox', async t => {
  const f = fixture(t);
  await f.call('leaf', { action: 'send', requestId: 'progress-one', kind: 'progress', summary: 'Existing analysis is still running' });
  await f.call('leaf', { action: 'report', requestId: 'checkpoint-one', status: 'partial', summary: 'Intermediate evidence saved' });
  f.restart(); f.advance(); await f.service().tick();
  assert.equal(f.notifications.length, 0);
  assert.equal(f.disk.readAll().length, 2);
  assert.equal((await f.call('branch', { action: 'pending' })).messages.length, 0);
  assert.equal((await f.call('branch', { action: 'status' })).messages.length, 2);
  assert.deepEqual(f.releases, []);
});

test('a quiet progress backlog cannot hide completion or a request for help', async t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) await f.call('leaf', { action: 'send', requestId: 'progress-' + i, kind: 'progress', summary: '研'.repeat(1500) });
  await f.call('leaf', request);
  await f.call('leaf', { action: 'report', requestId: 'finished', status: 'completed', summary: 'Saved evidence ready for verification', evidence: ['results/receipt.json'] });
  const inbox = await f.call('branch', { action: 'pending' });
  assert.deepEqual(inbox.messages.map(row => row.kind), ['request', 'result']);
  assert.equal(inbox.more, false);
  assert.equal(f.notifications.length, 2);
});

test('completed, blocked and failed deliveries each wake their parent', async t => {
  for (const status of ['completed', 'blocked', 'failed']) {
    const f = fixture(t);
    await f.call('leaf', { action: 'report', requestId: 'terminal', status, summary: 'Actual scoped result', evidence: ['results/receipt.json'] });
    assert.equal(f.notifications.length, 1, status);
    assert.equal((await f.call('branch', { action: 'pending' })).messages[0].status, status);
  }
});

test('an assigned communication report shares the dispatcher wakeup and stays durable without a second inbox reminder', async t => {
  let dispatcher;
  const f = fixture(t, { reportAssignment: input => dispatcher.handle(input) });
  const planId = 'dispatch-' + 'c'.repeat(40), at = '2026-11-13T00:00:00Z';
  f.rows[2].researchSession.dispatchId = planId; f.rows[2].researchSession.taskId = 'one'; f.rows[2].researchSession.requestId = 'request-one';
  const records = new Map([[planId, { schema: 'pi-research-dispatch.v1', kind: 'plan', id: planId, ...scope,
    parentSessionId: 'branch', rootSessionId: 'lead', status: 'running', concurrency: 1, createdAt: at,
    tasks: [{ id: 'one', requestId: 'request-one', status: 'running', spawnToken: 'token-leaf', dependsOn: [] }, { id: 'two', requestId: 'request-two', status: 'queued', dependsOn: [] }] }]]);
  dispatcher = createResearchDispatchService({
    store: { readAll: () => [...records.values()], write: row => records.set(row.id, structuredClone(row)) },
    getSession: id => f.rows.find(row => row.id === id), listSessions: () => f.rows,
    authorize: async ({ sessionId }) => ({ ...scope, parent: f.rows.find(row => row.id === sessionId) }),
    beforeLaunch: () => { throw new ResearchSessionError(409, 'research-session-resource-budget-unavailable'); },
    notifyParent: async (...args) => { f.notifications.push(args); return true; }, now: () => new Date(at),
  });
  const result = await f.call('leaf', { action: 'report', requestId: 'assigned-done', status: 'completed', summary: 'Actual assigned result', evidence: ['results/receipt.json'] });
  assert.equal(result.reportReceipt.persisted, true);
  assert.equal(records.get(planId).tasks[0].status, 'completed');
  assert.equal(f.notifications.length, 1);
  assert.equal((await f.call('branch', { action: 'pending' })).messages.length, 0);
  assert.equal((await f.call('branch', { action: 'status' })).messages.length, 1);
  f.restart(); f.advance(); await f.service().tick();
  assert.equal(f.notifications.length, 1);
});

test('durable request reaches its direct parent; receiving and processing are separate', async t => {
  const f = fixture(t);
  const sent = await f.call('leaf', request);
  assert.equal(sent.message.to, 'branch');
  assert.equal(f.notifications.length, 1);
  await f.service().acknowledgeReceipt('branch', sent.message.notificationId);
  const inbox = await f.call('branch', { action: 'pending' });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].delivered, true);
  await f.call('branch', { action: 'ack', messageId: sent.message.id });
  assert.equal((await f.call('branch', { action: 'pending' })).messages.length, 1, 'unanswered request stays visible after ack');
  await f.call('branch', { action: 'reply', requestId: 'reply-input', messageId: sent.message.id, summary: 'Use the existing approved reference' });
  assert.equal((await f.call('branch', { action: 'pending' })).messages.length, 0);
  assert.equal((await f.call('leaf', { action: 'pending' })).messages[0].kind, 'reply');
});

test('same intent survives restart without duplicate execution and changed intent conflicts', async t => {
  const f = fixture(t); const first = await f.call('leaf', request);
  await f.service().acknowledgeReceipt('branch', first.message.notificationId);
  f.restart(); f.advance();
  const second = await f.call('leaf', request);
  assert.equal(second.message.id, first.message.id);
  assert.equal(f.notifications.length, 1);
  await assert.rejects(f.call('leaf', { ...request, summary: 'Changed intent' }), /conflict/);
});

test('lost delivery retries its stable prompt ID after restart', async t => {
  const f = fixture(t); const sent = await f.call('leaf', request);
  f.restart(); f.advance(); await f.service().tick();
  assert.equal(f.notifications.length, 2);
  assert.equal(f.notifications[0][2], f.notifications[1][2]);
  assert.equal(f.notifications[1][2], sent.message.notificationId);
});

test('siblings, unrelated users, stale scope, spoofed caller fields and unsafe evidence are refused', async t => {
  const f = fixture(t);
  await assert.rejects(f.call('leaf', { ...request, to: 'sibling' }), /relationship/);
  await assert.rejects(f.call('lead', { ...request, to: 'foreign' }), /scope/);
  f.rows[0].scope.charterHash = 'sha256:' + 'c'.repeat(64);
  await assert.rejects(f.call('branch', request), /scope/);
  await assert.rejects(f.call('leaf', { ...request, parentSessionId: 'lead' }), /unknown-field/);
  for (const file of ['/private/file', '../other/file', 'results/../private', 'results\\..\\private']) {
    await assert.rejects(f.call('leaf', { ...request, evidence: [file] }), /evidence/);
  }
});

test('another recipient cannot acknowledge or answer a request', async t => {
  const f = fixture(t); const sent = await f.call('leaf', request);
  await assert.rejects(f.call('lead', { action: 'ack', messageId: sent.message.id }), /not-found/);
  await assert.rejects(f.call('sibling', { action: 'reply', requestId: 'wrong-reply', messageId: sent.message.id, summary: 'wrong' }), /not-found/);
});

test('direct reports are durable and release runnable capacity without pretending the process exited', async t => {
  const f = fixture(t);
  const reply = await f.call('leaf', { action: 'report', requestId: 'report-leaf', status: 'completed', summary: 'Approved task delivered', evidence: ['results/receipt.json'] });
  assert.equal(reply.message.kind, 'result');
  assert.equal(reply.message.processExitVerified, false);
  assert.deepEqual(f.releases, ['token-leaf']);
  assert.equal(f.rows[2].status, 'idle');
  f.restart(); assert.equal(f.service().isCompleted('token-leaf'), true);
  await assert.rejects(f.call('lead', { action: 'report', requestId: 'report-lead', status: 'completed', summary: 'No parent' }), /parent/);
});

test('completed refuses unfinished descendants; partial never fabricates completed', async t => {
  const f = fixture(t);
  await assert.rejects(f.call('branch', { action: 'report', requestId: 'report-branch', status: 'completed', summary: 'Not all children delivered' }), /children-pending/);
  await f.call('branch', { action: 'report', requestId: 'partial-branch', status: 'partial', summary: 'Evidence gap remains' });
  assert.equal(f.service().isCompleted('token-branch'), false);
  assert.deepEqual(f.releases, []);
});

test('failed persistence neither notifies nor releases; offline parent retains pending result', async t => {
  const f = fixture(t); f.failWrites(true);
  await assert.rejects(f.call('leaf', { action: 'report', requestId: 'report-fail', status: 'completed', summary: 'Must save before release' }), /disk failure/);
  assert.equal(f.notifications.length, 0); assert.equal(f.releases.length, 0);
  f.failWrites(false); f.rows[1].status = 'ended';
  await f.call('leaf', request);
  assert.equal(f.notifications.length, 0);
  f.rows[1].status = 'idle'; f.advance(); await f.service().tick();
  assert.equal(f.notifications.length, 1);
});

test('scope changes fence delivery; pending views have a bounded payload', async t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) await f.call('leaf', { ...request, requestId: 'request-' + i, summary: '研'.repeat(1500) });
  const view = await f.call('branch', { action: 'pending' });
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 24 * 1024);
  assert.equal(view.more, true);
  assert.ok(view.nextCursor);
  assert.ok((await f.call('branch', { action: 'pending', cursor: view.nextCursor })).messages.length > 0);
  const before = f.notifications.length; f.rows[1].scope.adoptionId = 'adopt-' + 'f'.repeat(24); f.advance();
  await f.service().tick(); assert.equal(f.notifications.length, before);
});

test('store refuses symlinked record files', t => {
  const f = fixture(t); const other = path.join(os.tmpdir(), 'missing-message-target');
  fs.symlinkSync(other, path.join(f.disk.directory, 'a'.repeat(64) + '.json'));
  assert.throws(() => f.disk.readAll());
});

test('reports cannot target children or originate from the lead', async t => {
  const f = fixture(t);
  await assert.rejects(f.call('branch', { action: 'report', requestId: 'wrong-direction', to: 'leaf', status: 'completed', summary: 'wrong' }), /report-parent/);
  await assert.rejects(f.call('lead', { action: 'report', requestId: 'lead-report', to: 'branch', status: 'completed', summary: 'wrong' }), /parent-required/);
  assert.equal(f.disk.readAll().length, 0);
  assert.equal(f.releases.length, 0);
});

test('ended without a receipt is an unresolved child, not successful execution', async t => {
  const f = fixture(t); f.rows[2].status = 'ended';
  await assert.rejects(f.call('branch', { action: 'report', requestId: 'bad-completion', status: 'completed', summary: 'missing result' }), /children-pending/);
});

test('terminal report conflicts until its direct parent explicitly resumes the branch', async t => {
  const f = fixture(t);
  await f.call('leaf', { action: 'report', requestId: 'report-first', status: 'completed', summary: 'done' });
  await assert.rejects(f.call('leaf', { action: 'report', requestId: 'report-second', status: 'failed', summary: 'contradiction' }), /terminal-report-conflict/);
  await f.call('branch', { action: 'send', to: 'leaf', kind: 'decision', requestId: 'resume-leaf', summary: 'Continue the existing scoped supplement' });
  assert.equal(f.service().isCompleted('token-leaf'), false);
  await f.call('leaf', { action: 'report', requestId: 'second-completion', status: 'completed', summary: 'Supplement done' });
  await f.call('branch', { action: 'send', to: 'leaf', kind: 'decision', requestId: 'resume-leaf', summary: 'Continue the existing scoped supplement' });
  assert.equal(f.service().isCompleted('token-leaf'), true, 'retrying an old resume cannot reopen a later completion');
});

test('blocked report does not release capacity while descendants remain in flight', async t => {
  const f = fixture(t);
  await f.call('branch', { action: 'report', requestId: 'report-blocked', status: 'blocked', summary: 'Awaiting descendant' });
  assert.equal(f.service().isCompleted('token-branch'), false);
  assert.deepEqual(f.releases, []);
});

test('disposing fences later writes and dispatcher side effects', async t => {
  const f = fixture(t); f.service().dispose();
  await assert.rejects(f.call('leaf', request), /service-closed/);
  assert.equal(f.disk.readAll().length, 0);
});

test('archived sender receipts remain deliverable to the verified current parent', async t => {
  const f = fixture(t); f.rows[1].status = 'ended';
  await f.call('leaf', request);
  f.rows.splice(2, 1); f.rows[1].status = 'idle'; f.restart(); f.advance();
  await f.service().tick();
  assert.equal(f.notifications.length, 1);
});
