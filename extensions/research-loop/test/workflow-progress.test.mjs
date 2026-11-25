import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, rootDir } from '../src/ledger.mjs';
import { createWorkflowObserver, normalizeEvidence, readEventsTolerant, validateRunIdentity } from '../src/workflow-progress.mjs';

const START = 1792713600000;
function fixture(t, runId = 'workflow-test-1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-progress-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project');
  const asyncDir = path.join(home, 'native', runId);
  fs.mkdirSync(rootDir(cwd), { recursive: true });
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir(cwd), 'state.json'), '{"charter":{"objective":"do not overwrite"},"claims":[]}\n');
  fs.writeFileSync(path.join(rootDir(cwd), 'ledger.jsonl'), '{"seq":1,"signal":"inconclusive"}\n');
  appendEvent(cwd, 'run-registered', { runId, launchId: 'launch-test', parentSessionId: 'parent-test', charterRevision: 1 });
  const native = { runId, mode: 'workflow', cwd, sessionId: 'parent-test', state: 'running', startedAt: START, steps: [], workflow: { trace: [], emits: [] } };
  const status = (patch = {}) => fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({ ...native, ...patch }));
  status();
  let seq = 0;
  const journal = (type, fields = {}) => fs.appendFileSync(path.join(asyncDir, 'events.jsonl'), JSON.stringify({ runId, ts: START + ++seq * 1000, type, ...fields }) + '\n');
  const records = () => readEventsTolerant(path.join(rootDir(cwd), 'events.jsonl'));
  const observer = () => {
    const o = createWorkflowObserver({ cwd, runId, asyncDir, parentSessionId: 'parent-test', charterRevision: 1 });
    t.after(() => o.stop());
    return o;
  };
  return { home, cwd, asyncDir, runId, native, status, journal, records, observer };
}
const trace = (key, state, phase = '1-idea') => ({ operation: 'run', key, state, phase, agent: 'research-explorer', runId: `child-${key}`, label: key });

test('identity requires an absolute matching run directory and rejects symlinks', t => {
  assert.throws(() => validateRunIdentity('../bad', '/tmp/bad'));
  assert.throws(() => validateRunIdentity('run', 'relative/run'));
  assert.throws(() => validateRunIdentity('run', '/tmp/another'));
  const f = fixture(t);
  const link = path.join(f.home, 'linked');
  fs.symlinkSync(path.join(f.home, 'native'), link, 'dir');
  assert.throws(() => validateRunIdentity(f.runId, path.join(link, f.runId)), /symlink/i);
});

test('cumulative traces are idempotent and never change scientific state or ledger', t => {
  const f = fixture(t);
  const before = ['state.json', 'ledger.jsonl'].map(n => fs.readFileSync(path.join(rootDir(f.cwd), n), 'utf8'));
  const a = trace('explorer-1', 'started');
  const b = trace('explorer-1', 'completed');
  f.journal('subagent.workflow.trace', { trace: [a] });
  f.journal('subagent.workflow.trace', { trace: [a, b] });
  f.journal('subagent.workflow.trace', { trace: [a, b] });
  const o = f.observer();
  o.pollOnce();
  const count = f.records().length;
  o.pollOnce();
  assert.equal(f.records().length, count);
  assert.equal(f.records().filter(e => e.kind === 'stage-enter').length, 1);
  assert.equal(f.records().filter(e => e.kind === 'run-step').at(-1).detail.status, 'completed');
  assert.deepEqual(['state.json', 'ledger.jsonl'].map(n => fs.readFileSync(path.join(rootDir(f.cwd), n), 'utf8')), before);
});

test('running duration is not an end timestamp or a progress heartbeat', t => {
  const f = fixture(t);
  const step = { workflowKey: 'explorer-1', agent: 'research-explorer', phase: '1-idea', status: 'running', startedAt: START, durationMs: 1000 };
  f.status({ steps: [step] });
  const observer = f.observer();
  observer.pollOnce();
  assert.equal(f.records().find(e => e.kind === 'run-step').detail.endedAt, undefined);
  const count = f.records().length;
  f.status({ steps: [{ ...step, durationMs: 2000 }] });
  observer.pollOnce();
  assert.equal(f.records().length, count);
});

test('natural child settlement does not need a stopped child-status event', t => {
  const f = fixture(t);
  f.journal('subagent.workflow.trace', { trace: [trace('explorer-1', 'started')] });
  f.journal('subagent.workflow.child_settled', { childKey: 'explorer-1', childRunId: 'child-explorer-1', outcome: 'completed' });
  f.observer().pollOnce();
  const detail = f.records().filter(e => e.kind === 'run-step').at(-1).detail;
  assert.equal(detail.status, 'completed');
  assert.equal(detail.agent, 'research-explorer');
  assert.equal(detail.stage, '1-idea');
});

test('partial journal lines and UTF-8 content are completed on a later poll', t => {
  const f = fixture(t);
  const line = JSON.stringify({ runId: f.runId, ts: START, type: 'subagent.workflow.emit', value: { type: 'step-result', key: 'explorer-1', phase: '1-idea', agent: 'research-explorer', executionStatus: 'completed', summary: '真实返回：候选结构' } }) + '\n';
  const bytes = Buffer.from(line);
  const split = bytes.indexOf(Buffer.from('真实')) + 1;
  fs.writeFileSync(path.join(f.asyncDir, 'events.jsonl'), bytes.subarray(0, split));
  const o = f.observer();
  o.pollOnce();
  assert.equal(f.records().filter(e => e.kind === 'run-step').length, 0);
  fs.appendFileSync(path.join(f.asyncDir, 'events.jsonl'), bytes.subarray(split));
  o.pollOnce();
  assert.equal(f.records().find(e => e.kind === 'run-step').detail.summary, '真实返回：候选结构');
});

