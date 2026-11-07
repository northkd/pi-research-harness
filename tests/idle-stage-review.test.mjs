import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { digest } from '../extensions/research-loop/src/workbench-sync.mjs';
import { createIdleStageReviewer, validateConfig } from '../extensions/research-loop/src/idle-stage-review.mjs';
import { appendEvent, loadState, saveState } from '../extensions/research-loop/src/ledger.mjs';
import { recordObservedStage } from '../extensions/research-loop/src/stage-observer.mjs';

const OWNER_KEY = '["host","inert-operator"]';
const UPSTREAM = 'mock-upstream.example';
const CHARTER = { objective: 'Synthetic test charter', successCriteria: ['Synthetic criterion'], frozenAt: '2026-01-01T00:00:00.000Z' };
const STAGE = '2-experiment';

function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
}

function makeProject(root, options = {}) {
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, '.pi', 'research-loop'), { recursive: true });
  const stateFile = path.join(cwd, '.pi', 'research-loop', 'state.json');
  write(stateFile, { schema: 'pi-research-state.v1', stage: options.stage ?? '1-idea', charter: { ...CHARTER } });
  const adoptionRoot = path.join(root, 'adoptions');
  const adoptionId = 'adopt-' + 'a'.repeat(24);
  const adoptionDir = path.join(adoptionRoot, digest(OWNER_KEY), digest(cwd));
  write(path.join(adoptionDir, 'adopted.json'), { confirmed: true, id: adoptionId }, 0o600);
  write(path.join(adoptionDir, adoptionId + '.json'), {
    schema: 'pi-res-workflow-operation.v1',
    ownerKey: OWNER_KEY,
    cwd,
    adoption: { id: adoptionId, status: 'confirmed', cwd },
  }, 0o600);
  return { cwd, stateFile, adoptionRoot, adoptionId, charterHash: 'sha256:' + digest({ ...CHARTER }) };
}

function sessionRow(project, overrides = {}) {
  return {
    id: 'session-1',
    cwd: project.cwd,
    sessionFile: path.join(project.cwd, 'session-1.jsonl'),
    status: 'idle',
    currentTool: null,
    hostPressure: null,
    resWorkflow: { canonicalCwd: project.cwd, joinedAt: '2026-01-01T00:00:00.000Z', via: 'adoption' },
    ...overrides,
  };
}

function observationFor(project, clock, rows, overrides = {}) {
  const joined = rows.filter(row => row.resWorkflow?.canonicalCwd === project.cwd).length;
  return {
    schema: 'res-workflow.workbench-observation.v1',
    cwd: project.cwd,
    adoptionId: project.adoptionId,
    charterHash: project.charterHash,
    coverage: { partial: false, reasons: [], parentSessions: joined, nativeRuns: 0 },
    executions: [{ id: 'session-session-1', kind: 'pi-session', status: 'idle', currentTool: null, lastActivityAt: new Date(clock - 60_000).toISOString() }],
    heartbeatAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock - 1_000).toISOString(),
    ...overrides,
  };
}

