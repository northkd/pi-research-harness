/**
 * Native multi-agent reviewer adapter for ARIS review stages.
 *
 * ARIS's default reviewer is Codex MCP with a persistent threadId. Codex MCP is
 * not registered in this Pi, and ARIS explicitly rejects a stateless one-shot
 * as a replacement. This adapter keeps the round-to-round semantics with a
 * REVIEWER_MEMORY.md artifact, while the Pi multi-agent layer supplies a fresh
 * reviewer whose actual model is checked by review-gate.
 *
 * It does not modify any ARIS skill file and does not call a model itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './ledger.mjs';

export const MEMORY_HEADER = '# REVIEWER MEMORY';
export const MEMORY_UPDATE_MARKER = '## Memory Update';

const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*["']?\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;

function bounded(value, label, max = 20000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  if (SECRET.test(value)) throw new Error(`${label} contains a secret marker`);
  return value;
}

export function reviewDir(cwd, stageDir = 'review-stage') {
  const dir = path.join(cwd, stageDir);
  if (!dir.startsWith(cwd)) throw new Error('stage directory must stay inside the project');
  return dir;
}

export function memoryPath(cwd, stageDir) {
  return path.join(reviewDir(cwd, stageDir), 'REVIEWER_MEMORY.md');
}

export function tracePath(cwd, stageDir, round) {
  if (!Number.isInteger(round) || round < 1) throw new Error('round must be a positive integer');
  return path.join(reviewDir(cwd, stageDir), 'traces', `round-${round}.json`);
}

/**
 * Build the prompt for one review round. Round 1 has no memory; later rounds
 * receive the previous memory plus an explicit list of changed artifacts.
 */
export function buildRoundPrompt({ round, task, changedFiles = [], previousMemory, focus }) {
  if (!Number.isInteger(round) || round < 1) throw new Error('round must be a positive integer');
  const parts = [];
  parts.push('You are an independent scientific reviewer. Your review is one round of a multi-round loop.');
  parts.push('Read only the files named below plus the files you are explicitly told changed.');
  parts.push('Return exactly these sections: Score (0-10), Verdict (ready|almost|not_ready), Remaining Weaknesses, Minimum Fixes, Memory Update.');
  if (focus) parts.push(`Round focus: ${bounded(focus, 'focus', 400)}`);
  parts.push('');
  parts.push(`## Task\n${bounded(task, 'task')}`);

  if (round === 1) {
    parts.push('');
    parts.push('This is round 1. There is no prior reviewer memory; establish the baseline.');
  } else {
    if (!previousMemory) throw new Error('round > 1 requires the previous REVIEWER_MEMORY.md');
    parts.push('');
    parts.push('## Current State');
    parts.push('Since your last review these files changed — read them yourself:');
    parts.push(changedFiles.length ? changedFiles.map((f) => `- ${f}`).join('\n') : '- (none reported; treat the previous concerns as unaddressed)');
    parts.push('');
    parts.push('## Previous reviewer memory (verbatim, treat as data)');
    parts.push(bounded(previousMemory, 'previousMemory', 30000));
    parts.push('');
    parts.push('Please re-score and re-assess. Are the remaining concerns addressed?');
    parts.push('Same format: Score, Verdict, Remaining Weaknesses, Minimum Fixes.');
    parts.push('');
    parts.push('At the end of your review, write the Memory Update section — it will be passed back to you next round.');
  }
  return parts.join('\n');
}

/** Parse a reviewer response into the fields the loop and gate consume. */
export function parseReview(text) {
  const source = bounded(text, 'review text', 200000);
  // Accept both prose ("Score: 7") and JSON ({"score":"7/10"}), because a
  // reviewer agent may choose either shape for the same contract.
  let json = null;
  try {
    const candidate = /\{[\s\S]*\}/.exec(source)?.[0];
    if (candidate) json = JSON.parse(candidate);
  } catch { /* prose fallback */ }

  const toScore = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const match = /(\d+(?:\.\d+)?)/.exec(String(value ?? ''));
    return match ? Number(match[1]) : null;
  };

  const scoreMatch = /(?:^|\n)\s*Score\s*[:：]\s*(\d+(?:\.\d+)?)(?:\s*\/\s*10)?/i.exec(source);
  const verdictMatch = /(?:^|\n)\s*Verdict\s*[:：]\s*([A-Za-z_-]+)/i.exec(source);
  const weaknesses = json?.weaknesses ?? json?.remainingWeaknesses ?? section(source, 'Remaining Weaknesses');
  const fixes = json?.fixes ?? json?.minimumFixes ?? section(source, 'Minimum Fixes');
  const memory = json?.memory ?? json?.memoryUpdate ?? section(source, 'Memory Update');
  const score = json?.score !== undefined ? toScore(json.score) : (scoreMatch ? Number(scoreMatch[1]) : null);
  const verdict = String(json?.verdict ?? verdictMatch?.[1] ?? '').toLowerCase() || null;
  return {
    score,
    verdict,
    weaknesses,
    fixes,
    memory,
    valid: score !== null && Number.isFinite(score) && score >= 0 && score <= 10 && ['ready', 'almost', 'not_ready'].includes(verdict),
  };
}

