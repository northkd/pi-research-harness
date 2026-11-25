/**
 * Exercise the actual pinned Goal extension with synthetic judge responses.
 * Usage: node scripts/test-goal-no-budget-sdk.mjs PI_ROOT GOAL_PACKAGE_ROOT
 * The package is copied outside node_modules for Node's TypeScript loader;
 * only the judge response is substituted. No provider request is permitted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const [piInput, goalInput] = process.argv.slice(2);
if (!piInput || !goalInput || process.argv.length !== 4) throw Error('Usage: node scripts/test-goal-no-budget-sdk.mjs PI_ROOT GOAL_PACKAGE_ROOT');
const piRoot = fs.realpathSync(piInput), goalRoot = fs.realpathSync(goalInput);
for (const [root, name, version] of [[piRoot, '@earendil-works/pi-coding-agent', '1.3.0'], [goalRoot, '@ricoyudog/pi-goal-hermes', '0.1.0']]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name); assert.equal(manifest.version, version);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-goal-no-budget-'));
const previousFetch = globalThis.fetch;
let networkAttempts = 0;
const checks = [];
try {
  const source = path.join(temp, 'goal');
  fs.cpSync(goalRoot, source, {recursive: true, filter: name => path.basename(name) !== 'node_modules'});
  fs.symlinkSync(path.resolve(piRoot, '../..'), path.join(temp, 'node_modules'), 'dir');
  globalThis.fetch = async () => { networkAttempts++; throw Error('offline test blocked network'); };
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const {createPiLocalGoalState, latestStateFromSession, GOAL_CUSTOM_TYPE} = await load('goal-state.ts');
  const {JudgeService} = await load('judge-service.ts');
  const {evaluateWithJudge} = await load('goal-manager.ts');
  const {default: activate} = await load('index.ts');
  const verdict = {verdict: 'continue', done: false, blocked: false, reason: 'synthetic unfinished work', parseFailed: false, preserveParseFailureCounter: false};
  const writes = [], messages = [], notifications = [];
  const pi = {
    appendEntry: (type, data) => writes.push({type, data: structuredClone(data)}),
    sendMessage: (message, options) => messages.push({message, options}),
  };
  const ctx = {isIdle: () => true, hasPendingMessages: () => false,
    ui: {theme: {fg: (_color, value) => value}, notify: (message, level) => notifications.push({message, level}), setStatus: () => {}}};

  // Verify the real judge uses the pinned SDK's configured provider entrypoint.
  // pi-ai 1.3 no longer exports the old global streamSimple function.
  const sdk = await import(pathToFileURL(path.join(piRoot, 'dist/index.js')).href);
  const ai = await import(pathToFileURL(path.join(path.resolve(piRoot, '../..'), '@earendil-works/pi-ai/dist/index.js')).href);
  const runtime = await sdk.ModelRuntime.create({authPath: path.join(temp, 'auth.json'), modelsPath: null, modelsStorePath: path.join(temp, 'models.json'), refreshOnCreate: false});
  let judgeCalls = 0;
  runtime.registerProvider('offline-goal', {
    name: 'Offline goal judge', baseUrl: 'http://invalid.test', apiKey: 'synthetic-only', api: 'pi-messages',
    models: [{id: 'judge', name: 'Judge fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 8000,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
    streamSimple: model => {
      judgeCalls++;
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = {role: 'assistant', content: [{type: 'text', text: JSON.stringify({done: false, blocked: false, reason: 'synthetic remaining work'})}],
          api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
          usage: {input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
        stream.push({type: 'done', reason: 'stop', message});
      });
      return stream;
    },
  });
  await runtime.refresh({allowNetwork: false});
  ctx.modelRegistry = new sdk.ModelRegistry(runtime);
  ctx.model = ctx.modelRegistry.find('offline-goal', 'judge');
  const actualVerdict = await new JudgeService().evaluate({goal: 'fixture goal', response: 'fixture progress'}, ctx, pi);
  assert.equal(actualVerdict.verdict, 'continue'); assert.equal(judgeCalls, 1);
  assert.equal(messages.at(-1).message.details.usage.totalTokens, 7);
  checks.push('the actual judge loads on Pi 1.3 and records configured-provider response usage');
  JudgeService.prototype.evaluate = async () => ({...verdict});

  for (const oldCap of [undefined, 0, 1, 20]) assert.equal(createPiLocalGoalState('test', oldCap).maxTurns, null);
  checks.push('new goals never impose a default or caller-supplied legacy turn cap');
  const legacy = {...createPiLocalGoalState('preserve the accepted work'), maxTurns: 20, turnsUsed: 250, status: 'paused', pausedReason: 'maxTurns budget exhausted'};
  const saved = JSON.stringify(legacy);
  const entry = {type: 'custom', customType: GOAL_CUSTOM_TYPE, data: {goal: legacy}};
  ctx.sessionManager = {getBranch: () => [entry], getEntries: () => [entry]};
  const restored = latestStateFromSession(ctx);
  assert.equal(restored.maxTurns, null); assert.equal(restored.turnsUsed, 250);
  assert.equal(JSON.stringify(legacy), saved); assert.notEqual(restored, legacy);
  checks.push('legacy exhausted sessions restore without modifying saved history or used turns');
  for (const oldCap of [-1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    const latest = {...legacy, id: 'latest-goal', goal: 'current scope', maxTurns: oldCap, turnsUsed: 251};
    const frozen = JSON.stringify(latest);
    const value = latestStateFromSession({sessionManager: {getBranch: () => [entry, {type: 'custom', customType: GOAL_CUSTOM_TYPE, data: {goal: latest}}]}});
    assert.equal(value.id, latest.id); assert.equal(value.goal, latest.goal);
    assert.equal(value.turnsUsed, 251); assert.equal(value.maxTurns, null);
    assert.equal(JSON.stringify(latest), frozen);
  }
  checks.push('obsolete numeric cap metadata never makes restoration select an older goal');

  const state = {...createPiLocalGoalState('continue research'), maxTurns: 1};
  for (let count = 0; count < 41; count++) {
    const result = await evaluateWithJudge(pi, ctx, state, 'synthetic work in progress', () => true);
    assert.equal(result.shouldContinue, true); assert.equal(state.status, 'active');
  }
  assert.equal(state.turnsUsed, 41); assert.equal(writes.at(-1).data.goal.turnsUsed, 41);
  assert.equal(writes.at(-1).data.goal.maxTurns, null);
  checks.push('41 real judge-loop transitions exceed the old 20-turn cap while recording each turn');

  JudgeService.prototype.evaluate = async () => ({...verdict, blocked: true, verdict: 'blocked'});
  assert.equal((await evaluateWithJudge(pi, ctx, state, 'blocked', () => true)).shouldContinue, false);
  assert.equal(state.status, 'paused');
  checks.push('an actual blocked verdict still pauses the goal');
  JudgeService.prototype.evaluate = async () => ({...verdict, parseFailed: true});
  const invalid = createPiLocalGoalState('test judge failures');
  for (let count = 0; count < 3; count++) await evaluateWithJudge(pi, ctx, invalid, 'progress', () => true);
  assert.equal(invalid.status, 'paused'); assert.match(invalid.pausedReason, /unparseable/);
  checks.push('the malformed-judge circuit breaker remains active');
  JudgeService.prototype.evaluate = async () => ({...verdict, done: true, verdict: 'done'});
  const done = createPiLocalGoalState('completed work');
  await evaluateWithJudge(pi, ctx, done, 'deliverable evidence', () => true);
  assert.equal(done.status, 'done');
  checks.push('completed work still terminates normally');
  const stale = createPiLocalGoalState('replaced work');
  assert.equal((await evaluateWithJudge(pi, ctx, stale, 'late result', () => false)).shouldContinue, false);
  assert.equal(stale.status, 'active');
  checks.push('a stale judge cannot mark a replacement goal complete');

  const handlers = new Map(), commands = new Map(), bus = new Map(), replies = [];
  Object.assign(pi, {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: () => {},
    events: {on: (name, handler) => bus.set(name, handler), emit: (name, data) => replies.push({name, data})},
  });
  activate(pi);
  handlers.get('session_start')({reason: 'resume'}, ctx);
  await commands.get('goal').handler('resume', ctx);
  assert.equal(writes.at(-1).data.goal.status, 'active');
  assert.equal(writes.at(-1).data.goal.turnsUsed, 250); assert.equal(writes.at(-1).data.goal.maxTurns, null);
  await delay(5);
  assert.ok(messages.some(row => row.options?.triggerTurn === true));
  checks.push('the actual Resume command continues an exhausted legacy goal without resetting usage');
  const before = writes.length;
  bus.get('pi-goal-hermes:turn-budget')({requestId: 'legacy-limit', objective: legacy.goal, engineGoalId: legacy.id, maxTurns: 1});
  assert.equal(replies.at(-1).data.payload.accepted, true);
  assert.equal(replies.at(-1).data.payload.maxTurns, null);
  assert.equal(replies.at(-1).data.payload.budgetEnforced, false);
  assert.equal(writes.length, before);
  bus.get('pi-goal-hermes:turn-budget')({requestId: 'wrong-scope', objective: 'different work', engineGoalId: legacy.id, maxTurns: 1});
  assert.equal(replies.at(-1).data.payload.accepted, false);
  checks.push('legacy budget messages cannot reinstate limits or change goal scope');
  await commands.get('goal').handler('pause', ctx);
  assert.equal(writes.at(-1).data.goal.status, 'paused'); assert.equal(writes.at(-1).data.goal.turnsUsed, 250);
  await commands.get('goal').handler('clear', ctx);
  assert.equal(writes.at(-1).data.goal.status, 'cleared');
  checks.push('manual pause and clear remain effective');
  assert.equal(JSON.stringify(legacy), saved); assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({schema: 'pi-research.goal-no-budget-validation.v1', pi: '1.3.0', goal: '0.1.0', checks, networkAttempts}, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  fs.rmSync(temp, {recursive: true, force: true});
}
