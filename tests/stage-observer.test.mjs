import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureResearch, withScientificRecordLock } from '../extensions/research-loop/src/adoption.mjs';
import { appendEvent, loadState, saveState, sha256 } from '../extensions/research-loop/src/ledger.mjs';
import { readEventsTolerant } from '../extensions/research-loop/src/workflow-progress.mjs';
import { classifyObservedStage, observeStageTurn, recordObservedStage, stripNonIntent } from '../extensions/research-loop/src/stage-observer.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stage-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { state } = configureResearch(root, { objective: 'example objective', successCriteria: ['reproducible'] });
  return { root, state };
}
const events = root => readEventsTolerant(path.join(root, '.pi', 'research-loop', 'events.jsonl'));
const stageEnters = root => events(root).filter(event => event.kind === 'stage-enter');

test('a joined research start records one visible observed stage entry without completion', t => {
  const { root, state } = fixture(t);
  const result = recordObservedStage(root, {
    stage: '1-idea', source: 'conversation', evidence: ['prompt:开始研究'],
    expectedCharterHash: sha256(state.charter), sessionId: 'session-1',
  });
  assert.deepEqual(result, { changed: true, stage: '1-idea' });
  const after = loadState(root);
  assert.equal(after.stage, '1-idea');
  assert.equal(after.stageSource, 'conversation');
  assert.deepEqual(after.claims, []);
  assert.equal(after.completed, undefined);
  const entries = stageEnters(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail.stage, '1-idea');
  assert.equal(entries[0].detail.source, 'conversation');
  assert.equal(entries[0].detail.observed, true);
  assert.deepEqual(entries[0].detail.evidence, ['prompt:开始研究']);
  assert.equal(entries[0].detail.sessionId, 'session-1');
});

test('repeated observations are idempotent and do not append duplicate events', t => {
  const { root, state } = fixture(t);
  const input = { stage: '2-experiment', source: 'tool-observed', evidence: ['tool:bash:run experiment'], expectedCharterHash: sha256(state.charter) };
  assert.equal(recordObservedStage(root, input).changed, true);
  assert.deepEqual(recordObservedStage(root, input), { changed: false, stage: '2-experiment', reason: 'already current' });
  assert.equal(stageEnters(root).length, 1);
});

test('daemon object evidence is bounded and recorded with its source label', t => {
  const { root, state } = fixture(t);
  const result = recordObservedStage(root, {
    stage: '3-review', source: 'idle-stage-review', evidence: { requestId: 'r1', model: 'mock-model', executions: 0 },
    expectedCharterHash: sha256(state.charter),
  });
  assert.equal(result.changed, true);
  const entry = stageEnters(root)[0];
  assert.equal(entry.detail.source, 'idle-stage-review');
  assert.deepEqual(entry.detail.evidence, ['requestId=r1', 'model=mock-model', 'executions=0']);
});

test('a changed charter rejects the observation instead of overwriting the record', t => {
  const { root, state } = fixture(t);
  const oldHash = sha256(state.charter);
  configureResearch(root, { objective: 'replacement objective', successCriteria: ['new criterion'] });
  const result = recordObservedStage(root, { stage: '3-review', source: 'daemon', evidence: ['daemon:review'], expectedCharterHash: oldHash });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'charter changed');
  assert.equal(stageEnters(root).length, 0);
  assert.notEqual(loadState(root).stage, '3-review');
});

test('missing state, invalid stage and invalid source are rejected without writing', t => {
  const empty = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stage-observer-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(recordObservedStage(empty, { stage: '1-idea', source: 'conversation', evidence: ['x'] }).reason, 'no research charter');
  assert.equal(fs.existsSync(path.join(empty, '.pi')), false);

  const { root } = fixture(t);
  assert.equal(recordObservedStage(root, { stage: 'unknown', source: 'conversation', evidence: ['x'] }).reason, 'unsupported stage');
  assert.equal(recordObservedStage(root, { stage: '1-idea', source: 'Bad Source', evidence: ['x'] }).reason, 'source must be a bounded label');
  assert.equal(recordObservedStage(root, { stage: '1-idea', source: 'daemon', evidence: ['x'] }).reason, 'daemon source requires expectedCharterHash');
  assert.equal(stageEnters(root).length, 0);
});

test('an older observation cannot regress the stage after a newer one', t => {
  const { root, state } = fixture(t);
  const expectedCharterHash = sha256(state.charter);
  recordObservedStage(root, { stage: '2-experiment', source: 'tool-observed', evidence: ['tool:bash:run experiment'], expectedCharterHash, at: '2026-11-04T10:00:00.000Z' });
  const stale = recordObservedStage(root, { stage: '1-idea', source: 'conversation', evidence: ['prompt:old'], expectedCharterHash, at: '2026-11-04T09:00:00.000Z' });
  assert.deepEqual(stale, { changed: false, stage: '2-experiment', reason: 'stale observation' });
  assert.equal(loadState(root).stage, '2-experiment');
  assert.equal(stageEnters(root).length, 1);
});

