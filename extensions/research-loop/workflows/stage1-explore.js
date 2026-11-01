// Stage 1 exploration workflow (ARIS: Idea Discovery).
//
// Memory-gated fan-out: admit as many explorers as fit while keeping a 1 GiB
// reserve, run them in isolated contexts, then hand the cards to the critic.
// The workflow does not decide the research direction; it only collects
// candidate hypothesis cards and their falsification conditions.
//
// Expected args:
//   topic        (string, required) broad direction
//   angles       (array<string>)    defaults to the angle pool
//   evidenceDir  (string)           project-relative directory explorers may read
//   maxExplorers (number)           upper bound, default 4
//   perAgentMiB  (number)           admission estimate, default 700
//   reserveMiB   (number)           reserve, default 1024

const topic = String(args?.topic ?? '').trim();
if (!topic) return { status: 'blocked', reason: 'topic is required' };

const RESERVE_MIB = Number(args?.reserveMiB ?? 1024);
const PER_AGENT_MIB = Number(args?.perAgentMiB ?? 700);
const MAX_EXPLORERS = Math.min(Math.max(Number(args?.maxExplorers ?? 4), 1), 8);
const evidenceDir = typeof args?.evidenceDir === 'string' ? args.evidenceDir : '.';
// Optional overrides for smoke tests; production uses each agent's bound model.
const explorerModel = typeof args?.explorerModel === 'string' && args.explorerModel.trim() ? args.explorerModel.trim() : undefined;
const criticModel = typeof args?.criticModel === 'string' && args.criticModel.trim() ? args.criticModel.trim() : undefined;

const ANGLE_POOL = [
  { id: 'mechanism', text: 'mechanism and physical constraint' },
  { id: 'analogy', text: 'cross-domain analogy' },
  { id: 'counterexample', text: 'counterexample and boundary condition' },
  { id: 'measurement', text: 'measurement and falsification path' },
  { id: 'prior-art', text: 'prior-art collision: what would make this incremental' },
  { id: 'regime', text: 'scale and regime transfer: does it hold at another limit' },
];

const requestedAngles = Array.isArray(args?.angles) && args.angles.length
  ? args.angles.map((a, i) => ({ id: typeof a === 'string' ? `angle-${i + 1}` : String(a?.id ?? `angle-${i + 1}`), text: typeof a === 'string' ? a : String(a?.text ?? '') }))
  : ANGLE_POOL;

const angles = requestedAngles.slice(0, MAX_EXPLORERS);

// Admission is computed by the caller before launch:
//   node research-loop/scripts/explorer-capacity.mjs admit --requested N --active 0
// and the admitted count is passed as maxExplorers. The workflow sandbox has no
// shell, so it must not try to read /proc itself.
const admitted = MAX_EXPLORERS;
const feasibleAngles = angles.slice(0, admitted);
if (!feasibleAngles.length) {
  return { status: 'blocked', reason: 'no explorer admitted; run explorer-capacity.mjs first' };
}

const cards = await runs.all(feasibleAngles.map((angle, index) => ({
  key: `explorer-${angle.id}`,
  agent: 'research-explorer',
  context: 'fresh',
  ...(explorerModel ? { model: explorerModel } : {}),
  task: [
    `Broad direction: ${topic}`,
    `Your angle: ${angle.text}`,
    `Allowed evidence directory: ${evidenceDir}`,
    'Do not read other explorers\' directories or any critic output.',
    'Return 2-5 hypothesis cards. Each card must include: hypothesisId, claim, angle, whyNow, falsification, minimalTest, cost, evidence, uncertainties.',
    'No confidence scores, no ranking, no comparison with other angles.',
  ].join('\n'),
})));

const failed = cards.filter((c) => c?.ok !== true);
const cardsText = cards.map((c, i) => `## ${feasibleAngles[i]?.id ?? i}\n${c?.output ?? ''}`).join('\n\n');

const review = await runs.run('critic', {
  agent: 'research-critic',
  context: 'fresh',
  ...(criticModel ? { model: criticModel } : {}),
  task: [
    `Broad direction: ${topic}`,
    'Below are independent hypothesis cards. Treat them as unverified candidates.',
    'For each card check: is it falsifiable, is the evidence real, is the minimal test actually decidable, is it obviously incremental?',
    'Return: kept, rejected (with reason), merged duplicates, and the evidence gaps.',
    cardsText,
  ].join('\n'),
});

return {
  status: failed.length ? 'partial' : 'review_completed_not_scientifically_verified',
  requested: angles.length,
  admitted,
  ran: feasibleAngles.length,
  deferred: angles.slice(admitted).map((a) => a.id),
  capacity: null,
  cards: cards.map((c, i) => ({ angle: feasibleAngles[i]?.id, ok: c?.ok === true, output: c?.output })),
  critic: { ok: review?.ok === true, output: review?.output },
  note: 'Explorer cards are candidates. The critic output is a first-pass screen, not a scientific verdict.',
};
