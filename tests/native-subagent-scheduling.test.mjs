import { randomUUID as releaseFixtureRandomUUID } from 'node:crypto';
const fixtureCredential1 = releaseFixtureRandomUUID();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { scheduleResearchSubagent } from '../extensions/research-loop/src/subagent-scheduling.mjs';
import { createResearchScheduledChild } from '../patches/subagents/support/research-subagent-scheduling.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const launch = (id = 'run-1', signal) => ({
  cwd: '/fixture/project', model: 'fixture/model-a', signal,
  runtime: { parentSessionId: 'parent-1', runId: id, childIndex: 0, agent: 'research-theory' },
});
const fakeChild = id => ({ sessionId: id, modelId: 'fixture/model-a', disposals: 0, async dispose() { this.disposals++; }, async prompt() {} });
function fixture({ cap = 3, unmanaged = false } = {}) {
  const rows = new Map(), requests = [], sleepers = [], errors = [];
  let limit = cap, authority = true, attempt = 0;
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const active = () => [...rows.values()].filter(row => row.status === 'acquired').length;
  const handler = async (_url, options) => {
    const input = JSON.parse(options.body); requests.push(input);
    let row = rows.get(input.requestId);
    if (input.action === 'subagent-acquire') {
      if (unmanaged) return respond({ status: 'unmanaged' });
      if (row && row.attemptId !== input.attemptId && row.status !== 'released') return respond({ error: 'subagent-launch-recovery-required' }, 409);
      if (row?.status === 'acquired' && row.attemptId === input.attemptId) return respond(row);
      if (!authority) return respond({ error: 'research-collaboration-main-historical' }, 409);
      if (!row || row.status === 'released') { row = { ...input, status: 'queued' }; rows.set(input.requestId, row); }
      const first = [...rows.values()].find(candidate => candidate.status === 'queued');
      if (active() < limit && first === row) { row.status = 'acquired'; row.leaseToken = 'lease-' + input.attemptId; }
      return respond({ ...row, retryAfterMs: 1000 });
    }
    if (!row || row.attemptId !== input.attemptId) return respond({ error: 'research-subagent-attempt-invalid' }, 409);
    if (row.status === 'acquired' && row.leaseToken !== input.leaseToken) return respond({ error: 'research-subagent-lease-required' }, 409);
    if (input.action === 'subagent-release') { row.status = 'released'; return respond({ status: 'released' }); }
    if (input.action === 'subagent-heartbeat') {
      if (input.phase === 'launching' && !authority) return respond({ error: 'research-collaboration-main-historical' }, 409);
      row.phase = input.phase;
      return respond({ status: 'acquired', leaseToken: row.leaseToken });
    }
    return respond({ error: 'unexpected-action' }, 400);
  };
  const options = {
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:1234', token: fixtureCredential1 }),
    fetchImpl: handler, heartbeatMs: 0, randomUUID: () => 'attempt-' + (++attempt),
    wait: (_ms, signal) => new Promise((resolve, reject) => {
      const abort = () => reject(new Error('research-subagent-launch-cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      sleepers.push(() => { signal?.removeEventListener('abort', abort); resolve(); });
    }),
  };
  return { rows, requests, errors, options, handler, active, setLimit: value => { limit = value; }, revoke: () => { authority = false; },
    tick: async () => { const all = sleepers.splice(0); for (const wake of all) wake(); await flush(); await flush(); },
    run: (id, create, controller) => scheduleResearchSubagent({ ...launch(id, controller?.signal), onExtensionError: event => errors.push(event.error.message) }, create, { task: 'Verify a fixture' }, options),
  };
}

test('ordinary installs leave native child creation exactly unchanged', async () => {
  const child = fakeChild('child-1'); let loads = 0;
  assert.equal(await createResearchScheduledChild(launch(), () => child, {}, { env: {}, load: async () => { loads++; } }), child);
  assert.equal(loads, 0);
});

test('configured native host bridge is exact and fails closed if missing', async () => {
  let url, creates = 0;
  const loader = async value => { url = value; return { scheduleResearchSubagent: async (value, create, metadata) => {
    assert.equal(value.runtime.parentSessionId, 'parent-1'); assert.equal(metadata.task, 'task'); return create();
  } }; };
  await createResearchScheduledChild(launch(), () => ++creates, { task: 'task' }, { env: { PI_RESEARCH_LOOP_ROOT: '/installed/research-loop' }, load: loader });
  assert.equal(url, 'file:///installed/research-loop/src/subagent-scheduling.mjs');
  assert.equal(creates, 1);
  await assert.rejects(createResearchScheduledChild(launch(), () => ++creates, {}, { env: { PI_RESEARCH_LOOP_ROOT: 'relative' }, load: loader }), /path-invalid/);
  await assert.rejects(createResearchScheduledChild(launch(), () => ++creates, {}, { env: { PI_RESEARCH_LOOP_ROOT: '/installed' }, load: async () => ({}) }), /scheduler-unavailable/);
  assert.equal(creates, 1);
});

test('only server-confirmed never-joined sessions bypass research admission', async () => {
  const f = fixture({ unmanaged: true }), child = fakeChild('outside-child');
  const dispose = child.dispose;
  assert.equal(await f.run('outside', () => child), child);
  assert.equal(child.dispose, dispose);
  assert.deepEqual(f.requests.map(row => row.action), ['subagent-acquire']);
});

test('live increase starts prepared work, decrease drains without killing active children', async () => {
  const f = fixture({ cap: 1 }), created = [];
  const create = id => () => { created.push(id); return fakeChild(id); };
  const first = await f.run('run-1', create('child-1'));
  const secondPromise = f.run('run-2', create('child-2'));
  const thirdPromise = f.run('run-3', create('child-3'));
  await flush();
  assert.deepEqual(created, ['child-1']); assert.equal(f.active(), 1);
  f.setLimit(2); await f.tick();
  const second = await secondPromise;
  assert.deepEqual(created, ['child-1', 'child-2']); assert.equal(f.active(), 2);
  f.setLimit(1); await f.tick();
  assert.equal(first.disposals, 0); assert.equal(second.disposals, 0);
  await first.dispose(); await f.tick();
  assert.equal(f.active(), 1); assert.equal(created.length, 2);
  await second.dispose(); await f.tick();
  const third = await thirdPromise;
  assert.deepEqual(created, ['child-1', 'child-2', 'child-3']);
  assert.equal(f.active(), 1); await third.dispose();
  assert.equal(f.active(), 0);
});

test('queued cancellation does not create a child and removes its pending request', async () => {
  const f = fixture({ cap: 1 });
  const live = await f.run('live', () => fakeChild('live'));
  const controller = new AbortController(); let creates = 0;
  const pending = f.run('waiting', () => { creates++; return fakeChild('wrong'); }, controller);
  await flush(); controller.abort();
  await assert.rejects(pending, /launch-cancelled/);
  assert.equal(creates, 0);
  assert.equal([...f.rows.values()].find(row => row.role === 'research-theory' && row.attemptId === 'attempt-2').status, 'released');
  assert.equal(f.active(), 1); await live.dispose();
});

test('acquire outcome lost in transit recovers the same attempt before release', async () => {
  const f = fixture(); let lost = false, creates = 0;
  const options = { ...f.options, fetchImpl: async (url, request) => {
    const response = await f.handler(url, request);
    if (!lost && JSON.parse(request.body).action === 'subagent-acquire') { lost = true; throw new Error('lost transport'); }
    return response;
  } };
  await assert.rejects(scheduleResearchSubagent(launch(), () => ++creates, {}, options), /admission-unconfirmed/);
  assert.equal(creates, 0); assert.equal(f.active(), 0);
  assert.equal(new Set(f.requests.map(row => row.attemptId)).size, 1);
});

test('detachment while waiting and at the final launch boundary denies new work', async () => {
  const f = fixture({ cap: 1 });
  const first = await f.run('first', () => fakeChild('child-1'));
  let creates = 0;
  const pending = f.run('waiting', () => { creates++; return fakeChild('wrong'); });
  const rejected = assert.rejects(pending, /main-historical/);
  await flush(); f.revoke(); await f.tick(); await rejected;
  assert.equal(creates, 0); assert.equal(first.disposals, 0);
  await first.dispose();

  const boundary = fixture();
  const options = { ...boundary.options, fetchImpl: async (url, request) => {
    const result = await boundary.handler(url, request);
    if (JSON.parse(request.body).action === 'subagent-acquire') boundary.revoke();
    return result;
  } };
  await assert.rejects(scheduleResearchSubagent(launch(), () => ++creates, {}, options), /main-historical/);
  assert.equal(creates, 0); assert.equal(boundary.active(), 0);
});

test('native disposal is idempotent and releases only after confirmed shutdown', async () => {
  const f = fixture(); let finish, disposals = 0;
  const child = await f.run('work', () => ({ sessionId: 'child', async dispose() { disposals++; await new Promise(resolve => { finish = resolve; }); } }));
  const first = child.dispose(), second = child.dispose();
  assert.equal(first, second); assert.equal(disposals, 1); assert.equal(f.active(), 1);
  finish(); await first;
  assert.equal(f.active(), 0);
  assert.equal(f.requests.filter(row => row.action === 'subagent-release').length, 1);
});

test('failed shutdown and unknown remote launch outcomes retain the slot', async () => {
  const f = fixture();
  const child = await f.run('failure', () => ({ sessionId: 'child', async dispose() { throw new Error('shutdown unknown'); } }));
  await assert.rejects(child.dispose(), /shutdown unknown/);
  assert.equal(f.active(), 1);
  const remote = fixture();
  await assert.rejects(scheduleResearchSubagent({ ...launch(), machine: { machineId: 'remote' } }, () => { throw new Error('remote unknown'); }, {}, remote.options), /remote unknown/);
  assert.equal(remote.active(), 1);
});

test('native startup failure releases before propagating the original error', async () => {
  const f = fixture();
  await assert.rejects(f.run('failed-create', () => { throw new Error('model unavailable'); }), /model unavailable/);
  assert.equal(f.active(), 0);
});

test('invalid/missing identity and unavailable server never reach create or expose credentials', async () => {
  let creates = 0;
  await assert.rejects(scheduleResearchSubagent({ cwd: '/fixture', runtime: {} }, () => ++creates), /parent-unavailable/);
  const f = fixture();
  const options = { ...f.options, resolveAuth: () => { throw new Error(fixtureCredential1); } };
  await assert.rejects(scheduleResearchSubagent(launch(), () => ++creates, {}, options), error => {
    assert.equal(error.message, 'research-subagent-dashboard-unavailable'); return true;
  });
  assert.equal(creates, 0);
});

test('metadata is bounded and actual child model is reported without changing launch choice', async () => {
  const f = fixture();
  const child = await scheduleResearchSubagent(launch(), () => fakeChild('child'), { task: 'x'.repeat(10_000) }, f.options);
  assert.equal(f.requests[0].task.length, 4000);
  assert.equal(f.requests[0].model, 'fixture/model-a');
  assert.equal(f.requests.find(row => row.phase === 'running').model, 'fixture/model-a');
  await child.dispose();
});

test('authenticated native patch includes the tested scheduling helper on both launch paths', () => {
  const metadata = JSON.parse(fs.readFileSync(new URL('../config/subagents-v020.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../patches/subagents/support/research-subagent-scheduling.mjs', import.meta.url));
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(metadata.files['src/runs/shared/research-subagent-scheduling.mjs'].afterSha256, hash);
  const patch = fs.readFileSync(new URL('../' + metadata.patch, import.meta.url), 'utf8');
  assert.match(patch, /createResearchScheduledChild\(input,/);
  assert.match(patch, /createResearchScheduledChild\(createInput,/);
});
