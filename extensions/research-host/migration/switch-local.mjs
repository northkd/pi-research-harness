import { createMachineRolloutPlan, stageRolloutArtifacts, runRollout } from './rollout.mjs';
import { createSystemdRolloutAdapter } from './rollout-systemd.mjs';
import { seedRuntimeState } from './runtime-state.mjs';
import { captureLiveBaseline, liveVerification } from './live-verification.mjs';

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || !['--preflight', '--apply'].includes(mode)) {
    throw Object.assign(new Error('rollout-mode-required'), { code: 'rollout-mode-required' });
  }
  const plan = createMachineRolloutPlan();
  const baseline = await captureLiveBaseline(plan);
  const adapter = createSystemdRolloutAdapter(liveVerification(plan, baseline));
  await adapter.preflight();
  console.log(JSON.stringify({ mode, legacySessions: baseline.sessions, grants: baseline.grants,
    workbenchScopes: baseline.scopes.length, adoptionScopes: baseline.scopes.filter(scope => scope.adopted).length,
    largestTranscriptBytes: baseline.largest.bytes, retirementPaths: plan.retirement.length }));
  if (mode === '--preflight') return;
  const bundle = stageRolloutArtifacts(plan);
  const result = await runRollout({ plan, bundle, adapter, seedRuntimeState, expectedPlanSha256: plan.planSha256 });
  console.log(JSON.stringify({ phase: result.phase, backupDir: result.backupDir, verifiedRetirementPaths: result.retiredPaths.length }));
}

try { await main(); }
catch (error) {
  const code = /^[a-z0-9-]{1,120}$/.test(error?.code ?? '') ? error.code : 'rollout-operation-unconfirmed';
  console.error(JSON.stringify({ code, ...(error?.journalFile ? { journalFile: error.journalFile } : {}) }));
  process.exitCode = 1;
}
