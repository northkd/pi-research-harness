import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createQuestionRuntime, createBriefModelResolver } from './index.mjs';
import { registerNativeQuestionTools, QUESTION_RESPONSE_EVENT } from './native.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const ask = (runtime, method, pathname, body, context = 'owner') => runtime.handle({ method, pathname, body, context });

async function fixture(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-native-questions-'));
  const pending = new Map();
  const calls = [];
  const history = [];
  let native;
  const runtime = createQuestionRuntime({ dataDir,
    authorizeSession: (_id, context) => context === 'owner',
    getConfig: () => ({ questions: { autoBrief: false, minBriefChars: 240 } }),
    describeSession: () => ({ label: 'Synthetic session' }),
    deliverUiResponse: async (sessionId, response, metadata) => {
      if (metadata?.transport === 'question-native') {
        const receipt = await native.consumeEvent({ eventType: QUESTION_RESPONSE_EVENT, eventId: randomUUID(), data: { sessionId, response } }, { sessionManager: { getSessionId: () => sessionId, getBranch: () => history } });
        return { accepted: receipt.status === 'accepted' };
      }
      const prompt = pending.get(response.id);
      if (!prompt) return { accepted: false };
      pending.delete(response.id);
      prompt.resolve(response.cancelled ? prompt.method === 'confirm' ? false : undefined
        : prompt.method === 'confirm' ? response.confirmed : response.value);
      await runtime.onNativeEvent(sessionId, { type: 'extension_ui_resolved', id: response.id });
      return { accepted: true };
    }, ...overrides });
  const hooks = new Map();
  const tools = [];
  const pi = { on: (name, handler) => hooks.set(name, handler), registerTool: tool => tools.push(tool),
    appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); void runtime.onNativeEvent('session', { type: 'entry_appended', entry: history.at(-1) }); } };
  native = registerNativeQuestionTools(pi, { getConfig: () => ({ askUserPromptTimeoutSeconds: -1 }) });
  hooks.get('session_start')();
  assert.equal(tools[0].name, 'ask_user');
  const ui = Object.fromEntries(['select', 'input', 'confirm'].map(method => [method, (title, value, opts) => {
    const id = randomUUID();
    const event = { type: 'extension_ui_request', id, method, title, ...(method === 'select' ? { options: value } : method === 'confirm' ? { message: value } : { placeholder: value }), ...(opts.timeout ? { timeout: opts.timeout } : {}) };
    calls.push({ ...event, opts });
    return new Promise(resolve => { pending.set(id, { method, resolve, event }); void runtime.onNativeEvent('session', event); });
  }]));
  const run = params => native.tool.execute('synthetic-tool-id', native.tool.prepareArguments(params), undefined, undefined, { ui, sessionManager: { getSessionId: () => 'session' } });
  return { runtime, native, run, calls, pending, history, dataDir,
    async answer(answer) { await tick(); const listed = await ask(runtime, 'GET', '/api/questions'); const id = listed.body.data[0].id; return ask(runtime, 'POST', '/api/questions/' + id + '/answer', { answer }); },
    async dispose() { runtime.dispose(); for (const item of pending.values()) item.resolve(undefined); await tick(); await fs.rm(dataDir, { recursive: true, force: true }); } };
}

test('legacy ask_user resolves a real native dialog and the question route preserves exact answer identity', async () => {
  const f = await fixture();
  try {
    const promise = f.run({ params: JSON.stringify({ method: 'select', question: 'Choose a synthetic option', options: ['A', 'B'], allowOther: false }) });
    await tick();
    const rows = (await ask(f.runtime, 'GET', '/api/questions')).body.data;
    assert.equal(rows.length, 1);
    assert.equal(f.calls[0].opts.timeout, undefined);
    assert.equal((await ask(f.runtime, 'GET', '/api/questions', undefined, 'stranger')).body.data.length, 0);
    assert.equal((await ask(f.runtime, 'POST', '/api/questions/' + rows[0].id + '/answer', { answer: 'C' })).statusCode, 400);
    assert.equal((await f.answer('B')).body.data.transmitted, true);
    const output = await promise;
    assert.equal(output.details.result, 'B');
    assert.equal(output.content[0].text, 'User responded: "B"');
    assert.equal((await ask(f.runtime, 'GET', '/api/questions')).body.data.length, 0);
    assert.ok(f.history.some(entry => entry.data.phase === 'resolved'));
  } finally { await f.dispose(); }
});

