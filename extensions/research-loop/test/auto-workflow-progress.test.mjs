import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../workflows/auto-research.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const researchBudget = { version: 1, scopeId: 'fixture-budget-scope', extension: '/synthetic-budget/extension.mjs' };

async function simulate(args = {}, options = {}) {
  const calls = [], emits = [];
  const descriptor = Object.hasOwn(args, 'researchBudget') ? args.researchBudget : researchBudget;
  const run = async (key, params) => {
    calls.push({ key, params });
    assert.equal(params.async, true, 'Controlled children must load their native adapter in a fresh runner');
    if (descriptor) assert(params.extensions.includes(descriptor.extension), 'An explicitly scoped child keeps its accounting extension');
    else assert.equal(params.extensions, undefined, 'A routine child does not synthesize an accounting scope');
    let structuredOutput;
    if (key.startsWith('explorer-')) structuredOutput = options.noCards ? undefined : { cards: [{ hypothesisId: key, claim: '离线候选', angle: 'test', falsification: 'test', minimalTest: 'test', cost: 'none' }] };
    if (key === 'plan') structuredOutput = { chosen: 'offline candidate', reason: 'test only', milestones: [{ id: 'm1', task: 'No real execution', executor: 'numerics' }], killCriteria: ['test'] };
    if (key.startsWith('experiment-')) structuredOutput = { status: options.blocked ? 'blocked' : 'completed', commands: ['fixture command, never executed'], evidence: ['runs/fixture.json'], notes: 'offline' };
    if (key.startsWith('review-')) structuredOutput = options.missingReview ? undefined : { score: options.noConvergence ? 0 : 7, verdict: options.noConvergence ? 'not_ready' : 'ready', weaknesses: 'offline', fixes: 'offline', memory: 'offline' };
    return { ok: !options.noCards, state: options.noCards ? 'failed' : 'completed', runId: `fixture-${key}`, output: 'actual fixture return', structuredOutput, results: options.noModel ? [] : [{ model: 'fixture/observed-model' }] };
  };
  const runs = { run, all: specs => Promise.all(specs.map(({ key, ...params }) => run(key, params))) };
  const value = await new AsyncFunction('args', 'runs', 'emit', source)({ topic: 'Offline progress contract only', taskDir: 'fixture', maxExplorers: 2, researchBudget, ...args }, runs, v => emits.push(JSON.parse(JSON.stringify(v))));
  return { calls, emits, value };
}

test('every actual scripted step carries a phase and reports its actual result', async () => {
  const { calls, emits, value } = await simulate();
  assert.equal(value.status, 'converged');
  for (const { key, params } of calls) {
    assert.equal(params.phase, key.startsWith('experiment-') ? '2-experiment' : key.startsWith('review-') ? '3-review' : '1-idea');
    assert.equal(typeof params.label, 'string');
    const observed = emits.find(e => e.type === 'step-result' && e.key === key);
    assert(observed, `missing returned result for ${key}`);
    assert.equal(observed.executionStatus, 'completed');
    assert.equal(observed.observedModel, 'fixture/observed-model');
  }
  assert.deepEqual(emits.at(-1), { type: 'workflow-result', outcome: 'converged' });
  assert.equal(value.accepted, undefined);
  assert.equal(value.publicationAuthorized, undefined);
});

test('planning-only completion does not emit experiment or review work', async () => {
  const { calls, emits, value } = await simulate({ stopAfter: 'plan' });
  assert.equal(value.status, 'planned');
  assert(calls.every(c => c.params.phase === '1-idea'));
  assert.equal(emits.at(-1).outcome, 'planned');
});

test('completed execution and a blocked experiment result stay distinct', async () => {
  const { calls, emits, value } = await simulate({}, { blocked: true });
  assert.equal(value.status, 'blocked');
  const result = emits.find(e => e.key === 'experiment-1');
  assert.equal(result.executionStatus, 'completed');
  assert.equal(result.businessStatus, 'blocked');
  assert(!calls.some(c => c.params.phase === '3-review'));
  assert.equal(emits.at(-1).outcome, 'blocked');
});

test('missing cards and missing reviews are explicitly blocked, not successful progress', async () => {
  const cards = await simulate({}, { noCards: true, noModel: true });
  assert.equal(cards.value.status, 'blocked');
  assert.equal(cards.calls.length, 2);
  assert(cards.emits.filter(e => e.type === 'step-result').every(e => e.executionStatus === 'failed' && e.observedModel === undefined));
  const review = await simulate({}, { missingReview: true });
  assert.equal(review.value.status, 'blocked');
  assert.equal(review.emits.at(-1).outcome, 'blocked');
});

test('no convergence records the actual review limit without accepting any claim', async () => {
  const { calls, emits, value } = await simulate({ maxRounds: 2 }, { noConvergence: true });
  assert.equal(value.status, 'max_rounds_reached');
  assert.equal(calls.filter(c => c.params.phase === '3-review').length, 2);
  assert.equal(emits.at(-1).outcome, 'max_rounds_reached');
  assert.equal(value.accepted, undefined);
});

test('an absent topic reports blocked without invoking a child', async () => {
  const { calls, emits, value } = await simulate({ topic: '' });
  assert.equal(value.status, 'blocked');
  assert.equal(calls.length, 0);
  assert.equal(emits.at(-1).outcome, 'blocked');
});

test('a routine workflow runs through the native host without a saved budget descriptor', async () => {
  const { calls, value } = await simulate({ researchBudget: undefined });
  assert.equal(value.status, 'converged');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.params.extensions === undefined));
});

test('a malformed explicit budget descriptor blocks before invoking any child', async () => {
  const { calls, value } = await simulate({ researchBudget: { version: 1 } });
  assert.equal(value.status, 'blocked');
  assert.equal(value.reason, 'research-budget-bridge-unavailable-open-new-session');
  assert.equal(calls.length, 0);
});
