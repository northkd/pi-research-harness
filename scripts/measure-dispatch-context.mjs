// Reproducible synthetic transport measurement, not a model token/cost benchmark.
// Run from any directory: node scripts/measure-dispatch-context.mjs
import {
  projectDispatchContext,
  dispatchContextBytes,
  DISPATCH_CONTEXT_BYTES,
  DISPATCH_DETAIL_BYTES,
} from '../extensions/research-loop/src/dispatch-context.mjs';

const fixtures = [
  { name: 'six-medium-CJK-tasks', tasks: 6, taskCharacters: 600, summaryCharacters: 400, evidencePathsPerTask: 2, evidencePathCharacters: 48 },
  { name: 'twenty-four-long-CJK-tasks', tasks: 24, taskCharacters: 4000, summaryCharacters: 4000, evidencePathsPerTask: 16, evidencePathCharacters: 1002 },
];

const results = fixtures.map(({ name, ...inputs }) => {
  const tasks = Array.from({ length: inputs.tasks }, (_, index) => ({
    id: `task-${index}`,
    role: 'research-critic',
    stage: '3-review',
    task: '任'.repeat(inputs.taskCharacters),
    summary: '结'.repeat(inputs.summaryCharacters),
    evidence: Array.from({ length: inputs.evidencePathsPerTask }, (_, pathIndex) => {
      const prefix = `evidence/${pathIndex}/`;
      return prefix + '路'.repeat(inputs.evidencePathCharacters - prefix.length);
    }),
    dependsOn: [],
    status: index === inputs.tasks - 1 ? 'failed' : 'completed',
    ...(index === inputs.tasks - 1 ? { error: 'evidence-mismatch' } : {}),
  }));
  const plans = [];
  for (let offset = 0; offset < inputs.tasks; offset += 12) {
    plans.push({
      id: `plan-${offset / 12}`,
      status: offset + 12 >= inputs.tasks ? 'failed' : 'completed',
      mode: 'tasks',
      tasks: tasks.slice(offset, offset + 12),
    });
  }
  const snapshot = { status: 'ok', collaborator: false, decisionRequired: false, childrenPending: false, declaredTasks: 0, plans };
  const oldModelBytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2));
  const projection = projectDispatchContext(snapshot, { action: 'status' });
  const newModelBytes = dispatchContextBytes(projection);
  return {
    name, inputs, oldModelBytes, newModelBytes,
    reductionPercent: Number(((1 - newModelBytes / oldModelBytes) * 100).toFixed(2)),
    preservedFailures: projection.counts.failed,
  };
});

console.log(JSON.stringify({
  date: new Date().toISOString().slice(0, 10),
  method: 'Synthetic snapshots rendered by the previous JSON.stringify(snapshot,null,2) path and the current production projectDispatchContext; UTF-8 bytes of model-facing text. No model/provider/token usage measurement.',
  limits: { defaultReplyBytes: DISPATCH_CONTEXT_BYTES, detailReplyBytes: DISPATCH_DETAIL_BYTES },
  results,
}, null, 2));
