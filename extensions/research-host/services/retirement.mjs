import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { checkResearchRetirement } from '../../research-loop/src/retirement-check.mjs';
import { createLocalRetirementProbe } from '../../research-loop/src/retirement-probe.mjs';
import { createResearchDispatchStore } from './research-dispatch-service.mjs';
import { createResearchCommunicationStore } from './research-communication-service.mjs';
import { createResearchSessionStore, researchProvenanceOf } from './research-session-service.mjs';
import { createResearchCollaborationStore } from './research-collaboration-service.mjs';

const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const ENDED = new Set(['ended', 'closed', 'archived']);
const unavailable = reason => ({ ready: false, reasons: [reason] });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Preserve native entry counts and tool identities without loading transcript bodies. */
export async function readNativeRetirementEntries(row) {
  const file = row.sessionFile;
  if (typeof file !== 'string' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('retirement-history-unsafe');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()) throw new Error('retirement-history-unsafe');
    const decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(64 * 1024), entries = [];
    let pending = '', offset = 0, header;
    const consume = line => {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string') {
        throw new Error('retirement-history-record-invalid');
      }
      if (!header) {
        if (entry?.type !== 'session' || entry.id !== row.id || entry.cwd !== row.cwd) throw new Error('retirement-history-identity-invalid');
        header = entry;
        return;
      }
      if (entry.type === 'session') throw new Error('retirement-history-identity-invalid');
      if (entries.length >= 50_000) throw new Error('retirement-history-activity-capacity');
      const message = entry?.type === 'message' ? entry.message : undefined;
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        entries.push({ type: 'message', message: { role: 'assistant', content: message.content
          .filter(part => part?.type === 'toolCall')
          .map(part => ({ type: 'toolCall', id: part.id, name: part.name,
            arguments: { action: part.arguments?.action } })) } });
      } else if (message?.role === 'toolResult') {
        entries.push({ type: 'message', message: { role: 'toolResult', toolName: message.toolName,
          toolCallId: message.toolCallId, isError: message.isError,
          details: { runId: message.details?.runId, task: { id: message.details?.task?.id } } } });
      } else entries.push({ type: 'custom' });
    };
    while (offset < before.size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!read.bytesRead) throw new Error('retirement-history-changed');
      offset += read.bytesRead;
      pending += decoder.write(buffer.subarray(0, read.bytesRead));
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error('retirement-history-record-too-large');
        if (line) consume(line);
      }
      if (Buffer.byteLength(pending) > 64 * 1024 * 1024) throw new Error('retirement-history-record-too-large');
    }
    pending += decoder.end();
    if (pending || !header) throw new Error('retirement-history-incomplete');
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('retirement-history-changed');
    const fingerprintOf = value => hash([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]);
    const fingerprint = fingerprintOf(before);
    return { entries, fingerprint, async verifyUnchanged() {
      const current = await fs.promises.lstat(file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || fingerprintOf(current) !== fingerprint) {
        throw new Error('retirement-history-changed');
      }
    } };
  } finally { await handle.close(); }
}

/** Resolve an actual persisted report for one exact formal assignment. */
export function readResearchRetirementReport({ privateDir, row, binding }) {
  const child = researchProvenanceOf(row);
  if (!child || child.origin !== 'research_session' || child.parentSessionId === row.id) return undefined;
  const matchesScope = record => record.cwd === row.cwd && record.ownerKey === binding.ownerKey
    && record.adoptionId === binding.adoptionId && record.charterHash === binding.charterHash;
  const scope = { sessionId: row.id, parentSessionId: child.parentSessionId,
    adoptionId: binding.adoptionId, charterHash: binding.charterHash };
  if (child.dispatchId && child.taskId) {
    const plans = createResearchDispatchStore(path.join(privateDir, 'dispatch')).readAll();
    const plan = plans.find(record => record.kind === 'plan' && record.id === child.dispatchId
      && record.parentSessionId === child.parentSessionId && matchesScope(record));
    const task = plan?.tasks.find(record => record.id === child.taskId && record.sessionId === row.id
      && record.spawnToken === child.spawnToken && record.reportedAt && TERMINAL.has(record.status));
    if (!task) return undefined;
    return { ...scope, id: 'dispatch-report-' + hash([plan.id, task.id, task.reportedAt]).slice(0, 40),
      status: task.status, persisted: true };
  }
  const reports = createResearchCommunicationStore(path.join(privateDir, 'communication')).readAll()
    .filter(record => record.from === row.id && record.to === child.parentSessionId && matchesScope(record)
      && record.kind === 'result' && record.spawnToken === child.spawnToken && !record.resumedBy)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const report = reports[0];
  if (!report || !TERMINAL.has(report.status)) return undefined;
  if (reports[1]?.createdAt === report.createdAt && reports[1].status !== report.status) return undefined;
  return { ...scope, id: report.id, status: report.status, persisted: true };
}

