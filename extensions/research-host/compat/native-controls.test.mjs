import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { registerNativeSessionControls, CONTROL_COMMAND, CONTROL_RESULT_EVENT, CONTROL_RECORD } from './native-controls.mjs';
import { createNativeControlClient } from './native-control-client.mjs';
import { createOwnedProcessGroups } from './process-groups.mjs';
import { createProposalCompatibility } from './open-spec/index.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-control-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = [], events = [], hooks = new Map(), commands = new Map();
  const sessionFile = path.join(root, 'session.jsonl'), metaFile = path.join(root, 'session.meta.json');
  const header = { type: 'session', version: 3, id: 'native-controls', cwd: root };
  fs.writeFileSync(sessionFile, JSON.stringify(header) + '\n', { mode: 0o600 });
  const metadata = { id: header.id, cwd: root, attachedProposal: 'verified-change' };
  fs.writeFileSync(metaFile, JSON.stringify(metadata), { mode: 0o600 });
  let shutdowns = 0, retries = 0;
  const ctx = { cwd: root, mode: 'rpc', isIdle: () => true, shutdown: () => { shutdowns++; },
    sessionManager: { getSessionId: () => header.id, getSessionFile: () => sessionFile, getHeader: () => header, getBranch: () => history } };
  const pi = {
    events: new EventEmitter(),
    on(name, handler) { (hooks.get(name) ?? (hooks.set(name, []), hooks.get(name))).push(handler); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); },
    sendMessage(message) { retries++; if (options.acceptRetry !== false) history.push({ type: 'custom_message', ...message }); },
  };
  const monitor = { observe: () => new Set([42]), kill: pgid => { if (pgid !== 42) throw new Error('native-process-group-not-owned'); return { requested: true, pgid }; } };
  const runtime = registerNativeSessionControls(pi, { publish: async event => events.push(event), processGroups: monitor, retryAcceptanceMs: 20, abortTimeoutMs: options.abortTimeoutMs ?? 40, syncProviders: options.syncProviders });
  t.after(() => runtime.dispose());
  for (const hook of hooks.get('session_start') ?? []) hook({}, ctx);
  const apply = (action, data = {}, requestId = 'control-' + events.length) => commands.get(CONTROL_COMMAND).handler(Buffer.from(JSON.stringify({ sessionId: header.id, requestId, action, ...data })).toString('base64url'), ctx);
  return { root, history, events, hooks, commands, ctx, pi, metadata, metaFile, apply, shutdowns: () => shutdowns, retries: () => retries };
}

test('proposal command proves the same structured fragment injected on the next turn', async t => {
  const f = fixture(t);
  const receipt = await f.apply('proposal-context', { attachedChange: 'verified-change' });
  assert.equal(receipt.accepted, true);
  assert.match(receipt.fragment, /Attached OpenSpec change: `verified-change`/);
  const event = { systemPromptOptions: { sections: { roles: 'preserved role instruction' } } };
  for (const hook of f.hooks.get('before_agent_start')) hook(event, f.ctx);
  assert.equal(event.systemPromptOptions.sections.dashboard_session, receipt.fragment);
  assert.equal(event.systemPromptOptions.sections.roles, 'preserved role instruction');
  assert.equal(receipt.fragmentHash, createHash('sha256').update(receipt.fragment).digest('hex'));
  fs.writeFileSync(f.metaFile, JSON.stringify({ ...f.metadata, attachedProposal: null }));
  const detached = await f.apply('proposal-context', { attachedChange: null });
  assert.doesNotMatch(detached.fragment, /Attached OpenSpec change/);
  await assert.rejects(f.apply('proposal-context', { attachedChange: 'old-selection' }), /binding-changed/);
});

test('stop_after_turn arms once and invokes native shutdown at the real turn boundary', async t => {
  const f = fixture(t);
  assert.equal((await f.apply('stop_after_turn')).state, 'armed');
  assert.equal(f.shutdowns(), 0);
  for (const hook of f.hooks.get('turn_end')) hook({}, f.ctx);
  assert.equal(f.shutdowns(), 1);
  for (const hook of f.hooks.get('turn_end')) hook({}, f.ctx);
  assert.equal(f.shutdowns(), 1);
});

test('an armed graceful stop survives native resume and a consumed stop stays completed', async t => {
  const f = fixture(t);
  await f.apply('stop_after_turn', {}, 'resume-stop');
  for (const hook of f.hooks.get('session_start')) hook({}, f.ctx);
  for (const hook of f.hooks.get('turn_end')) hook({}, f.ctx);
  assert.equal(f.shutdowns(), 1);
  assert.equal((await f.apply('stop_after_turn', {}, 'resume-stop')).state, 'completed');
  for (const hook of f.hooks.get('session_start')) hook({}, f.ctx);
  for (const hook of f.hooks.get('turn_end')) hook({}, f.ctx);
  assert.equal(f.shutdowns(), 1);
});

