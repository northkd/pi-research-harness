// End-to-end research workflow: Stage 1 -> direction -> Stage 2 -> Stage 3.
//
// One launch replaces the manual stage-by-stage calls. The caller supplies the
// memory-gated explorer count and the task directory; the workflow never reads
// /proc or guesses resources.
//
// Expected args:
//   topic          string  required
//   taskDir        string  required for experiments
//   maxExplorers   number  caller-computed admission, default 1
//   maxMilestones  number  default 2
//   maxRounds      number  default 4
//   stopAfter      'plan' | 'experiment' | 'review'  default 'review'
//   authorModel    string  optional, for reporting
//   reviewerModel  string  optional override (may be ignored for pinned agents)

function finish(value) {
  emit({ type: 'workflow-result', outcome: value.status, ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 2048) } : {}) });
  return value;
}
function reportStep(key, phase, agent, result) {
  if (!result || typeof result !== 'object') return;
  const structured = result.structuredOutput;
  const summary = typeof structured === 'object' && structured !== null ? JSON.stringify(structured) : String(result.output ?? result.error ?? '');
  const models = [...new Set((result.results ?? []).map(row => row.model).filter(model => typeof model === 'string' && model))];
  const executionStatus = result.state === 'running' ? 'running' : result.stopped ? 'stopped' : result.detached ? 'paused' : result.ok === true ? 'completed' : 'failed';
  emit({
    type: 'step-result', key, phase, agent, executionStatus,
    ...(typeof result.runId === 'string' ? { childRunId: result.runId } : {}),
    ...(models.length === 1 ? { observedModel: models[0] } : {}),
    ...(typeof structured?.status === 'string' ? { businessStatus: structured.status } : {}),
    ...(summary ? { summary: summary.slice(0, 2048) } : {}),
    evidence: [...(Array.isArray(structured?.evidence) ? structured.evidence : []), ...(Array.isArray(result.artifactPaths) ? result.artifactPaths : [])].filter(value => typeof value === 'string').slice(0, 20),
  });
}

// The host must install its scoped native adapter before this script may launch children.
const researchBudget = args?.researchBudget;
if (researchBudget?.version !== 1 || typeof researchBudget.scopeId !== 'string' || typeof researchBudget.extension !== 'string' || !researchBudget.extension.endsWith('/extension.mjs')) {
  return finish({ status: 'blocked', reason: 'research-budget-bridge-unavailable-open-new-session' });
}
const budgeted = input => ({ ...input, async: true, extensions: [...(input.extensions ?? []), researchBudget.extension] });
const budgetedRuns = { run: (key, input) => runs.run(key, budgeted(input)), all: inputs => runs.all(inputs.map(budgeted)) };

const topic = String(args?.topic ?? '').trim();
if (!topic) return finish({ status: 'blocked', reason: 'topic is required' });
const taskDir = String(args?.taskDir ?? '').trim();
const MAX_EXPLORERS = Math.min(Math.max(Number(args?.maxExplorers ?? 1), 1), 8);
const MAX_MILESTONES = Math.min(Math.max(Number(args?.maxMilestones ?? 2), 1), 6);
const MAX_ROUNDS = Math.min(Math.max(Number(args?.maxRounds ?? 4), 1), 4);
const stopAfter = ['plan', 'experiment', 'review'].includes(args?.stopAfter) ? args.stopAfter : 'review';
const reviewerModel = typeof args?.reviewerModel === 'string' && args.reviewerModel.trim()
  ? args.reviewerModel.trim()
  : undefined;

const ANGLE_POOL = [
  'mechanism and physical constraint',
  'cross-domain analogy',
  'counterexample and boundary condition',
  'measurement and falsification path',
  'prior-art collision',
  'scale and regime transfer',
];

const CARD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: {
    cards: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['hypothesisId', 'claim', 'angle', 'falsification', 'minimalTest', 'cost'],
        properties: {
          hypothesisId: { type: 'string' }, claim: { type: 'string' }, angle: { type: 'string' },
          whyNow: { type: 'string' }, falsification: { type: 'string' },
          minimalTest: { type: 'string' }, cost: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          uncertainties: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['chosen', 'reason', 'milestones', 'killCriteria'],
  properties: {
    chosen: { type: 'string' },
    reason: { type: 'string' },
    milestones: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'task', 'executor'],
        properties: {
          id: { type: 'string' }, task: { type: 'string' },
          executor: { type: 'string', enum: ['numerics', 'ssh'] },
        },
      },
    },
    killCriteria: { type: 'array', items: { type: 'string' } },
  },
};

const EXPERIMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'commands', 'evidence', 'notes'],
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    commands: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['score', 'verdict', 'weaknesses', 'fixes', 'memory'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 10 },
    verdict: { type: 'string', enum: ['ready', 'almost', 'not_ready'] },
    weaknesses: { type: 'string' }, fixes: { type: 'string' }, memory: { type: 'string' },
  },
};

// ── Stage 1: independent exploration ─────────────────────────────────────
const angles = ANGLE_POOL.slice(0, MAX_EXPLORERS);
const explorations = await budgetedRuns.all(angles.map((angle, index) => ({
  key: `explorer-${index + 1}`,
  agent: 'research-explorer',
  phase: '1-idea', label: `独立探索 ${index + 1}`,
  context: 'fresh',
  outputSchema: CARD_SCHEMA,
  task: [
    `Broad direction: ${topic}`,
    `Your angle: ${angle}`,
    'Return 2-5 hypothesis cards. No ranking, no confidence scores, no comparison with other angles.',
  ].join('\n'),
})));

