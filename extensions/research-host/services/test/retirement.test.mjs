import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchDispatchStore } from '../research-dispatch-service.mjs';
import { createResearchSessionStore } from '../research-session-service.mjs';
import { createResearchRetirementService, readResearchRetirementReport, readNativeRetirementEntries } from '../retirement.mjs';

function fixture(t, { entries = [], probe, pendingMessageCount = 0 } = {}) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-retirement-'));
  t.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
  const binding = { ownerKey: 'operator', cwd: '/synthetic/project', adoptionId: 'adopt-' + 'a'.repeat(24),
    charterHash: 'sha256:' + 'b'.repeat(64) };
  const row = { id: 'worker', cwd: binding.cwd, sessionFile: '/synthetic/worker.jsonl', pid: process.pid,
    status: 'idle', live: true, nativeRegistrationConfirmed: true,
    researchSession: { origin: 'research_session', parentSessionId: 'lead', spawnToken: 'token-worker',
      adoptionId: binding.adoptionId, charterHash: binding.charterHash, workflowCwd: binding.cwd,
      dispatchId: 'dispatch-synthetic', taskId: 'one' } };
  const records = createResearchDispatchStore(path.join(privateDir, 'dispatch'));
  const plan = { schema: 'pi-research-dispatch.v1', kind: 'plan', id: row.researchSession.dispatchId,
    parentSessionId: 'lead', ...binding, tasks: [{ id: 'one', sessionId: row.id, spawnToken: 'token-worker',
      status: 'completed', reportedAt: new Date().toISOString() }] };
  records.write(plan);
  const rows = [row], requests = [];
  let commands = 0, nativePending = pendingMessageCount, currentEntries = entries, shutdownHandler;
  const sessions = {
    getSession: id => rows.find(candidate => candidate.id === id), listSessions: () => rows,
    command: async (_id, command) => {
      commands++;
      if (command.type === 'get_state') return { success: true, data: { sessionId: row.id, sessionFile: row.sessionFile,
        isStreaming: false, isCompacting: false, pendingMessageCount: nativePending } };
      if (command.type === 'get_entries') return { success: true, data: { entries: currentEntries } };
      throw new Error('unexpected native command');
    },
    readEvents: () => ({ events: [{ event: { type: 'agent_settled' } }] }),
  };
  const deps = {
    privateDir, sessions, readBinding: async () => ({ ...binding }), principalForSession: () => ({ sub: 'operator' }),
    readHistory: async () => ({ entries: currentEntries, fingerprint: JSON.stringify(currentEntries) }),
    communication: { handle: async () => ({ retirement: { complete: true, formalChildren: [], supervisorRequests: [] } }) },
    requestShutdown: async request => { requests.push(request); return shutdownHandler?.(request); },
    ...(probe ? { observeOwnedWork: input => probe(input) } : {}),
  };
  let service = createResearchRetirementService(deps);
  t.after(() => service.dispose());
  return { privateDir, row, rows, binding, plan, records, requests,
    commands: () => commands,
    pending: value => { nativePending = value; },
    entries: value => { currentEntries = value; },
    shutdown: handler => { shutdownHandler = handler; },
    event: () => service.onEvent(row.id, { type: 'agent_settled' }),
    check: () => service.check(row.id),
    async restart() { service.dispose(); service = createResearchRetirementService(deps); await service.tick(); },
  };
}

test('exact durable dispatch reports become retirement receipts without model text', t => {
  const f = fixture(t);
  const report = readResearchRetirementReport(f);
  assert.equal(report.persisted, true);
  assert.equal(report.sessionId, f.row.id);
  assert.equal(report.status, 'completed');
  assert.match(report.id, /^dispatch-report-[a-f0-9]{40}$/);
  f.plan.tasks[0].spawnToken = 'different'; f.records.write(f.plan);
  assert.equal(readResearchRetirementReport(f), undefined);
});

test('a clean settled native child requests graceful shutdown once', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  assert.equal((await f.check()).ready, false);
  const checked = await f.event();
  assert.equal(checked.ready, true, JSON.stringify(checked));
  assert.equal(checked.shutdownRequested, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].sessionId, f.row.id);
  assert.equal(f.requests[0].pid, process.pid);
  await f.event();
  assert.equal(f.requests.length, 1);
});

test('a host restart recovers settled evidence from its native event journal', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  await f.restart();
  assert.equal(f.requests.length, 1);
});

test('queued native messages prevent shutdown until a fresh clean observation', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t, { pendingMessageCount: 1 });
  const first = await f.event();
  assert.equal(first.ready, false);
  assert.ok(first.reasons.includes('native-messages-pending'));
  assert.equal(f.requests.length, 0);
  f.pending(0);
  assert.equal((await f.check()).shutdownRequested, true);
});

test('formal pending reservations prevent retirement even before a process registers', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  createResearchSessionStore(path.join(f.privateDir, 'session-reservations')).write({
    schema: 'pi-research-session-request.v1', key: 'synthetic-reservation', fingerprint: 'synthetic',
    parentSessionId: f.row.id, spawnToken: 'pending-token', requestId: 'pending-request', phase: 'unknown',
  });
  const result = await f.event();
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes('formal-children-present'));
  assert.equal(f.requests.length, 0);
});

