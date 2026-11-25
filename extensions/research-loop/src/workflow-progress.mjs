import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { appendEvent, rootDir, sha256 } from './ledger.mjs';

const STAGES = new Set(['1-idea', '2-experiment', '3-review', '4-summary', '5-writing']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set(['completed', 'failed', 'stopped', 'blocked']);
const STEP_STATES = new Set(['started', 'running', 'queued', 'completed', 'failed', 'blocked', 'paused', 'stopped', 'unknown']);
const READ_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const text = (value, max = 2048) => typeof value === 'string' && value.trim() ? value.replace(/\0/g, '').slice(0, max) : undefined;
const stage = value => STAGES.has(value) ? value : undefined;
function status(value) {
  const name = value === 'complete' || value === 'success' ? 'completed' : value === 'error' ? 'failed' : value === 'detached' ? 'paused' : value;
  return STEP_STATES.has(name) ? name : undefined;
}
function iso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function noSymlinks(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('workflow symlink path rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function validateRunIdentity(runId, asyncDir) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('invalid workflow runId');
  if (typeof asyncDir !== 'string' || !path.isAbsolute(asyncDir) || path.basename(asyncDir) !== runId) throw new Error('workflow asyncDir identity mismatch');
  noSymlinks(asyncDir);
  return { runId, asyncDir };
}
function readSmall(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workflow metadata must be a regular file');
  if (stat.size > MAX_JSON_BYTES) throw new Error('workflow metadata exceeds safe read size');
  return fs.readFileSync(file, 'utf8');
}
export function readEventsTolerant(file) {
  let content;
  try { content = readSmall(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return content.split('\n').filter(line => line.trim()).flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; }
    catch { return []; }
  });
}
export function normalizeEvidence(cwd, value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 1024 || /[\0\\]/.test(item) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item) || item.startsWith('~')) continue;
    const target = path.resolve(cwd, item);
    const relative = path.relative(cwd, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || item.split('/').includes('..')) continue;
    if (/(^|\/)(?:\.env(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$)|credentials?(?:\.|$)|tokens?(?:\.|$))/i.test(relative)) continue;
    try { noSymlinks(target); } catch { continue; }
    if (!result.includes(relative)) result.push(relative);
    if (result.length >= 20) break;
  }
  return result;
}