test('symlinked project paths are rejected and reentrant locking loses no write', t => {
  const { root, state } = fixture(t);
  const alias = path.join(path.dirname(root), path.basename(root) + '-alias');
  fs.symlinkSync(root, alias, 'dir');
  t.after(() => fs.rmSync(alias, { force: true }));
  assert.throws(() => recordObservedStage(alias, { stage: '1-idea', source: 'conversation', evidence: ['prompt:start'] }), /Unsafe noncanonical|symlink/i);

  const result = withScientificRecordLock(root, () => recordObservedStage(root, {
    stage: '1-idea', source: 'conversation', evidence: ['prompt:start'], expectedCharterHash: sha256(state.charter),
  }));
  assert.equal(result.changed, true);
  assert.equal(loadState(root).stage, '1-idea');
});

test('a live foreign lock makes observation fail closed without touching the record', t => {
  const { root } = fixture(t);
  const lock = path.join(root, '.pi', 'research-loop', '.charter-configure.lock');
  fs.writeFileSync(lock, JSON.stringify({ schema: 'pi-research-charter-lock.v1', pid: process.pid, nonce: 'foreign' }));
  t.after(() => fs.rmSync(lock, { force: true }));
  assert.throws(() => recordObservedStage(root, { stage: '1-idea', source: 'conversation', evidence: ['prompt:start'] }), /busy/i);
  assert.equal(stageEnters(root).length, 0);
  assert.equal(loadState(root).stage, undefined);
});

test('observation preserves unrelated scientific records', t => {
  const { root } = fixture(t);
  const state = loadState(root);
  state.claims = [{ id: 'c1', statement: 'existing claim', status: 'proposed' }];
  state.attempts = 4;
  saveState(root, state);
  recordObservedStage(root, { stage: '4-summary', source: 'daemon', evidence: ['daemon:claims'], expectedCharterHash: sha256(state.charter) });
  const after = loadState(root);
  assert.deepEqual(after.claims, state.claims);
  assert.equal(after.attempts, 4);
  assert.equal(after.stage, '4-summary');
});

test('quoted protocol, code quotes, negations, planning and future mentions are not intent', () => {
  assert.equal(classifyObservedStage({ userText: '> 当您检测到对话与任务已进入对应阶段时，请调用 research_loop action="stage" 进入 3-review' }), null);
  assert.equal(classifyObservedStage({ userText: '文档写着 `写论文`，但不要照做' }), null);
  assert.equal(classifyObservedStage({ userText: '不要再推进到 3-review，我们还没开始写论文' }), null);
  assert.equal(classifyObservedStage({ userText: '以后再做实验，下一步计划写论文' }), null);
  assert.equal(classifyObservedStage({ userText: '我们计划先做文献调研' }), null);
  assert.equal(classifyObservedStage({ userText: '需要写论文吗？' }), null);
  assert.equal(stripNonIntent('> 引用：开始写论文\n正常讨论').trim(), '正常讨论');
});

test('explicit present-tense conversation and real revisits are observed', () => {
  assert.equal(classifyObservedStage({ userText: '现在开始做实验，已经准备好数据' }).stage, '2-experiment');
  assert.equal(classifyObservedStage({ userText: '我们来研究钙钛矿的稳定性' }).stage, '1-idea');
  assert.equal(classifyObservedStage({ userText: '回到评审阶段重新做对抗评审', currentStage: '5-writing' }).stage, '3-review');
  // Repeating the current stage is left to recordObservedStage's idempotence check.
  assert.equal(classifyObservedStage({ userText: '继续做对抗评审', currentStage: '3-review' }), null);
});

test('direct first-person action is observed while quotes and future-only plans are not', () => {
  assert.equal(classifyObservedStage({ userText: '先做实验，结果出来再讨论' }).stage, '2-experiment');
  assert.equal(classifyObservedStage({ userText: '“写论文”只是引用别人的要求' }), null);
  assert.equal(classifyObservedStage({ userText: '「先做实验」这句话是评审意见，我们先做文献调研' }).stage, '1-idea');
  assert.equal(classifyObservedStage({ userText: '准备写论文，下一步开始做实验' }), null);
});

function selectStageManually(root, stage, selectedAt) {
  return withScientificRecordLock(root, () => {
    const state = loadState(root);
    appendEvent(root, 'stage-enter', { stage, phase: state.phase ?? 1, charterRevision: state.charter.revision, source: 'manual', observed: false, selectedAt });
    state.stage = stage;
    state.stageSource = 'manual';
    state.stageObservedAt = selectedAt;
    state.stageCharterRevision = state.charter.revision;
    saveState(root, state);
    return selectedAt;
  });
}

