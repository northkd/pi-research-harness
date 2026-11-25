import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizePublication, charterFrom, gateClaim, newState, upsertClaim,
} from '../src/ledger.mjs';

function stateWithClaim(overrides = {}) {
  const charter = charterFrom({ objective: 'obj', successCriteria: ['s'], nonGoals: [] }, null);
  const state = newState(charter);
  upsertClaim(state, {
    id: 'C1',
    status: 'partially_supported',
    statement: 'radius ratio predicts the barrier',
    evidence: overrides.evidence ?? ['research/tasks/t1/table.md'],
  });
  return state;
}

const jury = [
  { modelId: 'cliproxy/gpt-6.1-sol(max)[1m]', family: 'sol' },
  { modelId: 'cliproxy/gemini-3.8-flash', family: 'gemini' },
];

test('repeating an unchanged supported claim preserves its acceptance and publication evidence', () => {
  const state = stateWithClaim();
  gateClaim(state, { claimId: 'C1', authorFamily: 'astra', jury, counterexample: { status: 'completed', evidence: ['counter.md'] }, unresolvedObligations: [] });
  authorizePublication(state, { claimId: 'C1', confirmedByUser: true, note: 'Synthetic authorized test' });
  const original = state.claims[0];
  const replay = upsertClaim(state, { id: original.id, statement: original.statement, status: original.status, evidence: [...original.evidence], limitations: [...original.limitations] });
  assert.equal(replay, original);
  assert.equal(replay.acceptance.verdict, 'accepted');
  assert.equal(replay.publication.authorized, true);
  assert.equal(state.claims.length, 1);
});

test('a material change to a claim invalidates its previous acceptance and publication authorization', () => {
  const state = stateWithClaim();
  gateClaim(state, { claimId: 'C1', authorFamily: 'astra', jury, counterexample: { status: 'completed' }, unresolvedObligations: [] });
  authorizePublication(state, { claimId: 'C1', confirmedByUser: true });
  const changed = upsertClaim(state, { id: 'C1', statement: 'A materially different claim', status: 'partially_supported', evidence: ['different.md'] });
  assert.equal(changed.acceptance, undefined);
  assert.equal(changed.publication, undefined);
});

test('cross-family jury plus completed counterexample yields internal accepted', () => {
  const state = stateWithClaim();
  const result = gateClaim(state, {
    claimId: 'C1', authorModel: 'cliproxy/gpt-6-astra(xhigh)[1m]', authorFamily: 'astra',
    jury, counterexample: { status: 'completed', evidence: ['research/tasks/t1/counter.log'] },
    unresolvedObligations: [],
  });
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.scope, 'internal');
  assert.equal(result.publicationAuthorized, false);
  assert.equal(state.claims[0].status, 'supported');
  assert.equal(state.claims[0].acceptance.verdict, 'accepted');
});

test('a jury sharing the author family is blocked', () => {
  const state = stateWithClaim();
  const result = gateClaim(state, {
    claimId: 'C1', authorFamily: 'astra',
    jury: [{ modelId: 'a', family: 'astra' }, { modelId: 'b', family: 'gemini' }],
    counterexample: { status: 'completed' }, unresolvedObligations: [],
  });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.diagnostics.join(' '), /must not share/);
});

test('a single-family jury is blocked even with two reviewers', () => {
  const state = stateWithClaim();
  const result = gateClaim(state, {
    claimId: 'C1', authorFamily: 'astra',
    jury: [{ modelId: 'a', family: 'sol' }, { modelId: 'b', family: 'sol' }],
    counterexample: { status: 'completed' }, unresolvedObligations: [],
  });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.diagnostics.join(' '), /two model families/);
});

test('missing counterexample or unresolved obligations block acceptance', () => {
  const state = stateWithClaim();
  const noCounter = gateClaim(state, { claimId: 'C1', authorFamily: 'astra', jury, counterexample: { status: 'running' }, unresolvedObligations: [] });
  assert.equal(noCounter.verdict, 'blocked');
  assert.match(noCounter.diagnostics.join(' '), /counterexample/);

  const obligations = gateClaim(state, { claimId: 'C1', authorFamily: 'astra', jury, counterexample: { status: 'completed' }, unresolvedObligations: ['prove boundedness'] });
  assert.equal(obligations.verdict, 'blocked');
  assert.match(obligations.diagnostics.join(' '), /proof obligations/);
});

test('a claim without evidence cannot be accepted', () => {
  const state = stateWithClaim({ evidence: [] });
  const result = gateClaim(state, {
    claimId: 'C1', authorFamily: 'astra', jury,
    counterexample: { status: 'completed' }, unresolvedObligations: [],
  });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.diagnostics.join(' '), /no evidence/);
});

test('publication requires internal acceptance and explicit user confirmation', () => {
  const state = stateWithClaim();
  assert.throws(() => authorizePublication(state, { claimId: 'C1', confirmedByUser: true }), /not internally accepted/);

  gateClaim(state, {
    claimId: 'C1', authorFamily: 'astra', jury,
    counterexample: { status: 'completed' }, unresolvedObligations: [],
  });
  assert.throws(() => authorizePublication(state, { claimId: 'C1', confirmedByUser: false }), /user confirmation/);

  const publication = authorizePublication(state, { claimId: 'C1', confirmedByUser: true, note: 'user approved' });
  assert.equal(publication.authorized, true);
  assert.equal(publication.scope, 'external');
});
