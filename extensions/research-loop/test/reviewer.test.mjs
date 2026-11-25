import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRoundPrompt, gateReview, parseReview, readMemory, recordRound,
} from '../src/reviewer.mjs';

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const response = (score, verdict, extra = '') => `
Score: ${score}
Verdict: ${verdict}

Remaining Weaknesses
- the ablation is missing

Minimum Fixes
- add the ablation

Memory Update
Round ${score}: ablation still missing.
${extra}`;

test('round 1 does not require memory; later rounds do', (t) => {
  const first = buildRoundPrompt({ round: 1, task: 'review the plan' });
  assert.match(first, /There is no prior reviewer memory/);
  assert.throws(() => buildRoundPrompt({ round: 2, task: 'review the plan' }), /requires the previous/);

  const second = buildRoundPrompt({
    round: 2, task: 'review the plan', previousMemory: '# REVIEWER MEMORY\nRound 1...',
    changedFiles: ['paper/plan.tex'],
  });
  assert.match(second, /paper\/plan\.tex/);
  assert.match(second, /Previous reviewer memory/);
});

test('a response without a valid score or verdict is rejected', (t) => {
  const cwd = setup(t);
  assert.throws(() => recordRound(cwd, 'review-stage', {
    round: 1, observedModel: 'cliproxy/gpt-6.1-sol(max)[1m]', response: 'Looks fine to me.',
  }), /valid Score or Verdict/);
});

test('rounds write a continuous memory artifact and distinct traces', (t) => {
  const cwd = setup(t);
  const one = recordRound(cwd, 'review-stage', {
    round: 1, observedModel: 'cliproxy/gpt-6.1-sol(max)[1m]', response: response(4, 'not_ready'),
  });
  const memoryAfterOne = readMemory(cwd, 'review-stage');
  assert.match(memoryAfterOne, /Score: 4/);

  const two = recordRound(cwd, 'review-stage', {
    round: 2, observedModel: 'cliproxy/gpt-6.1-sol(max)[1m]', response: response(7, 'ready'),
    changedFiles: ['analysis/ablation.csv'], previousDigest: one.digest,
  });
  assert.notEqual(one.digest, two.digest);
  const memoryAfterTwo = readMemory(cwd, 'review-stage');
  assert.match(memoryAfterTwo, /Round: 2/);
  assert.match(memoryAfterTwo, /Score: 7/);
});

test('gate blocks when the reviewer model was not observed', (t) => {
  const cwd = setup(t);
  recordRound(cwd, 'review-stage', { round: 1, observedModel: undefined, response: response(8, 'ready') });
  const result = gateReview({ authorModel: 'cliproxy/gpt-6-astra(xhigh)[1m]' })({ cwd, stageDir: 'review-stage' });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.diagnostics.join(' '), /not observed/);
});

test('gate blocks when reviewer and author share a model', (t) => {
  const cwd = setup(t);
  recordRound(cwd, 'review-stage', {
    round: 1, observedModel: 'cliproxy/gpt-6-astra(xhigh)[1m]', response: response(8, 'ready'),
  });
  const result = gateReview({ authorModel: 'cliproxy/gpt-6-astra(xhigh)[1m]' })({ cwd, stageDir: 'review-stage' });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.diagnostics.join(' '), /same model/);
});

test('an unbroken loop that converges is accepted; an unconverged one is provisional', (t) => {
  const cwd = setup(t);
  const one = recordRound(cwd, 'review-stage', {
    round: 1, observedModel: 'cliproxy/gpt-6.1-sol(max)[1m]', response: response(4, 'not_ready'),
  });
  const notYet = gateReview({ authorModel: 'cliproxy/gpt-6-astra(xhigh)[1m]' })({ cwd, stageDir: 'review-stage' });
  assert.equal(notYet.verdict, 'provisional');

  recordRound(cwd, 'review-stage', {
    round: 2, observedModel: 'cliproxy/gpt-6.1-sol(max)[1m]', response: response(7, 'ready'),
    changedFiles: ['analysis/ablation.csv'], previousDigest: one.digest,
  });
  const converged = gateReview({ authorModel: 'cliproxy/gpt-6-astra(xhigh)[1m]' })({ cwd, stageDir: 'review-stage' });
  assert.equal(converged.verdict, 'accepted');
  assert.equal(converged.rounds, 2);
});

test('parseReview extracts sections and ignores unrelated prose', () => {
  const parsed = parseReview(`${response(6, 'almost')}\nSome trailing note.`);
  assert.equal(parsed.score, 6);
  assert.equal(parsed.verdict, 'almost');
  assert.match(parsed.weaknesses, /ablation/);
  assert.match(parsed.memory, /ablation still missing/);
  assert.equal(parsed.valid, true);
});