test('hook-facing observation needs verified context and uses source time over settlement time', t => {
  const { root, state } = fixture(t);
  const context = { sessionId: 'session-1', charterHash: sha256(state.charter) };
  assert.equal(observeStageTurn(root, null, { userText: '现在开始做实验' }), null);
  assert.equal(observeStageTurn(root, { sessionId: 'session-1' }, { userText: '现在开始做实验' }), null);
  assert.equal(stageEnters(root).length, 0);

  const first = observeStageTurn(root, context, { userText: '现在开始做实验', at: '2026-11-04T10:00:00.000Z' });
  assert.deepEqual(first, { changed: true, stage: '2-experiment' });
  selectStageManually(root, '4-summary', '2026-11-04T10:30:00.000Z');

  // A long turn that started before the human click must not outrank it.
  const stale = observeStageTurn(root, context, { userText: '现在开始写论文', at: '2026-11-04T09:00:00.000Z' });
  assert.equal(stale.changed, false);
  assert.equal(stale.reason, 'stale observation');
  assert.equal(loadState(root).stage, '4-summary');
  assert.equal(stageEnters(root).length, 2);
});

test('a new charter does not dedupe against a stage event from the old charter', t => {
  const { root, state } = fixture(t);
  const oldHash = sha256(state.charter);
  assert.equal(recordObservedStage(root, {
    stage: '2-experiment', source: 'conversation', evidence: ['prompt:现在开始做实验'],
    expectedCharterHash: oldHash, at: '2026-11-04T10:00:00.000Z',
  }).changed, true);
  const replacement = configureResearch(root, { objective: 'replacement objective', successCriteria: ['new criterion'] });
  const newHash = sha256(replacement.state.charter);
  assert.notEqual(newHash, oldHash);
  const result = recordObservedStage(root, {
    stage: '2-experiment', source: 'conversation', evidence: ['prompt:现在开始做实验'],
    expectedCharterHash: newHash, at: '2026-11-04T11:00:00.000Z',
  });
  assert.equal(result.changed, true);
  const entries = stageEnters(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].detail.charterRevision, replacement.state.charter.revision);
  assert.equal(loadState(root).stageCharterRevision, replacement.state.charter.revision);
});

test('actual tool intent and results outrank prose and failed results are ignored', () => {
  assert.equal(classifyObservedStage({ tools: [{ name: 'write', input: { path: 'paper/main.tex' }, ok: true }] }).stage, '5-writing');
  assert.equal(classifyObservedStage({ tools: [{ name: 'write', input: { path: 'paper/main.tex' }, ok: false }] }), null);
  assert.equal(classifyObservedStage({ tools: [{ name: 'subagent', input: { agentName: 'research-critic' }, ok: true }] }).stage, '3-review');
  const result = classifyObservedStage({ userText: '现在开始写论文', tools: [{ name: 'bash', input: { command: 'python train.py --experiment main' }, ok: true }] });
  assert.equal(result.stage, '2-experiment');
  assert.equal(result.source, 'tool-observed');
});

test('actual successful tool observations write bounded evidence through the record contract', t => {
  const { root, state } = fixture(t);
  const context = { sessionId: 'session-1', charterHash: sha256(state.charter) };
  const result = observeStageTurn(root, context, {
    tools: [{ name: 'write', input: { path: 'paper/main.tex' }, ok: true }],
  });
  assert.deepEqual(result, { changed: true, stage: '5-writing' });
  assert.deepEqual(stageEnters(root)[0].detail.evidence, ['tool:write:path=paper/main.tex']);
  assert.equal(loadState(root).stage, '5-writing');
});

test('unversioned historical stage events cannot stale-block a current charter observation', t => {
  const { root, state } = fixture(t);
  appendEvent(root, 'stage-enter', { stage: '5-writing', source: 'manual', selectedAt: '2099-01-01T00:00:00.000Z' });
  const result = recordObservedStage(root, {
    stage: '2-experiment', source: 'conversation', evidence: ['prompt:现在开始做实验'],
    expectedCharterHash: sha256(state.charter), at: '2026-11-04T12:00:00.000Z',
  });
  assert.deepEqual(result, { changed: true, stage: '2-experiment' });
});

test('SDK adapter registers the real hook names and unverified sessions write nothing', async t => {
  const { default: register } = await import('../extensions/research-loop/src/index.ts');
  const handlers = new Map();
  const tools = [];
  register({
    on(name, handler) { handlers.set(name, handler); return () => {}; },
    registerTool(tool) { tools.push(tool); },
    registerCommand() {},
  });
  for (const name of ['before_agent_start', 'tool_call', 'tool_result', 'agent_settled', 'agent_end']) assert.ok(handlers.has(name), name);
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['research_dispatch', 'research_loop', 'research_session']);
  for (const name of ['input', 'context', 'tool_execution_end']) assert.ok(handlers.has(name), name);

  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stage-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => 'session-x', getSessionFile: () => path.join(root, 'session.jsonl') },
  };
  // No joined-session/adoption record: hooks must not create research state.
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: '现在开始做实验' }, ctx);
  handlers.get('tool_call')({ toolCallId: 't1', toolName: 'bash', input: { command: 'python train.py' } }, ctx);
  handlers.get('tool_result')({ toolCallId: 't1', toolName: 'bash', input: {}, isError: false }, ctx);
  await handlers.get('agent_settled')({ aborted: false }, ctx);
  await handlers.get('agent_end')({}, ctx);
  assert.equal(fs.existsSync(path.join(root, '.pi')), false);
});