test('journal replacement and observer recovery do not duplicate events', t => {
  const f = fixture(t);
  f.journal('subagent.workflow.trace', { trace: [trace('explorer-1', 'started')] });
  const first = f.observer();
  first.pollOnce();
  first.stop();
  const count = f.records().length;
  const old = path.join(f.asyncDir, 'events.jsonl');
  fs.renameSync(old, old + '.old');
  fs.copyFileSync(old + '.old', old);
  const second = f.observer();
  second.pollOnce();
  assert.equal(f.records().length, count);
});

test('completed journal event closes the observer even before status catches up', t => {
  const f = fixture(t);
  f.journal('subagent.workflow.emit', { value: { type: 'workflow-result', outcome: 'blocked', reason: 'waiting for authorization' } });
  f.journal('subagent.workflow.completed', { state: 'complete' });
  const o = f.observer();
  o.pollOnce();
  assert(o.isClosed());
  assert(o.isTerminal());
  assert.deepEqual(f.records().filter(e => e.kind === 'run-outcome').map(e => [e.detail.status, e.detail.outcome, e.detail.reason]), [['completed', 'blocked', 'waiting for authorization']]);
});

test('status snapshot recovers step state, actual timing and semantic return', t => {
  const f = fixture(t);
  f.status({ state: 'complete', endedAt: START + 5000, steps: [{ workflowKey: 'experiment-1', phase: '2-experiment', agent: 'research-numerics', runId: 'child-numerics', status: 'completed', startedAt: START, durationMs: 2000 }], workflow: { value: { status: 'blocked', reason: 'evidence missing' }, emits: [] } });
  const o = f.observer();
  o.pollOnce();
  const records = f.records();
  const step = records.find(e => e.kind === 'run-step').detail;
  assert.equal(step.endedAt, new Date(START + 2000).toISOString());
  assert.equal(records.find(e => e.kind === 'stage-enter').detail.stage, '2-experiment');
  assert.equal(records.find(e => e.kind === 'run-outcome').detail.outcome, 'blocked');
  const count = records.length;
  f.observer().pollOnce();
  assert.equal(f.records().length, count);
});

for (const field of ['runId', 'cwd', 'sessionId']) test(`mismatched ${field} is rejected before journal progress is appended`, t => {
  const f = fixture(t);
  f.status({ [field]: 'another-owner' });
  f.journal('subagent.workflow.trace', { trace: [trace('explorer-1', 'started')] });
  const o = f.observer();
  o.pollOnce();
  assert.equal(f.records().filter(e => e.kind !== 'run-registered').length, 0);
  assert(o.isClosed());
  assert.match(o.getLastError(), /identity|owner|cwd/i);
});

test('foreign journal run ids and parent-workflow step ids are ignored', t => {
  const f = fixture(t);
  f.journal('subagent.workflow.trace', { runId: 'foreign', trace: [trace('bad', 'started')] });
  f.status({ steps: [{ workflowKey: 'bad-step', parentWorkflowRunId: 'foreign', status: 'running', phase: '3-review' }] });
  f.observer().pollOnce();
  assert.equal(f.records().filter(e => e.kind === 'run-step' || e.kind === 'stage-enter').length, 0);
});

test('result summaries preserve business failure, observed models and safe evidence', t => {
  const f = fixture(t);
  f.journal('subagent.workflow.emit', { value: { type: 'step-result', key: 'experiment-1', phase: '2-experiment', agent: 'research-numerics', executionStatus: 'completed', businessStatus: 'failed', observedModel: 'actual/model', summary: 'returned failure', evidence: [path.join(f.cwd, 'runs/result.json'), '../escape', '/private/file'] } });
  f.observer().pollOnce();
  const step = f.records().find(e => e.kind === 'run-step').detail;
  assert.equal(step.businessStatus, 'failed');
  assert.equal(step.observedModel, 'actual/model');
  assert.deepEqual(step.evidence, ['runs/result.json']);
  assert(!f.records().some(e => e.kind === 'claim' || e.kind === 'attempt'));
});

test('late started snapshots cannot regress a completed step or discard its result', t => {
  const f = fixture(t);
  f.journal('subagent.workflow.emit', { value: { type: 'step-result', key: 'explorer-1', phase: '1-idea', executionStatus: 'completed', summary: 'actual result' } });
  f.status({ steps: [{ workflowKey: 'explorer-1', status: 'running', phase: '1-idea' }] });
  f.observer().pollOnce();
  const steps = f.records().filter(e => e.kind === 'run-step');
  assert.equal(steps.at(-1).detail.status, 'completed');
  assert.equal(steps.at(-1).detail.summary, 'actual result');
});

test('a newer registration does not erase an old run history or update scientific state', t => {
  const f = fixture(t);
  appendEvent(f.cwd, 'run-registered', { runId: 'new-run', launchId: 'new-launch' });
  f.journal('subagent.workflow.trace', { trace: [trace('review-1', 'started', '3-review')] });
  f.observer().pollOnce();
  assert.equal(f.records().find(e => e.kind === 'stage-enter').detail.runId, f.runId);
});

test('evidence references stay project-contained and do not traverse symlinks', t => {
  const f = fixture(t);
  const outside = path.join(f.home, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.cwd, 'link'), 'dir');
  assert.deepEqual(normalizeEvidence(f.cwd, ['runs/a.json', path.join(f.cwd, 'runs/b.json'), '../x', 'link/x', '.env', 'keys/id_rsa', 'C:\\secret']), ['runs/a.json', 'runs/b.json']);
});
