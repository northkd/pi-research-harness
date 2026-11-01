// Stage 2 experiment workflow (ARIS: Experiment Bridge).
//
// Runs experiment milestones sequentially so that a single 2-core host never
// has more than one heavy job in flight. Each milestone is executed by
// research-numerics (local bash) or research-ssh (one scheduler node).
//
// The workflow only orchestrates. It does not decide whether a scientific
// claim is supported; the main agent records results in the ledger and the
// gates decide what may be claimed.
//
// Expected args:
//   milestones   array<{ id, task, executor?: 'numerics'|'ssh' }>  required
//   planPath     string   optional; passed to every milestone as context
//   maxMilestones number   safety cap, default 6
//   executorModel string   optional smoke-test override

const milestones = Array.isArray(args?.milestones) ? args.milestones : [];
if (!milestones.length) return { status: 'blocked', reason: 'milestones is required' };

const MAX = Math.min(Math.max(Number(args?.maxMilestones ?? 6), 1), 12);
const planPath = typeof args?.planPath === 'string' ? args.planPath : '';
const taskDir = typeof args?.taskDir === 'string' ? args.taskDir : '';
const executorModel = typeof args?.executorModel === 'string' && args.executorModel.trim()
  ? args.executorModel.trim()
  : undefined;

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'commands', 'evidence', 'notes'],
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    commands: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const results = [];
for (const [index, milestone] of milestones.slice(0, MAX).entries()) {
  const id = String(milestone?.id ?? `milestone-${index + 1}`);
  const task = String(milestone?.task ?? '').trim();
  if (!task) {
    results.push({ id, ok: false, status: 'blocked', reason: 'empty task' });
    continue;
  }
  const executor = milestone?.executor === 'ssh' ? 'research-ssh' : 'research-numerics';

  const run = await runs.run(`milestone-${index + 1}`, {
    agent: executor,
    context: 'fresh',
    ...(executorModel ? { model: executorModel } : {}),
    outputSchema: RESULT_SCHEMA,
    task: [
      `Milestone: ${id}`,
      planPath ? `Experiment plan: ${planPath}` : '',
      taskDir ? `Write all outputs under this task directory: ${taskDir}` : '',
      task,
      'Work only inside the assigned task directory. Do not overwrite raw data.',
      taskDir ? 'Save raw stdout/stderr to files under the task directory and report their absolute paths.' : '',
      'Record the exact commands, exit codes, seeds, input hashes and raw output paths.',
      'Return status=completed only if the command actually ran and its output is saved.',
      'If a resource, authorization or environment is missing, return status=blocked with the missing item.',
    ].filter(Boolean).join('\n'),
  });

  const structured = run?.structuredOutput ?? null;
  results.push({
    id,
    executor,
    ok: run?.ok === true,
    status: structured?.status ?? (run?.ok === true ? 'completed' : 'failed'),
    commands: structured?.commands ?? [],
    evidence: structured?.evidence ?? [],
    notes: structured?.notes ?? '',
    output: run?.output,
  });

  if (structured?.status === 'blocked' || structured?.status === 'failed') {
    return {
      status: structured.status === 'blocked' ? 'blocked' : 'failed',
      failedMilestone: id,
      results,
      note: 'Stopped at the first blocked/failed milestone; later milestones were not launched.',
    };
  }
}

return {
  status: results.every((r) => r.ok && r.status === 'completed') ? 'completed' : 'partial',
  milestones: milestones.slice(0, MAX).length,
  results,
  note: 'Execution evidence only. Scientific claims still require gates and independent review.',
};