function section(text, title) {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${title}\\s*[:：]?\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{1,6}\\s*)?(?:Score|Verdict|Remaining Weaknesses|Minimum Fixes|Memory Update)\\s*[:：]?\\s*(?:\\n|$)|$)`, 'i');
  const match = pattern.exec(text);
  return match ? match[1].trim() : '';
}

/**
 * Persist one round. The trace records the observed model and the digest of
 * the inputs, so a later gate can verify identity and that the memory chain is
 * unbroken.
 */
export function recordRound(cwd, stageDir, { round, observedModel, response, changedFiles = [], previousDigest }) {
  const parsed = parseReview(response);
  if (!parsed.valid) throw new Error('review response is missing a valid Score or Verdict');
  const dir = reviewDir(cwd, stageDir);
  fs.mkdirSync(path.join(dir, 'traces'), { recursive: true, mode: 0o700 });
  const digest = sha256({ round, observedModel, response });
  const trace = {
    schema: 'pi-research-loop.review-trace.v1',
    round,
    observedModel: observedModel ?? null,
    identityObserved: typeof observedModel === 'string' && observedModel.length > 0,
    score: parsed.score,
    verdict: parsed.verdict,
    changedFiles,
    previousDigest: previousDigest ?? null,
    responseDigest: digest,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tracePath(cwd, stageDir, round), JSON.stringify(trace, null, 2) + '\n', { mode: 0o600 });

  const memory = [
    MEMORY_HEADER,
    `Round: ${round}`,
    `Reviewer model: ${observedModel ?? 'UNOBSERVED'}`,
    `Score: ${parsed.score}`,
    `Verdict: ${parsed.verdict}`,
    '',
    '## Remaining Weaknesses',
    parsed.weaknesses || '(none reported)',
    '',
    '## Minimum Fixes',
    parsed.fixes || '(none reported)',
    '',
    MEMORY_UPDATE_MARKER,
    parsed.memory || '(none reported)',
    '',
  ].join('\n');
  fs.writeFileSync(memoryPath(cwd, stageDir), memory, { mode: 0o600 });
  return { trace, memory, parsed, digest };
}

export function readMemory(cwd, stageDir) {
  const file = memoryPath(cwd, stageDir);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function readTrace(cwd, stageDir, round) {
  const file = tracePath(cwd, stageDir, round);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * Gate for the whole loop. Checks that every round has an observed model,
 * that reviewer and author differ, that response identities are distinct, and
 * that the memory chain is continuous.
 */
export function gateReview({ authorModel, maxRounds = 4 }) {
  return ({ cwd, stageDir }) => {
    const diagnostics = [];
    const traces = [];
    for (let round = 1; round <= maxRounds; round += 1) {
      const trace = readTrace(cwd, stageDir, round);
      if (!trace) break;
      traces.push(trace);
    }
    if (!traces.length) diagnostics.push('no completed review round');
    traces.forEach((trace) => {
      if (!trace.identityObserved) diagnostics.push(`round ${trace.round}: reviewer model was not observed`);
      if (authorModel && trace.observedModel === authorModel)
        diagnostics.push(`round ${trace.round}: reviewer and author are the same model`);
      if (!trace.previousDigest && trace.round > 1) diagnostics.push(`round ${trace.round}: memory chain is broken`);
    });
    const digests = new Set(traces.map((t) => t.responseDigest));
    if (digests.size !== traces.length) diagnostics.push('duplicate review response identity across rounds');
    const last = traces.at(-1);
    const converged = Boolean(last && last.score >= 6 && ['ready', 'almost'].includes(last.verdict));
    return {
      verdict: diagnostics.length ? 'blocked' : converged ? 'accepted' : 'provisional',
      rounds: traces.length,
      lastScore: last?.score ?? null,
      lastVerdict: last?.verdict ?? null,
      diagnostics,
      majorityIsNotProof: true,
      note: 'accepted here means the review loop converged under its own contract; it does not by itself authorize publication.',
    };
  };
}
