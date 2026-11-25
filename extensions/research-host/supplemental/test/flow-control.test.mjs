import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSelectedPi } from '../../compat/provider-auth/runtime.mjs';
import { createFlowControlAdapter, probeFlowRuntime } from '../flow-control.mjs';
import { registerNativeRuntime } from '../native-runtime.mjs';

const { entry } = await loadSelectedPi();
const { createEventBus } = await import(pathToFileURL(path.join(path.dirname(entry), 'core/event-bus.js')).href);

test('the installed Pi EventBus has no receiver acknowledgement and an absent Flow runtime is refused', async () => {
  const bus = createEventBus();
  assert.equal(bus.emit('flow:run', {}), undefined);
  assert.equal(bus.listenerCount, undefined);
  assert.equal((await probeFlowRuntime(bus)).available, false);
  let received = 0;
  const execute = createFlowControlAdapter(bus, { timeoutMs: 25 });
  const result = await execute({ eventType: 'flow:run', data: { flowName: 'absent' } }, () => { received += 1; });
  assert.deepEqual(result, { status: 'rejected', reason: 'flow-runtime-unavailable' });
  assert.equal(received, 0);
  bus.clear();
});

test('a query responder alone cannot acknowledge a run whose actual control receiver is absent', async () => {
  const bus = createEventBus();
  bus.on('flow:list-flows', query => { query.flows = [{ name: 'listed-only' }]; });
  let received = 0;
  const execute = createFlowControlAdapter(bus, { timeoutMs: 25 });
  const result = await execute({ eventType: 'flow:run', data: { flowName: 'listed-only' } }, () => { received += 1; });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(received, 1);
  bus.clear();
});

test('a real receiver must emit the matching flow-started observation before run acceptance', async () => {
  const bus = createEventBus();
  bus.on('flow:list-flows', query => { query.flows = [{ name: 'observable' }]; });
  bus.on('flow:run', data => { setTimeout(() => bus.emit('flow:flow-started', { flowName: data.flowName }), 5); });
  const execute = createFlowControlAdapter(bus, { timeoutMs: 100 });
  const result = await execute({ eventType: 'flow:run', data: { flowName: 'observable' } }, () => {});
  assert.deepEqual(result, { status: 'accepted', observation: 'flow_started' });
  const missing = await execute({ eventType: 'flow:run', data: { flowName: 'different' } }, () => { throw new Error('must not dispatch'); });
  assert.equal(missing.reason, 'flow-not-found');
  bus.clear();
});

test('a stale or wrong-name lifecycle event cannot turn an unhandled run into success', async () => {
  const bus = createEventBus();
  bus.on('flow:list-flows', query => { query.flows = [{ name: 'requested' }]; });
  bus.on('flow:run', () => { bus.emit('flow:flow-started', { flowName: 'other' }); });
  const result = await createFlowControlAdapter(bus, { timeoutMs: 25 })({ eventType: 'flow:run', data: { flowName: 'requested' } }, () => {});
  assert.equal(result.status, 'unconfirmed');
  bus.clear();
});

test('native rejection is durable, is never acknowledged as acceptance, and cannot launch after reload', async () => {
  const bus = createEventBus();
  const history = [];
  const calls = [];
  const context = { sessionManager: { getSessionId: () => 'native-fixture', getBranch: () => history } };
  const pi = { events: bus, on() {}, getCommands: () => [], appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); } };
  const options = { activateAnthropic: false, pollEvents: false, getContext: () => context, request: async (pathname, body) => { calls.push({ pathname, body }); return { data: {} }; } };
  const first = await registerNativeRuntime(pi, options);
  const event = { eventId: 'rejected-event', eventType: 'flow:run', data: { flowName: 'later-installed' } };
  assert.equal((await first.consumeEvents([event]))[0].status, 'rejected');
  first.dispose();
  let launched = 0;
  bus.on('flow:list-flows', query => { query.flows = [{ name: 'later-installed' }]; });
  bus.on('flow:run', () => { launched += 1; });
  const second = await registerNativeRuntime(pi, options);
  assert.equal((await second.consumeEvents([event]))[0].status, 'rejected');
  assert.equal(launched, 0);
  assert.equal(calls.filter(call => call.pathname.endsWith('event-acknowledge')).length, 0);
  assert.equal(calls.filter(call => call.pathname.endsWith('event-reject')).length, 2);
  second.dispose(); bus.clear();
});