function makeEnv(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-stage-review-'));
  const project = makeProject(root, options);
  const stateDir = path.join(root, 'state');
  const dashboardAuthFile = path.join(root, 'dashboard-auth.json');
  const workbenchTokenFile = path.join(root, 'workbench-token');
  const apiKeyFile = path.join(root, 'model-key');
  write(dashboardAuthFile, { headers: { 'x-pi-local-token': 'synthetic-dashboard-token' } });
  write(workbenchTokenFile, 'synthetic-workbench-token');
  write(apiKeyFile, 'synthetic-model-key');
  let clock = Date.parse('2026-11-04T12:00:00.000Z');
  const sessions = [sessionRow(project)];
  let observation = () => observationFor(project, clock, sessions);
  let modelHandler = () => Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  const calls = [];
  let modelCalls = 0;
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, redirect: init.redirect, headers: init.headers });
    if (parsed.pathname === '/api/sessions') return Response.json({ success: true, data: sessions });
    if (parsed.pathname === '/api/res-workflow/workbench-sync') return Response.json(observation());
    if (parsed.pathname === new URL(options.modelBaseUrl ?? 'http://127.0.0.1:18006/v1').pathname + '/chat/completions') {
      modelCalls += 1;
      return modelHandler({ url: String(url), init });
    }
    throw Error('unexpected-request');
  };
  const recordCalls = [];
  const recordStage = (cwd, input) => { recordCalls.push({ cwd, input }); return { changed: true, stage: input.stage }; };

  const raw = {
    enabled: true,
    stateDir,
    adoptionRoot: project.adoptionRoot,
    projectAllowlist: [project.cwd],
    dashboardOrigin: 'http://127.0.0.1:18005',
    dashboardAuthFile,
    workbench: { syncOrigin: 'http://127.0.0.1:18767', tokenFile: workbenchTokenFile, heartbeatMaxAgeMs: 120_000 },
    provider: 'openai-compatible',
    model: 'mock-stage-model',
    modelBaseUrl: options.modelBaseUrl ?? 'http://127.0.0.1:18006/v1',
    modelUpstreamHost: options.upstreamHost ?? UPSTREAM,
    apiKeyFile,
    authorization: {
      approved: true,
      approvedBy: 'synthetic-test',
      approvedAt: '2026-11-04T00:00:00.000Z',
      purpose: 'stage-classification',
      provider: 'openai-compatible',
      model: 'mock-stage-model',
      materialMode: options.materialMode ?? 'metadata',
      project: project.cwd,
      upstreamHost: options.authUpstreamHost ?? options.upstreamHost ?? UPSTREAM,
      ...(options.materialPaths ? { materialPaths: options.materialPaths } : {}),
      ...(options.maxCallsPerDay ? { maxCallsPerDay: options.maxCallsPerDay } : {}),
    },
    packet: options.packet ?? { mode: 'metadata' },
    idleAfterMs: options.idleAfterMs ?? 0,
    cooldownMs: options.cooldownMs ?? 60_000,
    maxRequestsPerProjectPerDay: options.maxRequestsPerProjectPerDay ?? 10,
    requestTimeoutMs: 2000,
    tickIntervalMs: 1000,
    backoffMs: options.backoffMs ?? 1000,
    maxBackoffMs: options.maxBackoffMs ?? 1000,
    skipAuditIntervalMs: 0,
  };
  const config = validateConfig(raw);
  const env = {
    root, project, stateDir, sessions, config, calls, recordCalls,
    get clock() { return clock; },
    advance(ms) { clock += ms; },
    setObservation(fn) { observation = fn; },
    setModelHandler(fn) { modelHandler = fn; },
    get modelCalls() { return modelCalls; },
    makeReviewer(recordStageFn = recordStage) {
      return createIdleStageReviewer({ config, fetcher, recordStage: recordStageFn, now: () => clock });
    },
    readAudit() {
      try { return fs.readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch { return []; }
    },
  };
  return env;
}

async function settleIdle(reviewer) {
  const first = await reviewer.tick();
  assert.equal(first.results[0].reason, 'idle-threshold-pending');
  return reviewer.tick();
}

test('idle project performs one bounded classification and writes the stage contract event', async t => {
  const env = makeEnv();
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'reviewed');
  assert.equal(result.results[0].stage, STAGE);
  assert.equal(env.modelCalls, 1);
  assert.equal(env.recordCalls.length, 1);
  assert.equal(env.recordCalls[0].cwd, env.project.cwd);
  assert.equal(env.recordCalls[0].input.source, 'idle-stage-review');
  assert.equal(env.recordCalls[0].input.expectedCharterHash, env.project.charterHash);
  assert.equal(env.recordCalls[0].input.stage, STAGE);
  assert.ok(!env.calls.some(call => call.method === 'POST' && !call.url.includes('/chat/completions')));
  assert.ok(!env.calls.some(call => call.url.includes('/api/session/')));
  assert.ok(env.readAudit().some(entry => entry.event === 'classified' && entry.stage === STAGE && entry.usage.total_tokens === 12 && entry.upstreamHost === UPSTREAM));
});

test('unchanged fingerprint suppresses a second charged request', async t => {
  const env = makeEnv();
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await settleIdle(reviewer);
  const second = await reviewer.tick();
  assert.equal(second.results[0].reason, 'unchanged');
  assert.equal(env.modelCalls, 1);
  assert.equal(env.recordCalls.length, 1);
});

test('observation heartbeats neither invalidate an in-flight reply nor defeat unchanged deduplication', async t => {
  const env = makeEnv({ cooldownMs: 0 });
  const fixed = observationFor(env.project, env.clock, env.sessions);
  env.setObservation(() => ({ ...fixed, heartbeatAt: new Date(env.clock).toISOString(), updatedAt: new Date(env.clock).toISOString() }));
  env.setModelHandler(() => {
    env.advance(10);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  assert.equal((await settleIdle(reviewer)).results[0].status, 'reviewed');
  env.advance(60_000);
  assert.equal((await reviewer.tick()).results[0].reason, 'unchanged');
  assert.equal(env.modelCalls, 1);
});

test('a charter revision keeps daily usage without enforcing the legacy daily quota', async t => {
  const env = makeEnv({ cooldownMs: 0, maxRequestsPerProjectPerDay: 1 });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await settleIdle(reviewer);
  const charter = { ...CHARTER, objective: 'Revised synthetic charter' };
  write(env.project.stateFile, { schema: 'pi-research-state.v1', stage: '1-idea', charter });
  env.project.charterHash = 'sha256:' + digest(charter);
  assert.equal((await reviewer.tick()).results[0].reason, 'idle-threshold-pending');
  assert.equal((await reviewer.tick()).results[0].status, 'reviewed');
  assert.equal(env.modelCalls, 2);
});

test('a standalone enabled daemon stays alive until signalled and releases its singleton', async t => {
  const env = makeEnv();
  const adoptionRoot = path.join(env.root, 'empty-adoptions');
  fs.mkdirSync(adoptionRoot, { mode: 0o700 });
  const configFile = path.join(env.root, 'daemon-config.json');
  write(configFile, { ...env.config, adoptionRoot });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../extensions/research-loop/scripts/run-stage-review.mjs', import.meta.url)), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let timeout;
  try {
    await Promise.race([
      new Promise(resolve => child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('[idle-stage-review] started')) resolve(); })),
      exited.then(([code]) => { throw Error('daemon exited before readiness: ' + code + ' ' + stderr); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('daemon readiness timeout: ' + stderr)), 5000); }),
    ]);
  } finally { clearTimeout(timeout); }
  await delay(80);
  assert.equal(child.exitCode, null, 'the daemon interval must keep the process alive');
  child.kill('SIGTERM');
  await exited;
  assert.equal(fs.existsSync(path.join(env.stateDir, 'daemon.lock')), false);
});