test('native multiselect and batch produce original toolResult structures through real choice dialogs', async () => {
  const f = await fixture();
  try {
    const multi = f.run({ method: 'multiselect', title: 'Synthetic multi', options: ['A', 'B'], allowOther: false });
    await f.answer('[ ] A');
    await f.answer('Done');
    assert.deepEqual((await multi).details.result, ['A']);
    const batch = f.run({ questions: [{ method: 'confirm', title: 'Synthetic confirm' }, { method: 'input', title: 'Synthetic input' }] });
    await f.answer('false');
    await f.answer('synthetic value');
    assert.deepEqual((await batch).details.results, [false, 'synthetic value']);
  } finally { await f.dispose(); }
});

test('shared question latch refuses concurrent native and legacy answers and releases failed transport', async () => {
  let accept;
  let deliveries = 0;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-claim-'));
  const runtime = createQuestionRuntime({ dataDir: temporary, authorizeSession: () => true,
    getConfig: () => ({ questions: { autoBrief: false, minBriefChars: 240 } }),
    deliverUiResponse: async () => { deliveries++; return new Promise(resolve => { accept = resolve; }); } });
  try {
    await runtime.onNativeEvent('session', { type: 'extension_ui_request', id: 'native-id', method: 'confirm', title: 'Synthetic claim' });
    const id = runtime.store.listRows()[0].id;
    const first = ask(runtime, 'POST', `/api/questions/${id}/answer`, { answer: 'true' });
    await tick();
    assert.equal((await runtime.respondNative('session', { type: 'extension_ui_response', id: 'native-id', confirmed: false })).statusCode, 409);
    assert.equal(deliveries, 1);
    accept({ accepted: false });
    assert.equal((await first).statusCode, 503);
    const retry = ask(runtime, 'POST', `/api/questions/${id}/answer`, { answer: 'false' });
    await tick(); accept({ accepted: true });
    assert.equal((await retry).statusCode, 200);
  } finally { runtime.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }
});

test('question snapshot and provided brief persist across restart and rebind to the same native request', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-rebind-'));
  const options = { dataDir: temporary, authorizeSession: () => true, deliverUiResponse: async () => ({ accepted: true }), getConfig: () => ({ questions: { autoBrief: false, minBriefChars: 16 } }) };
  let runtime = createQuestionRuntime(options);
  try {
    await runtime.onNativeEvent('session', { type: 'extension_ui_request', id: 'preserved-native-id', method: 'confirm', title: 'Synthetic rebind', metadata: { message: 'This is the agent provided explanation for a reproducible choice.' } });
    const id = runtime.store.listRows()[0].id;
    const detail = runtime.store.getDetail(id);
    assert.equal(detail.briefStatus, 'provided');
    runtime.dispose(); runtime = createQuestionRuntime(options);
    assert.equal(runtime.store.listRows().length, 0);
    assert.equal(runtime.store.getStats().persistedUnbound, 1);
    runtime.reconcile('session', [{ type: 'extension_ui_request', id: 'preserved-native-id', method: 'confirm', title: 'Synthetic rebind' }]);
    assert.equal(runtime.store.listRows()[0].id, id);
    assert.equal(runtime.store.getDetail(id).brief, detail.brief);
    assert.deepEqual(runtime.store.getDetail(id).snapshot, detail.snapshot);
    runtime.reconcile('session', []);
    assert.equal((await fs.readdir(path.join(temporary, 'questions'))).length, 0);
  } finally { runtime.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }
});

