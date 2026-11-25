import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { charterHash } from '../src/adoption.mjs';
import {
  analyze, appendAttempt, appendNarrow, buildPacket, charterFrom, loadState,
  newState, normalizeAttempt, readLedger, renderPacket, saveState, upsertClaim,
} from '../src/ledger.mjs';

function setup(t, budget = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const charter = charterFrom({
    objective: 'Reduce the migration barrier below 0.3 eV',
    successCriteria: ['Two independently evidenced structure families', 'A falsifiable mechanism'],
    nonGoals: ['Exhaustive database'],
  }, null);
  const state = newState(charter);
  Object.assign(state.budget, budget);
  saveState(cwd, state);
  return { cwd, state: () => loadState(cwd) };
}

function log(cwd, state, overrides = {}) {
  const attempt = normalizeAttempt({
    kind: 'experiment', signal: 'negative', actionText: 'run NEB on candidate set',
    expected: 'barrier below 0.3 eV', observed: '0.41 eV', lesson: 'saddle is not covered by the cage',
    evidence: ['research/tasks/t1/neb.log'], fingerprint: 'neb-soft-cage-v1', ...overrides,
  });
  const record = appendAttempt(cwd, state, attempt);
  saveState(cwd, state);
  return record;
}

test('a stable attemptId retries the same scientific attempt without changing its sequence or budget count', t => {
  const { cwd, state } = setup(t);
  const first = log(cwd, state(), { attemptId: 'attempt-synthetic-first' });
  const before = fs.readFileSync(path.join(cwd, '.pi/research-loop/ledger.jsonl'));
  const repeated = log(cwd, state(), { attemptId: 'attempt-synthetic-first' });
  assert.deepEqual(repeated, JSON.parse(JSON.stringify(first)));
  assert.equal(readLedger(cwd).length, 1);
  assert.equal(state().attempts, 1);
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.pi/research-loop/ledger.jsonl')), before);
  assert.equal(first.charterHash, charterHash(cwd));
});

test('a stable attemptId rejects changed evidence while traditional no-ID repetitions remain distinct', t => {
  const { cwd, state } = setup(t);
  log(cwd, state(), { attemptId: 'attempt-synthetic-first' });
  assert.throws(() => log(cwd, state(), { attemptId: 'attempt-synthetic-first', observed: 'A different observation' }), /attemptId.*conflict/i);
  assert.equal(readLedger(cwd).length, 1);
  const first = log(cwd, state());
  const second = log(cwd, state());
  assert.equal(second.seq, first.seq + 1);
  assert.equal(readLedger(cwd).length, 3);
});

test('stale charter CAS and invalid attempt IDs fail before any scientific append', t => {
  const { cwd, state } = setup(t);
  const attempt = normalizeAttempt({ action: 'Synthetic action', attemptId: 'attempt-cas-1' });
  assert.throws(() => appendAttempt(cwd, state(), attempt, { expectedCharterHash: 'sha256:' + 'f'.repeat(64) }), /charter.*changed/i);
  assert.equal(readLedger(cwd).length, 0);
  assert.throws(() => normalizeAttempt({ action: 'Synthetic action', attemptId: '../outside' }), /attemptId/i);
  assert.throws(() => normalizeAttempt({ action: 'Synthetic action', attemptId: 'sk-syntheticsecretidentifier' }), /attemptId.*secret/i);
  assert.throws(() => appendAttempt(cwd, state(), { ...attempt, attemptId: '../outside' }), /attemptId/i);
  assert.equal(readLedger(cwd).length, 0);
});

test('sequence numbers come from the ledger, so a crash between append and save cannot reuse one', (t) => {
  const { cwd, state } = setup(t);
  const first = log(cwd, state());
  const stale = state();                    // simulate state written before the next append
  const second = log(cwd, stale);
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(readLedger(cwd).map((a) => a.seq), [1, 2]);
});

test('a positive signal after narrowing clears the stuck state (no permanent stuck)', (t) => {
  const { cwd, state } = setup(t);
  for (let i = 0; i < 3; i += 1) log(cwd, state());
  assert.equal(analyze(cwd, state()).level, 'stuck');

  const narrowing = state();
  appendNarrow(cwd, narrowing, {
    reason: 'Static geometry cannot predict a dynamic saddle; switch to path compliance',
    dropped: ['static soft cage'], evidence: ['research/tasks/t1/neb.log'],
  });
  saveState(cwd, narrowing);
  // The narrow record itself is the first attempt of the new phase, so the
  // phase is progressing rather than unstarted; what matters is that the old
  // repetition no longer keeps it stuck.
  assert.equal(analyze(cwd, state()).level, 'progressing');

  log(cwd, state(), { signal: 'positive', fingerprint: 'compliance-v1' });
  const health = analyze(cwd, state());
  assert.equal(health.level, 'progressing');
  assert.equal(health.sincePositive, 0);
  assert.equal(health.phase, 2);
});