test('cooldown blocks changed evidence without a model request', async t => {
  const env = makeEnv({ cooldownMs: 60_000 });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await settleIdle(reviewer);
  env.sessions.push(sessionRow(env.project, { id: 'session-2', status: 'ended', endedAt: '2026-11-04T11:00:00.000Z' }));
  const second = await reviewer.tick();
  assert.equal(second.results[0].reason, 'cooldown');
  assert.equal(env.modelCalls, 1);
});

test('legacy daily limits do not cap changed-evidence reviews, including after restart', async t => {
  const env = makeEnv({ cooldownMs: 0, maxRequestsPerProjectPerDay: 1, maxCallsPerDay: 1 });
  let reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await settleIdle(reviewer);
  for (let index = 2; index <= 10; index += 1) {
    env.sessions.push(sessionRow(env.project, { id: 'session-' + index, status: 'ended', endedAt: '2026-11-04T11:00:00.000Z' }));
    assert.equal((await reviewer.tick()).results[0].status, 'reviewed');
  }
  reviewer.close();
  reviewer = env.makeReviewer();
  env.sessions.push(sessionRow(env.project, { id: 'session-11', status: 'ended', endedAt: '2026-11-04T11:00:00.000Z' }));
  assert.equal((await reviewer.tick()).results[0].status, 'reviewed');
  assert.equal(env.modelCalls, 11);
  assert.equal(env.readAudit().filter(entry => entry.event === 'requested').length, 11);
  assert.equal((await reviewer.tick()).results[0].reason, 'unchanged');
});

test('busy sessions, tools, permission waits and subagents fail closed', async t => {
  const cases = [
    { name: 'streaming session', rows: rows => { rows[0].status = 'streaming'; }, reason: 'project-busy' },
    { name: 'active tool', rows: rows => { rows[0].currentTool = 'bash'; }, reason: 'project-busy' },
    { name: 'permission wait', rows: rows => { rows[0].awaitingFileAccess = true; }, reason: 'project-busy' },
    { name: 'unsettled run', rows: rows => { rows[0].lastRunStartedAt = '2026-11-04T11:59:00.000Z'; rows[0].lastSettledAt = '2026-11-04T11:00:00.000Z'; }, reason: 'project-busy' },
    { name: 'host pressure', rows: rows => { rows[0].hostPressure = { state: 'degraded' }; }, reason: 'project-busy' },
    { name: 'unknown session status', rows: rows => { rows[0].status = 'mystery'; }, reason: 'coverage-unknown' },
    { name: 'running subagent', rows: () => {}, observation: obs => ({ ...obs, executions: [{ id: 'native-1', kind: 'native-subagent', status: 'running', currentTool: null }] }), reason: 'project-busy' },
    { name: 'queued subagent', rows: () => {}, observation: obs => ({ ...obs, executions: [{ id: 'native-1', status: 'queued' }] }), reason: 'project-busy' },
    { name: 'subagent waiting for approval', rows: () => {}, observation: obs => ({ ...obs, executions: [{ id: 'native-1', status: 'waiting-for-user' }] }), reason: 'project-busy' },
    { name: 'idle subagent with active tool', rows: () => {}, observation: obs => ({ ...obs, executions: [{ id: 'native-1', status: 'idle', currentTool: 'bash' }] }), reason: 'project-busy' },
    { name: 'terminal subagent with active tool', rows: () => {}, observation: obs => ({ ...obs, executions: [{ id: 'native-1', status: 'complete', currentTool: 'bash' }] }), reason: 'project-busy' },
    { name: 'partial coverage', rows: () => {}, observation: obs => ({ ...obs, coverage: { partial: true, reasons: ['catchup-pending'], parentSessions: 1, nativeRuns: 0 } }), reason: 'coverage-unknown' },
    { name: 'stale heartbeat', rows: () => {}, observation: obs => ({ ...obs, heartbeatAt: '2026-11-04T10:00:00.000Z' }), reason: 'coverage-unknown' },
    { name: 'membership mismatch', rows: () => {}, observation: obs => ({ ...obs, coverage: { ...obs.coverage, parentSessions: 2 } }), reason: 'coverage-unknown' },
  ];
  for (const item of cases) {
    const env = makeEnv();
    item.rows(env.sessions);
    if (item.observation) env.setObservation(() => item.observation(observationFor(env.project, env.clock, env.sessions)));
    const reviewer = env.makeReviewer();
    try {
      const base = observationFor(env.project, env.clock, env.sessions);
      if (item.observation) env.setObservation(() => item.observation(base));
      const result = await reviewer.tick();
      assert.equal(result.results[0].reason, item.reason, item.name);
      assert.equal(env.modelCalls, 0, item.name);
      assert.equal(env.recordCalls.length, 0, item.name);
    } finally {
      reviewer.close();
    }
  }
});

