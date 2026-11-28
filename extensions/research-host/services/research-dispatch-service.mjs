/** Durable bounded DAG execution. The model chooses semantic boundaries; this
 * executor owns process creation, dependencies, authenticated receipts and recovery. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResearchSessionError, RESEARCH_SESSION_LIMITS, RESEARCH_SESSION_STAGES, researchProvenanceOf, validateResearchTasks, readResearchSchedulingPolicy, researchParentConcurrency } from './research-session-service.mjs';

export const RESEARCH_DISPATCH_LIMITS = Object.freeze({ maxTasks: 64, maxConcurrency: 64, maxPlans: 512, maxPlanBytes: 2 * 1024 * 1024, registrationGraceMs: 120_000, receiptRetryMs: 30_000 });
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const ACTIVE = new Set(['launching', 'running', 'recovery-required']);
const TRANSIENT_ADMISSION = new Set(['research-session-concurrency-limit', 'research-session-capacity-limit', 'research-session-resident-limit', 'research-session-memory-limit', 'research-session-resource-budget-unavailable']);
const ENDED = new Set(['ended', 'closed', 'archived']);
/** Shared mailbox/roster state. Terminal task or session state takes precedence. */
export function researchDispatchPeerState(task, session) {
  if (TERMINAL.has(task?.status) || ENDED.has(session?.status) || Number.isFinite(session?.archivedAt)) return 'ended';
  if (task?.status === 'queued') return 'queued';
  return ACTIVE.has(task?.status) ? 'in_progress' : 'ended';
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code) => { throw new ResearchSessionError(status, code); };
const string = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const scopeMatches = (plan, verified) => plan.cwd === verified.cwd && plan.charterHash === verified.charterHash && plan.adoptionId === verified.adoptionId && plan.ownerKey === verified.ownerKey;
const clone = value => structuredClone(value);
const taskOrder = plan => {
  const order = new Map((plan.queueOrder ?? plan.tasks.map(task => task.id)).map((id, index) => [id, index]));
  return [...plan.tasks].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
};
// Optimistic queue revisions do not change on heartbeats, receipt acks, or a
// preflight reservation that returns to queued without creating a process.
// Mutation calls serialize behind launching; its eventual running/unknown
// outcome changes the revision before a stale drag can commit.
const queueSignature = plan => JSON.stringify([plan.schedulingPaused === true, taskOrder(plan).filter(task => task.status === 'queued' || task.status === 'launching').map(task => task.id)]);

/** The ledger is host-private, outside the project. Receipts are stored once;
 * 2 MiB covers every permitted UTF-8 task/summary/path combination in a plan. */
export function createResearchDispatchStore(directory) {
  function safeDirectory() {
    const resolved = path.resolve(directory);
    let cursor = path.parse(resolved).root;
    for (const part of resolved.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(503, 'research-dispatch-store-unsafe');
    }
    fs.chmodSync(resolved, 0o700);
    return resolved;
  }
  return {
    readAll() {
      const dir = safeDirectory();
      const names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (names.length > RESEARCH_DISPATCH_LIMITS.maxPlans) fail(503, 'research-dispatch-store-capacity');
      return names.map(name => {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RESEARCH_DISPATCH_LIMITS.maxPlanBytes) fail(503, 'research-dispatch-store-unsafe');
        const row = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!object(row) || row.schema !== 'pi-research-dispatch.v1' || !ID.test(row.id) || !ID.test(row.parentSessionId) || !Array.isArray(row.tasks)) fail(503, 'research-dispatch-store-invalid');
        return row;
      });
    },
    write(row) {
      const dir = safeDirectory(), filename = hash(row.id) + '.json';
      const file = path.join(dir, filename), temporary = path.join(dir, filename + '.tmp');
      for (const candidate of [file, temporary]) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) fail(503, 'research-dispatch-store-unsafe');
      const serialized = JSON.stringify(row);
      if (Buffer.byteLength(serialized) > RESEARCH_DISPATCH_LIMITS.maxPlanBytes) fail(503, 'research-dispatch-store-too-large');
      const descriptor = fs.openSync(temporary, 'w', 0o600);
      try { fs.fchmodSync(descriptor, 0o600); fs.writeFileSync(descriptor, serialized); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file);
      const directoryDescriptor = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    },
  };
}

