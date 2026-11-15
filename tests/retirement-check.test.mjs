import test from 'node:test';
import assert from 'node:assert/strict';
import { checkResearchRetirement } from '../extensions/research-loop/src/retirement-check.mjs';

const at = 1_000_000;
const scope = { sessionId: 'worker', parentSessionId: 'parent', adoptionId: 'adopt-' + 'b'.repeat(24), charterHash: 'sha256:' + 'a'.repeat(64) };
function fixture(entries = []) {
  let sessionId = scope.sessionId;
  const binding = { sessionId, adoptionId: scope.adoptionId, charterHash: scope.charterHash,
    researchSession: { origin: 'research_session', parentSessionId: scope.parentSessionId } };
  const report = { ...scope, id: 'report-one', persisted: true, status: 'partial' };
  const snapshot = { ...scope, cwd: '/workspace', observedAt: at, complete: true,
    backgroundTasks: [], subagents: [], formalChildren: [], supervisorRequests: [],
    descendantProcesses: [], heldLocks: [], unknownTools: [] };
  const ctx = { cwd: '/workspace', isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } };
  const options = { settled: true, binding, report, now: () => at, probe: async () => snapshot };
  return { ctx, options, binding, report, snapshot, changeSession: value => { sessionId = value; },
    run: () => checkResearchRetirement(ctx, options) };
}
function launch(name, id, details, args = {}) {
  return [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: name, details, content: [] } },
  ];
}
function background(id = 'bg-one') {
  return { id, sessionId: scope.sessionId, cwd: '/workspace', status: 'completed',
    startTime: at - 100, endTime: at - 10, exitCode: 0, processExited: true, notified: true };
}
function subagent(runId = 'run-one') {
  return { runId, sessionId: scope.sessionId, state: 'completed', processTerminal: {
    version: 1, state: 'observed', runId, runnerProcessInstanceId: 'instance-one', observedAt: at - 10,
    instances: [{ kind: 'runner', processInstanceId: 'instance-one', closeObservedAt: at - 10, exitCode: 0, signal: null }],
  } };
}
async function blocked(f, reason) {
  const result = await f.run();
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes(reason), JSON.stringify(result));
}

