import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSupplementalRuntime } from '../index.mjs';

async function fixture(overrides = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-automation-delivery-'));
  const project = path.join(temporary, 'project');
  const homeDir = path.join(temporary, 'home');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  const sessions = [{ id: 'lead', cwd: project, status: 'idle' }];
  let killed = 0;
  const runtime = await createSupplementalRuntime({ homeDir, dataDir: path.join(temporary, 'state'),
    getSession: id => sessions.find(session => session.id === id), listSessions: () => sessions,
    knownCwds: () => [project], logger: { info() {}, warn() {}, error() {} },
    sendToSession: async () => false,
    spawnSession: async input => { const id = 'worker-' + sessions.length; sessions.push({ id, cwd: project, status: 'idle', ...input.pluginRef }); return { success: true, spawnToken: id }; },
    abortSpawnedRun: async () => { killed += 1; return true; },
    ...overrides,
  });
  const request = (method, pathname, body, query = {}) => {
    const url = new URL(pathname, 'http://127.0.0.1');
    for (const [key, value] of Object.entries({ cwd: project, ...query })) url.searchParams.set(key, value);
    return runtime.handle({ method, pathname, url, body });
  };
  const create = async action => request('POST', '/api/plugins/automation/create', { cwd: project, name: 'delivery-fixture', promptBody: 'Synthetic dispatch', config: {
    on: { kind: 'schedule', cron: '0 0 1 1 *' }, model: 'cliproxy/fixture', mode: 'local', sandbox: 'workspace-write', concurrency: 'skip', action,
  } });
  return { runtime, sessions, request, create, killed: () => killed, async close() { runtime.dispose(); await fs.rm(temporary, { recursive: true, force: true }); } };
}

test('refused asynchronous automation prompt finalizes error instead of remaining running', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.create({ kind: 'prompt', prompt: './prompt.md' })).statusCode, 200);
    const run = await f.request('POST', '/api/plugins/automation/run', { cwd: f.sessions[0].cwd, name: 'delivery-fixture' });
    assert.equal(run.body.ok, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    f.runtime.onPiEvent(f.sessions[1].id, { type: 'agent_start' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const history = await f.request('GET', '/api/plugins/automation/runs');
    const result = history.body.runs.find(value => value.runId === run.body.runId);
    assert.equal(result.status, 'error');
    assert.ok(f.killed() > 0);
  } finally { await f.close(); }
});

test('a fast native flow completion is retained while its delivery acknowledgement is pending', async () => {
  let f;
  let finishDelivery;
  let emissions = 0;
  f = await fixture({ emitEventToSession: async (sessionId, eventType, data) => {
    emissions += 1;
    assert.equal(eventType, 'flow:run');
    f.runtime.onPiEvent(sessionId, { eventType: 'flow_complete', data: { flowName: data.flowName, status: 'success', lastResult: { result: { summary: 'Synthetic immediate output' } } } });
    return new Promise(resolve => { finishDelivery = resolve; });
  } });
  try {
    f.runtime.onPiEvent('lead', { type: 'flows_list', flows: [{ name: 'synthetic:flow' }], runtimeAvailable: true });
    assert.equal((await f.create({ kind: 'flows.run', payload: { flow: 'synthetic:flow' } })).statusCode, 200);
    const run = await f.request('POST', '/api/plugins/automation/run', { cwd: f.sessions[0].cwd, name: 'delivery-fixture' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const worker = f.sessions[1];
    f.runtime.onPiEvent(worker.id, { type: 'agent_start' });
    f.runtime.onPiEvent(worker.id, { type: 'agent_start' });
    assert.equal(emissions, 1);
    const result = await f.request('GET', '/api/plugins/automation/result', undefined, { runId: worker.automationRun.runId });
    assert.equal(result.statusCode, 200);
    assert.ok(result.body.result.includes('Synthetic immediate output'));
    finishDelivery(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const history = await f.request('GET', '/api/plugins/automation/runs');
    assert.equal(history.body.runs.find(value => value.runId === run.body.runId).status, 'done');
  } finally { await f.close(); }
});

test('control HTTP success requires acceptance and an absent native Flow runtime is reported explicitly', async () => {
  const f = await fixture({ emitEventToSession: async () => undefined });
  try {
    const body = { sessionId: 'lead', action: 'run', payload: { flowName: 'synthetic:flow' } };
    const unconfirmed = await f.request('POST', '/api/plugins/flows/control', body);
    assert.equal(unconfirmed.statusCode, 503);
    assert.equal(unconfirmed.body.success, false);
    f.runtime.onPiEvent('lead', { type: 'flows_list', flows: [], runtimeAvailable: false });
    const unavailable = await f.request('POST', '/api/plugins/flows/control', body);
    assert.equal(unavailable.statusCode, 409);
    assert.equal(unavailable.body.error, 'flow-runtime-unavailable');
    f.runtime.onPiEvent('lead', { eventType: 'flow_started', data: { flowName: 'synthetic:flow' } });
    const dismissed = await f.request('POST', '/api/plugins/flows/control', { sessionId: 'lead', action: 'dismiss_summary' });
    assert.equal(dismissed.statusCode, 200);
    const state = await f.request('GET', '/api/plugins/flows/state', undefined, { sessionId: 'lead' });
    assert.equal(state.body.flowState, null);
  } finally { await f.close(); }
});