test('autoBrief without an injected provider reports unavailable and never fabricates a summary', async () => {
  const f = await fixture({ getConfig: () => ({ questions: { autoBrief: true, minBriefChars: 240 } }) });
  try {
    const prompt = f.run({ method: 'input', title: 'Synthetic no provider' });
    await tick(); await tick();
    const row = f.runtime.store.listRows()[0];
    assert.equal(row.briefStatus, 'unavailable');
    const summarized = await ask(f.runtime, 'POST', `/api/questions/${row.id}/summarize`, {});
    assert.equal(summarized.statusCode, 503);
    assert.equal(summarized.body.error, 'question-brief-provider-not-configured');
    assert.equal((await ask(f.runtime, 'POST', `/api/questions/${row.id}/answer`, { cancelled: true })).statusCode, 200);
    assert.equal((await prompt).details.result, undefined);
  } finally { await f.dispose(); }
});

test('finite legacy timeout reaches native dialogs and a resolved context clears stale keeper state', async () => {
  const f = await fixture();
  try {
    const events = [];
    let tool;
    const native = registerNativeQuestionTools({ on() {}, registerTool(value) { tool = value; }, appendEntry(_kind, data) { events.push(data); } }, { getConfig: () => ({ askUserPromptTimeoutSeconds: 0.02 }) });
    native.register();
    let observed;
    const output = await tool.execute('synthetic-timeout', { method: 'input', title: 'Synthetic finite timeout' }, undefined, undefined, { sessionManager: { getSessionId: () => 'finite-session' }, ui: {
      select() {}, confirm() {}, async input(_title, _placeholder, options) { observed = options; await new Promise(resolve => setTimeout(resolve, options.timeout)); return undefined; },
    } });
    assert.ok(observed.timeout > 0 && observed.timeout <= 20);
    assert.equal(output.details.result, undefined);
    assert.deepEqual(events.map(event => event.phase), ['pending', 'resolved']);
    const pending = f.run({ method: 'select', title: 'Synthetic stale keeper', options: ['A', 'B'], allowOther: false });
    await tick();
    const context = f.history.findLast(entry => entry.data.phase === 'pending').data;
    await f.runtime.onNativeEvent('session', { type: 'pi-research-question-context', data: { ...context, phase: 'resolved' } });
    assert.equal(f.pending.size, 0);
    assert.equal(f.runtime.store.listRows().length, 0);
    await pending;
  } finally { await f.dispose(); }
});

test('the preserved brief engine uses injected model resolution and stores a real generated result', async () => {
  let completions = 0;
  const resolveModel = createBriefModelResolver({
    readProviders: async () => JSON.stringify({ roles: { fast: 'synthetic/provider-model' } }),
    getRegistry: async () => ({ find: async (provider, model) => ({ provider, id: model }) }),
    hasStreamFn: () => true,
  });
  const f = await fixture({ getConfig: () => ({ questions: { autoBrief: true, minBriefChars: 240 } }),
    briefProvider: { resolveModel, complete: async (model, prompt, signal) => {
      completions++;
      assert.equal(model.provider, 'synthetic');
      assert.equal(model.id, 'provider-model');
      assert.equal(typeof prompt.user, 'string');
      assert.equal(signal.aborted, false);
      return 'Synthetic generated decision context.';
    } } });
  try {
    const answer = f.run({ method: 'input', title: 'Synthetic generated context' });
    await tick(); await tick();
    const row = f.runtime.store.listRows()[0];
    assert.equal(row.briefStatus, 'ready');
    assert.equal(f.runtime.store.getDetail(row.id).brief, 'Synthetic generated decision context.');
    assert.equal(completions, 1);
    assert.equal((await ask(f.runtime, 'POST', `/api/questions/${row.id}/summarize`, {})).statusCode, 409);
    await f.answer('synthetic answer'); await answer;
  } finally { await f.dispose(); }
});

