import { createHash } from 'node:crypto';

export const MAX_LIVE_CHILD_PROCESSES = 3;
export const MIN_AVAILABLE_MEMORY_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB (1073741824 bytes)

/**
 * Computes a deterministic SHA-256 fingerprint for a list of models.
 * Independent of order.
 */
export function catalogueFingerprint(models) {
  if (!Array.isArray(models)) return '';
  const normalized = models.map(m => ({
    ref: `${m.provider}/${m.id}`,
    contextWindow: m.contextWindow ?? null,
    input: [...(m.input ?? [])].sort()
  }));
  normalized.sort((a, b) => a.ref.localeCompare(b.ref));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export const catalogFingerprint = catalogueFingerprint;

/**
 * Evaluates candidate model eligibility based on policy constraints.
 */
export function eligibleModels(policy, models, task, quota, now) {
  return models.map(model => {
    const ref = `${model.provider}/${model.id}`;
    const pool = policy.aliases?.[model.id];
    const reasons = [];
    if (!policy.providerAllow?.includes(model.provider)) reasons.push('provider-not-authorized');
    if (model.authenticated !== true) reasons.push('authentication-unverified');
    if (!pool) reasons.push('upstream-unmapped');
    if (!Number.isSafeInteger(task.requiredContext) || task.requiredContext <= 0) reasons.push('invalid-context-requirement');
    else if (!Number.isFinite(model.contextWindow) || model.contextWindow < task.requiredContext) reasons.push('context-insufficient');
    if (task.requiresVision && !model.input?.includes('image')) reasons.push('vision-unsupported');
    if (pool === 'squareface-backup') {
      const q = quota?.codex;
      if (!(q?.state === 'exhausted' && q.evidenceSource === 'trusted-provider-observation' && q.evidenceRef && Number.isFinite(q.observedAt) && q.observedAt <= now && Number.isFinite(q.validUntil) && q.validUntil > now)) {
        reasons.push('codex-exhaustion-unproven');
      }
    }
    return { ref, pool: pool ?? null, eligible: reasons.length === 0, reasons };
  });
}

/**
 * Evaluates escalation logic after failures.
 * Requires 2 consecutive same-model quality failures with evidence to request assessor.
 */
export function assessEscalation(attempts) {
  const corrections = attempts.filter(a => a.kind === 'targeted-correction');
  if (attempts.some(a => a.acceptance === 'verified-pass')) return { action: 'maintain', reason: 'acceptance-passed' };
  if (corrections.length < 2) return { action: 'maintain', reason: 'two-corrections-not-completed' };
  const last = corrections.slice(-2);
  if (last.some(a => a.failureClass !== 'quality' || !a.evidenceRef || a.acceptance !== 'verified-fail')) {
    return { action: 'blocked', reason: 'not-two-evidenced-quality-failures' };
  }
  if (!last[0].modelRef || last[0].modelRef !== last[1].modelRef) {
    return { action: 'blocked', reason: 'corrections-not-same-model' };
  }
  return { action: 'request-assessor', reason: 'two-evidenced-quality-failures', autoSwitch: false };
}

/**
 * Selects a good-enough model for a given task category and tier.
 * Filters out unverified or quarantined models.
 */
export function selectModelForTask(policy, taskCategory, currentTier = null, unverifiedPool = new Set()) {
  const categoryConfig = policy.taskCategories?.[taskCategory];
  if (!categoryConfig) {
    return { error: `Unknown task category: ${taskCategory}`, modelRef: null, tier: null };
  }

  const tier = currentTier || categoryConfig.preferredTier;
  const candidateList = categoryConfig.tiers?.[tier] || [];

  // Filter out any models currently in unverified pool
  const verifiedCandidates = candidateList.filter(ref => !unverifiedPool.has(ref));

  if (verifiedCandidates.length === 0) {
    return {
      error: `No verified models available for category ${taskCategory} at tier ${tier}`,
      modelRef: null,
      tier,
      unverifiedFallback: candidateList[0] || null
    };
  }

  // Good-enough principle: pick first verified candidate
  return {
    modelRef: verifiedCandidates[0],
    tier,
    candidates: verifiedCandidates,
    error: null
  };
}

/**
 * Gets next tier in escalation ladder for a category.
 */
export function escalateTier(policy, taskCategory, currentTier) {
  const categoryConfig = policy.taskCategories?.[taskCategory];
  if (!categoryConfig) return null;
  const ladder = categoryConfig.escalationLadder || {};
  return ladder[currentTier] || null;
}

/**
 * Reconciles catalog changes, invalidates removed models, and places newly added models into unverified pool.
 */
export function reconcileCatalog({ previousFingerprint, previousAuthenticatedModels = [], currentModels = [], policy = null }) {
  const newFingerprint = catalogueFingerprint(currentModels);
  const currentRefs = new Set(currentModels.map(m => `${m.provider}/${m.id}`));
  const prevRefs = new Set(previousAuthenticatedModels.map(m => typeof m === 'string' ? m : `${m.provider}/${m.id}`));

  const removedModels = [];
  for (const prev of prevRefs) {
    if (!currentRefs.has(prev)) {
      removedModels.push(prev);
    }
  }

  const unverifiedPool = new Set();
  for (const curr of currentRefs) {
    if (!prevRefs.has(curr)) {
      unverifiedPool.add(curr);
    }
  }

  const changed = previousFingerprint !== newFingerprint || removedModels.length > 0 || unverifiedPool.size > 0;

  // Active candidates: current models that are authorized and authenticated and not in unverified pool
  const activeCandidates = currentModels
    .map(m => `${m.provider}/${m.id}`)
    .filter(ref => !unverifiedPool.has(ref) && (!policy?.providerAllow || policy.providerAllow.includes(ref.split('/')[0])));

  return {
    catalogFingerprint: newFingerprint,
    activeCandidates,
    unverifiedPool: Array.from(unverifiedPool),
    removedModels,
    changed
  };
}

/**
 * Resource admission gate (pure function).
 * Dual-signature support:
 * 1. resourceAdmission(memAvailableBytes, activeSubagentProcesses, options)
 * 2. resourceAdmission(policy, observation, needsDescendant)
 *
 * NOTE: Pure-function snapshot only; not a machine-level lock, cannot substitute for atomic host locks.
 */
export function resourceAdmission(firstArg, secondArg, thirdArg = false) {
  let availableBytes;
  let liveChildProcesses;
  let minMemory = MIN_AVAILABLE_MEMORY_BYTES;
  let maxProcesses = MAX_LIVE_CHILD_PROCESSES;
  let needsDescendant = false;

  if (typeof firstArg === 'number') {
    // New signature: resourceAdmission(memAvailableBytes, activeSubagentProcesses, options)
    availableBytes = firstArg;
    liveChildProcesses = secondArg;
    if (typeof thirdArg === 'object' && thirdArg !== null) {
      needsDescendant = Boolean(thirdArg.needsDescendant);
      if (Number.isFinite(thirdArg.minAvailableMemoryBytes)) minMemory = thirdArg.minAvailableMemoryBytes;
      if (Number.isSafeInteger(thirdArg.maxLiveChildProcesses)) maxProcesses = thirdArg.maxLiveChildProcesses;
    } else if (typeof thirdArg === 'boolean') {
      needsDescendant = thirdArg;
    }
  } else if (typeof firstArg === 'object' && firstArg !== null) {
    // Prototype signature: resourceAdmission(policy, observation, needsDescendant)
    const policy = firstArg;
    const observation = secondArg || {};
    if (observation.reliable !== true || !Number.isFinite(observation.availableBytes) ||
        !Number.isSafeInteger(observation.liveChildProcesses) || observation.liveChildProcesses < 0 ||
        !Number.isSafeInteger(observation.queuedCount) || observation.queuedCount < 0) {
      return { allow: false, reason: 'resource-state-unknown' };
    }
    availableBytes = observation.availableBytes;
    liveChildProcesses = observation.liveChildProcesses;
    minMemory = policy.minimumAvailableMemoryBytes ?? MIN_AVAILABLE_MEMORY_BYTES;
    maxProcesses = policy.maxLiveChildProcessesMachineWide ?? MAX_LIVE_CHILD_PROCESSES;
    needsDescendant = Boolean(thirdArg);
  } else {
    return { allow: false, reason: 'invalid-arguments' };
  }

  if (!Number.isFinite(availableBytes) || availableBytes < 0 ||
      !Number.isSafeInteger(liveChildProcesses) || liveChildProcesses < 0) {
    return { allow: false, reason: 'invalid-resource-values' };
  }

  if (availableBytes < minMemory) {
    return {
      allow: false,
      reason: 'memory-low',
      detail: `Available memory (${(availableBytes / (1024 ** 3)).toFixed(2)} GiB) is below required ${(minMemory / (1024 ** 3)).toFixed(2)} GiB`
    };
  }

  const needed = needsDescendant ? 2 : 1;
  if (liveChildProcesses + needed > maxProcesses) {
    return {
      allow: false,
      reason: 'capacity-or-descendant-reserve',
      detail: `Live child processes (${liveChildProcesses}) + needed (${needed}) exceeds limit (${maxProcesses})`
    };
  }

  return {
    allow: true,
    reason: 'snapshot-only-requires-atomic-lease',
    notice: 'Pure-function decision only; does not provide machine-level locking guarantee.'
  };
}

/**
 * Checks whether idle evaluation may run.
 */
export function idleEvaluationAllowed(policy, state, now) {
  const rule = policy.idleEvaluation;
  if (state.reliable !== true || state.running !== 0 || state.queued !== 0 || state.evaluations !== 0) return false;
  if (!Number.isFinite(now) || !Number.isFinite(state.lastInteractionAt) || state.lastInteractionAt > now || now - state.lastInteractionAt < rule.idleMs) return false;
  if (state.lastEvaluationAt !== null && (!Number.isFinite(state.lastEvaluationAt) || state.lastEvaluationAt > now || now - state.lastEvaluationAt < rule.minimumIntervalMs)) return false;
  return resourceAdmission(policy, state.resources).allow;
}