test('an unproved shell remains unknown after a durable report', { skip: process.platform !== 'linux' }, async t => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'shell-one', name: 'bash', arguments: { command: 'synthetic' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'shell-one', toolName: 'bash', details: { exitCode: 0 } } },
  ];
  const f = fixture(t, { entries });
  const result = await f.event();
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes('unknown-tool-effects'));
  assert.equal(f.requests.length, 0);
});

test('a supplied native ordinary-subagent terminal proof is checked before shutdown', async t => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'child-call', name: 'subagent', arguments: { action: 'spawn' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'child-call', toolName: 'subagent', details: { runId: 'ordinary-run' } } },
  ];
  let observed = false;
  const f = fixture(t, { entries, probe: async ({ scope }) => ({ ...scope, observedAt: Date.now(), complete: true,
    backgroundTasks: [], formalChildren: [], supervisorRequests: [], descendantProcesses: [], heldLocks: [], unknownTools: [],
    subagents: [{ runId: 'ordinary-run', sessionId: 'worker', state: 'completed', processTerminal: {
      version: 1, state: observed ? 'observed' : 'pending', runId: 'ordinary-run', runnerProcessInstanceId: 'runner-one', observedAt: Date.now(),
      instances: [{ kind: 'runner', processInstanceId: 'runner-one', closeObservedAt: Date.now(), exitCode: 0, signal: null }],
    } }],
  }) });
  const pending = await f.event();
  assert.equal(pending.ready, false);
  assert.ok(pending.reasons.includes('subagent-terminal-unverified'));
  assert.equal(f.requests.length, 0);
  observed = true;
  assert.equal((await f.check()).shutdownRequested, true);
});

test('partial reports and prepared registrations never request shutdown', async t => {
  const f = fixture(t);
  f.plan.tasks[0].status = 'partial'; f.records.write(f.plan);
  assert.equal((await f.event()).ready, false);
  f.plan.tasks[0].status = 'completed'; f.records.write(f.plan);
  f.row.nativeRegistrationConfirmed = false;
  assert.equal((await f.event()).ready, false);
  assert.equal(f.requests.length, 0);
});

test('explicit native retirement refusal can retry after a fresh settled check', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  f.shutdown(request => ({ committed: false, retired: false, state: 'retained', reason: 'session-retirement-pending', reportId: request.reportId }));
  const refused = await f.event();
  assert.equal(refused.ready, false);
  assert.equal(refused.shutdownRequested, false);
  assert.equal(f.requests.length, 1);
  f.shutdown(request => {
    f.row.live = false; f.row.status = 'ended';
    return { committed: true, retired: true, workerExited: true, state: 'retired', reportId: request.reportId };
  });
  const completed = await f.event();
  assert.equal(completed.retirementConfirmed, true);
  assert.equal(f.requests.length, 2);
});

test('committed but unobserved exit remains distinct and is never re-requested', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  f.shutdown(request => ({ committed: true, retired: false, workerExited: false, state: 'retiring', reportId: request.reportId }));
  const retiring = await f.event();
  assert.equal(retiring.shutdownRequested, true);
  assert.equal(retiring.retirementConfirmed, false);
  await f.event();
  assert.equal(f.requests.length, 1);
});

test('large native history is reduced to bounded activity identities and exact entry counts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-large-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, 'legacy-filename.jsonl');
  const row = { id: 'native-header-id', cwd: directory, sessionFile };
  const entries = [
    { type: 'session', id: row.id, cwd: row.cwd },
    { type: 'message', message: { role: 'user', content: '中'.repeat(2 * 1024 * 1024) } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'text', text: 'Large unrelated model output '.repeat(50000) },
      { type: 'toolCall', id: 'ordinary-call', name: 'subagent', arguments: { action: 'spawn', task: '大'.repeat(1024 * 1024) } },
    ] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent', toolCallId: 'ordinary-call',
      details: { runId: 'actual-run', results: ['Long discarded payload '.repeat(50000)] } } },
    { type: 'custom', customType: 'synthetic' },
  ];
  fs.writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600 });
  const reduced = await readNativeRetirementEntries(row);
  assert.equal(reduced.entries.length, entries.length - 1);
  assert.ok(Buffer.byteLength(JSON.stringify(reduced)) < 2048);
  assert.equal(reduced.entries[1].message.content[0].id, 'ordinary-call');
  assert.equal(reduced.entries[2].message.details.runId, 'actual-run');
  await reduced.verifyUnchanged();
  fs.appendFileSync(sessionFile, JSON.stringify({ type: 'custom', customType: 'new-event' }) + '\n');
  await assert.rejects(reduced.verifyUnchanged(), /history-changed/);
  await assert.rejects(readNativeRetirementEntries({ ...row, id: 'legacy-filename' }), /identity-invalid/);
});