test('a remote answer to an interactive terminal resolves its real Promise, aborts the TUI and survives replay', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-external-'));
  const history = [];
  const context = { sessionManager: { getSessionId: () => 'external-session', getBranch: () => history } };
  let native;
  let runtime;
  let lastEvent;
  let aborted = false;
  const config = { askUserPromptTimeoutSeconds: -1, questions: { autoBrief: false, minBriefChars: 240 } };
  const runtimeOptions = { dataDir: temporary, authorizeSession: () => true, getConfig: () => config,
    deliverUiResponse: async (sessionId, response, metadata) => {
      assert.equal(metadata.transport, 'external-native');
      lastEvent = { eventId: 'synthetic-external-event', eventType: QUESTION_RESPONSE_EVENT, data: { sessionId, response } };
      const receipt = await native.consumeEvent(lastEvent, context);
      return { accepted: receipt.status === 'accepted' };
    } };
  runtime = createQuestionRuntime(runtimeOptions);
  native = registerNativeQuestionTools({ on() {}, registerTool() {}, appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); } }, {
    getConfig: () => config, remoteDialogs: true,
    publishContext: data => runtime.onNativeEvent('external-session', { type: 'pi-research-question-context', data }),
  });
  try {
    const pending = native.tool.execute('external-tool', { method: 'select', title: 'Synthetic external choice', options: ['A', 'B'], allowOther: false }, undefined, undefined,
      { ...context, ui: { confirm() {}, input() {}, select(_title, _options, opts) { return new Promise(resolve => opts.signal.addEventListener('abort', () => { aborted = true; resolve(undefined); })); } } });
    await tick();
    const before = runtime.store.listRows()[0].id;
    runtime.reconcile('external-session', []);
    assert.equal(runtime.store.listRows()[0].id, before);
    runtime.dispose(); runtime = createQuestionRuntime(runtimeOptions);
    await native.publishPending(context);
    assert.equal(runtime.store.listRows()[0].id, before);
    const answer = await ask(runtime, 'POST', `/api/questions/${before}/answer`, { answer: 'B' });
    assert.equal(answer.body.data.transmitted, true);
    assert.equal((await pending).details.result, 'B');
    assert.equal(aborted, true);
    assert.equal(runtime.store.listRows().length, 0);
    assert.deepEqual(await native.consumeEvent(lastEvent, context), { status: 'accepted', duplicate: true });
    assert.equal((await native.consumeEvent({ ...lastEvent, data: { ...lastEvent.data, response: { ...lastEvent.data.response, value: 'A' } } }, context)).reason, 'native-question-response-conflict');
  } finally { runtime.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }
});

test('a long unanswered terminal question publishes once, retries failed publication and republishes on an explicit host restart', async () => {
  let calls = 0;
  let failures = 1;
  let finish;
  const ctx = { sessionManager: { getSessionId: () => 'bounded-session' }, ui: {
    select() {}, confirm() {}, input: () => new Promise(resolve => { finish = resolve; }),
  } };
  const native = registerNativeQuestionTools({ on() {}, registerTool() {}, appendEntry() {} }, {
    remoteDialogs: true, getConfig: () => ({ askUserPromptTimeoutSeconds: -1 }),
    publishContext: async () => { calls++; if (failures-- > 0) throw new Error('Synthetic host unavailable'); },
  });
  const pending = native.tool.execute('bounded-tool', { method: 'input', title: 'Synthetic long unanswered prompt' }, undefined, undefined, ctx);
  await tick();
  assert.equal(calls, 1);
  await native.publishPending(ctx, { force: false });
  assert.equal(calls, 2);
  for (let index = 0; index < 1000; index++) await native.publishPending(ctx, { force: false });
  assert.equal(calls, 2);
  await native.publishPending(ctx, { force: true });
  assert.equal(calls, 3);
  finish('Synthetic eventual answer');
  assert.equal((await pending).details.result, 'Synthetic eventual answer');
  assert.equal(calls, 4);
});
