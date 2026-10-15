import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { POLICY_VERSION, normalizePolicy, groundedRestrictions, validReview, activeRestrictions, validateLocalOperation, observationTool, sameReview } from './policy.mjs';

// Release builds never bind an author's provider/account. Set an exact authenticated ref locally.
export const MODEL = process.env.PI_RESEARCH_SUPERVISOR_MODEL?.trim() || '';
const TYPES = new Set(['plan', 'tool_call', 'tool_result', 'stage_result']);
const OBSERVATION_TOOLS = /^(?:read|grep|find|ls|bg_status|bg_logs|lens_diagnostics|project_report|module_report|symbol_search|read_symbol|read_enclosing|effective_config)$/i;
const REVIEW_NOTES = /^(?:research\/tasks\/[A-Za-z0-9._-]+\/(?:REVIEW_FINDINGS|SUPERVISION_SCOPE)|research\/mainline-supervision\/(?:REVIEW_INDEX|CORRECTIONS|SESSION_LOG))\.(?:md|json)$/i;
const VERDICTS = new Set(['ON_TRACK', 'DRIFT_RISK', 'OFF_TRACK', 'INSUFFICIENT_CONTEXT']);
const MAX_CORE = 32 * 1024;
const MAX_EXCERPT = 8 * 1024;
// Per segment and per unreviewed review window, never a lifetime storage cap.
const MAX_EVENTS = 2000;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const EVENT_FILE = /^[a-f0-9]{32}(?:\.[0-9]{6})?\.jsonl$/;
const MAX_LOCAL_FILE = 8 * 1024 * 1024;
export const CHECKPOINT_KINDS = ['plan_change', 'scope_change', 'stage_complete', 'drift_signal'];
const checkpointCadence = () => ({ version: 1, mode: 'stage-checkpoints', sequence: 0, attemptedSequence: 0, checkpoints: [] });
function normalizeCadence(s) {
  if (s.reviewCadence === undefined) s.reviewCadence = { ...checkpointCadence(), migratedAtRevision: s.revision,
    migrationMeaning: 'Keep evidence/history; do not replay old material as automatic checkpoints' };
  const c = s.reviewCadence;
  if (c.version !== 1 || c.mode !== 'stage-checkpoints' || !Number.isInteger(c.sequence) || !Number.isInteger(c.attemptedSequence) ||
      c.attemptedSequence < 0 || c.attemptedSequence > c.sequence || !Array.isArray(c.checkpoints) ||
      c.checkpoints.some((p, i) => !Number.isInteger(p.sequence) || p.sequence <= (c.checkpoints[i - 1]?.sequence ?? 0) || p.sequence > c.sequence))
    throw new Error('Malformed checkpoint cadence; no automatic dispatch');
  return s;
}
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const secret = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*["']?\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;
const sensitive = /^(?:\.git|\.ssh|\.aws|\.config|\.pi|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|private|secrets?|credentials?|auth|models?|settings?|raw|trajectories?|sessions?)(?:\..*)?$|^\.env(?:\..*)?$|(?:credentials?|secrets?|auth|models?|settings?)[._-]|(?:^|[._-])(?:private|raw|trajectories?|tokens?)(?:[._-]|$)|\.(?:pem|key|p12|pfx)$/i;
const pidIdentity = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; }
};
const owner = () => ({ pid: process.pid, identity: pidIdentity(process.pid) });
const isAlive = (claim) => {
  if (!claim || !Number.isInteger(claim.pid)) return false;
  try { process.kill(claim.pid, 0); } catch (e) { return e.code === 'EPERM'; }
  const identity = pidIdentity(claim.pid);
  return !identity || !claim.identity || identity === claim.identity;
};
function safeText(value, cap = MAX_EXCERPT) {
  if (typeof value !== 'string') return { omitted: 'not-text' };
  if (secret.test(value)) return { omitted: 'secret-marker', digest: hash(value) };
  return { text: value.slice(0, cap), truncated: value.length > cap, digest: hash(value) };
}
function parseJSON(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`Malformed ${label}; supervision evidence is not verified`); }
}
function token(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || secret.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export class MainlineStore {
  constructor(cwd, options = {}) {
    this.cwd = fs.realpathSync(cwd);
    this.root = path.join(this.cwd, '.pi/mainline-supervision');
    this.clock = options.clock || Date.now;
    this.meminfo = options.meminfo;
    this.ensureDir(this.root);
  }

  // Every internal and approved path is checked component-by-component: no symlink traversal.
  contained(target) {
    const rel = path.relative(this.cwd, target);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('Path outside project');
    let current = this.cwd;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink path rejected'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return target;
  }

  ensureDir(dir) {
    this.contained(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (dir === this.root || dir.startsWith(this.root + path.sep)) fs.chmodSync(dir, 0o700);
  }

  readLocal(file) {
    this.contained(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_LOCAL_FILE) throw new Error('Unsafe or oversized local file');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  }

  writeLocal(file, text) {
    this.contained(file);
    this.ensureDir(path.dirname(file));
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }

  append(file, entry) {
    this.contained(file);
    this.ensureDir(path.dirname(file));
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('Not a regular journal');
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  defaultState() {
    return { version: 1, enabled: false, authorized: false, model: MODEL, coreRevision: 0,
      revision: 0, reviewedRevision: 0, blocked: false, pendingChanges: false,
      reviewActivity: { state: 'standby' }, authorizationScope: [], coreText: '',
      eventCount: 0, eventBytes: 0, omittedEvents: 0, lastEventDigest: {},
      materialRevision: 0, reviewedMaterialRevision: 0, lastAttemptMaterialRevision: 0,
      materialFileDigests: {}, captureReceipts: [], eventJournalVersion: 1, eventJournalFiles: {}, eventSourceGaps: [],
      policyVersion: POLICY_VERSION, branchRestrictions: [], operationGrants: [], publicationPending: true,
      reviewHealth: { status: 'UNREVIEWED', reason: 'No review yet' }, lastScience: { status: 'NOT_ASSESSED', limitations: [] },
      reviewCadence: checkpointCadence() };
  }

  load() {
    const file = path.join(this.root, 'state.json');
    if (!fs.existsSync(file)) return this.defaultState();
    const state = parseJSON(this.readLocal(file), 'supervision state');
    if (state.version !== 1 || state.model !== MODEL || !Number.isInteger(state.revision)) throw new Error('Invalid supervision state');
    if (state.eventJournalVersion === undefined) {
      // Bind existing source bytes once, checking the original counters first. No file is
      // rewritten, moved or deleted; lost legacy events cannot be recreated by migration.
      state.eventJournalFiles = this.readEventJournal(state).files;
      state.eventJournalVersion = 1;
    }
    if (state.eventJournalVersion !== 1 || !state.eventJournalFiles || Array.isArray(state.eventJournalFiles) ||
        typeof state.eventJournalFiles !== 'object') throw new Error('Unverified event journal binding');
    state.eventSourceGaps ??= [];
    if (!Array.isArray(state.eventSourceGaps)) throw new Error('Malformed event source gaps');
    if (state.omittedEvents || state.captureLimitReached) {
      if (!state.eventSourceGaps.some(g => g.kind === 'unpersisted-source-events')) state.eventSourceGaps.push({
        kind: 'unpersisted-source-events', count: state.omittedEvents ?? 0, throughRevision: state.revision,
        status: 'UNVERIFIED', executionProof: false,
        disposition: 'Historical evidence blind spot retained; no retrospective permission, execution proof or scientific acceptance may rely on these events' });
      state.blocked = true;
    }
    // Recover an unreviewed v1 tail rather than discarding it at lastAttemptRevision.
    // Known observation/declaration events are audit-only; missing or ambiguous evidence
    // stays pending/blocked. Reviewed revisions and old failures are never rewritten.
    if (state.materialRevision === undefined) {
      const boundary = Math.max(state.lastAttemptRevision ?? 0, state.reviewedRevision ?? 0);
      let material = boundary;
      if (state.revision > boundary) {
        try {
          const known = new Set();
          for (const event of this.readEventJournal(state).events.filter(e => e.revision > boundary)) {
            known.add(event.revision);
            if (event.material === true || (event.material === undefined &&
                !OBSERVATION_TOOLS.test(event.toolName ?? '') && event.type !== 'stage_result' &&
                !(event.path && REVIEW_NOTES.test(event.path) && event.status !== 'error')))
              material = Math.max(material, event.revision);
          }
          const journal = path.join(this.root, 'corrections.jsonl');
          if (fs.existsSync(journal)) for (const line of this.readLocal(journal).trim().split('\n').filter(Boolean)) {
            const correction = parseJSON(line, 'legacy correction journal');
            if (correction.revision > boundary && correction.revision <= state.revision && correction.executionProof === false)
              known.add(correction.revision);
          }
          if (known.size !== state.revision - boundary) {
            material = state.revision;
            state.migrationUnverifiedTail = { afterRevision: boundary, throughRevision: state.revision };
          }
        } catch {
          material = state.revision;
          state.migrationUnverifiedTail = { afterRevision: boundary, throughRevision: state.revision };
        }
      }
      state.materialRevision = material;
      if (material > boundary) state.blocked = true;
    }
    state.reviewedMaterialRevision ??= state.reviewedRevision ?? 0;
    state.lastAttemptMaterialRevision ??= state.lastAttemptRevision ?? 0;
    state.pendingChanges = state.materialRevision > state.reviewedMaterialRevision;
    state.materialFileDigests ??= {};
    state.captureReceipts ??= [];
    return normalizeCadence(normalizePolicy(state));
  }

  save(state) {
    normalizeCadence(normalizePolicy(state));
    state.pendingChanges = state.materialRevision > state.reviewedMaterialRevision;
    this.writeLocal(path.join(this.root, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  }

  mutate(fn) {
    const lock = path.join(this.root, 'state.lock');
    this.contained(lock);
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw new Error('State lock busy or interrupted; no automatic lock reclamation');
    }
    try {
      this.writeLocal(path.join(lock, 'owner.json'), JSON.stringify(owner()));
      const state = this.load();
      const result = fn(state);
      this.save(state);
      return result;
    } finally {
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock);
    }
  }

  getState() {
    const state = this.load();
    if (state.reviewActivity.state === 'reviewing' && !isAlive(state.reviewActivity.owner)) {
      return this.mutate((s) => {
        s.reviewActivity.state = 'unverified';
        s.reviewActivity.reason = 'Owner exited; exact terminal evidence required';
        s.reviewHealth = { status: 'UNREVIEWED', kind: 'owner-exited', reason: s.reviewActivity.reason };
        return structuredClone(s);
      });
    }
    return state;
  }

  scopePath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || secret.test(value) || path.isAbsolute(value)) throw new Error('Invalid approved path');
    const directory = value.endsWith('/');
    const parts = (directory ? value.slice(0, -1) : value).split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || sensitive.test(p))) throw new Error('Sensitive or non-canonical path');
    this.contained(path.join(this.cwd, ...parts));
    return parts.join('/') + (directory ? '/' : '');
  }

  configure({ coreText, approvedPaths = [], authorized = false, model = MODEL }) {
    if (model !== MODEL) throw new Error('Supervisor model is fixed');
    if (!MODEL || !/^[^\s/]+\/[^\s]+$/.test(MODEL)) throw new Error('Set PI_RESEARCH_SUPERVISOR_MODEL to an exact authenticated provider/model[:thinking] before configuring supervision');
    if (typeof coreText !== 'string' || !coreText.trim() || coreText.length > MAX_CORE || secret.test(coreText)) throw new Error('Core must be nonempty, bounded and free of secret markers');
    if (!Array.isArray(approvedPaths) || approvedPaths.length > 256) throw new Error('Invalid approvedPaths');
    const scope = [...new Set(approvedPaths.map((p) => this.scopePath(p)))].sort();
    return this.mutate((s) => {
      const coreChanged = s.coreText !== coreText;
      const changed = coreChanged || JSON.stringify(s.authorizationScope) !== JSON.stringify(scope);
      if (changed) { s.coreRevision++; s.materialRevision = ++s.revision; }
      if (changed || authorized !== true) { s.correctionPaths = []; delete s.correctionCoreRevision; s.operationGrants = []; }
      // Historical restrictions remain recorded. Core changes require an explicit new scoped judgment, not a global freeze.
      s.coreText = coreText;
      s.authorizationScope = scope;
      s.authorized = authorized === true;
      s.enabled = true;
      s.pendingChanges = s.materialRevision > s.reviewedMaterialRevision;
      if (coreChanged) this.addCheckpoint(s, { stageId: `frozen-core-${s.coreRevision}`, kind: 'plan_change', source: 'confirmed-core-config' });
      return structuredClone(s);
    });
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    return this.mutate((s) => { s.enabled = enabled; return structuredClone(s); });
  }

  approved(value, s) {
    try {
      const relative = this.scopePath(value);
      if (relative.endsWith('/')) return null;
      return s.authorizationScope.some((p) => p.endsWith('/') ? relative.startsWith(p) : relative === p) ? relative : null;
    } catch { return null; }
  }

  withheldCapturePaths(s) {
    return new Set((s.captureReceipts ?? []).filter(r => !r.outputs.every(p => this.approved(p, s))).flatMap(r => r.outputs));
  }

  snapshot(relative) {
    try {
      const absolute = this.contained(path.join(this.cwd, relative));
      const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_EXCERPT) return { path: relative, omitted: 'non-regular-or-oversized-artifact', size: st.size };
        const text = fs.readFileSync(fd, 'utf8');
        if (text.includes('\0')) return { path: relative, omitted: 'binary-artifact' };
        return { path: relative, size: st.size, ...safeText(text) };
      } finally { fs.closeSync(fd); }
    } catch { return { path: relative, omitted: 'missing-or-unsafe-artifact' }; }
  }

  fileDigest(relative) {
    try { return hash(this.readLocal(this.contained(path.join(this.cwd, relative)))); }
    catch { return null; }
  }

  pendingCheckpoints(s) {
    return s.reviewCadence.checkpoints.filter(p => p.sequence > s.reviewCadence.attemptedSequence && p.coreDigest === hash(s.coreText));
  }

  addCheckpoint(s, { stageId, kind, source = 'parent-research-checkpoint' }) {
    if (typeof stageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(stageId) || !CHECKPOINT_KINDS.includes(kind))
      throw new Error('Checkpoint needs a stable conceptual stageId and a research decision kind');
    const coreDigest = hash(s.coreText), key = hash({ coreDigest, stageId, kind });
    const prior = s.reviewCadence.checkpoints.find(p => p.key === key);
    if (prior) return { changed: false, reason: 'stage-checkpoint-already-recorded', sequence: prior.sequence };
    if (s.reviewCadence.checkpoints.length >= 1024) throw new Error('Checkpoint history capacity reached; no unbounded automatic calls');
    const checkpoint = { key, stageId, kind, source, coreDigest, sequence: ++s.reviewCadence.sequence,
      revision: s.revision, materialRevision: s.materialRevision };
    s.reviewCadence.checkpoints.push(checkpoint);
    return { changed: true, checkpoint };
  }

  recordCheckpoint({ stageId, kind }) {
    return this.mutate(s => {
      if (!s.enabled || !s.coreRevision) throw new Error('Enabled frozen core required for a research checkpoint');
      if (s.materialRevision <= Math.max(s.reviewedMaterialRevision, s.lastAttemptMaterialRevision))
        return { changed: false, reason: 'no-new-material-evidence' };
      return this.addCheckpoint(s, { stageId, kind });
    });
  }

  requestHumanCheck() {
    return this.mutate(s => {
      if (!s.enabled || !s.coreRevision || s.materialRevision <= Math.max(s.reviewedMaterialRevision, s.lastAttemptMaterialRevision))
        return { changed: false, reason: 'no-new-material-evidence' };
      return this.addCheckpoint(s, { stageId: `human-check-${s.materialRevision}`, kind: 'stage_complete', source: 'direct-human-command' });
    });
  }

  reviewEligibility({ automatic = false } = {}) {
    const s = this.getState();
    if (s.materialRevision <= Math.max(s.reviewedMaterialRevision, s.lastAttemptMaterialRevision))
      return { ok: false, reason: 'no-new-material-evidence', materialRevision: s.materialRevision };
    if (automatic && !this.pendingCheckpoints(s).length)
      return { ok: false, reason: 'evidence-accumulating-until-research-checkpoint', materialRevision: s.materialRevision };
    return { ok: true, materialRevision: s.materialRevision, checkpoints: this.pendingCheckpoints(s) };
  }

  record(event) {
    if (!event || Object.getPrototypeOf(event) !== Object.prototype || !TYPES.has(event.type)) return { changed: false, revision: this.load().revision };
    const tool = typeof event.toolName === 'string' ? event.toolName : '';
    if (/mainline[_-]supervision|contact_supervisor/i.test(tool) || /research-mainline-supervisor/i.test(event.sessionId || '') ||
        (/(?:subagent|spawn)/i.test(tool) && !event.input?.action && event.input?.agent === 'research-mainline-supervisor') ||
        /^Subagent updates above\./.test(event.text || '')) return { changed: false, revision: this.load().revision };
    if (tool === 'subagent' && ['status', 'debug.run', 'children.list', 'guide', 'list', 'models'].includes(event.input?.action))
      return { changed: false, revision: this.load().revision, materialChanged: false };
    token(event.sessionId, 'sessionId');
    const observedPath = event.input?.path ?? event.input?.file_path ?? event.input?.filePath;
    if (typeof observedPath === 'string') {
      const relative = path.isAbsolute(observedPath) ? path.relative(this.cwd, observedPath) : observedPath;
      if (relative === '.pi/mainline-supervision' || relative.startsWith('.pi/mainline-supervision/')) return { changed: false, revision: this.load().revision };
    }
    return this.mutate((s) => {
      if (!s.enabled || !s.coreRevision) return { changed: false, revision: s.revision };
      const input = event.input && typeof event.input === 'object' ? event.input : {};
      const rawPath = input.path ?? input.file_path ?? input.filePath;
      // Absolute tool paths are accepted only after conversion to an in-project canonical relative path.
      let candidate = rawPath;
      if (typeof rawPath === 'string' && path.isAbsolute(rawPath)) candidate = path.relative(this.cwd, rawPath);
      const approvedRelative = this.approved(candidate, s);
      const relative = this.withheldCapturePaths(s).has(approvedRelative) ? null : approvedRelative;
      // Unapproved observation/control reads contribute no reviewable content and must not
      // manufacture a new review. Approved reads still retain excerpts for the evidence ledger.
      if (!relative && observationTool(tool, input)) return { changed: false, revision: s.revision, materialChanged: false };
      const entry = { type: event.type, sessionId: event.sessionId,
        toolName: safeText(tool, 128).text || '[withheld]',
        toolCallId: typeof event.toolCallId === 'string' && !secret.test(event.toolCallId) ? event.toolCallId.slice(0, 256) : undefined,
        status: event.isError ? 'error' : 'observed', gateDenied: event.gateDenied === true, source: 'runtime-event',
        sourceDigest: hash(event), coverage: [], omissions: [] };
      if (relative && /^(?:read|write|edit)$/i.test(tool)) {
        entry.path = relative;
        entry.input = {};
        for (const key of ['content', 'oldText', 'newText', 'text']) {
          if (typeof input[key] === 'string') entry.input[key] = safeText(input[key]);
        }
        if (Array.isArray(input.edits)) entry.input.edits = input.edits.slice(0, 16).map((edit) => ({ oldText: safeText(edit?.oldText), newText: safeText(edit?.newText) }));
        if (input.edits?.length > 16) entry.omissions.push('additional-edits-withheld');
        const result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result ?? null);
        entry.result = safeText(result);
        entry.artifact = this.snapshot(relative);
        entry.coverage.push('approved-file-event-excerpt', 'event-time-artifact-snapshot');
      } else {
        entry.omissions.push('content-withheld: no explicitly approved file operation');
        entry.coverage.push('metadata-and-digest-only');
      }
      // The dedupe fingerprint includes source identity/content, but not caller timestamps.
      const fingerprint = hash({ ...entry, sourceDigest: hash({ ...event, timestamp: undefined }) });
      const sessionKey = hash(event.sessionId).slice(0, 32);
      if (s.lastEventDigest[sessionKey] === fingerprint) return { changed: false, revision: s.revision };
      s.lastEventDigest[sessionKey] = fingerprint;
      if (Object.keys(s.lastEventDigest).length > 128) delete s.lastEventDigest[Object.keys(s.lastEventDigest)[0]];
      const digest = relative ? this.fileDigest(relative) : null;
      let materialChanged = false;
      if (relative && event.type === 'tool_call' && /^(?:write|edit)$/i.test(tool) && !(relative in s.materialFileDigests))
        s.materialFileDigests[relative] = digest;
      if (relative && event.type === 'tool_result' && /^(?:write|edit)$/i.test(tool)) {
        materialChanged = !event.gateDenied && (event.isError === true || digest !== s.materialFileDigests[relative] || !digest);
        s.materialFileDigests[relative] = digest;
        // These exact bookkeeping names are audit-only. A new research plan or source edit
        // elsewhere remains material, even when performed during a completion wake.
        if (REVIEW_NOTES.test(relative) && !event.isError) materialChanged = false;
      } else if (event.type === 'tool_result' && !observationTool(tool, input) &&
                 !['plan', 'stage_result'].includes(event.type) && !event.gateDenied)
        materialChanged = true; // Even a failed execution can have partial effects.
      entry.material = materialChanged;
      entry.revision = ++s.revision;
      if (materialChanged) s.materialRevision = entry.revision;
      entry.timestamp = this.clock();
      this.appendEvent(s, sessionKey, entry);
      return { changed: true, revision: s.revision, materialChanged };
    });
  }

  eventFiles() {
    const dir = this.contained(path.join(this.root, 'events'));
    if (!fs.existsSync(dir)) return [];
    const names = fs.readdirSync(dir).sort();
    if (names.some(f => !EVENT_FILE.test(f))) throw new Error('Unknown event journal segment');
    return names;
  }

  eventFile(name, state) {
    if (!EVENT_FILE.test(name)) throw new Error('Invalid event journal segment');
    const text = this.readLocal(path.join(this.root, 'events', name));
    if (!text.endsWith('\n') || !text.trim()) throw new Error('Incomplete event journal segment');
    const events = text.slice(0, -1).split('\n').map(line => parseJSON(line, 'event journal'));
    let previous = 0;
    for (const e of events) {
      if (!e || !TYPES.has(e.type) || typeof e.sessionId !== 'string' ||
          hash(e.sessionId).slice(0, 32) !== name.slice(0, 32) || !Number.isInteger(e.revision) ||
          e.revision <= previous || e.revision > state.revision) throw new Error('Unverified event journal source order/identity');
      previous = e.revision;
    }
    const binding = { bytes: Buffer.byteLength(text), count: events.length, sha256: hash(text),
      firstRevision: events[0].revision, lastRevision: events.at(-1).revision };
    if (state.eventJournalVersion === 1 && JSON.stringify(binding) !== JSON.stringify(state.eventJournalFiles[name]))
      throw new Error('Event journal segment missing, changed or uncommitted');
    return { events, binding };
  }

  readEventJournal(state) {
    const names = this.eventFiles();
    if (state.eventJournalVersion === 1 && JSON.stringify(names) !== JSON.stringify(Object.keys(state.eventJournalFiles).sort()))
      throw new Error('Missing or uncommitted event journal segment');
    const files = {}, events = [];
    let bytes = 0;
    for (const name of names) {
      const file = this.eventFile(name, state); files[name] = file.binding;
      bytes += file.binding.bytes; events.push(...file.events);
    }
    events.sort((a, b) => a.revision - b.revision);
    if (events.some((e, i) => i > 0 && events[i - 1].revision === e.revision) ||
        events.length !== (state.eventCount ?? 0) || bytes !== (state.eventBytes ?? 0))
      throw new Error('Event journal source counters/order mismatch');
    return { events, files, bytes };
  }

  appendEvent(state, sessionKey, entry) {
    const text = JSON.stringify(entry) + '\n', bytes = Buffer.byteLength(text);
    if (bytes > MAX_EVENT_BYTES) throw new Error('Single source event exceeds segment budget');
    const names = this.eventFiles();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(state.eventJournalFiles).sort()))
      throw new Error('Missing or uncommitted event journal segment');
    // Legacy session.jsonl is always sealed. Only the last numbered segment may grow.
    const segments = names.filter(f => f.startsWith(sessionKey + '.') && f !== sessionKey + '.jsonl');
    let name = segments.at(-1), old = name ? this.eventFile(name, state).binding : undefined;
    if (!name || old.count >= MAX_EVENTS || old.bytes + bytes > MAX_EVENT_BYTES) {
      const number = name ? Number(name.split('.')[1]) + 1 : 1;
      if (number > 999999) throw new Error('Event journal segment identity exhausted');
      name = `${sessionKey}.${String(number).padStart(6, '0')}.jsonl`; old = undefined;
    }
    const file = path.join(this.root, 'events', name);
    this.append(file, entry);
    // The append is synced before the state commit. A crash between them is an orphan
    // append, detected on reopen; it is never silently incorporated or rolled back.
    const full = this.readLocal(file);
    state.eventJournalFiles[name] = { bytes: (old?.bytes ?? 0) + bytes, count: (old?.count ?? 0) + 1,
      sha256: hash(full), firstRevision: old?.firstRevision ?? entry.revision, lastRevision: entry.revision };
    if (Buffer.byteLength(full) !== state.eventJournalFiles[name].bytes) throw new Error('Event append byte mismatch');
    state.eventCount++; state.eventBytes += bytes;
  }

  eventsThrough(revision) {
    return this.readEventJournal(this.load()).events.filter(e => e.revision <= revision);
  }

  sourceGaps(state) {
    return [...state.eventSourceGaps, ...(state.migrationUnverifiedTail ? [{ kind: 'unverified-legacy-tail',
      ...state.migrationUnverifiedTail, status: 'UNVERIFIED', executionProof: false,
      disposition: 'Historical evidence blind spot retained; current direction review cannot resolve missing historical evidence or authorize claims about it' }] : [])];
  }

  beginReview({ sessionId, requestId, automatic = false }) {
    token(sessionId, 'sessionId'); token(requestId, 'requestId');
    return this.mutate((s) => {
      if (!s.enabled) return { ok: false, reason: 'disabled' };
      if (!s.authorized) return { ok: false, reason: 'unauthorized' };
      if (s.captureFailure) return { ok: false, reason: 'source-capture-failed' };
      const lock = path.join(this.root, 'review.lock');
      this.contained(lock);
      if (s.reviewActivity.requestId || fs.existsSync(lock)) return { ok: false, reason: 'active-or-unverified-review' };
      if (s.materialRevision <= Math.max(s.reviewedMaterialRevision, s.lastAttemptMaterialRevision))
        return { ok: false, reason: 'no-new-evidence', detail: 'no-new-material-evidence' };
      const checkpoints = this.pendingCheckpoints(s);
      if (automatic && !checkpoints.length) return { ok: false, reason: 'no-research-checkpoint' };
      let journal;
      try { journal = this.readEventJournal(s); }
      catch {
        s.captureFailure = true;
        s.reviewHealth = { status: 'BLIND_SPOT', kind: 'source-journal', reason: 'Source event journal unverified; no review dispatch or claims based on missing sources' };
        s.reviewActivity.reason = s.reviewHealth.reason;
        return { ok: false, reason: 'source-event-journal-unverified' };
      }
      const events = journal.events.filter(e => e.revision > s.reviewedRevision && e.revision <= s.revision);
      const eventBytes = events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e) + '\n'), 0);
      const eventWindow = { afterRevision: s.reviewedRevision, throughRevision: s.revision, eventCount: events.length,
        eventBytes, totalStoredEvents: journal.events.length, totalStoredBytes: journal.bytes,
        olderEventsNotReReviewed: journal.events.length - events.length,
        coverage: 'Complete unreviewed window; older events retained locally, not re-reviewed here; not a whole-history clean claim' };
      if (events.length > MAX_EVENTS || eventBytes > MAX_EVENT_BYTES) {
        s.reviewWindowLimit = eventWindow;
        s.reviewHealth = { status: 'UNREVIEWED', kind: 'window-limit', reason: 'Unreviewed event window exceeds budget; no truncation or model dispatch' };
        s.reviewActivity.reason = s.reviewHealth.reason;
        return { ok: false, reason: 'unreviewed-event-window-exceeds-budget', eventWindow };
      }
      delete s.reviewWindowLimit;
      const id = crypto.randomUUID();
      const packetDir = path.join(this.root, 'reviews', id);
      fs.mkdirSync(lock, { mode: 0o700 });
      const checkpointSequence = checkpoints.at(-1)?.sequence ?? s.reviewCadence.attemptedSequence;
      const claim = { ...owner(), requestId, ownerSessionId: sessionId, revision: s.revision, coreRevision: s.coreRevision, materialRevision: s.materialRevision, checkpointSequence };
      this.writeLocal(path.join(lock, 'owner.json'), JSON.stringify(claim));
      s.lastAttemptRevision = s.revision;
      s.lastAttemptMaterialRevision = s.materialRevision;
      s.reviewCadence.attemptedSequence = checkpointSequence;
      s.reviewActivity = { state: 'reviewing', requestId, packetDir, ownerSessionId: sessionId,
        owner: claim, revision: s.revision, coreRevision: s.coreRevision, materialRevision: s.materialRevision, checkpointSequence };
      // Durable claim precedes packet generation; interrupted capture cannot silently relaunch.
      this.save(s);
      try {
        const withheld = this.withheldCapturePaths(s);
        const safeEvents = events.map((e) => {
          if (!e.path || (this.approved(e.path, s) && !withheld.has(e.path))) return e;
          return { revision: e.revision, type: e.type, source: e.source, sourceDigest: e.sourceDigest,
            omissions: ['previous-scope-content-withheld'] };
        });
        const paths = [...new Set(safeEvents.map((e) => e.path).filter(Boolean))];
        for (const p of s.authorizationScope) if (!p.endsWith('/') && !paths.includes(p)) paths.push(p);
        const artifacts = paths.slice(0, 256).map((p) => withheld.has(p)
          ? { path: p, omitted: 'capture-scope-withheld' } : this.snapshot(p));
        const omissions = ['Unapproved content and shell commands/results withheld; summaries are not execution proof',
          'Approved subtrees are not recursively read; only runtime-observed files are captured'];
        if (s.omittedEvents) omissions.push(`${s.omittedEvents} old source events unpersisted after the legacy storage limit; historical evidence blind spot, not proof or retrospective permission`);
        if (eventWindow.olderEventsNotReReviewed) omissions.push(`${eventWindow.olderEventsNotReReviewed} earlier events retained locally, outside this incremental review window`);
        if (s.migrationUnverifiedTail) omissions.push(`Legacy evidence tail unverified: after revision ${s.migrationUnverifiedTail.afterRevision}, through ${s.migrationUnverifiedTail.throughRevision}; no recovered source proof`);
        if (paths.length > 256) omissions.push('Artifact count truncated to 256');
        this.writeLocal(path.join(packetDir, 'CORE.md'), s.coreText);
        const evidence = { source: 'captured-runtime-events', revision: s.revision, materialRevision: s.materialRevision,
          eventWindow, checkpoints: checkpoints.map(({ stageId, kind, source, revision }) => ({ stageId, kind, source, revision,
            executionProof: false, meaning: 'Dispatch navigation only, not scientific evidence or permission' })),
          events: safeEvents, artifacts, captures: this.capturesThrough(s.revision, s),
          sourceGaps: this.sourceGaps(s), corrections: this.correctionsThrough(s.revision, s) };
        const evidenceText = JSON.stringify(evidence, null, 2);
        if (Buffer.byteLength(evidenceText) > MAX_LOCAL_FILE) throw new Error('Frozen evidence packet exceeds bounded local read budget');
        this.writeLocal(path.join(packetDir, 'EVIDENCE.json'), evidenceText);
        const manifest = { version: 1, requestId, revision: s.revision, materialRevision: s.materialRevision, coreRevision: s.coreRevision, model: MODEL,
          createdAt: this.clock(), ownerSessionId: sessionId, capturedScope: s.authorizationScope,
          eventRange: events.length ? [events[0].revision, events.at(-1).revision] : null,
          eventCount: events.length, eventWindow, checkpointSequence, sourceGaps: this.sourceGaps(s),
          provenance: 'Incremental runtime event capture and separately read authorized artifact snapshots; declared corrections are not execution proof',
          omissions, files: { 'CORE.md': hash(s.coreText), 'EVIDENCE.json': hash(JSON.stringify(evidence, null, 2)) } };
        this.writeLocal(path.join(packetDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
        return { ok: true, packetDir, revision: s.revision, requestId };
      } catch {
        s.reviewActivity.state = 'unverified';
        s.reviewHealth = { status: 'UNREVIEWED', kind: 'packet-failure', reason: 'Packet creation failed; exact terminal disposition required' };
        s.reviewActivity.reason = s.reviewHealth.reason;
        return { ok: false, reason: 'packet-creation-failed' };
      }
    });
  }

  attachRun(requestId, runId) {
    token(runId, 'runId');
    return this.mutate((s) => {
      const active = s.reviewActivity;
      if (active.requestId !== requestId || (active.runId && active.runId !== runId)) return { ok: false, reason: 'stale-request-or-run' };
      active.runId = runId;
      return { ok: true };
    });
  }

  finishReview(requestId, { verdict, findings = [], outputPath, error, runId, review } = {}) {
    return this.mutate((s) => {
      const active = s.reviewActivity;
      if (!active.requestId || active.requestId !== requestId || (active.runId ? active.runId !== runId : runId !== undefined)) return { ok: false, reason: 'stale-request-or-run' };
      const failureCode = typeof error === 'string' && !secret.test(error) ? error.slice(0, 256) : 'execution-failure';
      let failure = error ? 'Supervisor execution failed: ' + failureCode : undefined;
      let frozenEvidence;
      if (!error && !active.runId) failure = 'Missing exact run association';
      try {
        const manifest = JSON.parse(this.readLocal(path.join(active.packetDir, 'MANIFEST.json')));
        if (manifest.requestId !== requestId || manifest.revision !== active.revision || manifest.coreRevision !== active.coreRevision ||
            manifest.files['CORE.md'] !== hash(this.readLocal(path.join(active.packetDir, 'CORE.md'))) ||
            manifest.files['EVIDENCE.json'] !== hash(this.readLocal(path.join(active.packetDir, 'EVIDENCE.json')))) failure = 'Frozen packet provenance mismatch';
        frozenEvidence = parseJSON(this.readLocal(path.join(active.packetDir, 'EVIDENCE.json')), 'frozen evidence');
      } catch { failure = 'Frozen packet missing or malformed'; }
      if (!error && (!VERDICTS.has(verdict) || !Array.isArray(findings) || findings.some((f) => !f || typeof f !== 'object' ||
          ['evidence', 'coreStep', 'relation', 'issue', 'correction'].some((key) => typeof f[key] !== 'string')))) failure = 'Missing or malformed verdict/findings';
      if (active.coreRevision !== s.coreRevision || active.revision > s.revision) failure = 'Core or evidence revision mismatch';
      // Historical blind spots do not turn a valid current direction review into a project-wide stop.
      // They remain explicit dependencies/claim limitations, never retrospectively authenticated.
      const sourceGaps = this.sourceGaps(s);
      if (s.captureFailure) sourceGaps.push({ kind: 'capture-failure', status: 'UNVERIFIED', executionProof: false });
      const sanitized = safeText(JSON.stringify(findings), 32 * 1024);
      if (sanitized.omitted || sanitized.truncated) failure = 'Unsafe or oversized findings';
      let safeOutput;
      if (outputPath !== undefined) {
        const expected = path.join(active.packetDir, 'RAW_REVIEW.json');
        if (outputPath !== expected) failure = 'Unexpected output path';
        else {
          try {
            const rawText = this.readLocal(expected);
            const raw = JSON.parse(rawText);
            if (secret.test(rawText) || !validReview(raw) || raw.verdict !== verdict || JSON.stringify(raw.findings) !== JSON.stringify(findings) ||
                (review !== undefined && !sameReview(raw, review))) failure = 'Output full schema/content mismatch or unsafe';
            else { safeOutput = path.relative(this.cwd, expected); review ??= raw; }
          } catch { failure = 'Missing, malformed or unsafe output file'; }
        }
      }
      review ??= { verdict, findings, coverage: 'Bounded direction review; no scientific acceptance', unverified: [] };
      if (!error && !validReview(review)) failure = 'Malformed direction/science/scope result';
      if (!error && (review.verdict !== verdict || JSON.stringify(review.findings) !== JSON.stringify(findings))) failure = 'Structured result arguments mismatch';
      const scoped = !failure ? groundedRestrictions(this, s, review, frozenEvidence, requestId, runId) : { accepted: [], rejected: [] };
      const lock = path.join(this.root, 'review.lock');
      this.contained(lock);
      if (!fs.existsSync(lock)) return { ok: false, reason: 'missing-review-lock' };
      const claim = parseJSON(this.readLocal(path.join(lock, 'owner.json')), 'review ownership');
      if (claim.requestId !== requestId || claim.revision !== active.revision || claim.coreRevision !== active.coreRevision) return { ok: false, reason: 'review-lock-identity-mismatch' };
      const result = { requestId, runId, revision: active.revision, coreRevision: active.coreRevision,
        verdict: failure ? null : verdict, findings: sanitized.omitted || sanitized.truncated ? [] : parseJSON(sanitized.text, 'sanitized findings'),
        error: failure, outputPath: safeOutput, finishedAt: this.clock(),
        coverage: 'Only this frozen packet; not a whole-history or whole-process clean claim',
        policyVersion: POLICY_VERSION, checkpointSequence: active.checkpointSequence, science: failure ? { status: 'NOT_ASSESSED', limitations: [] } : review.science ?? { status: 'NOT_ASSESSED', limitations: [] },
        sourceGaps, restrictions: scoped.accepted, restrictionAdvisories: scoped.rejected, publicationAuthorized: false };
      this.writeLocal(path.join(active.packetDir, 'RESULT.json'), JSON.stringify(result, null, 2));
      this.append(path.join(this.root, 'review-index.jsonl'), { ...result, packetDir: path.relative(this.cwd, active.packetDir) });
      this.append(path.join(this.root, 'findings-corrections.jsonl'), { kind: 'review-result', ...result });
      if (!failure) {
        s.reviewedRevision = Math.max(s.reviewedRevision, active.revision);
        s.reviewedMaterialRevision = Math.max(s.reviewedMaterialRevision, active.materialRevision ?? active.revision);
      }
      s.lastVerdict = failure ? 'FAILED' : verdict;
      if (!failure) {
        s.lastScience = result.science;
        if (verdict === 'ON_TRACK') for (const restriction of activeRestrictions(s)) {
          const repaired = restriction.paths.every(p => frozenEvidence.events.some(e => e.path === p && e.material === true && e.revision > restriction.revision));
          if (repaired && s.materialRevision <= (active.materialRevision ?? active.revision)) {
            restriction.active = false; restriction.resolvedByRequest = requestId;
          }
        }
        s.branchRestrictions.push(...scoped.accepted);
      }
      s.reviewHealth = { status: failure ? 'UNREVIEWED' : sourceGaps.length ? 'BLIND_SPOT' : 'REVIEWED',
        kind: failure ? failureCode : sourceGaps.length ? 'historical-source-gap' : 'native-direction-review', reason: failure ?? 'Scientific acceptance and publication are separate', requestId, runId };
      s.correctionPaths = [];
      s.blocked = activeRestrictions(s).length > 0;
      s.reviewActivity = { state: failure ? 'failed' : s.blocked ? 'blocked' : 'standby',
        lastRequestId: requestId, lastRunId: runId, lastPacketDir: active.packetDir };
      // Persist terminal disposition before releasing ownership: crashes cannot relaunch blindly.
      this.save(s);
      fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
      return { ok: true, state: s.reviewActivity.state, verdict: s.lastVerdict };
    });
  }

  addCapturedEvidence({ manifestPath, outputs, sources, files, consent, expectedCoreRevision, expectedCoreDigest }) {
    if (!consent || consent.source !== 'direct-human-ui' || consent.confirmed !== true)
      throw new Error('Direct human capture consent required');
    const approved = [...new Set(outputs.map(p => this.scopePath(p)))];
    if (!approved.includes(manifestPath) || approved.some(p => p.endsWith('/')) || approved.length > 180)
      throw new Error('Invalid fixed capture output list');
    return this.mutate(s => {
      if (!s.coreRevision || !s.authorized) throw new Error('Authorized frozen core required');
      if (s.reviewActivity.requestId) throw new Error('Capture scope cannot change during an active review');
      if (s.coreRevision !== expectedCoreRevision || hash(s.coreText) !== expectedCoreDigest)
        throw new Error('Capture core/scope changed before registration');
      const scope = [...new Set([...s.authorizationScope, ...approved])].sort();
      if (scope.length > 256) throw new Error('Capture scope limit exceeded');
      if (JSON.stringify(scope) !== JSON.stringify(s.authorizationScope)) s.coreRevision++;
      s.authorizationScope = scope; // Explicit UI grants only the generated fixed file list.
      s.correctionPaths = []; delete s.correctionCoreRevision;
      s.materialRevision = ++s.revision;
      s.captureReceipts.push({ manifestPath, outputs: approved, sources, files, consent,
        revision: s.revision, coreRevision: s.coreRevision });
      return { revision: s.revision, coreRevision: s.coreRevision, blocked: s.blocked };
    });
  }

  capturesThrough(revision, state) {
    return state.captureReceipts.filter(r => r.revision <= revision).map(receipt => {
      // A later scope narrowing withholds the entire grant, not only its manifest.
      if (!receipt.outputs.every(p => this.approved(p, state)))
        return { revision: receipt.revision, omitted: 'capture-scope-withheld' };
      const manifest = parseJSON(this.readLocal(path.join(this.cwd, receipt.manifestPath)), 'capture manifest');
      if (manifest.outputsDigest !== hash(JSON.stringify(receipt.outputs))) throw new Error('Capture output identity mismatch');
      const files = receipt.outputs.map(p => {
        const text = this.readLocal(path.join(this.cwd, p));
        const expected = receipt.files?.[p];
        if (!expected || hash(text) !== expected.sha256) throw new Error('Captured evidence changed');
        if (Buffer.byteLength(text) > 6 * 1024) throw new Error('Captured evidence chunk exceeded limit');
        return { path: p, text, sha256: hash(text) };
      });
      return { source: 'direct-bounded-host-capture', receipt, manifest, files };
    });
  }

  correctionsThrough(revision, state) {
    const file = path.join(this.root, 'corrections.jsonl');
    if (!fs.existsSync(file)) return [];
    const withheld = this.withheldCapturePaths(state);
    return this.readLocal(file).trim().split('\n').filter(Boolean).map((line) => parseJSON(line, 'correction journal'))
      .filter((e) => e.revision <= revision).map((e) => ({ ...e,
        evidence: e.evidence.filter((item) => this.approved(item.path, state) && !withheld.has(item.path)) }));
  }

  recordCorrection({ text, evidencePaths = [] }) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_EXCERPT || secret.test(text)) throw new Error('Correction must be bounded and free of secret markers');
    if (!Array.isArray(evidencePaths) || evidencePaths.length > 64) throw new Error('Invalid correction evidence paths');
    return this.mutate((s) => {
      if (!s.coreRevision) throw new Error('Configure a core first');
      const evidence = evidencePaths.map((p) => {
        const relative = this.approved(p, s);
        if (!relative || this.withheldCapturePaths(s).has(relative)) throw new Error('Correction evidence outside approved scope');
        return this.snapshot(relative);
      });
      const file = path.join(this.root, 'corrections.jsonl');
      if (fs.existsSync(file) && fs.statSync(this.contained(file)).size > MAX_EVENT_BYTES) throw new Error('Correction storage limit reached');
      const entry = { kind: 'declared-correction', executionProof: false, text, evidence, revision: ++s.revision, timestamp: this.clock() };
      this.append(file, entry);
      this.append(path.join(this.root, 'findings-corrections.jsonl'), entry);
      s.correctionRevision = s.revision;
      s.correctionCoreRevision = s.coreRevision;
      s.correctionPaths = evidence.map((item) => item.path);
      return { changed: true, revision: s.revision, blocked: s.blocked };
    });
  }

  allowOperation({ toolName, input, paths, reason, repair = false, consent, expectedCoreRevision, expectedPathDigests }) {
    if (consent?.source !== 'direct-human-ui' || consent.confirmed !== true) throw new Error('Direct human operation consent required');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000 || secret.test(reason)) throw new Error('Bounded operation purpose required');
    const prepared = validateLocalOperation(this, toolName, input, paths);
    if (consent.inputDigest && consent.inputDigest !== prepared.inputDigest) throw new Error('Operation input changed during consent');
    if (expectedPathDigests && JSON.stringify(expectedPathDigests) !== JSON.stringify(prepared.pathDigests)) throw new Error('Operation files changed during consent');
    return this.mutate(s => {
      if (!s.coreRevision || s.coreRevision !== expectedCoreRevision) throw new Error('Operation core changed before consent');
      if (s.operationGrants.length >= 64) throw new Error('Operation grant limit reached; no unbounded grants');
      const entry = { ...prepared, id: crypto.randomUUID(), reason, repair: repair === true, coreRevision: s.coreRevision,
        consent, timestamp: this.clock(), executionProof: false, kind: 'human-bounded-operation' };
      s.operationGrants.push(entry);
      this.append(path.join(this.root, 'human-decisions.jsonl'), entry);
      return { id: entry.id, toolName, paths: prepared.paths, coreRevision: s.coreRevision, boundary: entry.boundary, publicationAuthorized: false };
    });
  }

  recordHumanDecision({ restrictionIds, effect, text, consent, expectedCoreRevision }) {
    if (consent?.source !== 'direct-human-ui' || consent.confirmed !== true) throw new Error('Direct human decision required');
    if (!['release_branch', 'hold_branch'].includes(effect) || !Array.isArray(restrictionIds) || !restrictionIds.length || restrictionIds.length > 16)
      throw new Error('A bounded decision needs exact branch restriction IDs');
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || secret.test(text)) throw new Error('Bounded human decision text required');
    return this.mutate(s => {
      if (expectedCoreRevision !== undefined && s.coreRevision !== expectedCoreRevision) throw new Error('Decision core changed during consent');
      const selected = restrictionIds.map(id => s.branchRestrictions.find(r => r.id === id &&
        (r.coreDigest ? r.coreDigest === hash(s.coreText) : r.coreRevision === s.coreRevision)));
      if (selected.some(r => !r)) throw new Error('Unknown/stale branch restriction');
      const entry = { id: crypto.randomUUID(), kind: 'human-branch-decision', effect, restrictionIds, text, consent,
        timestamp: this.clock(), revision: s.revision, coreRevision: s.coreRevision, executionProof: false, publicationAuthorized: false };
      this.append(path.join(this.root, 'human-decisions.jsonl'), entry);
      for (const r of selected) { r.active = effect === 'hold_branch'; r.decisionId = entry.id; }
      s.blocked = activeRestrictions(s).length > 0;
      return { id: entry.id, effect, restrictionIds, blocked: s.blocked, publicationAuthorized: false };
    });
  }

  markCaptureFailure() {
    return this.mutate((s) => {
      s.captureFailure = true;
      s.reviewHealth = { status: 'BLIND_SPOT', kind: 'source-capture', reason: 'Source capture incomplete; cannot authenticate affected events or claims' };
      s.reviewActivity.reason = s.reviewHealth.reason;
      return structuredClone(s);
    });
  }

  statusText() {
    const s = this.getState();
    if (!s.enabled) return '主线监督：已暂停（不影响前台空闲）';
    if (!s.authorized) return '主线监督：待人工授权';
    const labels = { standby: '后台待命', reviewing: '后台审查中', blocked: '具体偏离分支暂停', failed: '未审查（运行故障）', unverified: '终态未核实（非全项目冻结）' };
    const gaps = s.omittedEvents ? ` · ${s.omittedEvents}条旧事件缺口（UNVERIFIED）` : s.eventSourceGaps.length ? ' · 事件来源缺口（UNVERIFIED）' : '';
    return `主线监督：${labels[s.reviewActivity.state] || '未知'}${s.pendingChanges ? (this.pendingCheckpoints(s).length ? ' · 研究节点待审' : ' · 阶段内证据积累（不逐步审查）') : ''}${gaps}${s.reviewWindowLimit ? ' · 未审窗口超限，未派发' : ''}`;
  }

  resourceGate() {
    try {
      const text = typeof this.meminfo === 'function' ? this.meminfo() : this.meminfo ?? fs.readFileSync('/proc/meminfo', 'utf8');
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
      if (!match) return { ok: false, memAvailableMiB: null, reason: 'MemAvailable unavailable' };
      const memAvailableMiB = Number(match[1]) / 1024;
      return { ok: memAvailableMiB >= 2048, memAvailableMiB, ...(memAvailableMiB < 2048 ? { reason: 'MemAvailable below 2048 MiB' } : {}) };
    } catch { return { ok: false, memAvailableMiB: null, reason: 'MemAvailable unavailable' }; }
  }
}
