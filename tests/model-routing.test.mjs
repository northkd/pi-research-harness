import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {eligibleModels, assessEscalation, resourceAdmission, catalogueFingerprint, selectModelForTask, escalateTier, reconcileCatalog, idleEvaluationAllowed} from '../integration/model-routing/routing-policy.mjs';
import {sanitizeHistoryRecord, appendHistoryRecord, readHistoryRecords, getModelHistoricalStats} from '../integration/model-routing/history-store.mjs';

const model = id => ({provider: 'synthetic-provider', id, authenticated: true, contextWindow: 100000, input: ['text']});
const policy = {providerAllow: ['synthetic-provider'], aliases: {'fast-model': 'primary', 'backup-model': 'squareface-backup'}, minimumAvailableMemoryBytes: 2 * 1024 ** 3, maxLiveChildProcessesMachineWide: 3, idleEvaluation: {idleMs: 900000, minimumIntervalMs: 3600000}, taskCategories: {'quick-lookup': {preferredTier: 'fast', tiers: {fast: ['synthetic-provider/fast-model'], standard: ['synthetic-provider/standard-model']}, escalationLadder: {fast: 'standard'}}}};
const task = {requiredContext: 1000};

test('eligibility fails closed on authentication, mapping, context, vision and pool exhaustion evidence', () => {
  const result = eligibleModels(policy, [model('fast-model'), model('unknown'), {...model('fast-model'), authenticated: false}, {...model('fast-model'), provider: 'other'}], task, {}, 1000);
  assert.deepEqual(result.map(row => row.eligible), [true, false, false, false]);
  assert.equal(eligibleModels(policy, [model('fast-model')], {requiredContext: 200000}, {}, 1000)[0].eligible, false);
  assert.equal(eligibleModels(policy, [model('fast-model')], {...task, requiresVision: true}, {}, 1000)[0].eligible, false);
  assert.equal(eligibleModels(policy, [model('backup-model')], task, {codex: {state: 'exhausted'}}, 1000)[0].eligible, false);
  const codex = {state: 'exhausted', evidenceSource: 'trusted-provider-observation', evidenceRef: 'synthetic:receipt', observedAt: 100, validUntil: 2000};
  assert.equal(eligibleModels(policy, [model('backup-model')], task, {codex}, 1000)[0].eligible, true);
});

test('two evidenced same-model corrections request assessment, not an automatic switch', () => {
  const attempt = {kind: 'targeted-correction', modelRef: 'synthetic-provider/fast-model', failureClass: 'quality', evidenceRef: 'fixture:1', acceptance: 'verified-fail'};
  assert.equal(assessEscalation([attempt]).action, 'maintain');
  assert.deepEqual(assessEscalation([attempt, {...attempt, evidenceRef: 'fixture:2'}]), {action: 'request-assessor', reason: 'two-evidenced-quality-failures', autoSwitch: false});
  assert.equal(assessEscalation([attempt, {...attempt, failureClass: 'network'}]).action, 'blocked');
});

test('resource and idle gates require capacity, reliable observations and cooldown', () => {
  const resources = {reliable: true, availableBytes: 3 * 1024 ** 3, liveChildProcesses: 1, queuedCount: 0};
  assert.equal(resourceAdmission(policy, resources, true).allow, true);
  assert.equal(resourceAdmission(policy, {...resources, liveChildProcesses: 2}, true).allow, false);
  assert.equal(resourceAdmission(0.5 * 1024 ** 3, 0).allow, false);
  assert.equal(resourceAdmission(1 * 1024 ** 3, 0).allow, true);
  const state = {reliable: true, running: 0, queued: 0, evaluations: 0, lastInteractionAt: 0, lastEvaluationAt: null, resources};
  assert.equal(idleEvaluationAllowed(policy, state, 900000), true);
  assert.equal(idleEvaluationAllowed(policy, {...state, queued: 1}, 900000), false);
  assert.equal(idleEvaluationAllowed(policy, {...state, lastEvaluationAt: 800000}, 900000), false);
});

test('catalog changes quarantine new entries and category selection does not promote unknowns', () => {
  const a = model('fast-model'), b = model('new-model');
  assert.equal(catalogueFingerprint([a, b]), catalogueFingerprint([b, a]));
  const result = reconcileCatalog({previousFingerprint: catalogueFingerprint([a]), previousAuthenticatedModels: [a], currentModels: [a, b], policy});
  assert.deepEqual(result.unverifiedPool, ['synthetic-provider/new-model']);
  assert.equal(selectModelForTask(policy, 'quick-lookup').modelRef, 'synthetic-provider/fast-model');
  assert.equal(selectModelForTask(policy, 'quick-lookup', null, new Set(['synthetic-provider/fast-model'])).modelRef, null);
  assert.equal(escalateTier(policy, 'quick-lookup', 'fast'), 'standard');
});

test('history rejects forbidden fields, uses temporary files and keeps scores model-specific', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'history.jsonl');
  const record = {taskClass: 'critique', modelRef: 'synthetic-provider/fast-model', acceptance: 'verified-pass', evidenceRef: 'fixture:1', subscriptionCost: '0'};
  assert.throws(() => sanitizeHistoryRecord({...record, prompt: 'not admitted'}), /Forbidden/);
  assert.equal(sanitizeHistoryRecord(record).subscriptionCost, 'unknown');
  appendHistoryRecord(file, record);
  assert.equal(readHistoryRecords(file).length, 1);
  assert.equal(getModelHistoricalStats(file, record.modelRef).passCount, 1);
  assert.equal(getModelHistoricalStats(file, 'synthetic-provider/new-model').total, 0);
});
