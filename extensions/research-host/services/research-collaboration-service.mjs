/** Durable human-controlled coordination. This ledger is not a transcript and
 * never confers model, filesystem or host authority. All callers arrive through
 * the existing owner/cwd admission; launches retain their existing proof checks. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RESEARCH_SESSION_LIMITS } from './research-session-service.mjs';

export const COLLABORATION_SCHEMA = 'pi-research-collaboration.v1';
export const COLLABORATION_DEFAULT_LIMITS = Object.freeze({ maxMultiAgents: 4, maxSubagents: 3 });
export const COLLABORATION_LIMIT_MAXIMUMS = Object.freeze({ maxMultiAgents: RESEARCH_SESSION_LIMITS.maxTotal, maxSubagents: 32 });
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const live = row => !!row && ['active', 'idle', 'streaming'].includes(row.status);
const provenance = row => row?.researchSession ?? row?.pluginRefs?.['res-workflow']?.researchSession;
const membership = row => row?.resWorkflow ?? row?.pluginRefs?.['res-workflow']?.resWorkflow;
const terminalNative = row => ['released', 'cancelled'].includes(row.status);
const detached = (state, id) => Object.hasOwn(state.detached, id);
const safeText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const localOwner = value => {
  try { const [iss, sub] = JSON.parse(value); return iss === 'host' && sub === 'inert-operator' || iss === 'urn:pi-dashboard:local-operator' && sub === 'local-operator'; } catch { return false; }
};
// These are the same host-local owner realm, not aliases for a named user.
const normalizedOwner = value => localOwner(value) ? '["host","inert-operator"]' : value;
const scopeKey = input => sha(JSON.stringify([input.cwd, normalizedOwner(input.ownerKey)]));

export class ResearchCollaborationError extends Error {
  constructor(statusCode, code) { super(code); this.name = 'ResearchCollaborationError'; this.statusCode = statusCode; this.code = code; }
}
const fail = (status, code) => { throw new ResearchCollaborationError(status, code); };

/** Private, atomic, fsynced state. A failed write never changes memory. */
export function createResearchCollaborationStore(directory) {
  function root() {
    const resolved = path.resolve(directory);
    let cursor = path.parse(resolved).root;
    for (const part of resolved.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(503, 'research-collaboration-store-unsafe');
    }
    fs.chmodSync(resolved, 0o700);
    return resolved;
  }
  return {
    readAll() {
      const dir = root();
      return fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) fail(503, 'research-collaboration-store-unsafe');
        let row;
        try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(503, 'research-collaboration-store-invalid'); }
        if (!object(row) || row.schema !== COLLABORATION_SCHEMA || typeof row.cwd !== 'string' || typeof row.ownerKey !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 0 || !Array.isArray(row.tenures) || !object(row.detached) || !Array.isArray(row.nativeQueue) || `${scopeKey(row)}.json` !== name) fail(503, 'research-collaboration-store-invalid');
        if (!object(row.limits) || ['maxMultiAgents', 'maxSubagents'].some(key => !Number.isSafeInteger(row.limits[key]) || row.limits[key] < 1 || row.limits[key] > COLLABORATION_LIMIT_MAXIMUMS[key]) || row.tenures.some(item => !object(item) || !ID.test(item.id ?? '') || !ID.test(item.mainSessionId ?? '') || !Array.isArray(item.sessionIds) || item.sessionIds.some(id => !ID.test(id)) || !item.sessionIds.includes(item.mainSessionId) || !['current', 'historical', 'removed'].includes(item.status)) || row.tenures.filter(item => item.status === 'current').length > 1 || row.currentTenureId !== null && !row.tenures.some(item => item.id === row.currentTenureId && item.status === 'current')) fail(503, 'research-collaboration-store-invalid');
        return row;
      });
    },
    write(row) {
      const dir = root(), file = path.join(dir, `${scopeKey(row)}.json`), temporary = `${file}.tmp`;
      for (const candidate of [file, temporary]) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) fail(503, 'research-collaboration-store-unsafe');
      const data = JSON.stringify(row);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) fail(503, 'research-collaboration-store-capacity');
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      const parent = fs.openSync(dir, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    },
  };
}

