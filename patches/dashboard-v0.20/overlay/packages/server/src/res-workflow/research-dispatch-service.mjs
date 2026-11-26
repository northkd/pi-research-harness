/** Durable bounded DAG execution. The model chooses semantic boundaries; this
 * executor owns process creation, dependencies, authenticated receipts and recovery. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResearchSessionError, RESEARCH_SESSION_LIMITS, RESEARCH_SESSION_STAGES, researchProvenanceOf, validateResearchTasks } from './research-session-service.mjs';

export const RESEARCH_DISPATCH_LIMITS = Object.freeze({ maxTasks: 64, maxConcurrency: 4, maxPlans: 512, maxPlanBytes: 2 * 1024 * 1024, registrationGraceMs: 120_000, receiptRetryMs: 30_000 });
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const ACTIVE = new Set(['launching', 'running', 'recovery-required']);
const ENDED = new Set(['ended', 'closed', 'archived']);
/** Shared mailbox/roster state. Terminal task or session state takes precedence. */
export function researchDispatchPeerState(task, session) {
  if (TERMINAL.has(task?.status) || ENDED.has(session?.status) || Number.isFinite(session?.archivedAt)) return 'ended';
  if (task?.status === 'queued') return 'queued';
  return ACTIVE.has(task?.status) ? 'in_progress' : 'ended';
}

