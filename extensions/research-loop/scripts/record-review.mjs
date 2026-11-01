#!/usr/bin/env node
/**
 * Bridge a completed Stage 3 workflow result into the research-loop state.
 *
 * A workflow sandbox cannot call Pi tools, so the main agent saves the workflow
 * result and runs this script once. It writes every round's trace and the
 * REVIEWER_MEMORY.md chain, then evaluates review-gate.
 *
 * Usage:
 *   node record-review.mjs --input result.json --observed-model cliproxy/... --author-model cliproxy/... \
 *     [--cwd /path/to/project] [--stage-dir review-stage] [--max-rounds 4] [--no-gate]
 */
import fs from 'node:fs';
import path from 'node:path';
import { gateReview, recordRound } from '../src/reviewer.mjs';
import { rootDir } from '../src/ledger.mjs';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; }
    else out[key] = true;
  }
  return out;
}

const opts = args(process.argv.slice(2));
if (!opts.input) {
  console.error('record-review: --input is required');
  process.exit(2);
}
const cwd = path.resolve(opts.cwd ?? process.cwd());
const stageDir = opts['stage-dir'] ?? 'review-stage';
const observedModel = typeof opts['observed-model'] === 'string' ? opts['observed-model'] : undefined;
const authorModel = typeof opts['author-model'] === 'string' ? opts['author-model'] : undefined;

const raw = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
const rounds = Array.isArray(raw)
  ? raw
  : Array.isArray(raw.rounds)
    ? raw.rounds
    : Array.isArray(raw?.workflow?.value?.rounds)
      ? raw.workflow.value.rounds
      : raw.score !== undefined
        ? [raw]
        : [];

if (!rounds.length) {
  console.error('record-review: no rounds found in input');
  process.exit(2);
}

// Ensure the project has a frozen charter; the loop state is authoritative.
if (!fs.existsSync(path.join(rootDir(cwd), 'state.json'))) {
  console.error(`record-review: no research charter at ${rootDir(cwd)}; call research_loop configure first`);
  process.exit(2);
}

const written = [];
for (const round of rounds) {
  const response = typeof round.output === 'string' && round.output.trim().startsWith('{')
    ? round.output
    : JSON.stringify({
        score: round.score,
        verdict: round.verdict,
        weaknesses: round.weaknesses ?? '',
        fixes: round.fixes ?? '',
        memory: round.memory ?? '',
      });
  const result = recordRound(cwd, stageDir, {
    round: Number(round.round),
    observedModel: round.observedModel ?? observedModel,
    response,
    changedFiles: Array.isArray(round.changedFiles) ? round.changedFiles : [],
  });
  written.push({ round: result.trace.round, score: result.trace.score, verdict: result.trace.verdict });
}

const gate = opts['no-gate'] === true
  ? null
  : gateReview({ authorModel, maxRounds: Number(opts['max-rounds'] ?? 4) })({ cwd, stageDir });

console.log(JSON.stringify({ ok: true, stageDir, written, gate }, null, 2));
process.exit(gate && gate.verdict === 'blocked' ? 1 : 0);