/** Request native shutdown only after the shared current-scope retirement check.
 * observeOwnedWork may supply a native terminal adapter. Missing process evidence
 * remains unknown through createLocalRetirementProbe and prevents shutdown.
 */
export function createResearchRetirementService({ privateDir, sessions, communication, readBinding,
  principalForSession, requestShutdown, observeOwnedWork, readHistory = readNativeRetirementEntries, onDiagnostic = () => {} }) {
  if (!path.isAbsolute(privateDir)) throw new TypeError('retirement-private-directory-required');
  for (const [name, value] of Object.entries({ readBinding, principalForSession, requestShutdown })) {
    if (typeof value !== 'function') throw new TypeError(`retirement-${name}-required`);
  }
  const settled = new Map(), inFlight = new Map(), requested = new Map();
  let disposed = false;

  function nativeSnapshots(stateReply, history, row) {
    const state = stateReply?.data;
    if (stateReply?.success !== true || state?.sessionId !== row.id || state.sessionFile !== row.sessionFile
        || typeof state.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean'
        || !Number.isInteger(state.pendingMessageCount) || state.pendingMessageCount < 0
        || !Array.isArray(history?.entries) || typeof history.fingerprint !== 'string') {
      throw new Error('retirement-native-state-unverified');
    }
    return { state, entries: history.entries, historyFingerprint: history.fingerprint,
      verifyHistory: history.verifyUnchanged };
  }

  async function inspect(sessionId) {
    if (disposed) return unavailable('retirement-service-closed');
    const row = sessions.getSession(sessionId);
    if (!row || row.external || row.nativeRegistrationConfirmed === false || !row.live || !Number.isInteger(row.pid)) {
      return unavailable('retirement-native-session-unavailable');
    }
    if (row.pendingUIRequests?.length) return unavailable('retirement-native-ui-pending');
    const child = researchProvenanceOf(row);
    if (child?.origin !== 'research_session') return unavailable('not-formal-research-child');
    let binding = await readBinding(row);
    binding = { ...binding, sessionId: row.id, researchSession: child };
    const report = readResearchRetirementReport({ privateDir, row, binding });
    if (!report) return unavailable('durable-report-unverified');
    const key = hash([row.id, row.pid, report.id]);
    if (requested.get(sessionId) === key) return unavailable('retirement-shutdown-already-requested');
    const refreshNative = async () => nativeSnapshots(...await Promise.all([
      sessions.command(sessionId, { type: 'get_state' }),
      readHistory(row),
    ]), row);
    let native = await refreshNative();
    const historyFingerprint = native.historyFingerprint;
    const ctx = {
      cwd: row.cwd,
      isIdle: () => native.state.isStreaming === false && native.state.isCompacting === false,
      hasPendingMessages: () => native.state.pendingMessageCount !== 0,
      sessionManager: { getSessionId: () => sessions.getSession(sessionId)?.id,
        getEntries: () => native.entries },
    };
    const probe = async input => {
      const status = await communication.handle({ body: { sessionId, action: 'status' }, principal: principalForSession(row) });
      const allSessions = sessions.listSessions();
      const currentChildren = allSessions.filter(candidate => {
        const provenance = researchProvenanceOf(candidate);
        return provenance?.parentSessionId === row.id && (!ENDED.has(candidate.status) || candidate.live !== false);
      }).map(candidate => ({ id: candidate.id, status: candidate.status }));
      const reservations = createResearchSessionStore(path.join(privateDir, 'session-reservations')).readAll();
      for (const reservation of reservations) if (reservation.parentSessionId === row.id && reservation.phase !== 'released') {
        const observed = allSessions.find(candidate => researchProvenanceOf(candidate)?.spawnToken === reservation.spawnToken);
        if (!observed || !ENDED.has(observed.status) || observed.live !== false) {
          currentChildren.push({ id: reservation.requestId, status: 'reservation-' + reservation.phase });
        }
      }
      const plans = createResearchDispatchStore(path.join(privateDir, 'dispatch')).readAll();
      for (const plan of plans) if (plan.parentSessionId === row.id) for (const task of plan.tasks) {
        if (!TERMINAL.has(task.status) || task.processUnconfirmed === true) currentChildren.push({ id: task.id, status: task.status });
      }
      const collaborations = createResearchCollaborationStore(path.join(privateDir, 'collaboration')).readAll();
      for (const collaboration of collaborations) for (const lease of collaboration.nativeQueue) {
        if (lease.parentSessionId === row.id && !['released', 'cancelled'].includes(lease.status)) {
          currentChildren.push({ id: lease.requestId, status: 'native-' + lease.status });
        }
      }
      const hostObservation = { ...status.retirement, sessionId, pid: row.pid, reportId: report.id,
        formalChildren: currentChildren };
      const observed = observeOwnedWork
        ? await observeOwnedWork({ ...input, row, report, hostObservation })
        : await createLocalRetirementProbe({ pid: row.pid, reportId: report.id,
          request: async () => ({ retirement: hostObservation }) })(input);
      const snapshot = { ...observed, complete: observed?.complete === true && hostObservation.complete === true,
        formalChildren: Array.isArray(observed?.formalChildren) ? [...observed.formalChildren, ...currentChildren] : undefined,
        supervisorRequests: Array.isArray(observed?.supervisorRequests) && Array.isArray(hostObservation.supervisorRequests)
          ? [...observed.supervisorRequests, ...hostObservation.supervisorRequests] : undefined };
      if (typeof native.verifyHistory === 'function') {
        const stateReply = await sessions.command(sessionId, { type: 'get_state' });
        await native.verifyHistory();
        native = nativeSnapshots(stateReply, { entries: native.entries, fingerprint: native.historyFingerprint,
          verifyUnchanged: native.verifyHistory }, row);
      } else native = await refreshNative();
      if (native.historyFingerprint !== historyFingerprint) throw new Error('retirement-native-history-changed');
      const currentRow = sessions.getSession(sessionId);
      if (currentRow?.pid !== row.pid || currentRow.live !== true || currentRow.nativeRegistrationConfirmed === false || currentRow.pendingUIRequests?.length) {
        throw new Error('retirement-native-session-changed');
      }
      const freshBinding = await readBinding(currentRow);
      for (const key of Object.keys(binding)) delete binding[key];
      Object.assign(binding, freshBinding, { sessionId, researchSession: researchProvenanceOf(currentRow) });
      const freshReport = readResearchRetirementReport({ privateDir, row: currentRow, binding });
      if (JSON.stringify(freshReport) !== JSON.stringify(report)) throw new Error('retirement-report-changed');
      return snapshot;
    };
    const checked = await checkResearchRetirement(ctx, { settled: settled.get(sessionId) === row.pid,
      binding, report, probe });
    if (!checked.ready) return checked;
    if (disposed || settled.get(sessionId) !== row.pid) return unavailable('agent-not-settled');
    requested.set(sessionId, key);
    try {
      const shutdown = requestShutdown({ sessionId, pid: row.pid, reportId: report.id });
      const outcome = await shutdown;
      if (outcome?.committed === false) {
        requested.delete(sessionId);
        return { ...unavailable(/^[a-z0-9-]{1,100}$/.test(outcome.reason ?? '') ? outcome.reason : 'retirement-native-refused'),
          shutdownRequested: false };
      }
      return { ...checked, shutdownRequested: true, reportId: report.id,
        retirementConfirmed: outcome?.committed === true && outcome.retired === true && outcome.workerExited === true
          && outcome.reportId === report.id && sessions.getSession(sessionId)?.live !== true };
    } catch {
      return { ...unavailable('retirement-shutdown-outcome-unknown'), shutdownRequested: true };
    }
  }

  function check(sessionId) {
    if (!inFlight.has(sessionId)) {
      const pending = inspect(sessionId).catch(error => {
        onDiagnostic(error.code ?? 'retirement-observation-unavailable');
        return unavailable('retirement-observation-unavailable');
      }).finally(() => inFlight.delete(sessionId));
      inFlight.set(sessionId, pending);
    }
    return inFlight.get(sessionId);
  }

  async function onEvent(sessionId, event) {
    if (event?.type === 'agent_start') { settled.delete(sessionId); return; }
    if (event?.type !== 'agent_settled') return;
    const row = sessions.getSession(sessionId);
    if (!row?.pid) return;
    settled.set(sessionId, row.pid);
    return check(sessionId);
  }

  async function tick() {
    if (disposed) return;
    for (const row of sessions.listSessions()) {
      if (row.external || !row.live || row.status !== 'idle' || !researchProvenanceOf(row)) continue;
      if (settled.get(row.id) !== row.pid && typeof sessions.readEvents === 'function') {
        const page = sessions.readEvents(row.id, { after: Math.max(0, (row.eventCursor ?? 0) - 200), limit: 200 });
        const lifecycle = page.events.map(entry => entry.event).filter(event => ['agent_start', 'agent_settled'].includes(event.type)).at(-1);
        if (lifecycle?.type === 'agent_settled') settled.set(row.id, row.pid);
      }
      if (settled.get(row.id) === row.pid) await check(row.id);
    }
  }

  return { onEvent, tick, check, dispose() { disposed = true; settled.clear(); } };
}