const RETRY_ADMISSION = new Set(['research-session-resource-budget-unavailable', 'research-session-memory-limit', 'research-session-concurrency-limit', 'research-session-capacity-limit', 'research-session-resident-limit']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code) => { throw new ResearchSessionError(status, code); };
const string = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const scopeMatches = (plan, verified) => plan.cwd === verified.cwd && plan.charterHash === verified.charterHash && plan.adoptionId === verified.adoptionId && plan.ownerKey === verified.ownerKey;
const clone = value => structuredClone(value);

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
  const startedAt = now().getTime();
  const graceMs = deps.registrationGraceMs ?? RESEARCH_DISPATCH_LIMITS.registrationGraceMs;
  const isRecoveringSession = session => session?.dataUnavailable === true && ENDED.has(session.status) && now().getTime() - startedAt < graceMs;
  let tail = Promise.resolve(), disposed = false;
  const assertOpen = () => { if (disposed) fail(503, 'research-dispatch-service-closed'); };
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const sessions = () => deps.listSessions();
  // Copy-on-write: a failed disk write must not mutate in-memory truth or free a slot.
  const persist = plan => { assertOpen(); const saved = clone({ ...plan, updatedAt: now().toISOString() }); deps.store?.write(saved); plans.set(saved.id, saved); synchronizePeerMailboxes(saved); return saved; };
  const ownerPrincipal = session => deps.principalForSession ? deps.principalForSession(session) : session?.principalOwner ?? null;
  const activeFor = (sessionId, verified) => [...plans.values()].filter(row => row.parentSessionId === sessionId && row.kind === 'plan' && !TERMINAL.has(row.status) && (!verified || scopeMatches(row, verified)));
  const publicPlan = plan => ({ id: plan.id, clientPlanId: plan.clientPlanId, mode: plan.mode ?? 'tasks', parentSessionId: plan.parentSessionId, rootSessionId: plan.rootSessionId, tenureId: plan.tenureId, status: plan.status, concurrency: plan.concurrency, schedulingPaused: plan.schedulingPaused === true, ...(plan.readOnly === true ? { readOnly: true } : {}), error: plan.error, tasks: plan.tasks.map((row, index) => ({ ...row, rank: row.rank ?? index, queueRank: index })), createdAt: plan.createdAt, updatedAt: plan.updatedAt });
  const matchesTask = (plan, task, child) => {
    const p = researchProvenanceOf(child);
    return p && (p.spawnToken === task.spawnToken || p.requestId === task.requestId) && p.parentSessionId === plan.parentSessionId && p.adoptionId === plan.adoptionId && p.charterHash === plan.charterHash && p.workflowCwd === plan.cwd;
  };
  const childFor = (plan, task) => sessions().find(child => matchesTask(plan, task, child));

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

  function upstreamStopped(session) {
    const seen = new Set();
    let current = session;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
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

  async function authorize(input) {
    assertOpen();
    if (!object(input.body) || !ID.test(input.body.sessionId ?? '')) fail(400, 'research-dispatch-session-invalid');
    const verified = await deps.authorize({ sessionId: input.body.sessionId, principal: input.principal, expiresAt: input.expiresAt });
    assertOpen(); return verified;
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
  function createPlanFromTasks(verified, normalized, planId, concurrency, source, mode, requestedReadOnly) {
    if (upstreamStopped(verified.parent)) fail(409, 'research-dispatch-upstream-terminal');
    if (!ID.test(planId ?? '')) fail(400, 'research-dispatch-plan-id-invalid');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > RESEARCH_DISPATCH_LIMITS.maxConcurrency) fail(400, 'research-dispatch-concurrency-invalid');
    const provenance = researchProvenanceOf(verified.parent);
    const readOnly = requestedReadOnly === true || provenance?.readOnly === true;
    // Preserve replay of pre-mode ordinary plans. New delegation and narrowed
    // plans fingerprint their mode/constraint, so a retry cannot change either.
    const fingerprint = hash(JSON.stringify(mode === 'tasks' && !readOnly ? [normalized, concurrency] : [{ mode, readOnly }, normalized, concurrency]));
    const id = 'dispatch-' + hash(JSON.stringify([verified.ownerKey, verified.cwd, verified.adoptionId, verified.charterHash, verified.parent.id, planId])).slice(0, 40);
    const existing = plans.get(id);
    if (existing) {
      if (!scopeMatches(existing, verified) || (existing.mode ?? 'tasks') !== mode || existing.fingerprint !== fingerprint) fail(409, 'research-dispatch-idempotency-conflict');
      return existing;
    }
    if (activeFor(verified.parent.id, verified).length) fail(409, 'research-dispatch-plan-already-active');
    if ((provenance?.depth ?? 0) >= 3) fail(409, 'research-session-depth-limit');
    const rootSessionId = provenance?.rootSessionId ?? verified.parent.id;
    const reserved = [...plans.values()].filter(row => row.kind === 'plan' && row.rootSessionId === rootSessionId && scopeMatches(row, verified)).reduce((sum, row) => sum + row.tasks.length, 0);
    if (deps.maxRootTasks !== undefined && reserved + normalized.length > deps.maxRootTasks) fail(409, 'research-dispatch-budget-limit');
    if (plans.size >= RESEARCH_DISPATCH_LIMITS.maxPlans) fail(409, 'research-dispatch-store-capacity');
    const plan = {
      schema: 'pi-research-dispatch.v1', kind: 'plan', id, clientPlanId: planId, parentSessionId: verified.parent.id, rootSessionId,
      cwd: verified.cwd, ownerKey: verified.ownerKey, adoptionId: verified.adoptionId, charterHash: verified.charterHash,
      fingerprint, source, mode, ...(readOnly ? { readOnly: true } : {}), depth: provenance?.depth ?? 0, concurrency, status: 'running', createdAt: now().toISOString(),
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
        createPlan(verified, p.tasks, planId, 2, planId);
      } catch (error) {
        if (!(error instanceof ResearchSessionError)) throw error;
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
    await discoverAssignments();
    if (disposed) return;
    // Drain deeper work first; waiting coordinators use resident capacity, not
    // runnable-worker slots. This prevents a tree of coordinators starving leaves.
    const ordered = [...plans.values()].filter(row => row.kind === 'plan').sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
    for (const saved of ordered) {
      if (disposed) return;
      let plan = clone(plans.get(saved.id));
      const parent = deps.getSession(plan.parentSessionId);
      if ((!parent || isRecoveringSession(parent)) && now().getTime() - startedAt < graceMs) continue;
      let verified;
      try {
        verified = await deps.authorize({ sessionId: plan.parentSessionId, principal: ownerPrincipal(parent), expiresAt: null });
        if (disposed) return;
        if (!scopeMatches(plan, verified)) fail(409, 'research-dispatch-scope-changed');
        if (ENDED.has(parent?.status)) fail(409, 'research-dispatch-coordinator-ended');
        if (upstreamStopped(parent) && !TERMINAL.has(plan.status)) fail(409, 'research-dispatch-upstream-terminal');
      } catch (error) {
        if (!TERMINAL.has(plan.status)) {
          plan.error = error?.code ?? 'research-dispatch-owner-unavailable';
          blockPending(plan, plan.error);
          plan.status = 'blocked'; plan.finishedAt = now().toISOString(); persist(plan);
        }
        continue; // Never deliver old-scope receipts into a new adoption.
      }
      if (!TERMINAL.has(plan.status)) {
        delete plan.error;
        const release = [];
        for (const task of plan.tasks) {
          if (!ACTIVE.has(task.status)) continue;
          const child = childFor(plan, task);
          if (child) {
            if (isRecoveringSession(child)) continue;
            task.spawnToken = researchProvenanceOf(child).spawnToken; task.sessionId = child.id;
            task.registeredAt ??= now().toISOString();
            if (ENDED.has(child.status)) { terminalize(task, 'failed', 'research-dispatch-worker-ended-without-report'); release.push(task.spawnToken); }
            else { task.status = 'running'; task.lastSeenAt = now().toISOString(); delete task.error; }
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
        for (const token of release) deps.releaseSession?.(token);
        for (const task of plan.tasks) {
          if (plan.schedulingPaused) break;
          if (task.status !== 'queued') continue;
          const dependencies = task.dependsOn.map(id => plan.tasks.find(row => row.id === id));
          if (dependencies.some(row => row.status === 'failed' || row.status === 'blocked')) { terminalize(task, 'blocked', 'research-dispatch-dependency-failed'); continue; }
          if (dependencies.some(row => row.status !== 'completed')) continue;
          if (plan.tasks.filter(row => ACTIVE.has(row.status)).length >= plan.concurrency) break;
          // A preflight denial proves no process has been attempted. Settle it
          // before creating a durable launch reservation, including foreign
          // typed permission errors from the host adapter.
          try { await deps.beforeLaunch?.({ parent, verified, planId: plan.id }); }
          catch (error) {
            if (disposed) return;
            const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(error.code) ? error.code : 'research-dispatch-preflight-blocked';
            if (RETRY_ADMISSION.has(code)) { task.error = code; persist(plan); break; }
            terminalize(task, 'blocked', code); persist(plan); continue;
          }
          if (disposed) return;
          task.status = 'launching'; task.launchedAt = now().toISOString();
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
            if (RETRY_ADMISSION.has(code)) task.status = 'queued';
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
          const message = `[research_dispatch receipt ${promptId}] Plan ${plan.id} is ${plan.status}. Call research_dispatch status for the durable task summaries, evidence and errors, then aggregate the findings or report the blocked/failed outcome. Do not repeat completed work.`;
          // Socket transmission is not delivery. Only the owning bridge's
          // prompt_received event (or the parent's status read) settles this.
          if (await deps.notifyParent(plan.parentSessionId, message, promptId)) { plan.notificationSentAt = now().toISOString(); persist(plan); }
        }
      }
    }
  }

  async function handleInternal(input) {
    assertOpen();
    const verified = await authorize(input), body = input.body;
    if (!['delegate', 'plan', 'status', 'atomic', 'report', 'cancel', 'pause', 'resume'].includes(body.action)) fail(400, 'research-dispatch-action-invalid');
    const allowed = new Set(['sessionId', 'action', 'planId', 'task', 'stage', 'tasks', 'concurrency', 'readOnly', 'reason', 'status', 'summary', 'evidence']);
    if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'research-dispatch-unknown-field');
    if (body.readOnly !== undefined && body.readOnly !== true) fail(400, 'research-dispatch-read-only-invalid');
    await discoverAssignments();
    if (body.action === 'delegate') createDelegatedObjective(verified, body);
    if (body.action === 'plan') createPlan(verified, body.tasks, body.planId, body.concurrency ?? 2, 'tool', body.readOnly);
    if (body.action === 'pause' || body.action === 'resume') {
      for (const saved of activeFor(verified.parent.id, verified)) {
        if (body.planId && saved.id !== body.planId && saved.clientPlanId !== body.planId) continue;
        persist({ ...saved, schedulingPaused: body.action === 'pause' });
      }
    }
    if (body.action === 'atomic') {
      if (!string(body.reason, 1000)) fail(400, 'research-dispatch-atomic-reason-required');
      if (activeFor(verified.parent.id, verified).length || researchProvenanceOf(verified.parent)?.tasks) fail(409, 'research-dispatch-declared-tasks-require-execution');
      const id = 'atomic-' + hash(JSON.stringify([verified.ownerKey, verified.cwd, verified.adoptionId, verified.charterHash, verified.parent.id])).slice(0, 40);
      if (!plans.has(id) && plans.size >= RESEARCH_DISPATCH_LIMITS.maxPlans) fail(409, 'research-dispatch-store-capacity');
      persist({ schema: 'pi-research-dispatch.v1', kind: 'atomic', id, parentSessionId: verified.parent.id, cwd: verified.cwd, ownerKey: verified.ownerKey, adoptionId: verified.adoptionId, charterHash: verified.charterHash, reason: body.reason, tasks: [], status: 'completed', createdAt: now().toISOString() });
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
        deps.releaseSession?.(provenance.spawnToken);
      }
    }
    await advance();
    const own = [...plans.values()].filter(plan => plan.parentSessionId === verified.parent.id && scopeMatches(plan, verified));
    // Internal gates also read status. Only native prompt_received proves delivery;
    // a silent host read must not discard a result that never reached the model.
    const visible = own.filter(plan => plan.kind === 'plan').map(publicPlan), atomic = own.find(plan => plan.kind === 'atomic');
    const collaborator = researchProvenanceOf(verified.parent);
    // A child's exact task can be fetched on demand after its initial prompt
    // was bounded. Never expose an obsolete adoption's task through this scope.
    const brief = collaborator && collaborator.workflowCwd === verified.cwd && collaborator.charterHash === verified.charterHash && collaborator.adoptionId === verified.adoptionId
      ? { task: collaborator.task, role: collaborator.role, stage: collaborator.stage, readOnly: collaborator.readOnly === true } : null;
    const assignment = collaborator ? [...plans.values()].flatMap(plan => {
      if (plan.kind !== 'plan' || !scopeMatches(plan, verified)) return [];
      return plan.tasks.filter(task => matchesTask(plan, task, verified.parent)).map(task => ({ planId: plan.id, taskId: task.id, status: task.status, error: task.error, dependencies: task.dependsOn.map(id => plan.tasks.find(row => row.id === id)).map(row => ({ id: row.id, summary: row.summary, evidence: row.evidence })) }));
    }) : [];
    const peerContext = getPeerContext(verified.parent.id);
    const peers = peerContext && scopeMatches(peerContext.plan, verified) ? peerContext.peers : [];
    return { status: 'ok', tool: 'research_dispatch', sessionId: verified.parent.id, peers: peers.slice(0, 32), omittedPeers: Math.max(0, peers.length - 32), plans: visible, atomicReason: atomic?.reason ?? null, collaborator: !!collaborator, brief, assignment: assignment[0] ?? null, declaredTasks: collaborator?.tasks?.length ?? 0, decisionRequired: !atomic && !visible.length, childrenPending: visible.some(plan => !TERMINAL.has(plan.status)) };
  }

  return {
    handle: input => serial(() => handleInternal(input)), tick: () => serial(advance),
    getPeerContext, getPeerTask,
    acknowledgeReceipt: (sessionId, promptId) => serial(async () => {
      for (const plan of plans.values()) if (plan.parentSessionId === sessionId && plan.kind === 'plan') acknowledge(plan, promptId);
    }),
    isCompleted: token => [...plans.values()].some(plan => plan.kind === 'plan' && plan.tasks.some(task => task.spawnToken === token && (task.reportedAt || task.error === 'research-dispatch-worker-ended-without-report'))),
    isWaitingCoordinator: sessionId => activeFor(sessionId).length > 0,
    isRecoveringSession,
    unregisteredReservations: () => [...plans.values()].flatMap(plan => plan.kind === 'plan' ? plan.tasks.filter(task => (ACTIVE.has(task.status) || task.processUnconfirmed) && !childFor(plan, task)).map(task => ({ requestId: task.requestId, spawnToken: task.spawnToken, parentSessionId: plan.parentSessionId, rootSessionId: plan.rootSessionId })) : []),
    dispose: () => { disposed = true; },
  };
}