test('dirty project during inference aborts without recording', async t => {
  const env = makeEnv();
  env.setModelHandler(() => {
    env.sessions[0].status = 'active';
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'aborted');
  assert.equal(result.results[0].reason, 'project-became-dirty');
  assert.equal(env.recordCalls.length, 0);
  assert.ok(env.readAudit().some(entry => entry.event === 'aborted' && entry.reason === 'project-became-dirty'));
});

test('activity during inference requires a fresh complete idle window before another request', async t => {
  const env = makeEnv({ idleAfterMs: 100, cooldownMs: 0 });
  env.setModelHandler(() => {
    env.sessions[0].status = 'active';
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await reviewer.tick();
  env.advance(101);
  assert.equal((await reviewer.tick()).results[0].status, 'aborted');
  env.sessions[0].status = 'idle';
  env.advance(1);
  assert.equal((await reviewer.tick()).results[0].reason, 'idle-threshold-pending');
  env.advance(99);
  assert.equal((await reviewer.tick()).results[0].reason, 'idle-threshold');
  assert.equal(env.modelCalls, 1);
});

test('charter change during inference aborts without recording', async t => {
  const env = makeEnv();
  env.setModelHandler(() => {
    write(env.project.stateFile, { schema: 'pi-research-state.v1', stage: '1-idea', charter: { ...CHARTER, objective: 'Changed charter' } });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'aborted');
  assert.equal(result.results[0].reason, 'charter-or-scope-changed');
  assert.equal(env.recordCalls.length, 0);
});

test('a charter changed during the final awaited telemetry probe is revalidated before recording', async t => {
  const env = makeEnv();
  let probes = 0;
  env.setObservation(() => {
    if (++probes === 3) write(env.project.stateFile, { schema: 'pi-research-state.v1', stage: '1-idea', charter: { ...CHARTER, objective: 'Changed during final probe' } });
    return observationFor(env.project, env.clock, env.sessions);
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  assert.equal((await settleIdle(reviewer)).results[0].reason, 'charter-or-scope-changed');
  assert.equal(env.recordCalls.length, 0);
});

test('a late classifier reply retains request source time and cannot override a newer manual selection', async t => {
  const env = makeEnv();
  const fixed = observationFor(env.project, env.clock, env.sessions);
  env.setObservation(() => ({ ...fixed, heartbeatAt: new Date(env.clock).toISOString() }));
  env.setModelHandler(() => {
    env.advance(500);
    const state = loadState(env.project.cwd);
    const selectedAt = new Date(env.clock).toISOString();
    appendEvent(env.project.cwd, 'stage-enter', { stage: '1-idea', source: 'manual', charterRevision: state.charter.revision, selectedAt });
    Object.assign(state, { stage: '1-idea', stageSource: 'manual', stageObservedAt: selectedAt, stageCharterRevision: state.charter.revision });
    saveState(env.project.cwd, state);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer(recordObservedStage);
  t.after(() => reviewer.close());
  const result = (await settleIdle(reviewer)).results[0];
  assert.equal(result.status, 'reviewed');
  assert.equal(result.changed, false);
  assert.equal(loadState(env.project.cwd).stageSource, 'manual');
  assert.equal(loadState(env.project.cwd).stage, '1-idea');
  assert.ok(env.readAudit().some(entry => entry.event === 'classified' && entry.recordReason === 'stale observation'));
});

test('malformed model JSON is audited and retried after backoff', async t => {
  const env = makeEnv({ cooldownMs: 0, backoffMs: 1000, maxBackoffMs: 1000 });
  let attempts = 0;
  env.setModelHandler(() => {
    attempts += 1;
    return Response.json({ choices: [{ message: { content: attempts === 1 ? 'not json' : JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await reviewer.tick();
  const failed = await reviewer.tick();
  assert.equal(failed.results[0].status, 'error');
  assert.equal(failed.results[0].reason, 'model-json-invalid');
  assert.ok(env.readAudit().some(entry => entry.event === 'error' && entry.code === 'model-json-invalid'));
  assert.equal(env.modelCalls, 1);
  env.advance(1001);
  const retried = await reviewer.tick();
  assert.equal(retried.results[0].status, 'reviewed');
  assert.equal(env.modelCalls, 2);
});

test('network errors back off and retry without losing the idle window', async t => {
  const env = makeEnv({ cooldownMs: 0, backoffMs: 1000, maxBackoffMs: 1000 });
  let attempts = 0;
  env.setModelHandler(() => {
    attempts += 1;
    if (attempts === 1) throw Error('synthetic network failure');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: '3-review' }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await reviewer.tick();
  const failed = await reviewer.tick();
  assert.equal(failed.results[0].status, 'error');
  env.advance(1001);
  const retried = await reviewer.tick();
  assert.equal(retried.results[0].status, 'reviewed');
  assert.equal(retried.results[0].stage, '3-review');
  assert.equal(env.modelCalls, 2);
});

test('singleton lock prevents a second daemon instance', () => {
  const env = makeEnv();
  const first = env.makeReviewer();
  try {
    assert.throws(() => env.makeReviewer(), /already-running/);
  } finally {
    first.close();
  }
  const second = env.makeReviewer();
  second.close();
});

test('missing dashboard auth and missing model auth are observable skips with no request', async t => {
  const env = makeEnv();
  delete env.config.dashboardAuthFile;
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await reviewer.tick();
  assert.equal(result.results[0].reason, 'dashboard-auth-missing');
  assert.equal(env.modelCalls, 0);
  assert.ok(env.readAudit().some(entry => entry.event === 'skipped' && entry.reason === 'dashboard-auth-missing'));

  const env2 = makeEnv();
  delete env2.config.apiKeyFile;
  const reviewer2 = env2.makeReviewer();
  t.after(() => reviewer2.close());
  await reviewer2.tick();
  const result2 = await reviewer2.tick();
  assert.equal(result2.results[0].reason, 'model-auth-missing');
  assert.equal(env2.modelCalls, 0);
});

test('disabled configuration never discovers projects or calls a model', async t => {
  const env = makeEnv();
  env.config.enabled = false;
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await reviewer.tick();
  assert.equal(result.results[0].reason, 'disabled');
  assert.equal(env.calls.length, 0);
  assert.equal(env.modelCalls, 0);
});

test('approved extracts are redacted and bounded before transport', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-stage-extract-'));
  const extractFile = path.join(root, 'approved.md');
  write(extractFile, 'Goal paragraph.\npassword: hunter2\nMethod note.');
  const env = makeEnv({
    materialMode: 'approved-extracts',
    materialPaths: [extractFile],
    packet: { mode: 'approved-extracts', extractFiles: [{ label: 'goal', file: extractFile, maxChars: 500 }] },
  });
  let sentBody;
  env.setModelHandler(({ init }) => {
    sentBody = init.body;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: '1-idea' }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'reviewed');
  assert.ok(!sentBody.includes('hunter2'));
  assert.ok(sentBody.includes('[redacted]'));
  assert.ok(sentBody.includes('Goal paragraph.'));
  assert.ok(sentBody.length <= env.config.maxPromptChars);
  assert.ok(!sentBody.includes(extractFile));
  const audit = JSON.stringify(env.readAudit());
  assert.ok(!audit.includes('Goal paragraph.'));
  assert.ok(!audit.includes('hunter2'));
});

test('metadata-only packet is marked as non-semantic for the classifier', async t => {
  const env = makeEnv();
  let sentBody;
  env.setModelHandler(({ init }) => {
    sentBody = init.body;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: null, insufficient: true }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].reason, 'model-insufficient');
  const packet = JSON.parse(JSON.parse(sentBody).messages[1].content);
  assert.equal(packet.mode, 'metadata');
  assert.equal(packet.extracts, undefined);
  assert.ok(packet.projectRef);
  assert.equal(env.recordCalls.length, 0);
});

async function skipAfterIdle(env) {
  const reviewer = env.makeReviewer();
  try {
    const first = await reviewer.tick();
    assert.equal(first.results[0].reason, 'idle-threshold-pending');
    const second = await reviewer.tick();
    assert.equal(env.modelCalls, 0);
    return second.results[0];
  } finally {
    reviewer.close();
  }
}

test('authorization still binds exact project, upstream host and model', async () => {
  const cases = [
    ['two allowlisted projects', env => { env.config.projectAllowlist.push('/tmp/other-project'); }, 'authorization-project-scope-required'],
    ['different authorized project', env => { env.config.authorization.project = '/tmp/other-project'; }, 'authorization-project-mismatch'],
    ['missing upstream host', env => { delete env.config.authorization.upstreamHost; }, 'authorization-upstream-required'],
    ['different upstream host', env => { env.config.authorization.upstreamHost = 'other-upstream.example'; }, 'authorization-upstream-mismatch'],
    ['missing configured upstream host', env => { delete env.config.modelUpstreamHost; }, 'model-upstream-host-required'],
  ];
  for (const [name, mutate, reason] of cases) {
    const env = makeEnv();
    env.config.authorization.maxCallsPerDay = 12;
    mutate(env);
    const result = await skipAfterIdle(env);
    assert.equal(result.reason, reason, name);
    assert.equal(env.recordCalls.length, 0, name);
  }
});

test('approved extract files must exactly match the authorization material paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-stage-extract-scope-'));
  const approved = path.join(root, 'approved-summary.md');
  const unlisted = path.join(root, 'unlisted.md');
  write(approved, 'Approved de-identified task summary.');
  write(unlisted, 'Unapproved paper body.');
  const env = makeEnv({
    materialMode: 'approved-extracts',
    materialPaths: [approved],
    packet: { mode: 'approved-extracts', extractFiles: [
      { label: 'summary', file: approved, maxChars: 500 },
      { label: 'extra', file: unlisted, maxChars: 500 },
    ] },
  });
  const result = await skipAfterIdle(env);
  assert.equal(result.reason, 'authorization-material-path-mismatch');
  assert.equal(env.modelCalls, 0);
  assert.ok(!env.calls.some(call => call.method === 'POST'));
  assert.ok(!env.readAudit().some(entry => entry.event === 'classified'));

  const swapped = makeEnv({
    materialMode: 'approved-extracts',
    materialPaths: [approved],
    packet: { mode: 'approved-extracts', extractFiles: [{ label: 'summary', file: unlisted, maxChars: 500 }] },
  });
  const swappedResult = await skipAfterIdle(swapped);
  assert.equal(swappedResult.reason, 'authorization-material-path-mismatch');
  assert.equal(swapped.modelCalls, 0);

  const missing = makeEnv({
    materialMode: 'approved-extracts',
    packet: { mode: 'approved-extracts', extractFiles: [{ label: 'summary', file: approved, maxChars: 500 }] },
  });
  const missingResult = await skipAfterIdle(missing);
  assert.equal(missingResult.reason, 'authorization-material-paths-required');
  assert.equal(missing.modelCalls, 0);

  const duplicated = makeEnv({
    materialMode: 'approved-extracts',
    materialPaths: [approved, approved],
    packet: { mode: 'approved-extracts', extractFiles: [
      { label: 'summary', file: approved, maxChars: 500 },
      { label: 'extra', file: unlisted, maxChars: 500 },
    ] },
  });
  const duplicatedResult = await skipAfterIdle(duplicated);
  assert.equal(duplicatedResult.reason, 'authorization-material-path-mismatch');
  assert.equal(duplicated.modelCalls, 0);
});

test('every local fetch uses a validated loopback origin and disables redirects', async t => {
  const env = makeEnv();
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  await settleIdle(reviewer);
  assert.ok(env.calls.length >= 3);
  for (const call of env.calls) {
    const url = new URL(call.url);
    assert.equal(url.hostname, '127.0.0.1', call.url);
    assert.equal(call.redirect, 'error', call.url);
  }
  assert.ok(env.calls.every(call => call.headers?.['x-pi-local-token'] === 'synthetic-workbench-token' || call.headers?.['x-pi-local-token'] === 'synthetic-dashboard-token' || call.headers?.authorization === 'Bearer synthetic-model-key'));

  for (const raw of [
    { dashboardOrigin: 'http://example.com:8000' },
    { workbench: { syncOrigin: 'http://example.com:18767' } },
    { modelBaseUrl: 'http://example.com/v1' },
    { modelBaseUrl: 'http://127.0.0.1:18006/v1?escape=1' },
  ]) {
    assert.throws(() => validateConfig({ stateDir: '/tmp/idle-stage-config-check', ...raw }), /loopback-url-required/);
  }
  assert.throws(() => validateConfig({ stateDir: '/tmp/idle-stage-config-check', modelUpstreamHost: 'https://evil.example/path' }), /model-upstream-host-invalid/);
  assert.throws(() => validateConfig({
    enabled: true,
    stateDir: '/tmp/idle-stage-config-check',
    adoptionRoot: '/tmp/idle-stage-adoptions',
    dashboardOrigin: 'http://127.0.0.1:1',
    workbench: { syncOrigin: 'http://127.0.0.1:2' },
  }), /project-allowlist-required/);
});

test('model rejection is audited, records nothing and releases the lock on close', async () => {
  const env = makeEnv({ cooldownMs: 0, backoffMs: 1000, maxBackoffMs: 1000 });
  env.setModelHandler(() => Response.json({ error: 'denied' }, { status: 401 }));
  const reviewer = env.makeReviewer();
  await reviewer.tick();
  const failed = await reviewer.tick();
  assert.equal(failed.results[0].status, 'error');
  assert.equal(failed.results[0].reason, 'model-auth-rejected');
  assert.equal(env.recordCalls.length, 0);
  assert.ok(env.readAudit().some(entry => entry.event === 'error' && entry.code === 'model-auth-rejected'));
  assert.throws(() => env.makeReviewer(), /already-running/);
  reviewer.close();
  assert.equal(fs.existsSync(path.join(env.stateDir, 'daemon.lock')), false);
  const next = env.makeReviewer();
  const result = await next.tick();
  assert.equal(result.ok, true);
  next.close();
  assert.equal(fs.existsSync(path.join(env.stateDir, 'daemon.lock')), false);
});

test('workbench busy state appearing during inference aborts without recording', async t => {
  const env = makeEnv();
  env.setModelHandler(() => {
    const base = observationFor(env.project, env.clock, env.sessions);
    env.setObservation(() => ({ ...base, executions: [{ id: 'sub-1', kind: 'native-subagent', status: 'running', currentTool: null }] }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'aborted');
  assert.equal(result.results[0].reason, 'project-became-dirty');
  assert.equal(env.recordCalls.length, 0);
  assert.ok(env.readAudit().some(entry => entry.event === 'aborted' && entry.reason === 'project-became-dirty'));
});

test('oversized packet and oversized model responses are refused without recording', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-stage-bounds-'));
  const extract = path.join(root, 'summary.md');
  write(extract, 'x'.repeat(2000));
  const env = makeEnv({
    materialMode: 'approved-extracts',
    materialPaths: [extract],
    packet: { mode: 'approved-extracts', extractFiles: [{ label: 'summary', file: extract, maxChars: 2000 }] },
  });
  env.config.maxPacketChars = 256;
  const packetResult = await skipAfterIdle(env);
  assert.equal(packetResult.reason, 'packet-too-large');
  assert.equal(env.modelCalls, 0);

  const env2 = makeEnv();
  env2.setModelHandler(() => Response.json({ choices: [{ message: { content: 'z'.repeat(env2.config.maxResponseChars + 1) } }] }));
  const reviewer2 = env2.makeReviewer();
  await reviewer2.tick();
  const charResult = await reviewer2.tick();
  reviewer2.close();
  assert.equal(charResult.results[0].reason, 'model-response-too-large');
  assert.equal(env2.recordCalls.length, 0);

  const env3 = makeEnv();
  env3.config.maxResponseBytes = 1024;
  env3.setModelHandler(() => Response.json({ choices: [{ message: { content: 'stage: 1-idea ' + 'y'.repeat(5000) } }] }));
  const reviewer3 = env3.makeReviewer();
  await reviewer3.tick();
  const byteResult = await reviewer3.tick();
  reviewer3.close();
  assert.equal(byteResult.results[0].reason, 'model-response-too-large');
  assert.equal(env3.recordCalls.length, 0);
});

test('shutdown during inference aborts without recording and releases the lock', async () => {
  const env = makeEnv();
  let reviewer;
  env.setModelHandler(() => {
    reviewer.close();
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  reviewer = env.makeReviewer();
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'aborted');
  assert.equal(result.results[0].reason, 'daemon-closed');
  assert.equal(env.recordCalls.length, 0);
  assert.equal(fs.existsSync(path.join(env.stateDir, 'daemon.lock')), false);
});

const SUMMARY_SCHEMA = 'pi-research.stage-task-summary.v1';

function summaryFileFor(env) {
  return path.join(env.project.cwd, '.pi', 'research-loop', 'stage-task-summary.json');
}

function summaryEnv(env, options = {}) {
  const file = summaryFileFor(env);
  env.config.packet = {
    mode: 'approved-extracts',
    extractFiles: [{ label: 'task-summary', file, kind: 'stage-task-summary', maxChars: options.maxChars ?? 800 }],
  };
  env.config.authorization.materialMode = 'approved-extracts';
  env.config.authorization.materialPaths = options.materialPaths ?? [file];
  return env;
}

function writeStageSummary(env, value) {
  write(summaryFileFor(env), value);
}

test('generated task summary is accepted only as an explicitly configured bounded extract', async t => {
  const env = summaryEnv(makeEnv());
  writeStageSummary(env, {
    schema: SUMMARY_SCHEMA,
    charterHash: env.project.charterHash,
    charterRevision: 1,
    tasks: [
      { summary: 'Please implement the bounded plan.' },
      { summary: 'Please review the ablation.', at: '2026-11-04T11:00:00.000Z' },
    ],
    padding: 'x'.repeat(5000),
    note: 'SHOULD-NOT-APPEAR',
    updatedAt: '2026-11-04T11:30:00.000Z',
  });
  let sentBody;
  env.setModelHandler(({ init }) => {
    sentBody = init.body;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: '2-experiment' }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'reviewed');
  const packet = JSON.parse(JSON.parse(sentBody).messages[1].content);
  assert.equal(packet.mode, 'approved-extracts');
  assert.equal(packet.extracts.length, 1);
  assert.equal(packet.extracts[0].label, 'task-summary');
  assert.equal(packet.extracts[0].text, '- Please implement the bounded plan.\n- Please review the ablation.');
  assert.ok(packet.extracts[0].text.length <= 800);
  assert.ok(!sentBody.includes('SHOULD-NOT-APPEAR'));
  assert.ok(!sentBody.includes('x'.repeat(100)));
  assert.ok(!sentBody.includes(env.project.cwd));
});

test('malformed, unbounded, stale-charter or secret summary files cannot masquerade as extracts', async () => {
  const base = env => ({
    schema: SUMMARY_SCHEMA,
    charterHash: env.project.charterHash,
    charterRevision: 1,
    tasks: [{ summary: 'Please implement the approved plan.' }],
    updatedAt: '2026-11-04T11:30:00.000Z',
  });
  const cases = [
    ['wrong schema', env => ({ ...base(env), schema: 'pi-research.other.v1' })],
    ['wrong charter hash', env => ({ ...base(env), charterHash: 'sha256:' + 'd'.repeat(64) })],
    ['missing tasks', env => ({ ...base(env), tasks: [] })],
    ['too many tasks', env => ({ ...base(env), tasks: Array.from({ length: 5 }, () => ({ summary: 'Please implement the plan.' })) })],
    ['oversized task', env => ({ ...base(env), tasks: [{ summary: 'Please implement ' + 'y'.repeat(260) }] })],
    ['unknown task field', env => ({ ...base(env), tasks: [{ summary: 'Please implement the plan.', hidden: 'raw result body' }] })],
    ['absolute path', env => ({ ...base(env), tasks: [{ summary: 'Please read /etc/passwd and continue.' }] })],
    ['secret', env => ({ ...base(env), tasks: [{ summary: 'Please use password: hunter2 and continue.' }] })],
  ];
  for (const [name, value] of cases) {
    const env = summaryEnv(makeEnv());
    writeStageSummary(env, value(env));
    const result = await skipAfterIdle(env);
    assert.equal(result.reason, 'stage-task-summary-invalid', name);
    assert.equal(env.modelCalls, 0, name);
    assert.equal(env.recordCalls.length, 0, name);
  }

  const unreadable = summaryEnv(makeEnv());
  write(summaryFileFor(unreadable), '{not-json');
  const unreadableResult = await skipAfterIdle(unreadable);
  assert.equal(unreadableResult.reason, 'stage-task-summary-unreadable');
  assert.equal(unreadable.modelCalls, 0);

  assert.throws(() => makeEnv({
    materialMode: 'approved-extracts',
    materialPaths: [path.join(os.tmpdir(), 'not-a-summary.json')],
    packet: { mode: 'approved-extracts', extractFiles: [{ label: 'x', file: path.join(os.tmpdir(), 'not-a-summary.json'), kind: 'other', maxChars: 100 }] },
  }), /extract-kind-invalid/);
});

test('a generated summary file is never automatic authorization', async () => {
  const env = makeEnv({ materialMode: 'approved-extracts', packet: { mode: 'approved-extracts', extractFiles: [{ label: 'task-summary', file: path.join(os.tmpdir(), 'summary.json'), kind: 'stage-task-summary', maxChars: 800 }] } });
  writeStageSummary(env, { schema: SUMMARY_SCHEMA, charterHash: env.project.charterHash, charterRevision: 1, tasks: [{ summary: 'Please implement the plan.' }] });
  const result = await skipAfterIdle(env);
  assert.equal(result.reason, 'authorization-material-paths-required');
  assert.equal(env.modelCalls, 0);
});

test('the post-await fingerprint uses the same guarded summary packet', async t => {
  const env = summaryEnv(makeEnv());
  writeStageSummary(env, { schema: SUMMARY_SCHEMA, charterHash: env.project.charterHash, charterRevision: 1, tasks: [{ summary: 'Please implement the original plan.' }] });
  env.setModelHandler(() => {
    writeStageSummary(env, { schema: SUMMARY_SCHEMA, charterHash: env.project.charterHash, charterRevision: 1, tasks: [{ summary: 'Please implement a different plan.' }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ stage: STAGE }) } }] });
  });
  const reviewer = env.makeReviewer();
  t.after(() => reviewer.close());
  const result = await settleIdle(reviewer);
  assert.equal(result.results[0].status, 'aborted');
  assert.equal(result.results[0].reason, 'project-became-dirty');
  assert.equal(env.recordCalls.length, 0);
});

test('disabled configuration needs no allowlist and performs no discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-stage-disabled-'));
  const config = validateConfig({ enabled: false, stateDir: path.join(root, 'state') });
  let fetched = 0;
  const reviewer = createIdleStageReviewer({
    config,
    fetcher: async () => { fetched += 1; throw Error('unexpected'); },
    recordStage: () => ({ changed: false }),
  });
  const result = await reviewer.tick();
  assert.equal(result.results[0].reason, 'disabled');
  assert.equal(fetched, 0);
  reviewer.close();
});