explorations.forEach((result, index) => reportStep(`explorer-${index + 1}`, '1-idea', 'research-explorer', result));
const cards = explorations.flatMap((r, i) => (r?.structuredOutput?.cards ?? []).map((c) => ({ ...c, angle: c.angle || angles[i] })));
if (!cards.length) return finish({ status: 'blocked', reason: 'no hypothesis cards produced', explorations: explorations.map((r) => ({ ok: r?.ok, error: r?.error })) });

const screen = await budgetedRuns.run('screen', {
  agent: 'research-critic', phase: '1-idea', label: '新颖性与可证伪性筛选',
  context: 'fresh',
  task: [
    `Direction: ${topic}`,
    'Screen these candidate cards. Treat them as unverified.',
    'Identify which are falsifiable, which lack evidence, and which are obviously incremental.',
    JSON.stringify(cards, null, 2),
  ].join('\n'),
});

reportStep('screen', '1-idea', 'research-critic', screen);

// ── Direction choice and milestone plan ──────────────────────────────────
const plan = await budgetedRuns.run('plan', {
  agent: 'research-strategist', phase: '1-idea', label: '方向选择与里程碑规划',
  context: 'fresh',
  outputSchema: PLAN_SCHEMA,
  task: [
    `Direction: ${topic}`,
    'Choose one direction worth executing now and turn it into at most '
      + `${MAX_MILESTONES} minimal, decidable experiment milestones.`,
    'Each milestone must have a concrete task and an executor: numerics (local) or ssh (one scheduler node).',
    'Include kill criteria. Do not claim results.',
    'Cards:',
    JSON.stringify(cards, null, 2),
    'Critic screen:',
    String(screen?.output ?? '').slice(0, 12000),
  ].join('\n'),
});

reportStep('plan', '1-idea', 'research-strategist', plan);
const chosenPlan = plan?.structuredOutput ?? null;
if (!chosenPlan) return finish({ status: 'blocked', reason: 'strategist produced no structured plan', cards, screen: screen?.output });
if (stopAfter === 'plan') return finish({ status: 'planned', cards, screen: screen?.output, plan: chosenPlan });

// ── Stage 2: sequential experiments ─────────────────────────────────────
const experiments = [];
for (const [index, milestone] of chosenPlan.milestones.slice(0, MAX_MILESTONES).entries()) {
  const run = await budgetedRuns.run(`experiment-${index + 1}`, {
    agent: milestone.executor === 'ssh' ? 'research-ssh' : 'research-numerics',
    phase: '2-experiment', label: `实验 ${index + 1} · ${milestone.id}`,
    context: 'fresh',
    outputSchema: EXPERIMENT_SCHEMA,
    task: [
      `Milestone: ${milestone.id}`,
      `Task: ${milestone.task}`,
      taskDir ? `Write all outputs under: ${taskDir}` : 'Write outputs under the current task directory.',
      'Save raw stdout/stderr and report absolute paths. Do not overwrite raw data.',
      'Return completed only if the command ran and evidence was saved.',
    ].filter(Boolean).join('\n'),
  });
  const structured = run?.structuredOutput ?? { status: 'failed', commands: [], evidence: [], notes: 'no structured result' };
  experiments.push({ id: milestone.id, executor: milestone.executor, ok: run?.ok === true, ...structured });
  reportStep(`experiment-${index + 1}`, '2-experiment', milestone.executor === 'ssh' ? 'research-ssh' : 'research-numerics', { ...run, structuredOutput: structured });
  if (structured.status !== 'completed') {
    return finish({ status: 'blocked', reason: `milestone ${milestone.id} ${structured.status}`, cards, screen: screen?.output, plan: chosenPlan, experiments });
  }
}
if (stopAfter === 'experiment') return finish({ status: 'experiments_completed', cards, screen: screen?.output, plan: chosenPlan, experiments });

// ── Stage 3: review loop with memory chain ──────────────────────────────
const rounds = [];
let memory = '';
for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const review = await budgetedRuns.run(`review-${round}`, {
    agent: 'research-critic', phase: '3-review', label: `对抗评审 · 第 ${round} 轮`,
    context: 'fresh',
    ...(reviewerModel ? { model: reviewerModel } : {}),
    outputSchema: REVIEW_SCHEMA,
    task: [
      'You are an independent scientific reviewer. This is one round of a multi-round loop.',
      `Direction: ${topic}`,
      `Chosen plan: ${chosenPlan.chosen}`,
      `Experiments: ${JSON.stringify(experiments)}`,
      round === 1 ? 'Round 1: establish the baseline.' : `Previous reviewer memory:\n${memory}`,
      'Judge whether the evidence supports the claim. Be strict about scope, controls and reproducibility.',
    ].join('\n'),
  });
  reportStep(`review-${round}`, '3-review', 'research-critic', review);
  const structured = review?.structuredOutput;
  if (!structured) return finish({ status: 'blocked', reason: `round ${round} produced no structured review`, cards, plan: chosenPlan, experiments, rounds });
  rounds.push({ round, ...structured });
  memory = `Round ${round}: score=${structured.score} verdict=${structured.verdict}\nWeaknesses: ${structured.weaknesses}\nFixes: ${structured.fixes}\nMemory: ${structured.memory}`;
  if (structured.score >= 6 && (structured.verdict === 'ready' || structured.verdict === 'almost')) {
    return finish({ status: 'converged', cards, screen: screen?.output, plan: chosenPlan, experiments, rounds, finalMemory: memory });
  }
}

return finish({ status: 'max_rounds_reached', cards, screen: screen?.output, plan: chosenPlan, experiments, rounds, finalMemory: memory });