export function createResearchDispatchService(deps) {
  const now = deps.now ?? (() => new Date());
  const plans = new Map((deps.store?.readAll() ?? []).map(row => [row.id, clone(row)]));
  // Native registration can confirm without changing the task's stored session id.
  const peerMailboxStates = new Map();
  const settledReservations = new Set();
  const releaseReservation = async token => {
    if (!token || settledReservations.has(token)) return;
    await deps.releaseSession?.(token); settledReservations.add(token);
  };
  const startedAt = now().getTime();
  const graceMs = deps.registrationGraceMs ?? RESEARCH_DISPATCH_LIMITS.registrationGraceMs;
  const isRecoveringSession = session => session?.dataUnavailable === true && ENDED.has(session.status) && session?.live !== false;
  let tail = Promise.resolve(), disposed = false;
  const assertOpen = () => { if (disposed) fail(503, 'research-dispatch-service-closed'); };
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const sessions = () => deps.listSessions();
  // Copy-on-write: a failed disk write must not mutate in-memory truth or free a slot.
  const persist = plan => {
    assertOpen();
    const previous = plans.get(plan.id);
    const revision = previous ? (previous.revision ?? 1) + (queueSignature(previous) === queueSignature(plan) ? 0 : 1) : 1;
    const saved = clone({ ...plan, revision, updatedAt: now().toISOString() });
    deps.store?.write(saved); plans.set(saved.id, saved); synchronizePeerMailboxes(saved);
    // The caller continues from the same copy after each durable state change.
    plan.revision = revision;
    return saved;
  };
  const ownerPrincipal = session => deps.principalForSession ? deps.principalForSession(session) : session?.principalOwner ?? null;
  const activeFor = (sessionId, verified, tenureId) => [...plans.values()].filter(row => row.parentSessionId === sessionId && row.kind === 'plan' && !TERMINAL.has(row.status) && (!verified || scopeMatches(row, verified)) && (!tenureId || row.tenureId === tenureId));
  const publicPlan = (plan, compact = false) => ({ id: plan.id, clientPlanId: plan.clientPlanId, mode: plan.mode ?? 'tasks', parentSessionId: plan.parentSessionId, rootSessionId: plan.rootSessionId,
    ...(plan.tenureId ? { tenureId: plan.tenureId } : {}), revision: plan.revision ?? 1, status: plan.status,
    concurrency: plan.effectiveConcurrency ?? plan.concurrency, requestedConcurrency: plan.concurrency, schedulingPaused: plan.schedulingPaused === true,
    ...(plan.readOnly === true ? { readOnly: true } : {}), error: plan.error, suspendedReason: plan.suspendedReason,
    tasks: taskOrder(plan).map((row, index) => {
      if (!compact) return { ...row, rank: row.rank ?? index, queueRank: index };
      const { summary: _summary, evidence: _evidence, task, ...state } = row;
      const characters = Array.from(task);
      return { ...state, task: characters.slice(0, 240).join(''), taskTruncated: characters.length > 240, rank: row.rank ?? index, queueRank: index };
    }), createdAt: plan.createdAt, updatedAt: plan.updatedAt });
  const matchesTask = (plan, task, child) => {
    const p = researchProvenanceOf(child);
    return p && (p.spawnToken === task.spawnToken || p.requestId === task.requestId) && p.parentSessionId === plan.parentSessionId && p.adoptionId === plan.adoptionId && p.charterHash === plan.charterHash && p.workflowCwd === plan.cwd && (!plan.tenureId || p.tenureId === plan.tenureId || plan.importedLegacy === true && !p.tenureId);
  };
  const childFor = (plan, task) => sessions().find(child => child.nativeRegistrationConfirmed !== false && matchesTask(plan, task, child));

  // Internal metadata lookup only. Formal dispatch identity is required even
  // when historical direct children share a parent and matching request tokens.
  function formalPeerSession(plan, task, session) {
    const p = researchProvenanceOf(session);
    return session?.nativeRegistrationConfirmed !== false && p?.dispatchId === plan.id && p?.taskId === task.id
      && p.parentSessionId === plan.parentSessionId && p.workflowCwd === plan.cwd
      && p.charterHash === plan.charterHash && p.adoptionId === plan.adoptionId
      && (p.tenureId ?? null) === (plan.tenureId ?? null)
      && (!task.sessionId || task.sessionId === session.id)
      && (!!task.spawnToken && p.spawnToken === task.spawnToken || !!task.requestId && p.requestId === task.requestId);
  }
  function peerTask(plan, task, availableSessions) {
    const storedSessionId = ID.test(task.sessionId ?? '') ? task.sessionId : null;
    let session = null;
    if (task.status !== 'queued') {
      const stored = storedSessionId ? deps.getSession(storedSessionId) : null;
      if (stored && formalPeerSession(plan, task, stored)) session = stored;
      if (!session && storedSessionId) {
        // History proves retirement only. Read the exact recorded identity and
        // never turn an archived summary into live participation authority.
        session = deps.history?.().find(row => row.id === storedSessionId && row.cwd === plan.cwd
          && Number.isFinite(row.archivedAt) && formalPeerSession(plan, task, row));
      }
      if (!session && !storedSessionId && ACTIVE.has(task.status)) {
        session = (availableSessions ?? sessions()).find(row => formalPeerSession(plan, task, row));
      }
    }
    const state = researchDispatchPeerState(task, session);
    const sessionId = session?.id ?? (TERMINAL.has(task.status) ? storedSessionId : null);
    return { taskId: task.id, role: task.role, stage: task.stage, state, rawStatus: task.status,
      waitingReason: task.waitingReason ?? null,
      registration: sessionId ? 'registered' : task.launchedAt ? 'pending' : 'not-started',
      sessionId,
      communicatable: { message: state === 'in_progress' ? true : state === 'queued' ? 'deferred' : false,
        request: state === 'in_progress' } };
  }
  function getPeerContext(sessionId) {
    const session = deps.getSession(sessionId), p = researchProvenanceOf(session);
    if (session?.nativeRegistrationConfirmed === false || !ID.test(p?.dispatchId ?? '') || !ID.test(p?.taskId ?? '')) return null;
    const plan = plans.get(p.dispatchId), task = plan?.tasks.find(row => row.id === p.taskId);
    if (!plan || plan.kind !== 'plan' || !task || !formalPeerSession(plan, task, session)) return null;
    const availableSessions = sessions(), own = peerTask(plan, task, availableSessions);
    if (own.sessionId !== sessionId) return null;
    return { plan: { id: plan.id, parentSessionId: plan.parentSessionId, rootSessionId: plan.rootSessionId,
      tenureId: plan.tenureId ?? null, cwd: plan.cwd, ownerKey: plan.ownerKey,
      charterHash: plan.charterHash, adoptionId: plan.adoptionId }, task: own, state: own.state,
      peers: plan.tasks.filter(row => row.id !== task.id).map(row => peerTask(plan, row, availableSessions)) };
  }
  function getPeerTask({ planId, taskId }) {
    const plan = plans.get(planId), task = plan?.tasks.find(row => row.id === taskId);
    return plan?.kind === 'plan' && task ? peerTask(plan, task) : null;
  }
  function synchronizePeerMailboxes(plan) {
    if (plan.kind !== 'plan') return;
    const availableSessions = sessions();
    for (const task of plan.tasks) {
      const target = peerTask(plan, task, availableSessions);
      const key = plan.id + ':' + task.id;
      const state = target.state === 'ended' ? 'ended' : target.sessionId ? 'session:' + target.sessionId : null;
      const previous = peerMailboxStates.get(key);
      peerMailboxStates.set(key, state);
      if (!state || state === previous) continue;
      let operation;
      if (target.state === 'ended') {
        operation = () => deps.expireDeferredPeerMessages?.({ planId: plan.id, taskId: task.id });
      } else {
        operation = () => deps.bindDeferredPeerMessages?.({ planId: plan.id, taskId: task.id, sessionId: target.sessionId });
      }
      // Communication may itself await dispatch reporting. Enqueue without
      // awaiting its serialization lane. Its inbox/tick repairs durable mailboxes.
      if (operation) Promise.resolve().then(operation).catch(() => {});
    }
  }
  const terminalize = (task, status, error) => { task.status = status; task.error = error; task.finishedAt = now().toISOString(); };
  function acknowledge(plan, promptId) {
    const copy = clone(plan), at = now().toISOString();
    let changed = false;
    if (TERMINAL.has(copy.status) && !copy.notifiedAt && copy.notificationId === promptId) {
      copy.notifiedAt = at; changed = true;
    }
    for (const task of copy.tasks) if (task.notificationId && !task.notifiedAt && TERMINAL.has(task.status)
        && (task.notificationId === promptId || copy.notificationId === promptId)) {
      task.notifiedAt = at; changed = true;
    }
    if (changed) persist(copy);
  }

  function upstreamStopped(session, rootSessionId) {
    const seen = new Set();
    let current = session;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.id === rootSessionId) return false;
      const provenance = researchProvenanceOf(current);
      if (!provenance) return false;
      for (const plan of plans.values()) {
        if (plan.kind !== 'plan') continue;
        const assignment = plan.tasks.find(task => matchesTask(plan, task, current));
        if (assignment && TERMINAL.has(assignment.status)) return true;
      }
      current = deps.getSession(provenance.parentSessionId);
    }
    return false;
  }
  function blockPending(plan, code) {
    for (const task of plan.tasks) if (!TERMINAL.has(task.status)) {
      if (ACTIVE.has(task.status) && !childFor(plan, task)) task.processUnconfirmed = true;
      terminalize(task, 'blocked', code);
    }
  }
  function suspendPending(plan, code) {
    for (const task of plan.tasks) if (task.status === 'queued') terminalize(task, 'blocked', code);
    plan.suspendedReason = code;
    plan.error = code;
    if (plan.tasks.every(task => TERMINAL.has(task.status))) {
      plan.status = plan.tasks.every(task => task.status === 'completed') ? 'completed' : plan.tasks.some(task => task.status === 'failed') ? 'failed' : 'blocked';
      plan.finishedAt ??= now().toISOString();
    }
    return persist(plan);
  }

  async function authorize(input) {
    assertOpen();
    if (!object(input.body) || !ID.test(input.body.sessionId ?? '')) fail(400, 'research-dispatch-session-invalid');
    const verified = await deps.authorize({ sessionId: input.body.sessionId, principal: input.principal, expiresAt: input.expiresAt });
    assertOpen(); return verified;
  }
  function depthInTenure(parent, mainSessionId) {
    if (!mainSessionId) return researchProvenanceOf(parent)?.depth ?? 0;
    const seen = new Set(); let current = parent, depth = 0;
    while (current && !seen.has(current.id)) {
      if (current.id === mainSessionId) return depth;
      seen.add(current.id);
      current = deps.getSession(researchProvenanceOf(current)?.parentSessionId); depth++;
    }
    return researchProvenanceOf(parent)?.depth ?? 0;
  }
  async function importLegacyOwnPlans(verified, policy) {
    if (!policy?.importLegacy || !policy.tenureId) return;
    // Only an explicitly selected first tenure may claim a proven old subtree.
    // Reading another root's history never reparents its work implicitly.
    try { await deps.assertDispatchAllowed?.({ parent: verified.parent, verified }); } catch { return; }
    for (const previous of plans.values()) {
      if (previous.parentSessionId !== verified.parent.id || !scopeMatches(previous, verified) || previous.tenureId) continue;
      persist({ ...previous, tenureId: policy.tenureId, importedLegacy: true, legacyRootSessionId: previous.rootSessionId,
        rootSessionId: policy.mainSessionId ?? previous.rootSessionId, depth: depthInTenure(verified.parent, policy.mainSessionId) });
    }
  }
  // Both entry points use the same ledger and scheduler. Only this internal
  // objective builder may construct a one-task plan: the caller cannot choose
  // its role, task id, concurrency or dependency shape.
  function createDelegatedObjective(verified, body) {
    const allowed = new Set(['sessionId', 'action', 'planId', 'task', 'stage', 'readOnly']);
    if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'research-dispatch-unknown-field');
    if (!string(body.task, RESEARCH_SESSION_LIMITS.maxTaskChars)) fail(400, 'research-dispatch-task-invalid');
    if (!RESEARCH_SESSION_STAGES.includes(body.stage)) fail(400, 'research-dispatch-stage-invalid');
    const tasks = [{ id: 'coordinator', role: 'research-coordinator', task: body.task, stage: body.stage, dependsOn: [] }];
    return createPlanFromTasks(verified, tasks, body.planId, 1, 'tool', 'delegate', body.readOnly);
  }
  function createPlan(verified, tasks, planId, concurrency, source, readOnly) {
    return createPlanFromTasks(verified, validateResearchTasks(tasks), planId, concurrency, source, 'tasks', readOnly);
  }
  async function createPlanFromTasks(verified, normalized, planId, concurrency, source, mode, requestedReadOnly) {
    await deps.assertDispatchAllowed?.({ parent: verified.parent, verified });
    const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
    await importLegacyOwnPlans(verified, policy);
    if (upstreamStopped(verified.parent, policy?.mainSessionId)) fail(409, 'research-dispatch-upstream-terminal');
    if (!ID.test(planId ?? '')) fail(400, 'research-dispatch-plan-id-invalid');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > RESEARCH_DISPATCH_LIMITS.maxConcurrency) fail(400, 'research-dispatch-concurrency-invalid');
    const provenance = researchProvenanceOf(verified.parent);
    const readOnly = requestedReadOnly === true || provenance?.readOnly === true;
    // Preserve replay of pre-mode ordinary plans. New delegation and narrowed
    // plans fingerprint their mode/constraint, so a retry cannot change either.
    const fingerprint = hash(JSON.stringify(mode === 'tasks' && !readOnly ? [normalized, concurrency] : [{ mode, readOnly }, normalized, concurrency]));
    const id = 'dispatch-' + hash(JSON.stringify([verified.ownerKey, verified.cwd, verified.adoptionId, verified.charterHash, verified.parent.id, planId, ...(policy?.tenureId ? [policy.tenureId] : [])])).slice(0, 40);
    const existing = plans.get(id) ?? [...plans.values()].find(plan => plan.kind === 'plan' && plan.importedLegacy && plan.clientPlanId === planId && plan.parentSessionId === verified.parent.id && plan.tenureId === policy?.tenureId && scopeMatches(plan, verified));
    if (existing) {
      if (!scopeMatches(existing, verified) || (existing.mode ?? 'tasks') !== mode || existing.fingerprint !== fingerprint) fail(409, 'research-dispatch-idempotency-conflict');
      return existing;
    }
    if (activeFor(verified.parent.id, verified, policy?.tenureId).length) fail(409, 'research-dispatch-plan-already-active');
    const depth = depthInTenure(verified.parent, policy?.mainSessionId);
    if (depth >= RESEARCH_SESSION_LIMITS.maxDepth) fail(409, 'research-session-depth-limit');
    const rootSessionId = policy?.mainSessionId ?? provenance?.rootSessionId ?? verified.parent.id;
    // Per-request payload/storage limits remain bounded. Completed work does
    // not consume a lifetime research budget or prevent the next queue.
    if (deps.maxRootTasks !== undefined) {
      const reserved = [...plans.values()].filter(row => row.kind === 'plan' && row.rootSessionId === rootSessionId && scopeMatches(row, verified) && (!policy?.tenureId || row.tenureId === policy.tenureId)).reduce((sum, row) => sum + row.tasks.length, 0);
      if (reserved + normalized.length > deps.maxRootTasks) fail(409, 'research-dispatch-budget-limit');
    }
    if (plans.size >= RESEARCH_DISPATCH_LIMITS.maxPlans) fail(409, 'research-dispatch-store-capacity');
    const plan = {
      schema: 'pi-research-dispatch.v1', kind: 'plan', id, clientPlanId: planId, parentSessionId: verified.parent.id, rootSessionId,
      cwd: verified.cwd, ownerKey: verified.ownerKey, adoptionId: verified.adoptionId, charterHash: verified.charterHash,
      fingerprint, source, mode, ...(readOnly ? { readOnly: true } : {}), ...(policy?.tenureId ? { tenureId: policy.tenureId } : {}), depth, concurrency,
      effectiveConcurrency: researchParentConcurrency(verified.parent, policy, concurrency), revision: 1, queueOrder: normalized.map(task => task.id), status: 'running', createdAt: now().toISOString(),
      tasks: normalized.map(task => ({ ...task, status: 'queued', requestId: 'dispatch-' + hash(id + ':' + task.id).slice(0, 40) })),
    };
    return persist(plan);
  }

  async function discoverAssignments() {
    for (const session of sessions()) {
      const p = researchProvenanceOf(session);
      if (!p?.tasks || !ID.test(session.id ?? '') || ENDED.has(session.status)) continue;
      const planId = 'assignment-' + hash(p.spawnToken).slice(0, 40);
      if ([...plans.values()].some(row => row.parentSessionId === session.id && row.source === planId && row.adoptionId === p.adoptionId && row.charterHash === p.charterHash)) continue;
      try {
        const verified = await deps.authorize({ sessionId: session.id, principal: ownerPrincipal(session), expiresAt: null });
        if (verified.charterHash !== p.charterHash || verified.adoptionId !== p.adoptionId || verified.cwd !== p.workflowCwd) continue;
        const policy = await readResearchSchedulingPolicy(deps, session, verified);
        if (policy?.mainSessionId === session.id || p.tenureId && policy?.tenureId && p.tenureId !== policy.tenureId) continue;
        await createPlan(verified, p.tasks, planId, 2, planId);
      } catch (error) {
        const refused = error instanceof ResearchSessionError || Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500 && /^[a-z0-9-]+$/.test(error.code ?? '');
        if (!refused) throw error;
        // A historical/detached worker may still return its in-flight result.
        // Refusing NEW nested work must not fabricate a failed old receipt.
        if (['research-collaboration-main-not-selected', 'research-collaboration-not-current', 'research-collaboration-detached', 'research-dispatch-tenure-changed'].includes(error.code) || /(?:historical|detached|tenure)/.test(error.code)) continue;
        // A refused nested plan becomes a truthful failed assignment, not an
        // invisible gate that waits forever. No process is relaunched here.
        for (const saved of plans.values()) {
          if (saved.kind !== 'plan') continue;
          const plan = clone(saved), task = plan.tasks.find(row => matchesTask(plan, row, session));
          if (task && !TERMINAL.has(task.status)) { terminalize(task, 'blocked', error.code); persist(plan); }
        }
      }
    }
  }

  async function advance() {
    if (disposed) return;
    // A report write and a shared-pool release are separate durable operations.
    // Retry the latter after a crash/error without inventing process termination
    // for cancelled or unregistered work.
    for (const plan of plans.values()) for (const task of plan.tasks ?? []) if (task.reportedAt || task.error === 'research-dispatch-worker-ended-without-report') await releaseReservation(task.spawnToken);
    await discoverAssignments();
    if (disposed) return;
    // Drain deeper work first; waiting coordinators use resident capacity, not
    // runnable-worker slots. This prevents a tree of coordinators starving leaves.
    const ordered = [...plans.values()].filter(row => row.kind === 'plan').sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
    for (const saved of ordered) {
      if (disposed) return;
      // Already-terminal and already-notified historical plans need no per-tick
      // re-authorization; skipping them avoids O(history) synchronous disk stalls.
      if (TERMINAL.has(saved.status) && (saved.notifiedAt || !deps.notifyParent)) continue;
      let plan = clone(plans.get(saved.id));
      const parent = deps.getSession(plan.parentSessionId);
      if (!parent && now().getTime() - startedAt < graceMs) continue;
      if (isRecoveringSession(parent)) {
        // The server restores disconnected processes as ended/dataUnavailable.
        // A grace timer cannot convert that placeholder into witnessed exit.
        if (now().getTime() - startedAt >= graceMs && !TERMINAL.has(plan.status)) {
          plan.error = 'research-dispatch-coordinator-recovery-required'; persist(plan);
        }
        continue;
      }
      let verified, policy;
      try {
        verified = await deps.authorize({ sessionId: plan.parentSessionId, principal: ownerPrincipal(parent), expiresAt: null });
        if (disposed) return;
        if (!scopeMatches(plan, verified)) fail(409, 'research-dispatch-scope-changed');
        if (ENDED.has(parent?.status)) fail(409, 'research-dispatch-coordinator-ended');
        policy = await readResearchSchedulingPolicy(deps, parent, verified);
        await importLegacyOwnPlans(verified, policy);
        plan = clone(plans.get(plan.id));
        if (upstreamStopped(parent, plan.rootSessionId) && !TERMINAL.has(plan.status)) fail(409, 'research-dispatch-upstream-terminal');
      } catch (error) {
        if (!TERMINAL.has(plan.status)) {
          const code = error?.code ?? 'research-dispatch-owner-unavailable';
          if (/(?:historical|detached|tenure)/.test(code)) suspendPending(plan, code);
          else {
            // Explicit cancellation, scope loss and witnessed coordinator loss
            // retain their pre-existing terminal ledger contract. Lifecycle
            // switches use the separate pending-only suspension below.
            plan.error = code; blockPending(plan, code);
            plan.status = 'blocked'; plan.finishedAt = now().toISOString(); persist(plan);
          }
        }
        continue; // Never deliver old-scope receipts into a new adoption.
      }
      if (!TERMINAL.has(plan.status)) {
        if (!plan.suspendedReason) delete plan.error;
        plan.effectiveConcurrency = researchParentConcurrency(parent, policy, plan.concurrency);
        const release = [];
        for (const task of plan.tasks) {
          if (!ACTIVE.has(task.status)) continue;
          const child = childFor(plan, task);
          const pendingRegistration = sessions().find(row => row.nativeRegistrationConfirmed === false && matchesTask(plan, task, row));
          if (child) {
            if (isRecoveringSession(child)) {
              if (now().getTime() - startedAt >= graceMs) { task.status = 'recovery-required'; task.error = 'research-dispatch-worker-recovery-required'; }
              continue;
            }
            task.spawnToken = researchProvenanceOf(child).spawnToken; task.sessionId = child.id;
            task.registeredAt ??= now().toISOString();
            if (ENDED.has(child.status)) {
              const resumingRecently = task.reopenResuming === true && task.reopenedAt
                && (now().getTime() - Date.parse(task.reopenedAt) < graceMs);
              if (!resumingRecently) {
                delete task.reopenResuming;
                terminalize(task, 'failed', 'research-dispatch-worker-ended-without-report');
                release.push(task.spawnToken);
              }
            } else {
              task.status = 'running';
              task.lastSeenAt = now().toISOString();
              delete task.error;
              delete task.reopenResuming;
              if (task.pendingReopenPrompt && deps.notifyParent) {
                const { promptId, text } = task.pendingReopenPrompt;
                if (await deps.notifyParent(child.id, text, promptId)) {
                  delete task.pendingReopenPrompt;
                }
              }
            }
          } else if (pendingRegistration) {
            task.status = 'recovery-required'; task.error = 'research-dispatch-native-registration-unconfirmed';
          } else {
            task.launchedAt ??= task.createdAt ?? plan.createdAt;
            const missingSince = task.lastSeenAt ?? task.launchedAt;
            if (now().getTime() - Math.max(Date.parse(missingSince), startedAt) >= graceMs) {
              terminalize(task, 'blocked', task.registeredAt ? 'research-dispatch-worker-lost-without-report' : 'research-dispatch-registration-unconfirmed');
              // Unknown process outcomes retain their reservation. A blocked
              // scientific result is not proof that an unseen process exited.
              task.processUnconfirmed = true;
            } else if (task.status === 'launching') { task.status = 'recovery-required'; task.error = 'research-dispatch-launch-outcome-unknown'; }
          }
        }
        persist(plan);
        for (const token of release) await releaseReservation(token);
        for (const task of taskOrder(plan)) {
          if (disposed) return;
          if (plan.schedulingPaused) break;
          if (task.status !== 'queued') continue;
          delete task.waitingReason;
          if (TRANSIENT_ADMISSION.has(task.error)) delete task.error;
          const dependencies = task.dependsOn.map(id => plan.tasks.find(row => row.id === id));
          if (dependencies.some(row => row.status === 'failed' || row.status === 'blocked')) { terminalize(task, 'blocked', 'research-dispatch-dependency-failed'); continue; }
          if (dependencies.some(row => row.status !== 'completed')) { task.waitingReason = 'dependencies'; continue; }
          if (plan.tasks.filter(row => ACTIVE.has(row.status)).length >= plan.effectiveConcurrency) { task.waitingReason = 'capacity'; continue; }
          // Current-tenure authority is independent of receipt authority.
          // A switch or detach cancels only tasks that have not launched.
          try {
            await deps.assertDispatchAllowed?.({ parent, verified });
            policy = await readResearchSchedulingPolicy(deps, parent, verified);
            if (plan.tenureId && policy?.tenureId !== plan.tenureId) fail(409, 'research-dispatch-tenure-changed');
            plan.effectiveConcurrency = researchParentConcurrency(parent, policy, plan.concurrency);
            if (plan.tasks.filter(row => ACTIVE.has(row.status)).length >= plan.effectiveConcurrency) { task.waitingReason = 'capacity'; continue; }
          } catch (error) {
            if (error?.code === 'research-collaboration-main-not-selected') {
              task.waitingReason = 'main-agent-not-selected'; task.error = error.code;
              continue;
            }
            suspendPending(plan, error?.code ?? 'research-dispatch-not-current');
            break;
          }
          // A preflight denial proves no process has been attempted. Settle it
          // before creating a durable launch reservation, including foreign
          // typed permission errors from the host adapter.
          try { await deps.beforeLaunch?.({ parent, verified, planId: plan.id }); }
          catch (error) {
            if (disposed) return;
            const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(error.code) ? error.code : 'research-dispatch-preflight-blocked';
            if (TRANSIENT_ADMISSION.has(code)) { task.waitingReason = code; task.error = code; }
            else terminalize(task, 'blocked', code);
            persist(plan); continue;
          }
          if (disposed) return;
          task.status = 'launching'; task.launchedAt = now().toISOString(); delete task.waitingReason;
          persist(plan); // Reserve durably before crossing the process boundary.
          try {
            assertOpen();
            const result = await deps.createSession({
              body: { parentSessionId: plan.parentSessionId, role: task.role, task: task.task, stage: task.stage, requestId: task.requestId, ...(plan.readOnly === true ? { readOnly: true } : {}) },
              principal: ownerPrincipal(parent), expiresAt: null,
              taskContext: { dispatchId: plan.id, taskId: task.id, prerequisiteResults: dependencies.map(row => ({ id: row.id, summary: row.summary, evidence: row.evidence ?? [] })) },
            });
            task.status = 'running'; task.spawnToken = result.spawnToken;
            const child = childFor(plan, task); if (child) { task.sessionId = child.id; task.registeredAt = now().toISOString(); }
            delete task.error;
          } catch (error) {
            const code = error?.code ?? 'research-dispatch-launch-outcome-unknown';
            if (TRANSIENT_ADMISSION.has(code)) { task.status = 'queued'; task.waitingReason = code; delete task.launchedAt; }
            else if (code === 'research-session-spawn-failed') terminalize(task, 'failed', code);
            else if (code.includes('unknown') || code === 'research-session-spawn-in-progress' || !(error instanceof ResearchSessionError)) task.status = 'recovery-required';
            else terminalize(task, 'blocked', code);
            task.error = code;
          }
          persist(plan);
        }
        if (plan.tasks.every(task => TERMINAL.has(task.status))) {
          plan.status = plan.tasks.every(task => task.status === 'completed') ? 'completed' : plan.tasks.some(task => task.status === 'failed') ? 'failed' : 'blocked';
          plan.finishedAt = now().toISOString();
        }
        persist(plan);
      }
      if (!TERMINAL.has(plan.status) && deps.notifyParent) {
        for (const task of plan.tasks) {
          if (!TERMINAL.has(task.status) || task.notifiedAt) continue;
          if (task.notificationSentAt && now().getTime() - Date.parse(task.notificationSentAt) < RESEARCH_DISPATCH_LIMITS.receiptRetryMs) continue;
          const promptId = task.notificationId ?? 'research-dispatch-receipt-dispatch-' + hash(JSON.stringify([plan.id, task.id, task.reportedAt ?? task.finishedAt])).slice(0, 40);
          task.notificationId = promptId;
          persist(plan);
          // Child text stays in tool results, outside the user-input permission lane.
          const message = `[research_dispatch receipt ${promptId}] Plan ${plan.id} has a ${task.status} task delivery. Read research_dispatch status for the saved task summary and evidence, then verify that evidence before acceptance. Other tasks continue autonomously. Do not repeat completed work.`;
          if (await deps.notifyParent(plan.parentSessionId, message, promptId)) { task.notificationSentAt = now().toISOString(); persist(plan); }
        }
      }
      // The final plan signal also covers its last task, avoiding two wakeups.
      if (TERMINAL.has(plan.status) && !plan.notifiedAt && deps.notifyParent) {
        if (!plan.notificationSentAt || now().getTime() - Date.parse(plan.notificationSentAt) >= RESEARCH_DISPATCH_LIMITS.receiptRetryMs) {
          const promptId = 'research-dispatch-receipt-' + plan.id;
          plan.notificationId = promptId;
          persist(plan);
          const message = plan.status === 'completed'
            ? `[research_dispatch receipt ${promptId}] Plan ${plan.id} is ${plan.status}. Call research_dispatch status for the durable task summaries, evidence and errors, then aggregate the findings or report the blocked/failed outcome. Do not repeat completed work.`
            : `[research_dispatch receipt ${promptId}] Plan ${plan.id} is ${plan.status} with unresolved blocked/failed tasks. Call research_dispatch status to inspect the exact blocker causes. Do NOT unilaterally abandon unfinished user goals or stop in prose: resolve recoverable resource/coordination blockers within scope, or call ask_user for missing permissions/decisions before concluding.`;
          // Socket transmission is not delivery. Only the owning bridge's
          // prompt_received event settles this; status reads are not delivery.
          if (await deps.notifyParent(plan.parentSessionId, message, promptId)) { plan.notificationSentAt = now().toISOString(); persist(plan); }
        }
      }
    }
  }

  function findHistoricalSession(plan, task) {
    const storedSessionId = ID.test(task.sessionId ?? '') ? task.sessionId : null;
    const live = childFor(plan, task) ?? (storedSessionId ? deps.getSession(storedSessionId) : null);
    if (live && !ENDED.has(live.status)) return { session: live, live: true };
    const fromHistory = (deps.history?.() ?? []).find(row =>
      (storedSessionId && row.id === storedSessionId) || matchesTask(plan, task, row),
    );
    const candidate = fromHistory ?? live ?? null;
    if (candidate && matchesTask(plan, task, candidate)) return { session: candidate, live: !ENDED.has(candidate.status) };
    return { session: null, live: false };
  }

  async function reopenOneTask(plan, task, { verified, reason, fromCommunication = false }) {
    if (ACTIVE.has(task.status) && task.status !== 'recovery-required') return;
    if (task.status === 'queued') return;
    task.reopenCount = (task.reopenCount ?? 0) + 1;
    task.reopenedAt = now().toISOString();
    if (reason) task.reopenReason = reason;
    task.previousOutcome = {
      status: task.status,
      ...(task.summary !== undefined ? { summary: task.summary } : {}),
      ...(task.evidence !== undefined ? { evidence: task.evidence } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    };
    const priorToken = task.spawnToken;
    delete task.finishedAt;
    delete task.reportedAt;
    delete task.error;
    delete task.notificationId;
    delete task.notificationSentAt;
    delete task.notifiedAt;
    delete task.waitingReason;
    delete task.summary;
    delete task.evidence;
    if (priorToken) settledReservations.delete(priorToken);

    plan.status = 'running';
    plan.schedulingPaused = false;
    delete plan.finishedAt;
    delete plan.error;
    delete plan.suspendedReason;
    delete plan.cancelReason;
    delete plan.notificationId;
    delete plan.notificationSentAt;
    delete plan.notifiedAt;

    const { session, live } = findHistoricalSession(plan, task);
    const reopenPromptId = 'research-dispatch-reopen-' + hash(JSON.stringify([plan.id, task.id, task.reopenCount, task.reopenedAt])).slice(0, 40);
    const reopenText = `[research_dispatch reopen ${reopenPromptId}] Your assignment (${task.id} in plan ${plan.clientPlanId || plan.id}) has been reopened by your parent.${reason ? ` Instruction/reason: ${reason}` : ''} Continue in this existing session from your prior progress without repeating completed work. If you encounter missing permissions, coordination needs, or recoverable blockers, send research_communication (kind="request", to="parent") and wait for parent reply instead of prematurely reporting blocked. When finished, submit an updated report with verified evidence.`;

    if (session && live) {
      if (priorToken) await deps.activateSession?.(priorToken, { allowExited: false, session });
      if (priorToken) deps.clearTerminalReport?.(priorToken, reopenPromptId);
      task.status = 'running';
      task.sessionId = session.id;
      task.lastSeenAt = now().toISOString();
      delete task.processUnconfirmed;
      delete task.reopenResuming;
      if (!fromCommunication) {
        task.pendingReopenPrompt = { promptId: reopenPromptId, text: reopenText };
      }
      persist(plan);
      if (task.pendingReopenPrompt && deps.notifyParent) {
        if (await deps.notifyParent(session.id, task.pendingReopenPrompt.text, task.pendingReopenPrompt.promptId)) {
          delete task.pendingReopenPrompt;
          persist(plan);
        }
      }
      return;
    }

    if (session && !live && session.sessionFile && deps.resumeSession) {
      await deps.beforeLaunch?.({ parent: verified.parent, verified, planId: plan.id });
      if (priorToken) await deps.activateSession?.(priorToken, { allowExited: true, session });
      if (priorToken) deps.clearTerminalReport?.(priorToken, reopenPromptId);
      task.status = 'launching';
      task.sessionId = session.id;
      task.launchedAt = now().toISOString();
      task.reopenResuming = true;
      delete task.lastSeenAt;
      delete task.processUnconfirmed;
      if (!fromCommunication) {
        task.pendingReopenPrompt = { promptId: reopenPromptId, text: reopenText };
      }
      persist(plan);
      const resumed = await deps.resumeSession(session, { spawnToken: priorToken });
      if (!resumed || resumed.success === false) {
        fail(502, 'research-dispatch-reopen-resume-failed');
      }
      return;
    }

    // No resumable session exists (e.g. blocked before spawn or no resume hook): re-queue cleanly.
    if (priorToken) deps.clearTerminalReport?.(priorToken, reopenPromptId);
    task.status = 'queued';
    task.requestId = 'dispatch-' + hash(JSON.stringify([plan.id, task.id, 'reopen', task.reopenCount])).slice(0, 40);
    delete task.spawnToken;
    delete task.sessionId;
    delete task.launchedAt;
    delete task.registeredAt;
    delete task.lastSeenAt;
    delete task.processUnconfirmed;
    delete task.reopenResuming;
    delete task.pendingReopenPrompt;
    persist(plan);
  }

  async function reopenAssignmentInternal({ spawnToken, childSessionId, reason, verified, fromCommunication = true }) {
    assertOpen();
    const matches = [...plans.values()].flatMap(saved => {
      if (saved.kind !== 'plan' || saved.parentSessionId !== verified.parent.id || !scopeMatches(saved, verified)) return [];
      return saved.tasks
        .filter(task => (spawnToken && task.spawnToken === spawnToken) || (childSessionId && task.sessionId === childSessionId))
        .map(task => ({ plan: saved, task }));
    });
    if (!matches.length) return { reopened: false };
    const plan = clone(matches[0].plan);
    const task = plan.tasks.find(row => row.id === matches[0].task.id);
    if (!task) return { reopened: false };
    if (ACTIVE.has(task.status) && task.status !== 'recovery-required') return { reopened: false, alreadyActive: true };
    await deps.assertDispatchAllowed?.({ parent: verified.parent, verified });
    await reopenOneTask(plan, task, { verified, reason, fromCommunication });
    await advance();
    return { reopened: true, planId: plan.id, taskId: task.id, status: plans.get(plan.id)?.tasks.find(r => r.id === task.id)?.status };
  }

  async function handleInternal(input) {
    assertOpen();
    const verified = await authorize(input), body = input.body;
    if (!['delegate', 'plan', 'status', 'atomic', 'report', 'cancel', 'pause', 'resume', 'reopen'].includes(body.action)) fail(400, 'research-dispatch-action-invalid');
    const allowed = new Set(['sessionId', 'action', 'planId', 'taskId', 'task', 'stage', 'tasks', 'concurrency', 'readOnly', 'reason', 'status', 'summary', 'evidence']);
    if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'research-dispatch-unknown-field');
    if (body.readOnly !== undefined && body.readOnly !== true) fail(400, 'research-dispatch-read-only-invalid');
    await discoverAssignments();
    if (body.action === 'delegate') await createDelegatedObjective(verified, body);
    if (body.action === 'plan') await createPlan(verified, body.tasks, body.planId, body.concurrency ?? 2, 'tool', body.readOnly);
    if (body.action === 'reopen') {
      if (!ID.test(body.planId ?? '')) fail(400, 'research-dispatch-plan-id-invalid');
      if (body.taskId !== undefined && !ID.test(body.taskId)) fail(400, 'research-dispatch-task-id-invalid');
      const reason = body.reason ?? body.summary;
      if (reason !== undefined && !string(reason, 4000)) fail(400, 'research-dispatch-reopen-reason-invalid');
      await deps.assertDispatchAllowed?.({ parent: verified.parent, verified });
      const found = [...plans.values()].find(plan => plan.kind === 'plan' && plan.parentSessionId === verified.parent.id && scopeMatches(plan, verified) && (plan.id === body.planId || plan.clientPlanId === body.planId));
      if (!found) fail(404, 'research-dispatch-plan-not-found');
      const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
      if (found.tenureId && policy?.tenureId !== found.tenureId) fail(409, 'research-dispatch-tenure-changed');
      const plan = clone(found);
      const targets = body.taskId
        ? plan.tasks.filter(row => row.id === body.taskId)
        : plan.tasks.filter(row => ['blocked', 'failed', 'recovery-required'].includes(row.status));
      if (!targets.length) fail(body.taskId ? 404 : 409, body.taskId ? 'research-dispatch-task-not-found' : 'research-dispatch-nothing-to-reopen');
      for (const task of targets) {
        await reopenOneTask(plan, task, { verified, reason, fromCommunication: false });
      }
    }
    if (body.action === 'pause' || body.action === 'resume') {
      await deps.assertDispatchAllowed?.({ parent: verified.parent, verified });
      const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
      await importLegacyOwnPlans(verified, policy);
      for (const saved of activeFor(verified.parent.id, verified, policy?.tenureId)) {
        if (body.planId && saved.id !== body.planId && saved.clientPlanId !== body.planId) continue;
        persist({ ...saved, schedulingPaused: body.action === 'pause' });
      }
    }
    if (body.action === 'atomic') {
      if (!string(body.reason, 1000)) fail(400, 'research-dispatch-atomic-reason-required');
      const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
      if (activeFor(verified.parent.id, verified, policy?.tenureId).length || policy?.mainSessionId !== verified.parent.id && researchProvenanceOf(verified.parent)?.tasks) fail(409, 'research-dispatch-declared-tasks-require-execution');
      const id = 'atomic-' + hash(JSON.stringify([verified.ownerKey, verified.cwd, verified.adoptionId, verified.charterHash, verified.parent.id, ...(policy?.tenureId ? [policy.tenureId] : [])])).slice(0, 40);
      if (!plans.has(id) && plans.size >= RESEARCH_DISPATCH_LIMITS.maxPlans) fail(409, 'research-dispatch-store-capacity');
      persist({ schema: 'pi-research-dispatch.v1', kind: 'atomic', id, parentSessionId: verified.parent.id, cwd: verified.cwd, ownerKey: verified.ownerKey, adoptionId: verified.adoptionId, charterHash: verified.charterHash, ...(policy?.tenureId ? { tenureId: policy.tenureId } : {}), reason: body.reason, tasks: [], status: 'completed', createdAt: now().toISOString() });
    }
    if (body.action === 'cancel') {
      if (!string(body.reason, 1000)) fail(400, 'research-dispatch-cancel-reason-required');
      const found = [...plans.values()].find(plan => plan.kind === 'plan' && plan.parentSessionId === verified.parent.id && scopeMatches(plan, verified) && (plan.id === body.planId || plan.clientPlanId === body.planId));
      if (!found) fail(404, 'research-dispatch-plan-not-found');
      if (!TERMINAL.has(found.status)) {
        const plan = clone(found); plan.status = 'blocked'; plan.error = 'research-dispatch-cancelled'; plan.cancelReason = body.reason;
        blockPending(plan, 'research-dispatch-cancelled');
        plan.finishedAt = now().toISOString(); persist(plan);
      }
      // Cancellation settles the ledger, not proof of process termination.
      // Registered children see the terminal assignment at their next tool gate.
    }
    if (body.action === 'report') {
      if (!TERMINAL.has(body.status) || !string(body.summary, 4000)) fail(400, 'research-dispatch-report-invalid');
      const evidence = body.evidence ?? [];
      if (!Array.isArray(evidence) || evidence.length > 16 || evidence.some(file => !string(file, 1024) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) fail(400, 'research-dispatch-evidence-invalid');
      if (body.status === 'blocked' && deps.hasOpenParentRequest?.(verified.parent.id) === true) fail(409, 'research-dispatch-awaiting-parent-reply');
      if (activeFor(verified.parent.id, verified).length) fail(409, 'research-dispatch-children-pending');
      const ownPlans = [...plans.values()].filter(plan => plan.kind === 'plan' && plan.parentSessionId === verified.parent.id && scopeMatches(plan, verified));
      if (body.status === 'completed' && ownPlans.some(plan => plan.status !== 'completed')) fail(409, 'research-dispatch-child-failure-unresolved');
      const matches = [...plans.values()].flatMap(plan => plan.kind === 'plan' && scopeMatches(plan, verified) ? plan.tasks.filter(task => matchesTask(plan, task, verified.parent)).map(task => ({ plan, task })) : []);
      if (matches.length !== 1) fail(404, 'research-dispatch-assignment-not-found');
      const plan = clone(matches[0].plan), task = plan.tasks.find(row => row.id === matches[0].task.id), provenance = researchProvenanceOf(verified.parent);
      if (TERMINAL.has(task.status)) {
        if (task.status !== body.status || task.summary !== body.summary || JSON.stringify(task.evidence) !== JSON.stringify(evidence)) fail(409, 'research-dispatch-report-conflict');
      } else {
        task.status = body.status; task.summary = body.summary; task.evidence = evidence; task.finishedAt = now().toISOString(); task.reportedAt = task.finishedAt; task.sessionId = verified.parent.id;
        task.spawnToken = provenance.spawnToken; delete task.error;
        persist(plan); // A receipt becomes authoritative before freeing capacity.
      }
      await releaseReservation(provenance.spawnToken); // Also retry a previously failed durable pool release.
    }
    await advance();
    // Internal gates also read status. Only native prompt_received proves delivery;
    // a silent host read must not discard a result that never reached the model.
    return snapshot(verified, body.action === 'status' ? body.planId : undefined);
  }

  async function visibleOwnPlans(verified) {
    const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
    await importLegacyOwnPlans(verified, policy);
    return [...plans.values()].filter(plan => plan.parentSessionId === verified.parent.id && scopeMatches(plan, verified)
      && (!policy?.tenureId || policy.mainSessionId !== verified.parent.id || plan.tenureId === policy.tenureId));
  }

  async function snapshot(verified, requestedPlanId) {
    const own = await visibleOwnPlans(verified);
    const all = own.filter(plan => plan.kind === 'plan');
    // Unlimited sequential research must not turn status into an unbounded
    // download of old evidence bodies. Old plans stay addressable explicitly;
    // the default has every active plan and the latest two terminal plans.
    let selected;
    if (requestedPlanId !== undefined) {
      if (!ID.test(requestedPlanId)) fail(400, 'research-dispatch-plan-id-invalid');
      selected = all.filter(plan => plan.id === requestedPlanId || plan.clientPlanId === requestedPlanId);
      // A child may name its assigning plan to disambiguate one direct
      // prerequisite. That exposes only the child's dependency receipts below,
      // never its siblings' complete task/receipt bodies.
      const ownAssignmentPlan = [...plans.values()].some(plan => plan.kind === 'plan' && plan.id === requestedPlanId && scopeMatches(plan, verified) && plan.tasks.some(task => matchesTask(plan, task, verified.parent)));
      if (!selected.length && !ownAssignmentPlan) fail(404, 'research-dispatch-plan-not-found');
    } else {
      const recent = all.filter(plan => TERMINAL.has(plan.status)).sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt)).slice(0, 2);
      selected = [...all.filter(plan => !TERMINAL.has(plan.status)), ...recent];
    }
    const visible = selected.map(plan => publicPlan(plan)), atomic = own.find(plan => plan.kind === 'atomic');
    const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
    const collaborator = policy?.mainSessionId === verified.parent.id ? null : researchProvenanceOf(verified.parent);
    // A child's exact task can be fetched on demand after its initial prompt
    // was bounded. Never expose an obsolete adoption's task through this scope.
    const brief = collaborator && collaborator.workflowCwd === verified.cwd && collaborator.charterHash === verified.charterHash && collaborator.adoptionId === verified.adoptionId
      ? { task: collaborator.task, role: collaborator.role, stage: collaborator.stage, readOnly: collaborator.readOnly === true } : null;
    const assignment = collaborator ? [...plans.values()].flatMap(plan => {
      if (plan.kind !== 'plan' || !scopeMatches(plan, verified)) return [];
      return plan.tasks.filter(task => matchesTask(plan, task, verified.parent)).map(task => ({ planId: plan.id, taskId: task.id, status: task.status, error: task.error, dependencies: task.dependsOn.map(id => plan.tasks.find(row => row.id === id)).map(row => ({ id: row.id, summary: row.summary, evidence: row.evidence })) }));
    }) : [];
    const historyCounts = { total: 0, completed: 0, failed: 0, blocked: 0, active: 0, queued: 0 };
    for (const plan of all) for (const task of plan.tasks) { historyCounts.total++; historyCounts[TERMINAL.has(task.status) || task.status === 'queued' ? task.status : 'active']++; }
    const peerContext = getPeerContext(verified.parent.id);
    const peers = peerContext && scopeMatches(peerContext.plan, verified) ? peerContext.peers : [];
    return { status: 'ok', tool: 'research_dispatch', sessionId: verified.parent.id, peers: peers.slice(0, 32), omittedPeers: Math.max(0, peers.length - 32), plans: visible, planHistory: { total: all.length, shown: visible.length, counts: historyCounts }, atomicReason: atomic?.reason ?? null, collaborator: !!collaborator, brief, assignment: assignment[0] ?? null, declaredTasks: collaborator?.tasks?.length ?? 0, decisionRequired: !atomic && !all.length, childrenPending: all.some(plan => !TERMINAL.has(plan.status)), awaitingParentReply: deps.hasOpenParentRequest?.(verified.parent.id) === true };
  }

  async function manageQueueInternal(input) {
    assertOpen();
    const verified = await authorize(input), body = input.body;
    if (!['snapshot', 'reorder', 'start'].includes(body.action)) fail(400, 'research-queue-action-invalid');
    if (Object.keys(body).some(key => !['sessionId', 'action', 'planId', 'taskId', 'taskIds', 'expectedRevision'].includes(key))) fail(400, 'research-queue-unknown-field');
    if (body.action === 'snapshot') return snapshot(verified);
    await deps.assertDispatchAllowed?.({ parent: verified.parent, verified });
    const policy = await readResearchSchedulingPolicy(deps, verified.parent, verified);
    const found = [...plans.values()].find(plan => plan.kind === 'plan' && plan.parentSessionId === verified.parent.id && scopeMatches(plan, verified) && (plan.id === body.planId || plan.clientPlanId === body.planId));
    if (!found) fail(404, 'research-dispatch-plan-not-found');
    if (found.tenureId && policy?.tenureId !== found.tenureId) fail(409, 'research-dispatch-tenure-changed');
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) fail(400, 'research-queue-revision-required');
    if (body.expectedRevision !== (found.revision ?? 1)) fail(409, 'research-queue-revision-conflict');
    if (TERMINAL.has(found.status) || found.suspendedReason) fail(409, 'research-queue-plan-not-active');
    if (body.action === 'start' && found.schedulingPaused) fail(409, 'research-dispatch-scheduling-paused');
    const plan = clone(found), queued = taskOrder(plan).filter(task => task.status === 'queued');
    let order;
    if (body.action === 'reorder') {
      if (!Array.isArray(body.taskIds) || body.taskIds.length !== queued.length || body.taskIds.some(id => typeof id !== 'string') || new Set(body.taskIds).size !== queued.length || body.taskIds.some(id => !queued.some(task => task.id === id))) fail(400, 'research-queue-order-invalid');
      order = body.taskIds;
    } else {
      const task = queued.find(task => task.id === body.taskId);
      if (!task) fail(409, 'research-queue-task-not-queued');
      if (task.dependsOn.some(id => plan.tasks.find(row => row.id === id)?.status !== 'completed')) fail(409, 'research-queue-dependencies-pending');
      order = [task.id, ...queued.filter(row => row.id !== task.id).map(row => row.id)];
    }
    plan.queueOrder = [...order, ...taskOrder(plan).filter(task => task.status !== 'queued').map(task => task.id)];
    persist(plan); // One atomic ledger write owns the ordering decision.
    await advance(); // No model turn or page refresh is required to fill a slot.
    const result = await snapshot(verified);
    if (body.action === 'start') {
      const task = plans.get(plan.id)?.tasks.find(task => task.id === body.taskId);
      result.startResult = { planId: plan.id, taskId: body.taskId, status: task?.status ?? 'queued', waitingReason: task?.waitingReason, error: task?.error };
    }
    return result;
  }

  return {
    handle: input => serial(() => handleInternal(input)), tick: () => serial(advance),
    reopenAssignment: input => serial(() => reopenAssignmentInternal(input)),
    getPeerContext, getPeerTask,
    manageQueue: input => serial(() => manageQueueInternal(input)),
    listForScope: ({ cwd, ownerKey }) => [...plans.values()].filter(plan => plan.kind === 'plan' && plan.cwd === cwd && plan.ownerKey === ownerKey).map(plan => publicPlan(plan, true)),
    suspendSessions: (sessionIds, reason = 'research-collaboration-detached', tenureId) => serial(async () => {
      const ids = new Set(sessionIds);
      for (const saved of plans.values()) if (saved.kind === 'plan' && ids.has(saved.parentSessionId) && (!tenureId || saved.tenureId === tenureId) && !TERMINAL.has(saved.status)) suspendPending(clone(saved), reason);
    }),
    acknowledgeReceipt: (sessionId, promptId) => serial(async () => {
      for (const plan of plans.values()) if (plan.parentSessionId === sessionId && plan.kind === 'plan') acknowledge(plan, promptId);
    }),
    isCompleted: token => [...plans.values()].some(plan => plan.kind === 'plan' && plan.tasks.some(task => task.spawnToken === token && (task.reportedAt || task.error === 'research-dispatch-worker-ended-without-report'))),
    isAssignmentNonActive: token => [...plans.values()].some(plan => plan.kind === 'plan' && plan.tasks.some(task => task.spawnToken === token && (TERMINAL.has(task.status) || task.status === 'recovery-required'))),
    completedAt: token => {
      let latest = null;
      for (const plan of plans.values()) {
        if (plan.kind !== 'plan') continue;
        for (const task of plan.tasks) {
          if (task.spawnToken !== token) continue;
          if (!task.reportedAt && task.error !== 'research-dispatch-worker-ended-without-report') continue;
          const ts = Date.parse(task.reportedAt ?? task.finishedAt ?? '');
          if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
        }
      }
      return latest;
    },
    isWaitingCoordinator: sessionId => activeFor(sessionId).length > 0,
    isRecoveringSession,
    unregisteredReservations: () => [...plans.values()].flatMap(plan => plan.kind === 'plan' ? plan.tasks.filter(task => (ACTIVE.has(task.status) || task.processUnconfirmed) && !childFor(plan, task)).map(task => ({ requestId: task.requestId, spawnToken: task.spawnToken, parentSessionId: plan.parentSessionId, rootSessionId: plan.rootSessionId })) : []),
    dispose: () => { disposed = true; },
  };
}