test('model refresh waits for the real offline registry operation without reading or persisting external transcript', async t => {
  const f = fixture(t);
  let finish;
  let started;
  const registryStarted = new Promise(resolve => { started = resolve; });
  const refreshOptions = [];
  f.ctx.modelRegistry = { refresh: options => { refreshOptions.push(options); started(); return new Promise(resolve => { finish = resolve; }); }, getError: () => undefined };
  f.ctx.sessionManager.getBranch = () => { assert.fail('Model registry refresh traversed the conversation'); };
  const refreshing = f.apply('refresh-models', { allowNetwork: true }, 'offline-refresh');
  await registryStarted;
  assert.deepEqual(refreshOptions, [{ allowNetwork: false }]);
  assert.equal(f.events.length, 0);
  assert.equal(f.history.length, 0);
  finish({ aborted: false, errors: new Map() });
  const receipt = await refreshing;
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.state, 'refreshed');
  assert.equal(receipt.allowNetwork, false);
  assert.equal(f.events.length, 1);
  assert.equal(f.history.length, 0);
});

test('model refresh refuses missing hooks, aborted refreshes and reported native registry errors', async t => {
  const f = fixture(t);
  await assert.rejects(f.apply('refresh-models'), /native-model-refresh-unavailable/);
  f.ctx.modelRegistry = { refresh: async () => ({ aborted: true, errors: new Map() }) };
  await assert.rejects(f.apply('refresh-models'), /native-model-refresh-unconfirmed/);
  f.ctx.modelRegistry.refresh = async () => ({ aborted: false, errors: new Map([['fixture', new Error('provider failed')]]) });
  await assert.rejects(f.apply('refresh-models'), /native-model-refresh-failed/);
  f.ctx.modelRegistry.refresh = async () => ({ aborted: false, errors: new Map() });
  f.ctx.modelRegistry.getError = () => 'invalid configuration';
  await assert.rejects(f.apply('refresh-models'), /native-model-refresh-failed/);
  assert.equal(f.events.some(event => event.accepted === true), false);
  assert.equal(f.history.length, 0);
});

test('external model refresh returns only bounded picker fields and fails if the live catalogue cannot be enumerated', async t => {
  const f = fixture(t);
  const model = { provider: 'fixture', id: 'model', name: 'Model', reasoning: true, input: ['text', 'image'], contextWindow: 8192,
    thinkingLevelMap: { high: 'high', xhigh: null }, baseUrl: 'DO_NOT_EXPOSE', headers: { Authorization: 'DO_NOT_EXPOSE' }, apiKey: 'DO_NOT_EXPOSE' };
  f.ctx.modelRegistry = { refresh: async () => ({ aborted: false, errors: new Map() }), getAvailable: () => [model] };
  const receipt = await f.apply('refresh-models', { includeModels: true });
  assert.deepEqual(receipt.models, [{ provider: model.provider, id: model.id, name: model.name, reasoning: true,
    input: ['text', 'image'], contextWindow: 8192, thinkingLevelMap: { high: 'high', xhigh: null } }]);
  assert.equal(JSON.stringify(receipt).includes('DO_NOT_EXPOSE'), false);
  assert.equal(f.history.length, 0);
  f.ctx.modelRegistry.getAvailable = undefined;
  await assert.rejects(f.apply('refresh-models', { includeModels: true }), /native-model-list-unavailable/);
  f.ctx.modelRegistry.getAvailable = () => Array(1001).fill(model);
  await assert.rejects(f.apply('refresh-models', { includeModels: true }), /native-model-list-too-large/);
  f.ctx.modelRegistry.getAvailable = () => [{ ...model, thinkingLevelMap: { headers: { secret: 'DO_NOT_EXPOSE' } } }];
  await assert.rejects(f.apply('refresh-models', { includeModels: true }), /native-model-list-unconfirmed/);
});