/** One RPC-confirmed run only; progress is append-only and never a scientific ledger update. */
export function createWorkflowObserver({ cwd, runId, asyncDir, parentSessionId, charterRevision, intervalMs = 1000 }) {
  const identity = validateRunIdentity(runId, asyncDir);
  cwd = fs.realpathSync(cwd);
  const researchEvents = path.join(rootDir(cwd), 'events.jsonl');
  const journalFile = path.join(identity.asyncDir, 'events.jsonl');
  const statusFile = path.join(identity.asyncDir, 'status.json');
  const seen = new Set();
  const steps = new Map();
  for (const event of readEventsTolerant(researchEvents)) {
    if (event.detail?.runId !== runId) continue;
    if (typeof event.detail.eventId === 'string') seen.add(event.detail.eventId);
    if (event.kind === 'run-step' && typeof event.detail.key === 'string') steps.set(event.detail.key, { ...event.detail });
  }
  let offset = 0, sequence = 0, inode, remainder = '', decoder = new StringDecoder('utf8');
  let timer, closed = false, terminal = false, lastError, snapshot, journalCompletion, businessOutcome;

  function append(kind, detail) {
    if (seen.has(detail.eventId)) return;
    appendEvent(cwd, kind, detail);
    seen.add(detail.eventId);
  }
  function enter(phase, key, context) {
    if (!phase || !key) return;
    append('stage-enter', {
      runId, key, stage: phase, source: 'workflow', ...context,
      ...(charterRevision !== undefined ? { charterRevision } : {}),
      eventId: `stage-enter:${runId}:${phase}`,
    });
  }
  function updateStep(patch, context = {}) {
    const key = text(patch.key, 200);
    const nextStatus = status(patch.status);
    if (!key || !nextStatus) return;
    const previous = steps.get(key) ?? {};
    const next = { ...previous, runId, key };
    delete next.eventId;
    delete next.sourceAt;
    delete next.sourceSeq;
    next.status = TERMINAL.has(previous.status) && !TERMINAL.has(nextStatus) ? previous.status : nextStatus;
    for (const field of ['agent', 'label', 'observedModel', 'summary']) {
      const value = text(patch[field], field === 'summary' ? 2048 : 200);
      if (value) next[field] = value;
    }
    const phase = stage(patch.stage ?? patch.phase) ?? previous.stage;
    if (phase) next.stage = phase;
    if (typeof patch.childRunId === 'string' && RUN_ID.test(patch.childRunId)) next.childRunId = patch.childRunId;
    const business = status(patch.businessStatus);
    if (business) next.businessStatus = business;
    if (patch.evidence !== undefined) next.evidence = normalizeEvidence(cwd, patch.evidence);
    const startTime = iso(patch.startedAt) ?? (!previous.startedAt && ['started', 'running'].includes(nextStatus) ? context.sourceAt : undefined);
    const endTime = iso(patch.endedAt) ?? (!previous.endedAt && TERMINAL.has(nextStatus) ? context.sourceAt : undefined);
    if (startTime) next.startedAt = startTime;
    if (endTime) next.endedAt = endTime;
    const eventId = `run-step:${runId}:${key}:${sha256(next)}`;
    steps.set(key, next);
    append('run-step', { ...next, ...context, eventId });
    if (phase && nextStatus !== 'queued' && nextStatus !== 'unknown') enter(phase, key, context);
  }
  function emit(value, context = {}) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'workflow-result') {
      businessOutcome = { outcome: text(value.outcome, 200), reason: text(value.reason) };
    } else if (value.type === 'step-result') {
      updateStep({ ...value, status: value.executionStatus ?? value.businessStatus, stage: value.phase }, context);
    }
  }
  function trace(entries, context) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || entry.operation !== 'run') continue;
      updateStep({
        ...entry, status: entry.state === 'reused' ? 'unknown' : entry.state,
        stage: entry.phase, childRunId: entry.runId,
        ...(entry.error ? { summary: entry.error } : {}),
      }, context);
    }
  }
  function readStatus() {
    let value;
    try { value = JSON.parse(readSmall(statusFile)); }
    catch (error) { if (error.code !== 'ENOENT') lastError = `status temporarily unreadable: ${error.message}`; return null; }
    if (!value || value.runId !== runId || value.mode !== 'workflow'
      || typeof value.cwd !== 'string' || path.resolve(value.cwd) !== cwd
      || (parentSessionId && value.sessionId !== parentSessionId)) {
      lastError = 'workflow identity/owner/cwd mismatch';
      stop();
      return null;
    }
    snapshot = value;
    return value;
  }
  function readJournal() {
    let stat;
    try {
      stat = fs.lstatSync(journalFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workflow journal must be a regular file');
    } catch (error) { if (error.code !== 'ENOENT') lastError = error.message; return { records: [], more: false }; }
    if (inode !== stat.ino || stat.size < offset) {
      offset = 0; sequence = 0; remainder = ''; decoder = new StringDecoder('utf8');
    }
    inode = stat.ino;
    const bytes = Math.min(stat.size - offset, READ_BYTES);
    if (bytes <= 0) return { records: [], more: false };
    const buffer = Buffer.alloc(bytes);
    const fd = fs.openSync(journalFile, 'r');
    let read;
    try { read = fs.readSync(fd, buffer, 0, bytes, offset); } finally { fs.closeSync(fd); }
    offset += read;
    const lines = (remainder + decoder.write(buffer.subarray(0, read))).split('\n');
    remainder = lines.pop() ?? '';
    if (Buffer.byteLength(remainder) > MAX_JSON_BYTES) throw new Error('workflow journal line exceeds safe read size');
    const records = [];
    for (const line of lines) {
      sequence += 1;
      if (!line.trim()) continue;
      try { records.push({ value: JSON.parse(line), sourceSeq: sequence }); }
      catch { lastError = 'malformed workflow journal line skipped; status reconciliation retained'; }
    }
    return { records, more: offset < stat.size };
  }
  function reconcile(value) {
    if (!value) return;
    for (const step of Array.isArray(value.steps) ? value.steps : []) {
      if (step.parentWorkflowRunId && step.parentWorkflowRunId !== runId) continue;
      const startedAt = iso(step.startedAt);
      const endedAt = iso(step.endedAt) ?? (TERMINAL.has(status(step.status)) && startedAt && Number.isFinite(step.durationMs) ? iso(Date.parse(startedAt) + step.durationMs) : undefined);
      updateStep({ ...step, key: step.workflowKey, stage: step.phase, childRunId: step.runId, startedAt, endedAt, ...(step.error ? { summary: step.error } : {}) });
    }
    // Status retains the whole emit list, including summaries missed during disconnection.
    for (const emitted of Array.isArray(value.workflow?.emits) ? value.workflow.emits : []) emit(emitted);
  }
  function pollOnce() {
    if (closed) return { closed: true, appended: 0 };
    const before = seen.size;
    try {
      const current = readStatus();
      if (closed || (!current && !snapshot)) return { closed, appended: 0, ...(lastError ? { error: lastError } : {}) };
      const { records, more } = readJournal();
      for (const { value, sourceSeq } of records) {
        if (!value || value.runId !== runId) continue;
        const context = { sourceSeq, ...(iso(value.ts) ? { sourceAt: iso(value.ts) } : {}) };
        if (value.type === 'subagent.workflow.trace') trace(value.trace, context);
        else if (value.type === 'subagent.workflow.child_settled') updateStep({ key: value.childKey, childRunId: value.childRunId, status: value.outcome }, context);
        else if (value.type === 'subagent.child-status') updateStep({ ...value, key: value.workflowKey ?? value.childId, stage: value.phase }, context);
        else if (value.type === 'subagent.workflow.emit') emit(value.value, context);
        else if (value.type === 'subagent.workflow.completed') journalCompletion = { ...value, ...context };
      }
      reconcile(current);
      const execution = status(journalCompletion?.state ?? snapshot.state);
      if (!more && execution && TERMINAL.has(execution)) {
        const returned = snapshot.workflow?.value;
        const outcome = businessOutcome?.outcome ?? text(returned?.status, 200);
        const reason = businessOutcome?.reason ?? text(returned?.reason) ?? (execution === 'failed' ? text(journalCompletion?.error ?? snapshot.error) : undefined);
        const detail = {
          runId, status: execution,
          ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}),
          ...(journalCompletion?.sourceSeq !== undefined ? { sourceSeq: journalCompletion.sourceSeq } : {}),
          ...(iso(snapshot.endedAt) ?? journalCompletion?.sourceAt ? { sourceAt: iso(snapshot.endedAt) ?? journalCompletion.sourceAt } : {}),
        };
        append('run-outcome', { ...detail, eventId: `run-outcome:${runId}:${sha256(detail)}` });
        terminal = true;
        stop();
      }
    } catch (error) { lastError = error.message; }
    return { closed, appended: seen.size - before, ...(lastError ? { error: lastError } : {}) };
  }
  function start() {
    if (closed || timer) return;
    pollOnce();
    if (!closed) { timer = setInterval(pollOnce, Math.max(Number(intervalMs) || 1000, 100)); timer.unref?.(); }
  }
  function stop() { closed = true; if (timer) clearInterval(timer); timer = undefined; }
  return { runId, start, stop, pollOnce, verify: () => readStatus() !== null, isClosed: () => closed, isTerminal: () => terminal, getLastError: () => lastError };
}
