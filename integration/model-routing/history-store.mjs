import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const ALLOWED_TASK_CLASSES = new Set([
  'quick-lookup',
  'numeric-check',
  'literature-search',
  'theory-derivation',
  'critique',
  'deep-synthesis'
]);

const ALLOWED_ACCEPTANCES = new Set([
  'verified-pass',
  'verified-fail',
  'indeterminate'
]);

const FORBIDDEN_KEYS = new Set([
  'prompt',
  'rawPrompt',
  'task',
  'taskDescription',
  'instruction',
  'user',
  'username',
  'apiKey',
  'token',
  'secret',
  'auth',
  'password',
  'code',
  'fileContent',
  'patch'
]);

/**
 * Sanitizes and validates an evaluation history record.
 * Guarantees zero sensitive prompt/code/credential leakage and normalizes subscription cost.
 */
export function sanitizeHistoryRecord(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('History record must be a valid object');
  }

  // Ensure no forbidden keys exist in input
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Forbidden sensitive key "${key}" detected in history record`);
    }
  }

  const {
    taskClass,
    modelRef,
    acceptance,
    correctionRounds,
    latencyMs,
    tokens,
    subscriptionCost,
    evidenceRef,
    recordedAt
  } = input;

  if (typeof taskClass !== 'string' || !ALLOWED_TASK_CLASSES.has(taskClass)) {
    throw new Error(`Invalid or missing taskClass: ${taskClass}`);
  }

  if (typeof modelRef !== 'string' || !modelRef.includes('/')) {
    throw new Error(`Invalid or missing modelRef: ${modelRef}`);
  }

  if (typeof acceptance !== 'string' || !ALLOWED_ACCEPTANCES.has(acceptance)) {
    throw new Error(`Invalid or missing acceptance: ${acceptance}`);
  }

  const cleanCorrectionRounds = Number.isSafeInteger(correctionRounds) && correctionRounds >= 0
    ? correctionRounds
    : 0;

  const cleanLatencyMs = Number.isSafeInteger(latencyMs) && latencyMs >= 0
    ? latencyMs
    : 0;

  const inputTokens = Number.isSafeInteger(tokens?.input) && tokens.input >= 0 ? tokens.input : 0;
  const outputTokens = Number.isSafeInteger(tokens?.output) && tokens.output >= 0 ? tokens.output : 0;
  const totalTokens = Number.isSafeInteger(tokens?.total) && tokens.total >= 0 ? tokens.total : inputTokens + outputTokens;

  // Never treat cost=0 or "0" or "free" as free; default cliproxy unknown
  let cleanCost = 'unknown';
  if (typeof subscriptionCost === 'string' && subscriptionCost !== 'free' && subscriptionCost !== '0') {
    cleanCost = subscriptionCost;
  }

  if (typeof evidenceRef !== 'string' || !evidenceRef.trim()) {
    throw new Error('Valid evidenceRef is required for acceptance tracking');
  }

  const cleanRecordedAt = typeof recordedAt === 'string' && recordedAt.trim()
    ? recordedAt
    : new Date().toISOString();

  // Return strictly whitelisted object
  return {
    taskClass,
    modelRef: modelRef.trim(),
    acceptance,
    correctionRounds: cleanCorrectionRounds,
    latencyMs: cleanLatencyMs,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens
    },
    subscriptionCost: cleanCost,
    evidenceRef: evidenceRef.trim(),
    recordedAt: cleanRecordedAt
  };
}

/**
 * Appends a sanitized record to history.jsonl
 */
export function appendHistoryRecord(filepath, rawRecord) {
  const sanitized = sanitizeHistoryRecord(rawRecord);
  const line = JSON.stringify(sanitized) + '\n';
  appendFileSync(filepath, line, 'utf8');
  return sanitized;
}

/**
 * Reads and parses history records from history.jsonl
 */
export function readHistoryRecords(filepath, filter = {}) {
  if (!existsSync(filepath)) {
    return [];
  }
  const content = readFileSync(filepath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const records = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const sanitized = sanitizeHistoryRecord(parsed);

      if (filter.taskClass && sanitized.taskClass !== filter.taskClass) continue;
      if (filter.modelRef && sanitized.modelRef !== filter.modelRef) continue;
      if (filter.acceptance && sanitized.acceptance !== filter.acceptance) continue;

      records.push(sanitized);
    } catch {
      // Skip malformed/invalid historical records
    }
  }

  return records;
}

/**
 * Gets acceptance stats for a specific model without letting new models inherit old models' stats.
 */
export function getModelHistoricalStats(filepath, modelRef, taskClass = null) {
  const records = readHistoryRecords(filepath, { modelRef, ...(taskClass ? { taskClass } : {}) });
  if (records.length === 0) {
    return {
      modelRef,
      taskClass,
      passCount: 0,
      failCount: 0,
      total: 0,
      successRate: null,
      verified: false
    };
  }

  const passCount = records.filter(r => r.acceptance === 'verified-pass').length;
  const failCount = records.filter(r => r.acceptance === 'verified-fail').length;
  const total = passCount + failCount;
  const successRate = total > 0 ? passCount / total : null;

  return {
    modelRef,
    taskClass,
    passCount,
    failCount,
    total,
    successRate,
    verified: total >= 3
  };
}