test('repetition is evaluated inside the current phase only', (t) => {
  const { cwd, state } = setup(t);
  for (let i = 0; i < 3; i += 1) log(cwd, state());
  appendNarrow(cwd, state(), { reason: 'switch method', evidence: ['research/tasks/t1/neb.log'] });
  saveState(cwd, state());
  log(cwd, state(), { signal: 'inconclusive', fingerprint: 'compliance-v1' });
  const health = analyze(cwd, state());
  assert.deepEqual(health.repeated, []);
  assert.equal(health.level, 'progressing');
});

test('dead-ends packet keeps blocked and inconclusive records that caused the stall', (t) => {
  const { cwd, state } = setup(t);
  log(cwd, state(), { signal: 'blocked', observed: 'Slurm queue paused', lesson: 'waiting on scheduler' });
  log(cwd, state(), { signal: 'inconclusive', observed: 'noise dominates', lesson: 'need longer sampling' });
  log(cwd, state(), { signal: 'blocked', observed: 'quota exhausted mid-run', lesson: 'waiting on quota' });
  const health = analyze(cwd, state());
  assert.equal(health.level, 'stuck');

  const packet = buildPacket(cwd, state(), { intent: 'unstick', mode: 'dead-ends' });
  assert.equal(packet.mode, 'dead-ends');
  assert.equal(packet.attempts.length, 3);
  const signals = packet.attempts.map((a) => a.signal).sort();
  assert.deepEqual(signals, ['blocked', 'blocked', 'inconclusive']);
  const text = renderPacket(packet);
  assert.match(text, /Slurm queue paused/);
  assert.match(text, /noise dominates/);
  assert.match(text, /quota exhausted mid-run/);
});

test('the packet limit is applied in every mode', (t) => {
  const { cwd, state } = setup(t);
  for (let i = 0; i < 10; i += 1) log(cwd, state(), { signal: i === 9 ? 'positive' : 'negative', fingerprint: `f-${i}` });
  assert.equal(buildPacket(cwd, state(), { mode: 'recent', limit: 3 }).attempts.length, 3);
  assert.equal(buildPacket(cwd, state(), { mode: 'dead-ends', limit: 2 }).attempts.length, 2);
  const packet = buildPacket(cwd, state(), { mode: 'recent', limit: 3 });
  assert.equal(packet.omittedAttempts, 7);
});

test('a historical attempt ceiling preserves evidence-based progressing status', (t) => {
  const { cwd, state } = setup(t, { maxAttempts: 2 });
  log(cwd, state(), { signal: 'positive', fingerprint: 'a' });
  log(cwd, state(), { signal: 'positive', fingerprint: 'b' });
  const health = analyze(cwd, state());
  assert.equal(health.level, 'progressing');
  assert.equal(health.thresholds.maxAttempts, null);
  assert.equal(health.attempts, 2);
  assert.doesNotMatch(health.reasons.join(' '), /budget exhausted/);
});

test('a supported claim without evidence is rejected, and evidence survives into the packet', (t) => {
  const { cwd, state } = setup(t);
  assert.throws(() => upsertClaim(state(), {
    id: 'C1', status: 'supported', statement: 'radius ratio predicts the barrier',
  }), /evidence/);

  log(cwd, state());
  const current = state();
  upsertClaim(current, {
    id: 'C1', status: 'supported', statement: 'radius ratio predicts the barrier',
    evidence: ['research/tasks/t1/table.md'],
  });
  saveState(cwd, current);
  const packet = buildPacket(cwd, state(), { mode: 'recent' });
  assert.deepEqual(packet.claims[0].evidence, ['research/tasks/t1/table.md']);
  assert.match(renderPacket(packet), /research\/tasks\/t1\/table\.md/);
});

test('narrow requires a reason and at least one evidence path', (t) => {
  const { cwd, state } = setup(t);
  assert.throws(() => appendNarrow(cwd, state(), { reason: 'changed mind', evidence: [] }), /evidence/);
  assert.throws(() => appendNarrow(cwd, state(), { evidence: ['research/tasks/t1/table.md'] }), /reason/);
});

test('claim status values are validated', (t) => {
  const { state } = setup(t);
  assert.throws(() => upsertClaim(state(), {
    id: 'C2', status: 'probably_true', statement: 'x', evidence: ['a.md'],
  }), /status/);
});