export function createResearchCollaborationService(deps) {
  const now = deps.now ?? (() => new Date());
  const mint = deps.mintId ?? randomUUID;
  const states = new Map((deps.store?.readAll() ?? []).map(row => [scopeKey(row), copy(row)]));
  let tail = Promise.resolve();
  const serial = fn => { const pending = tail.then(fn); tail = pending.catch(() => {}); return pending; };
  const allSessions = () => deps.listSessions();
  const at = () => now().toISOString();
  const fresh = access => ({ schema: COLLABORATION_SCHEMA, cwd: access.cwd, ownerKey: normalizedOwner(access.ownerKey), revision: 0, currentTenureId: null, limits: { ...COLLABORATION_DEFAULT_LIMITS }, tenures: [], detached: {}, nativeQueue: [], sessionReservations: [], prompts: [], updatedAt: at() });
  const get = access => copy(states.get(scopeKey(access)) ?? fresh(access));
  const save = (state, bump = true) => {
    const next = copy({ ...state, revision: state.revision + (bump ? 1 : 0), updatedAt: at() });
    deps.store?.write(next); states.set(scopeKey(next), next); return copy(next);
  };
  const currentOf = state => state.tenures.find(row => row.id === state.currentTenureId && row.status === 'current');
  const sameScopeRow = (row, state) => row && row.cwd === state.cwd && !row.originDeviceId && !row.pluginHidden && !row.archiveOnEnd && (!state.ownerKey || localOwner(state.ownerKey) || row.principalOwner && JSON.stringify([row.principalOwner.iss, row.principalOwner.sub]) === state.ownerKey);
  const snapshotOf = (row, tenure) => ({
    ...(typeof row?.name === 'string' && row.name ? { title: row.name } : {}),
    ...(typeof row?.model === 'string' && row.model ? { model: row.model } : {}),
    ...(typeof provenance(row)?.role === 'string' ? { role: provenance(row).role } : {}),
    ...(typeof row?.status === 'string' ? { status: row.status } : row?.archivedAt ? { status: 'ended' } : {}),
    ...(row?.id === tenure?.mainSessionId ? { origin: 'user-selected' } : provenance(row) && ID.test(provenance(row).parentSessionId ?? '') && provenance(row).workflowCwd === row?.cwd
      ? { origin: 'agent-dispatch', parentSessionId: provenance(row).parentSessionId }
      : membership(row)?.via === 'manual' ? { origin: 'manual-join' } : {}),
  });

  /** Membership follows explicit provenance only. A new selection never turns
   * same-folder conversations into children or rewrites old tenure ownership. */
  function reconcile(state) {
    let changed = false;
    const rows = allSessions().filter(row => sameScopeRow(row, state));
    const assigned = new Set(state.tenures.flatMap(row => row.sessionIds.filter(id => id !== row.mainSessionId)));
    for (let iteration = 0; iteration < rows.length + 1; iteration++) {
      let added = false;
      for (const row of rows) {
        const p = provenance(row);
        if (!p || !ID.test(p.parentSessionId ?? '') || p.workflowCwd !== state.cwd || detached(state, row.id)) continue;
        let tenure = p.tenureId ? state.tenures.find(item => item.id === p.tenureId) : undefined;
        if (!tenure && !p.tenureId && !assigned.has(row.id)) {
          tenure = state.tenures.find(item => item.status === 'current' && item.sessionIds.includes(p.parentSessionId) && (item.importLegacy === true || typeof p.createdAt === 'string' && p.createdAt >= item.startedAt));
        }
        if (!tenure || tenure.status === 'removed' || tenure.sessionIds.includes(row.id) || !tenure.sessionIds.includes(p.parentSessionId)) continue;
        tenure.sessionIds.push(row.id); assigned.add(row.id); changed = true; added = true;
        (tenure.snapshots ??= {})[row.id] = snapshotOf(row, tenure);
      }
      if (!added) break;
    }
    const current = currentOf(state);
    if (current && freeze(current, rows)) changed = true;
    return changed;
  }
  function freeze(tenure, rows = allSessions(), refresh = false) {
    const byId = new Map([...rows].reverse().map(row => [row.id, row]));
    tenure.snapshots ??= {};
    let changed = false;
    for (const id of tenure.sessionIds) {
      const row = byId.get(id);
      if (row && (refresh || !Object.hasOwn(tenure.snapshots, id))) {
        tenure.snapshots[id] = { ...tenure.snapshots[id], ...snapshotOf(row, tenure) };
        changed = true;
      }
    }
    return changed;
  }
  const revision = (state, expected) => { if (!Number.isSafeInteger(expected) || expected !== state.revision) fail(409, 'research-collaboration-revision-conflict'); };
  const admitted = async (access, write = false) => { if (write && access.write !== true) fail(403, 'research-collaboration-write-required'); await access.revalidate(); };
  async function sessionFor(access, id) {
    if (!ID.test(id ?? '')) fail(400, 'research-collaboration-session-invalid');
    const row = allSessions().find(item => item.id === id);
    if (!sameScopeRow(row, access) || !access.canReadHistory || !(await access.canReadHistory(row))) fail(404, 'research-collaboration-session-not-found');
    await access.revalidate(); return row;
  }

  function stateForLaunch(parent, verified) {
    const direct = states.get(scopeKey(verified));
    if (direct) return direct;
    // A local operator can explicitly select an owned local session. Its proven
    // dispatch owner is retained, without granting any access to another API user.
    const matches = [...states.values()].filter(state => state.cwd === verified.cwd && state.tenures.some(tenure => normalizedOwner(tenure.dispatchOwnerKey) === normalizedOwner(verified.ownerKey) && (tenure.sessionIds.includes(parent.id) || provenance(parent)?.tenureId === tenure.id)));
    if (matches.length > 1) fail(409, 'research-collaboration-owner-ambiguous');
    return matches[0];
  }
  function policy(input) {
    const parent = input.parent ?? input.verified?.parent, verified = input.verified ?? input;
    const state = stateForLaunch(parent, verified), tenure = state && currentOf(state);
    return { ...(state?.limits ?? COLLABORATION_DEFAULT_LIMITS), managed: true, tenureId: tenure?.id, mainSessionId: tenure?.mainSessionId, isMainAgent: parent?.id === tenure?.mainSessionId, importLegacy: tenure?.importLegacy === true };
  }
  function assertDispatchAllowed(input) {
    const parent = input.parent ?? input.verified?.parent, verified = input.verified ?? input;
    const state = stateForLaunch(parent, verified), tenure = state && currentOf(state);
    if (!state || !tenure) fail(409, 'research-collaboration-main-not-selected');
    // The caller's normal verifier owns current charter/adoption approval.
    // Selecting a main is not a second goal-version gate. Child provenance,
    // unlike the main role itself, remains tied to its original task scope.
    const rows = new Map(allSessions().map(row => [row.id, row]));
    let row = parent; const visited = new Set();
    while (row && !visited.has(row.id)) {
      if (detached(state, row.id)) fail(409, 'research-collaboration-session-detached');
      if (row.id === tenure.mainSessionId) return;
      visited.add(row.id);
      const p = provenance(row);
      if (p?.adoptionId !== verified.adoptionId || p?.charterHash !== verified.charterHash) fail(409, 'research-collaboration-binding-changed');
      if (!p || p.workflowCwd !== state.cwd || p.tenureId && p.tenureId !== tenure.id || !p.tenureId && state.tenures.some(other => other.id !== tenure.id && other.sessionIds.includes(row.id))) fail(409, 'research-collaboration-historical-main');
      row = rows.get(p.parentSessionId);
    }
    fail(409, 'research-collaboration-not-current-descendant');
  }
  function cancelQueuedNative(state, ids, reason, tenureId) {
    for (const row of state.nativeQueue) if (ids.has(row.parentSessionId) && (!tenureId || row.tenureId === tenureId) && row.status === 'queued') { row.status = 'cancelled'; row.finishedAt = at(); row.queueReason = reason; }
  }
  function projection(state, adopted, extras = {}) {
    const current = currentOf(state);
    const byId = new Map(allSessions().filter(row => sameScopeRow(row, state)).reverse().map(row => [row.id, row]));
    const latestTenureBySession = new Map(state.tenures.filter(tenure => tenure.status !== 'removed')
      .flatMap(tenure => tenure.sessionIds.map(id => [id, tenure.id])));
    const tenures = state.tenures.map(({ dispatchOwnerKey: _owner, adoptionId: _adoption, charterHash: _hash, importLegacy: _legacy, ...tenure }) => {
      if (tenure.status === 'current') return { ...copy(tenure), snapshots: Object.fromEntries(tenure.sessionIds.map(id => [id, { ...tenure.snapshots?.[id], ...snapshotOf(byId.get(id), tenure) }])) };
      const result = copy(tenure);
      if (result.status === 'historical') {
        result.snapshots ??= {};
        for (const id of tenure.sessionIds) {
          if (latestTenureBySession.get(id) !== tenure.id) continue;
          const { status } = snapshotOf(byId.get(id), tenure);
          if (status) result.snapshots[id] = { ...result.snapshots[id], status };
        }
      }
      return result;
    });
    const ownerKeys = [...new Set([state.ownerKey, ...state.tenures.map(row => row.dispatchOwnerKey).filter(Boolean)])];
    const scopedPlans = ownerKeys.flatMap(ownerKey => deps.listPlans?.({ cwd: state.cwd, ownerKey }) ?? []);
    const plans = [...new Map(scopedPlans.map(plan => [plan.id, plan])).values()].map(plan => ({
      ...plan,
      tenureId: plan.tenureId ?? null,
      readOnly: plan.readOnly === true,
      effectiveConcurrency: plan.concurrency,
      tasks: plan.tasks.map(task => ({
        ...task,
        sessionId: task.sessionId ?? null,
        dependsOn: task.dependsOn ?? [],
        waitingReason: task.waitingReason ?? null,
        error: task.error ?? null,
        rank: task.rank ?? task.queueRank,
        ...(task.waitingReason ? { queueReason: task.waitingReason } : {}),
      })),
    }));
    return {
      schema: COLLABORATION_SCHEMA, cwd: state.cwd, adopted, revision: state.revision,
      currentTenureId: current?.id ?? null, currentMainSessionId: current?.mainSessionId ?? null,
      limits: { ...state.limits }, limitMaximums: { ...COLLABORATION_LIMIT_MAXIMUMS },
      operationalLimits: { maxTotal: RESEARCH_SESSION_LIMITS.maxTotal, maxResident: RESEARCH_SESSION_LIMITS.maxResident, minAvailableMemoryBytes: RESEARCH_SESSION_LIMITS.minAvailableMemory },
      tenures, detachedSessionIds: Object.keys(state.detached), plans,
      nativeQueue: state.nativeQueue.map(({ leaseToken: _token, attemptId: _attempt, lastSeenAt, ...row }) => {
        const unknown = !terminalNative(row) && row.status !== 'queued' && (!lastSeenAt || now().getTime() - Date.parse(lastSeenAt) > 45_000);
        return copy(unknown ? { ...row, status: 'recovery-required', queueReason: 'heartbeat-missing' } : row);
      }),
      ...extras,
    };
  }
  async function snapshot(access) {
    return serial(async () => {
      await admitted(access); let state = get(access);
      if (reconcile(state)) state = save(state);
      const adopted = (await deps.connection(access)).adopted;
      await admitted(access); return projection(state, adopted);
    });
  }

  async function mutate(access, body, actor = {}) {
    return serial(async () => {
      await admitted(access, true);
      let state = get(access);
      if (reconcile(state)) state = save(state);
      revision(state, body.expectedRevision);
      const connection = await deps.connection(access);
      if (!connection.adopted && body.action !== 'detach') fail(409, 'res-workflow-not-connected');
      let extras = {}, suspend = [], suspendTenureId, queueCommand;
      if (body.action === 'select-main') {
        let selected = await sessionFor(access, body.sessionId);
        if (!live(selected)) fail(409, 'research-collaboration-main-not-active');
        if (membership(selected)?.canonicalCwd !== access.cwd || detached(state, selected.id)) {
          await deps.join?.(access, selected.id);
          selected = await sessionFor(access, selected.id);
          if (membership(selected)?.canonicalCwd !== access.cwd) fail(409, 'research-collaboration-main-not-joined');
        }
        const verified = await deps.verifySelected?.(selected, actor);
        if (!verified?.adoptionId || !verified?.charterHash) fail(409, 'research-collaboration-binding-unavailable');
        const previous = currentOf(state);
        if (previous?.mainSessionId !== selected.id) {
          if (previous) { previous.status = 'historical'; previous.endedAt = at(); freeze(previous, allSessions().filter(row => sameScopeRow(row, state)), true); suspend = [...previous.sessionIds]; suspendTenureId = previous.id; cancelQueuedNative(state, new Set(suspend), 'main-agent-changed'); }
          const tenure = { id: `tenure-${mint()}`, ordinal: state.tenures.length + 1, mainSessionId: selected.id, startedAt: at(), status: 'current', sessionIds: [selected.id], snapshots: {}, adoptionId: verified.adoptionId, charterHash: verified.charterHash, dispatchOwnerKey: verified.ownerKey ?? access.ownerKey, importLegacy: state.tenures.length === 0 };
          delete state.detached[selected.id]; state.tenures.push(tenure); state.currentTenureId = tenure.id;
          reconcile(state); state = save(state);
        }
      } else if (body.action === 'limits') {
        for (const name of ['maxMultiAgents', 'maxSubagents']) if (!Number.isSafeInteger(body[name]) || body[name] < 1 || body[name] > COLLABORATION_LIMIT_MAXIMUMS[name]) fail(400, 'research-collaboration-limits-invalid');
        state.limits = { maxMultiAgents: body.maxMultiAgents, maxSubagents: body.maxSubagents }; state = save(state);
      } else if (body.action === 'detach') {
        const id = body.sessionId;
        if (typeof id !== 'string' || !ID.test(id)) fail(400, 'research-collaboration-session-invalid');
        const targetTenure = body.tenureId ? state.tenures.find(row => row.id === body.tenureId && row.sessionIds.includes(id)) : state.tenures.find(row => row.id === state.currentTenureId && row.sessionIds.includes(id)) ?? [...state.tenures].reverse().find(row => row.sessionIds.includes(id));
        if (body.tenureId && !targetTenure) fail(404, 'research-collaboration-tenure-not-found');
        const scopeRows = allSessions();
        const selected = targetTenure && !scopeRows.some(row => row.id === id) ? { id } : await sessionFor(access, id);
        if (!targetTenure && membership(selected)?.canonicalCwd !== state.cwd) fail(409, 'research-collaboration-session-not-joined');
        const ids = new Set([selected.id]);
        const scoped = new Map(scopeRows.filter(row => sameScopeRow(row, state)).reverse().map(row => [row.id, row]));
        const eligible = targetTenure
          ? targetTenure.sessionIds.map(id => ({ id, parentSessionId: targetTenure.snapshots?.[id]?.parentSessionId ?? (targetTenure.status === 'current' ? provenance(scoped.get(id))?.parentSessionId : undefined) }))
          : [...scoped.values()].map(row => ({ id: row.id, parentSessionId: provenance(row)?.parentSessionId }));
        for (let n = 0; n <= eligible.length; n++) { let added = false; for (const row of eligible) if (!ids.has(row.id) && ids.has(row.parentSessionId)) { ids.add(row.id); added = true; } if (!added) break; }
        if (targetTenure?.mainSessionId === selected.id) {
          for (const id of targetTenure.sessionIds) ids.add(id);
          if (targetTenure.status === 'current') freeze(targetTenure, [...scoped.values()], true);
          targetTenure.status = 'removed'; targetTenure.endedAt ??= at();
          if (state.currentTenureId === targetTenure.id) state.currentTenureId = null;
        }
        // The same conversation can have a later tenure. Removing its archived
        // role does not remove its independently selected current role.
        const allTargetIds = new Set(ids);
        if (targetTenure) targetTenure.detachedSessionIds = [...new Set([...(targetTenure.detachedSessionIds ?? []), ...allTargetIds])];
        const protectedIds = targetTenure && targetTenure.id !== state.currentTenureId ? new Set(currentOf(state)?.sessionIds ?? []) : new Set();
        for (const id of protectedIds) ids.delete(id);
        for (const id of ids) state.detached = { ...state.detached, [id]: { at: at(), tenureId: targetTenure?.id ?? null } };
        cancelQueuedNative(state, allTargetIds, 'participant-removed', targetTenure?.id);
        state = save(state); // Durable tombstone is the barrier BEFORE any await.
        suspend = [...allTargetIds];
        suspendTenureId = targetTenure?.id;
        const warnings = [];
        for (const id of ids) {
          if (!scoped.has(id)) continue;
          try { await deps.detach?.(access, id); } catch { warnings.push(`association-metadata-pending:${id}`); }
        }
        if (warnings.length) extras.warnings = warnings;
      } else if (body.action === 'native-reorder') {
        const selected = await sessionFor(access, body.sessionId);
        const verified = await deps.verifySelected?.(selected, actor);
        assertDispatchAllowed({ parent: selected, verified });
        const queued = state.nativeQueue.filter(row => row.parentSessionId === selected.id && row.tenureId === state.currentTenureId && row.status === 'queued');
        if (!Array.isArray(body.taskIds) || body.taskIds.length !== queued.length || new Set(body.taskIds).size !== queued.length || body.taskIds.some(id => !queued.some(row => row.id === id))) fail(409, 'research-native-queue-changed');
        body.taskIds.forEach((id, index) => { queued.find(row => row.id === id).rank = index + 1; });
        state = save(state);
      } else if (['reorder', 'start'].includes(body.action)) {
        const selected = await sessionFor(access, body.sessionId);
        const verified = await deps.verifySelected?.(selected, actor);
        assertDispatchAllowed({ parent: selected, verified });
        if (!deps.manageQueue) fail(503, 'research-collaboration-queue-unavailable');
        queueCommand = { body: { sessionId: selected.id, action: body.action, planId: body.planId, taskId: body.taskId, taskIds: body.taskIds, expectedRevision: body.queueRevision }, ...actor };
      } else if (body.action === 'send-main-task') {
        const current = currentOf(state);
        if (!current || current.mainSessionId !== body.sessionId) fail(409, 'research-collaboration-main-changed');
        const selected = await sessionFor(access, body.sessionId);
        if (!live(selected) || !safeText(body.text, 24000) || !ID.test(body.requestId ?? '')) fail(400, 'research-collaboration-task-invalid');
        const fingerprint = sha(body.text), previous = (state.prompts ?? []).find(row => row.requestId === body.requestId);
        if (previous && (previous.sessionId !== selected.id || previous.fingerprint !== fingerprint)) fail(409, 'research-collaboration-task-conflict');
        if (previous) {
          if (previous.status !== 'sent') fail(409, 'research-collaboration-task-delivery-unknown');
          extras.promptReceipt = { success: true, transmitted: true, promptId: previous.promptId };
        } else {
          const promptId = `research-main-task-${mint()}`;
          const receipt = { requestId: body.requestId, sessionId: selected.id, fingerprint, promptId, status: 'pending', at: at() };
          (state.prompts ??= []).push(receipt); state = save(state, false);
          let sent = false;
          try { sent = await deps.sendMainTask?.(selected.id, body.text, promptId) === true; } catch { fail(503, 'research-collaboration-task-delivery-unknown'); }
          if (!sent) fail(409, 'research-collaboration-task-not-sent');
          state.prompts.find(row => row.promptId === promptId).status = 'sent'; state = save(state, false);
          extras.promptReceipt = { success: true, transmitted: true, promptId };
        }
      } else fail(400, 'research-collaboration-action-invalid');
      await admitted(access);
      return { extras, suspend, suspendTenureId, queueCommand };
    }).then(async ({ extras, suspend, suspendTenureId, queueCommand }) => {
      // Never acquire the dispatcher lock while holding the shared admission
      // mutex: the dispatcher itself reserves slots through this service.
      if (suspend.length) await deps.suspendSessions?.(suspend, body.action === 'select-main' ? 'main-agent-changed' : 'participant-removed', suspendTenureId);
      if (queueCommand) extras.queueAction = await deps.manageQueue(queueCommand);
      await deps.onChanged?.();
      return { ...(await snapshot(access)), ...extras };
    });
  }

  /** Spawn registration may arrive after removal. Provenance is retained, but
   * the old pending intent must never silently join the workbench again. */
  function assertParticipationAllowed({ cwd, sessionId, researchSession, via }) {
    for (const state of states.values()) {
      if (state.cwd !== cwd) continue;
      if (detached(state, sessionId) && via !== 'manual') fail(409, 'research-collaboration-session-detached');
      if (!researchSession) continue;
      const tenure = state.tenures.find(row => row.id === researchSession.tenureId);
      if (detached(state, researchSession.parentSessionId) || tenure?.status === 'removed' || tenure?.detachedSessionIds?.includes(researchSession.parentSessionId) || tenure?.detachedSessionIds?.includes(sessionId)) fail(409, 'research-collaboration-session-detached');
    }
  }
  function isKnownManaged(parent) {
    if (membership(parent) || provenance(parent)) return true;
    return [...states.values()].some(state => state.cwd === parent.cwd && (detached(state, parent.id) || state.tenures.some(row => row.sessionIds.includes(parent.id))));
  }
  function retainedBinding(parent) {
    const p = provenance(parent);
    for (const state of states.values()) {
      if (!sameScopeRow(parent, state)) continue;
      const candidates = state.tenures.filter(tenure => tenure.sessionIds.includes(parent.id) && (detached(state, parent.id) || tenure.status === 'removed') && (!p?.tenureId || p.tenureId === tenure.id));
      const tenure = candidates.at(-1);
      if (!tenure?.adoptionId || !tenure.charterHash || parent.id !== tenure.mainSessionId && (p?.adoptionId !== tenure.adoptionId || p?.charterHash !== tenure.charterHash)) continue;
      return { cwd: state.cwd, ownerKey: tenure.dispatchOwnerKey ?? state.ownerKey, adoptionId: tenure.adoptionId, charterHash: tenure.charterHash };
    }
    return null;
  }

  /** A Multi-agent has ONE shared pool for native subagents and spawned child
   * sessions. This same mutex admits both paths; two independent counters would
   * allow each path to consume all three slots. Registered ids/tokens dedupe. */
  function occupied(state, parentId, { includeNative, includeSessions, excludeToken } = {}) {
    const keys = new Set();
    const observed = allSessions().filter(row => sameScopeRow(row, state));
    const completed = token => !!token && deps.isSessionCompleted?.(token) === true;
    if (includeNative) for (const row of state.nativeQueue) {
      if (row.parentSessionId !== parentId || terminalNative(row) || row.status === 'queued') continue;
      keys.add(row.childSessionId ? `session:${row.childSessionId}` : `native:${row.id}`);
    }
    if (includeSessions) {
      for (const row of observed) {
        const p = provenance(row);
        if (p?.parentSessionId !== parentId || p.workflowCwd !== state.cwd || p.spawnToken === excludeToken || completed(p.spawnToken) || !live(row) && !deps.isRecoveringSession?.(row)) continue;
        keys.add(`session:${row.id}`);
      }
      for (const reservation of state.sessionReservations ?? []) {
        if (reservation.parentSessionId !== parentId || reservation.status === 'released' || reservation.spawnToken === excludeToken || completed(reservation.spawnToken) && !reservation.reactivated) continue;
        const registered = observed.find(row => provenance(row)?.spawnToken === reservation.spawnToken);
        if (registered && ['ended', 'closed', 'archived'].includes(registered.status) && (registered.dataUnavailable !== true || registered.live === false) && !deps.isRecoveringSession?.(registered)) continue;
        keys.add(registered ? `session:${registered.id}` : `spawn:${reservation.spawnToken}`);
      }
    }
    return keys.size;
  }
  async function acquireSchedulingReservation(input) {
    return serial(() => {
      const { parent, verified, requestId, spawnToken } = input;
      if (!ID.test(requestId ?? '') || !ID.test(spawnToken ?? '')) fail(400, 'research-session-reservation-invalid');
      assertDispatchAllowed({ parent, verified });
      const settings = policy({ parent, verified });
      if (input.tenureId && input.tenureId !== settings.tenureId) fail(409, 'research-collaboration-historical-main');
      const state = copy(stateForLaunch(parent, verified));
      state.sessionReservations ??= [];
      if (input.reactivation === true) {
        const child = allSessions().find(row => sameScopeRow(row, state) && provenance(row)?.spawnToken === spawnToken);
        const childProvenance = provenance(child);
        if (!child || !live(child) || childProvenance?.parentSessionId !== parent.id || childProvenance.requestId !== requestId
            || childProvenance.tenureId && childProvenance.tenureId !== settings.tenureId) fail(409, 'research-session-resume-unavailable');
        assertDispatchAllowed({ parent: child, verified });
      }
      const existing = state.sessionReservations.find(row => row.parentSessionId === parent.id && row.requestId === requestId && row.tenureId === settings.tenureId);
      if (existing) {
        if (existing.status !== 'released') {
          if (existing.spawnToken !== spawnToken) fail(409, 'research-session-launch-recovery-required');
          if (input.reactivation !== true || existing.reactivated) return;
          // A pre-upgrade terminal receipt may already have excluded this old
          // reservation from occupancy. Re-activation must recheck native seats,
          // not treat the leftover row as a currently held execution lease.
        } else {
          if (existing.spawnToken === spawnToken && input.reactivation !== true) fail(409, 'research-session-launch-already-released');
          if (existing.spawnToken !== spawnToken && input.reactivation === true) fail(409, 'research-session-resume-unavailable');
        }
        // Only the session service's confirmed-no-spawn retry reaches this road.
        // Its durable successful/unknown request records replay or refuse before
        // acquiring another slot. A released reservation is safe to replace.
        state.sessionReservations.splice(state.sessionReservations.indexOf(existing), 1);
      }
      const active = occupied(state, parent.id, { includeSessions: true, includeNative: !settings.isMainAgent, excludeToken: spawnToken });
      const limit = settings.isMainAgent ? settings.maxMultiAgents : settings.maxSubagents;
      if (active >= limit) fail(409, 'research-session-concurrency-limit');
      state.sessionReservations.push({ parentSessionId: parent.id, requestId, spawnToken, tenureId: settings.tenureId, status: 'reserved', createdAt: at(), ...(input.reactivation === true ? { reactivated: true } : {}) });
      save(state);
    });
  }
  async function releaseSchedulingReservation(spawnToken) {
    return serial(() => {
      for (const original of states.values()) {
        const state = copy(original), row = state.sessionReservations?.find(item => item.spawnToken === spawnToken && item.status !== 'released');
        if (!row) continue;
        row.status = 'released'; row.finishedAt = at(); save(state);
      }
    });
  }

  /** Per-parent native-subagent leases span foreground/background processes.
   * No clock expiry frees an unknown process; only an authenticated release. */
  async function native(access, body, actor = {}) {
    return serial(async () => {
      await admitted(access, true);
      const parent = await sessionFor(access, body.sessionId);
      if (!ID.test(body.requestId ?? '') || !ID.test(body.attemptId ?? '') || !['subagent-acquire', 'subagent-release', 'subagent-heartbeat'].includes(body.action)) fail(400, 'research-native-request-invalid');
      const managed = isKnownManaged(parent);
      if (!managed && body.action === 'subagent-acquire') return { status: 'unmanaged' };
      // Native background helpers authenticate as the local host, while the
      // parent can belong to a named browser owner. New admissions must use the
      // parent's verified dispatch ledger, never a second host-only slot pool.
      // Cleanup locates an exact old attempt after membership was removed; the
      // existing sessionFor ownership/history admission still applies first.
      const candidates = [...states.values()].filter(item => sameScopeRow(parent, item) && item.nativeQueue.some(lease => lease.parentSessionId === parent.id && lease.requestId === body.requestId));
      const exact = candidates.filter(item => item.nativeQueue.some(lease => lease.parentSessionId === parent.id && lease.requestId === body.requestId && lease.attemptId === body.attemptId));
      if (exact.length > 1) fail(409, 'research-native-lease-ambiguous');
      let verified;
      let state = exact.length ? copy(exact[0]) : undefined;
      if (!state) {
        if (body.action !== 'subagent-acquire') fail(404, 'research-native-lease-not-found');
        if (candidates.some(item => item.nativeQueue.some(lease => lease.parentSessionId === parent.id && lease.requestId === body.requestId && !terminalNative(lease)))) fail(409, 'subagent-launch-recovery-required');
        verified = await deps.verifySelected?.(parent, actor);
        assertDispatchAllowed({ parent, verified });
        state = copy(stateForLaunch(parent, verified));
      }
      let row = state.nativeQueue.find(item => item.parentSessionId === parent.id && item.requestId === body.requestId);
      if (row && row.attemptId !== body.attemptId && !terminalNative(row)) fail(409, 'subagent-launch-recovery-required');
      if (body.action === 'subagent-release') {
        if (!row || row.attemptId !== body.attemptId) fail(404, 'research-native-lease-not-found');
        if (terminalNative(row)) return { status: 'released' };
        if (row.status !== 'queued' && row.leaseToken !== body.leaseToken) fail(409, 'research-native-lease-token-invalid');
        row.status = row.status === 'queued' ? 'cancelled' : 'released'; row.finishedAt = at(); save(state);
        return { status: 'released' };
      }
      if (body.action === 'subagent-heartbeat') {
        if (!row || row.attemptId !== body.attemptId || !row.leaseToken || row.leaseToken !== body.leaseToken || terminalNative(row) || row.status === 'queued') fail(409, 'research-native-lease-token-invalid');
        if (!['launching', 'running'].includes(body.phase)) fail(400, 'research-native-phase-invalid');
        if (body.phase === 'launching') { const verified = await deps.verifySelected?.(parent, actor); assertDispatchAllowed({ parent, verified }); if (row.tenureId !== policy({ parent, verified }).tenureId) fail(409, 'research-collaboration-historical-main'); }
        if (body.childSessionId !== undefined && !ID.test(body.childSessionId)) fail(400, 'research-native-child-invalid');
        if (body.model !== undefined && !safeText(body.model, 256)) fail(400, 'research-native-metadata-invalid');
        row.status = body.phase; row.lastSeenAt = at(); if (body.childSessionId) row.childSessionId = body.childSessionId; if (body.model) row.model = body.model;
        save(state, false); return { status: 'acquired', leaseToken: row.leaseToken, tenureId: row.tenureId };
      }
      if (row && row.attemptId === body.attemptId && !terminalNative(row) && row.status !== 'queued') return { status: 'acquired', leaseToken: row.leaseToken, tenureId: row.tenureId };
      if (row && row.attemptId === body.attemptId && terminalNative(row)) fail(409, 'research-native-attempt-ended');
      verified ??= await deps.verifySelected?.(parent, actor);
      assertDispatchAllowed({ parent, verified });
      const settings = policy({ parent, verified });
      if (row?.status === 'queued' && row.tenureId !== settings.tenureId) fail(409, 'research-collaboration-historical-main');
      let changed = false;
      if (!row || row.attemptId !== body.attemptId) {
        if (body.role !== undefined && !safeText(body.role, 128) || body.model !== undefined && !safeText(body.model, 256) || body.task !== undefined && !safeText(body.task, 4000)) fail(400, 'research-native-metadata-invalid');
        const replacement = { id: `native-${mint()}`, requestId: body.requestId, attemptId: body.attemptId, kind: 'subagent', parentSessionId: parent.id, tenureId: settings.tenureId, role: body.role ?? 'subagent', ...(body.model ? { model: body.model } : {}), ...(body.task ? { task: body.task } : {}), status: 'queued', rank: Math.max(0, ...state.nativeQueue.filter(item => item.parentSessionId === parent.id).map(item => item.rank)) + 1, createdAt: at() };
        if (row) state.nativeQueue.splice(state.nativeQueue.indexOf(row), 1);
        row = replacement; state.nativeQueue.push(row); changed = true;
      }
      const active = occupied(state, parent.id, { includeNative: true, includeSessions: !settings.isMainAgent });
      const waiting = state.nativeQueue.filter(item => item.parentSessionId === parent.id && item.status === 'queued').sort((a, b) => a.rank - b.rank);
      const position = waiting.indexOf(row);
      if (active < settings.maxSubagents && position === 0) {
        row.status = 'launching'; row.leaseToken = mint(); row.startedAt = at(); row.lastSeenAt = at();
        delete row.queueReason; save(state);
        return { status: 'acquired', leaseToken: row.leaseToken, tenureId: row.tenureId };
      }
      if (row.queueReason !== 'subagent-capacity') { row.queueReason = 'subagent-capacity'; changed = true; }
      if (changed) save(state, !states.get(scopeKey(state))?.nativeQueue.some(item => item.id === row.id));
      return { status: 'queued', position: position + 1, retryAfterMs: 1000 };
    });
  }
  return { snapshot, mutate, native, getSchedulingPolicy: policy, assertDispatchAllowed, assertParticipationAllowed, isKnownManaged, retainedBinding, acquireSchedulingReservation, releaseSchedulingReservation };
}