test('a reported formal child can be ready only with an explicit complete clean host probe', async () => {
  assert.deepEqual(await fixture().run(), { ready: true, reasons: [] });
});
test('report and idle alone cannot authorize retirement', async () => {
  const f = fixture(); delete f.options.probe;
  await blocked(f, 'retirement-probe-unavailable');
});
test('only the settled hook may request this check', async () => {
  const f = fixture(); f.options.settled = false;
  await blocked(f, 'agent-not-settled');
});
test('a lead or ordinary subagent is never eligible', async () => {
  const f = fixture(); delete f.binding.researchSession;
  await blocked(f, 'not-formal-research-child');
});
test('an unpersisted or merely running report cannot authorize exit', async () => {
  for (const patch of [{ persisted: false }, { status: 'running' }, { id: '../report' }]) {
    const f = fixture(); Object.assign(f.report, patch);
    await blocked(f, 'durable-report-unverified');
  }
});
test('report identity and research scope must match the exact child', async () => {
  for (const key of ['sessionId', 'parentSessionId', 'adoptionId', 'charterHash']) {
    const f = fixture(); f.report[key] = 'foreign';
    await blocked(f, 'durable-report-unverified');
  }
});
test('malformed or self-parent binding is refused before probing', async () => {
  for (const mutation of [f => { f.binding.sessionId = '../worker'; },
    f => { f.binding.researchSession.parentSessionId = 'worker'; },
    f => { f.binding.charterHash = 'unverified'; }]) {
    const f = fixture(); mutation(f); let probes = 0;
    f.options.probe = async () => { probes++; return f.snapshot; };
    assert.equal((await f.run()).ready, false); assert.equal(probes, 0);
  }
});
test('native pending messages or a busy agent block even a clean probe', async () => {
  const queued = fixture(); queued.ctx.hasPendingMessages = () => true;
  await blocked(queued, 'native-messages-pending');
  const busy = fixture(); busy.ctx.isIdle = () => false;
  await blocked(busy, 'agent-not-idle');
});
test('unavailable session entries or native state are not treated as empty', async () => {
  const f = fixture(); f.ctx.sessionManager.getEntries = () => { throw new Error('offline'); };
  await blocked(f, 'session-history-unavailable');
  const g = fixture(); delete g.ctx.hasPendingMessages;
  await blocked(g, 'native-state-unavailable');
});
test('the native getBranch fallback is accepted when getEntries is absent', async () => {
  const f = fixture(); delete f.ctx.sessionManager.getEntries; f.ctx.sessionManager.getBranch = () => [];
  assert.equal((await f.run()).ready, true);
});
test('probe errors and incomplete snapshots cannot clear a task', async () => {
  const f = fixture(); f.options.probe = async () => { throw new Error('credentials must not leak'); };
  const result = await f.run(); assert.deepEqual(result, { ready: false, reasons: ['retirement-probe-unavailable'] });
  const g = fixture(); g.snapshot.complete = false; await blocked(g, 'retirement-probe-incomplete');
});
test('foreign, stale, or future probes are refused', async () => {
  const foreign = fixture(); foreign.snapshot.sessionId = 'other'; await blocked(foreign, 'retirement-probe-scope-mismatch');
  const stale = fixture(); stale.snapshot.observedAt = at - 60_000; await blocked(stale, 'retirement-probe-stale');
  const future = fixture(); future.snapshot.observedAt = at + 1; await blocked(future, 'retirement-probe-stale');
});
for (const [field, reason] of [
  ['formalChildren', 'formal-children-present'], ['supervisorRequests', 'supervisor-requests-pending'],
  ['descendantProcesses', 'descendant-processes-present'], ['heldLocks', 'locks-held'], ['unknownTools', 'unknown-tool-effects'],
]) test(`a nonempty ${field} prevents retirement`, async () => {
  const f = fixture(); f.snapshot[field] = [{ id: 'still-owned' }]; await blocked(f, reason);
});
test('missing probe inventories cannot certify zero activity', async () => {
  const f = fixture(); delete f.snapshot.heldLocks;
  await blocked(f, 'retirement-probe-incomplete');
});
test('session replacement and incoming messages during a probe are rechecked', async () => {
  const f = fixture(); f.options.probe = async () => { f.changeSession('replacement'); return f.snapshot; };
  await blocked(f, 'native-session-changed');
  const g = fixture(); g.options.probe = async () => { g.ctx.hasPendingMessages = () => true; return g.snapshot; };
  await blocked(g, 'native-messages-pending');
});
test('a background task must be covered by current native terminal metadata', async () => {
  const f = fixture(launch('bg_run', 'call-bg', { task: { id: 'bg-one', status: 'running' } }));
  await blocked(f, 'background-task-unaccounted');
  f.snapshot.backgroundTasks = [background()];
  assert.equal((await f.run()).ready, true);
});
test('reporting does not conceal a running or unconfirmed background process', async () => {
  const f = fixture(launch('bg_run', 'call-bg', { task: { id: 'bg-one' } }));
  for (const patch of [{ status: 'running' }, { processExited: false }, { endTime: undefined }, { notified: false }]) {
    f.snapshot.backgroundTasks = [{ ...background(), ...patch }];
    assert.equal((await f.run()).ready, false);
  }
});
test('failed native tasks may retire after observed process exit and terminal delivery', async () => {
  const f = fixture(launch('bg_run', 'call-bg', { task: { id: 'bg-one' } }));
  f.snapshot.backgroundTasks = [{ ...background(), status: 'failed', exitCode: 1 }];
  assert.equal((await f.run()).ready, true);
});
test('foreign or duplicate task metadata cannot satisfy native activity coverage', async () => {
  const f = fixture(launch('bg_run', 'call-bg', { task: { id: 'bg-one' } }));
  f.snapshot.backgroundTasks = [{ ...background(), sessionId: 'foreign' }];
  await blocked(f, 'background-task-unverified');
  f.snapshot.backgroundTasks = [background(), background()];
  await blocked(f, 'background-task-unverified');
});
test('ordinary async child completion requires observed runner and writer termination', async () => {
  const f = fixture(launch('subagent', 'call-sub', { runId: 'run-one' }, { agent: 'worker', async: true }));
  await blocked(f, 'subagent-unaccounted');
  f.snapshot.subagents = [subagent()]; assert.equal((await f.run()).ready, true);
  f.snapshot.subagents[0].processTerminal.state = 'pending'; await blocked(f, 'subagent-terminal-unverified');
});
test('completed output alone and an unknown descendant process tree cannot certify exit', async () => {
  const f = fixture(launch('subagent', 'call-sub', { runId: 'run-one' }, { agent: 'worker', async: true }));
  const child = subagent(); delete child.processTerminal;
  f.snapshot.subagents = [child]; await blocked(f, 'subagent-terminal-unverified');
  const row = subagent(); row.processTerminal.instances.push({ kind: 'pi-writer', processInstanceId: 'writer',
    closeObservedAt: at - 10, exitCode: 0, signal: null, attempt: 0, processTree: { state: 'unknown' } });
  f.snapshot.subagents = [row]; await blocked(f, 'subagent-terminal-unverified');
});
test('subagent proof must identify its exact run and runner instance', async () => {
  const f = fixture(launch('subagent', 'call-sub', { runId: 'run-one' }, { async: true }));
  for (const patch of [{ runId: 'foreign' }, { runnerProcessInstanceId: 'foreign' }, { instances: [] }]) {
    f.snapshot.subagents = [{ ...subagent(), processTerminal: { ...subagent().processTerminal, ...patch } }];
    await blocked(f, 'subagent-terminal-unverified');
  }
});
test('tool output prose or a completion notification cannot invent a native result identity', async () => {
  const entries = launch('bg_run', 'call-bg', undefined);
  entries[1].message.content = [{ type: 'text', text: 'Completed bg-one; all processes exited.' }];
  entries.push({ type: 'custom_message', customType: 'background-task-notification', content: 'completed' });
  const f = fixture(entries); f.snapshot.backgroundTasks = [background()];
  await blocked(f, 'launch-outcome-unknown');
});
test('malformed activity IDs are never interpreted as metadata paths', async () => {
  const f = fixture(launch('bg_run', 'call-bg', { task: { id: '../../outside' } }));
  await blocked(f, 'launch-outcome-unknown');
});
test('numeric and coercible identity inputs are refused', async () => {
  const f = fixture(); f.report.id = 123;
  await blocked(f, 'durable-report-unverified');
  const g = fixture(launch('bg_run', 'call-bg', { task: { id: 123 } }));
  await blocked(g, 'launch-outcome-unknown');
});
test('pending or unreported ordinary child work remains blocked after parent report', async () => {
  const f = fixture(launch('subagent', 'call-sub', { runId: 'run-one' }, { async: true }));
  f.snapshot.subagents = [{ ...subagent(), state: 'running' }];
  await blocked(f, 'subagent-terminal-unverified');
});
test('a writer with an observed process-group exit can satisfy a child terminal proof', async () => {
  const f = fixture(launch('subagent', 'call-sub', { runId: 'run-one' }, { async: true }));
  const row = subagent(); row.processTerminal.instances.push({ kind: 'pi-writer', processInstanceId: 'writer',
    closeObservedAt: at - 10, exitCode: 0, signal: null, attempt: 0,
    processTree: { state: 'observed', mechanism: 'posix-process-group', processGroupId: 42, verifiedAt: at - 10 } });
  f.snapshot.subagents = [row]; assert.equal((await f.run()).ready, true);
});
test('changing a report or binding during the probe invalidates readiness', async () => {
  const f = fixture(); f.options.probe = async () => { f.report.persisted = false; return f.snapshot; };
  await blocked(f, 'durable-report-unverified');
  const g = fixture(); g.options.probe = async () => { g.binding.charterHash = 'sha256:' + 'c'.repeat(64); return g.snapshot; };
  await blocked(g, 'native-session-changed');
});
test('new native activity appearing while a probe is running forces a later settled check', async () => {
  const entries = [], f = fixture(entries);
  f.options.probe = async () => { entries.push(...launch('bg_run', 'late-call', { task: { id: 'late-task' } })); return f.snapshot; };
  await blocked(f, 'session-history-changed');
});