test('external model and thinking setters verify native readback and replay cannot repeat a mutation', async t => {
  const f = fixture(t);
  const selected = { provider: 'fixture', id: 'selected' };
  let modelCalls = 0, thinking = 'off';
  f.ctx.modelRegistry = { find: (provider, id) => provider === selected.provider && id === selected.id ? selected : undefined };
  f.pi.setModel = async model => { modelCalls++; f.ctx.model = model; return true; };
  f.pi.getThinkingLevel = () => thinking;
  f.pi.setThinkingLevel = level => { thinking = level === 'max' ? 'high' : level; };
  const model = await f.apply('set-model', { provider: selected.provider, modelId: selected.id }, 'native-model-change');
  assert.equal(model.provider, selected.provider);
  assert.equal(model.modelId, selected.id);
  await f.apply('set-model', { provider: selected.provider, modelId: selected.id }, 'native-model-change');
  assert.equal(modelCalls, 1);
  const clamped = await f.apply('set-thinking-level', { level: 'max' });
  assert.equal(clamped.level, 'high');
  assert.equal(clamped.requestedLevel, 'max');
  assert.equal(clamped.clamped, true);
  await assert.rejects(f.apply('set-model', { provider: 'fixture', modelId: 'missing' }), /native-model-not-found/);
  f.pi.setModel = async () => true;
  f.ctx.model = { provider: 'fixture', id: 'wrong' };
  await assert.rejects(f.apply('set-model', { provider: selected.provider, modelId: selected.id }), /native-model-selection-unconfirmed/);
});

test('saved provider synchronization finishes before registry refresh or model selection', async t => {
  let synchronized = false, synchronizations = 0;
  const f = fixture(t, { syncProviders: async () => { await new Promise(resolve => setTimeout(resolve, 1)); synchronized = true; synchronizations++; } });
  const model = { provider: 'fixture', id: 'synced-model' };
  f.ctx.modelRegistry = {
    refresh: async () => { assert.equal(synchronized, true); return { aborted: false, errors: new Map() }; },
    find: () => { assert.equal(synchronized, true); return model; },
  };
  f.pi.setModel = async selected => { f.ctx.model = selected; return true; };
  await f.apply('refresh-models');
  synchronized = false;
  await f.apply('set-model', { provider: model.provider, modelId: model.id });
  assert.equal(synchronizations, 2);
});

test('abort confirms idle after native cancellation and cannot clear queued messages or re-abort on replay', async t => {
  const f = fixture(t);
  let idle = false, aborts = 0;
  f.ctx.isIdle = () => idle;
  f.ctx.hasPendingMessages = () => true;
  f.ctx.abort = () => { aborts++; setTimeout(() => { idle = true; }, 5); };
  const aborted = await f.apply('abort', {}, 'native-abort');
  assert.equal(aborted.state, 'idle');
  assert.equal(aborted.alreadyIdle, false);
  assert.equal(aborted.hasPendingMessages, true);
  idle = false;
  await f.apply('abort', {}, 'native-abort');
  assert.equal(aborts, 1);
  const pending = fixture(t, { abortTimeoutMs: 1 });
  pending.ctx.isIdle = () => false;
  pending.ctx.abort = () => {};
  await assert.rejects(pending.apply('abort'), /native-abort-unconfirmed/);
  assert.equal(pending.events.some(event => event.accepted), false);
});

test('normal shutdown publishes its request receipt before invoking native shutdown and never claims process exit', async t => {
  const f = fixture(t);
  let shutdowns = 0;
  f.ctx.shutdown = () => {
    assert.equal(f.events.at(-1).state, 'shutdown-requested');
    assert.equal(f.history.at(-1).data.result.state, 'shutdown-requested');
    shutdowns++;
  };
  const result = await f.apply('shutdown', {}, 'native-shutdown');
  assert.equal(result.accepted, true);
  assert.equal(result.state, 'shutdown-requested');
  assert.equal('stopped' in result, false);
  assert.equal(shutdowns, 1);
  await f.apply('shutdown', {}, 'native-shutdown');
  assert.equal(shutdowns, 1);
});

test('live command listing is bounded, contains only native command metadata and does not persist external history', async t => {
  const f = fixture(t);
  f.pi.getCommands = () => [{ name: 'inspect', source: 'extension', description: 'Inspect state', sourceInfo: { path: 'DO_NOT_EXPOSE' } }];
  f.ctx.sessionManager.getBranch = () => assert.fail('Command listing traversed conversation');
  const result = await f.apply('list-commands');
  assert.deepEqual(result.commands, [{ name: 'inspect', source: 'extension', description: 'Inspect state' }]);
  assert.equal(f.history.length, 0);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPOSE'), false);
});

test('manual retry requires native branch acceptance and a repeated ID cannot redrive it', async t => {
  const f = fixture(t);
  const first = await f.apply('retry', {}, 'exact-retry');
  assert.equal(first.accepted, true);
  assert.equal(f.retries(), 1);
  await f.apply('retry', {}, 'exact-retry');
  assert.equal(f.retries(), 1);
  const failed = fixture(t, { acceptRetry: false });
  await assert.rejects(failed.apply('retry', {}, 'unconfirmed-retry'), /acceptance-unconfirmed/);
  assert.equal((await failed.apply('retry', {}, 'unconfirmed-retry')).accepted, false);
  assert.equal(failed.retries(), 1);
});

test('process-group control refuses the current group, foreign groups and recycled IDs while preserving witnessed orphan children', () => {
  let rows = [
    { pid: 10, ppid: 1, pgid: 10, uid: 1000, startTime: 'own' },
    { pid: 42, ppid: 10, pgid: 42, uid: 1000, startTime: 'original' },
    { pid: 43, ppid: 42, pgid: 42, uid: 1000, startTime: 'child' },
    { pid: 99, ppid: 1, pgid: 99, uid: 1000, startTime: 'foreign' },
  ];
  const signals = [];
  const groups = createOwnedProcessGroups({ pid: 10, uid: 1000, snapshot: () => rows, signal: (...args) => signals.push(args) });
  assert.deepEqual([...groups.observe()], [42]);
  assert.throws(() => groups.kill(10), /not-owned/);
  assert.throws(() => groups.kill(99), /not-owned/);
  rows = rows.filter(row => row.pid !== 42).map(row => row.pid === 43 ? { ...row, ppid: 1 } : row);
  assert.equal(groups.kill(42).requested, true);
  assert.deepEqual(signals, [[-42, 'SIGTERM']]);
  rows = rows.filter(row => row.pid !== 43).concat({ pid: 42, ppid: 1, pgid: 42, uid: 1000, startTime: 'recycled' });
  assert.throws(() => groups.kill(42), /not-owned/);
});

test('native client preflights the internal command and requires exact result hash and identity', async () => {
  const journal = [], commands = [];
  const row = { id: 'native', eventCursor: 0 };
  const sessions = {
    getSession: () => row,
    readEvents: async (_id, { after }) => ({ events: journal.filter(record => record.sequence > after), nextCursor: journal.at(-1)?.sequence ?? after }),
    command: async (_id, input) => {
      commands.push(input);
      if (input.type === 'get_commands') return { success: true, data: { commands: [{ name: CONTROL_COMMAND }] } };
      const request = JSON.parse(Buffer.from(input.message.split(' ')[1], 'base64url').toString('utf8'));
      journal.push({ sequence: 1, event: { type: 'entry_appended', entry: { type: 'custom', customType: CONTROL_RECORD,
        data: { status: 'applied', result: { type: CONTROL_RESULT_EVENT, sessionId: request.sessionId, requestId: request.requestId,
          action: request.action, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'), accepted: true, state: 'armed' } } } } });
      return { success: true, data: { disposition: 'handled' } };
    },
  };
  assert.equal((await createNativeControlClient({ sessions }).apply(row, 'stop_after_turn')).accepted, true);
  assert.equal(commands[0].type, 'get_commands');
  sessions.command = async input => ({ success: true, data: { commands: [] } });
  await assert.rejects(createNativeControlClient({ sessions }).apply(row, 'retry'), { statusCode: 501, code: 'native-session-controls-unavailable' });
});

test('proposal compatibility persists attachment and idempotent naming only with a native fragment receipt', async () => {
  let row = { id: 'session', live: true, name: '', eventCursor: 0 };
  const commands = [], controls = [];
  const proposals = createProposalCompatibility({ sessions: {
    getSession: () => row,
    updateSession: (_id, patch) => { row = { ...row, ...patch }; },
    command: async (_id, input) => { commands.push(input); return { success: true }; },
  }, nativeControls: {
    probe: async () => {},
    apply: async (_row, action, input) => { controls.push({ action, input }); return { attachedChange: input.attachedChange, fragmentHash: 'a'.repeat(64), accepted: true }; },
  } });
  const attached = await proposals.attach(row, { changeName: 'chosen-change' });
  assert.equal(attached.body.data.contextState, 'applied');
  assert.equal(row.attachedProposal, 'chosen-change');
  assert.equal(row.name, 'chosen-change');
  assert.equal(row.nameSource, 'system');
  await proposals.detach(row, {});
  assert.equal(row.attachedProposal, null);
  assert.equal(row.name, undefined);
  assert.equal(commands[0].name, 'chosen-change');
  assert.deepEqual(controls.find(control => control.action === 'set-name'), { action: 'set-name', input: { name: '' } });
  row = { ...row, live: false, name: 'User name', nameSource: 'user' };
  const pending = await proposals.attach(row, { changeName: 'next-change' });
  assert.equal(pending.statusCode, 202);
  assert.equal(pending.body.pending, true);
  assert.equal(row.name, 'User name');
  assert.throws(() => proposals.attach(row, { changeName: '../outside' }), { statusCode: 400 });
});
