/**
 * Backend for the native `research_session` tool.
 *
 * It creates a separate native Pi process with a recorded logical parent, joins it
 * through the SAME token-keyed res-workflow spawn preparation used by the
 * browser road, binds the parent's owner, and queues exactly one token-bound
 * initial prompt. No project/model/destination is accepted from the caller.
 */
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";

export const RESEARCH_SESSION_SCHEMA = "pi-research-session.v1";
export const RESEARCH_SESSION_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"];
export const RESEARCH_SESSION_LIMITS = Object.freeze({ maxPerParent: 4, maxTotal: 8, maxTaskChars: 4000, maxRoleChars: 40, maxDepth: 3, maxDescendants: 24, maxResident: 32, minAvailableMemory: 1024 * 1024 * 1024 });
const ROLE = /^[a-z][a-z0-9-]{1,39}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ADOPTION = /^adopt-[a-f0-9]{24}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const ALLOWED_KEYS = new Set(["parentSessionId", "role", "task", "stage", "requestId", "tasks", "readOnly"]);
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const sameOwner = (a, b) => !!a && !!b && a.iss === b.iss && a.sub === b.sub;
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

export class ResearchSessionError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = "ResearchSessionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
const fail = (statusCode, code) => { throw new ResearchSessionError(statusCode, code); };

/** Bounded DAG, whose items are executed by the server, not merely prompt advice. */
export function validateResearchTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 12) fail(400, "research-dispatch-task-count-invalid");
  const ids = new Set();
  const result = tasks.map(row => {
    if (!object(row) || Object.keys(row).some(key => !["id", "role", "task", "stage", "dependsOn"].includes(key))) fail(400, "research-dispatch-task-invalid");
    if (typeof row.id !== "string" || !ID.test(row.id) || ids.has(row.id)) fail(400, "research-dispatch-task-id-invalid");
    ids.add(row.id);
    if (!ROLE.test(row.role ?? "") || !text(row.task, RESEARCH_SESSION_LIMITS.maxTaskChars) || !RESEARCH_SESSION_STAGES.includes(row.stage)) fail(400, "research-dispatch-task-invalid");
    if (row.dependsOn !== undefined && (!Array.isArray(row.dependsOn) || row.dependsOn.length > 12 || row.dependsOn.some(id => typeof id !== "string"))) fail(400, "research-dispatch-dependency-invalid");
    return { id: row.id, role: row.role, task: row.task, stage: row.stage, dependsOn: [...new Set(row.dependsOn ?? [])] };
  });
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) fail(400, "research-dispatch-cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of result.find(row => row.id === id).dependsOn) {
      if (!ids.has(dep)) fail(400, "research-dispatch-dependency-invalid");
      visit(dep);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return result;
}

export const researchProvenanceOf = row => row?.researchSession?.parentSessionId ? row.researchSession : row?.pluginRefs?.["res-workflow"]?.researchSession;

export function validateResearchSessionRequest(body) {
  if (!object(body)) fail(400, "research-session-invalid-request");
  for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) fail(400, "research-session-unknown-field");
  if (typeof body.parentSessionId !== "string" || !ID.test(body.parentSessionId)) fail(400, "research-session-parent-invalid");
  if (typeof body.role !== "string" || !ROLE.test(body.role)) fail(400, "research-session-role-invalid");
  if (!text(body.task, RESEARCH_SESSION_LIMITS.maxTaskChars)) fail(400, "research-session-task-invalid");
  if (!RESEARCH_SESSION_STAGES.includes(body.stage)) fail(400, "research-session-stage-invalid");
  if (body.readOnly !== undefined && body.readOnly !== true) fail(400, "research-session-readonly-invalid");
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId))) fail(400, "research-session-request-id-invalid");
  return {
    parentSessionId: body.parentSessionId,
    role: body.role,
    task: body.task,
    stage: body.stage,
    requestId: body.requestId ?? randomUUID(),
    ...(body.tasks === undefined ? {} : { tasks: validateResearchTasks(body.tasks) }),
    ...(body.readOnly === true ? { readOnly: true } : {}),
  };
}

export const RESEARCH_SESSION_INITIAL_PROMPT_BYTES = 16 * 1024;
const promptBytes = value => new TextEncoder().encode(value).length;
function promptPrefix(value, maximum) {
  let used = 0, output = '';
  for (const character of value) {
    const bytes = promptBytes(character);
    if (used + bytes > maximum) break;
    output += character; used += bytes;
  }
  return output;
}

/** A fresh task brief, never a copy of the parent's transcript or dependency bodies. */
export function buildResearchSessionInitialPrompt(provenance, taskContext) {
  const ids = [...new Set((taskContext?.prerequisiteResults ?? []).map(row => row?.id).filter(id => typeof id === 'string' && ID.test(id)))].slice(0, 12);
  const dispatchId = taskContext?.dispatchId ?? provenance.dispatchId;
  const taskId = taskContext?.taskId ?? provenance.taskId;
  const prefix = [
    'You are a research collaborator in a fresh Pi session joined to the confirmed research workbench. No parent conversation is copied into this task.',
    `Role: ${provenance.role}`,
    `Stage: ${provenance.stage}`,
    `Parent session: ${provenance.parentSessionId}`,
    `Frozen charter: ${provenance.charterHash} (adoption ${provenance.adoptionId})`,
    'Use the verified workbench context for the workspace, current charter, permission scope and shared budget. This assignment expands none of them.',
    provenance.readOnly === true ? 'READ-ONLY assignment: preserve project files and external state. Do not edit, install, or run modifying experiments. Delegate only read-only work; coordination and result receipts remain available.' : '',
    provenance.role === 'research-coordinator'
      ? 'You are the execution coordinator: analyze the goal, decompose it into bounded tasks, schedule specialists, follow progress and blockers, arrange independent verification, and aggregate the evidence. Keep implementation and raw logs in worker contexts. Send the lead only decisions requiring attention and a short final aggregate receipt with evidence references.'
      : 'Complete only this assigned scope. Keep analysis and raw execution details in this worker context; return a short truthful result and evidence references.',
    '',
    'Task:',
  ].filter(Boolean).join('\n') + '\n';
  const suffix = [
    '',
    typeof dispatchId === 'string' && ID.test(dispatchId) ? `Dispatcher plan reference: ${dispatchId}` : '',
    typeof taskId === 'string' && ID.test(taskId) ? `Assignment task reference: ${taskId}` : '',
    ids.length ? `Direct dependency IDs: ${ids.join(', ')}` : '',
    'First call research_dispatch action="status". Retrieve dependency receipts with action="status", view="detail", taskId="<dependency-id>", offset=0; read further pages only as needed. Dependency summaries and evidence bodies are deliberately not copied into this prompt.',
    'Declared structured tasks are automatically scheduled. Coordinate their receipts instead of redoing the work. For several separable items submit a plan; for one indivisible item record atomic with a concrete reason. Leaf roles cannot delegate.',
    'Use research_loop to record actual evidence. Finish an assigned task with research_dispatch report (completed, failed or blocked), a short summary and relative evidence paths. Wait for your own children and independent checks before claiming completion. Publication, provider access, budget and workspace limits remain unchanged.',
  ].filter(Boolean).join('\n');
  const task = String(provenance.task ?? '');
  const complete = prefix + task + '\n' + suffix;
  if (promptBytes(complete) < RESEARCH_SESSION_INITIAL_PROMPT_BYTES) return complete;
  const notice = '\n[Task brief truncated to fit the startup budget. The complete original task is preserved in the verified session record. Before ANY execution, call research_dispatch action="status", view="detail", taskId="self", offset=0 and read every task page. Apply all original goals and constraints; do not infer that omitted text grants permission.]';
  const available = RESEARCH_SESSION_INITIAL_PROMPT_BYTES - 1 - promptBytes(prefix + notice + '\n' + suffix);
  if (available < 0) fail(400, 'research-session-prompt-metadata-too-large');
  return prefix + promptPrefix(task, available) + notice + '\n' + suffix;
}

/** Tool callers need routing receipts; complete tasks/provenance remain in persisted metadata. */
function compactSpawnReceipt(provenance, registration, sessionId) {
  return {
    status: 'spawned', registration, requestId: provenance.requestId,
    parentSessionId: provenance.parentSessionId,
    ...(provenance.rootSessionId ? { rootSessionId: provenance.rootSessionId } : {}),
    ...(provenance.depth ? { depth: provenance.depth } : {}),
    ...(sessionId ? { sessionId } : {}),
    spawnToken: provenance.spawnToken, role: provenance.role, stage: provenance.stage,
    workflowCwd: provenance.workflowCwd, charterHash: provenance.charterHash, adoptionId: provenance.adoptionId,
    ...(provenance.readOnly === true ? { readOnly: true } : {}),
    initialPromptQueued: true,
  };
}

function provenanceFor({ parentSessionId, role, task, stage, charterHash, adoptionId, workflowCwd, spawnToken, now, requestId, tasks, rootSessionId, depth, readOnly }) {
  return {
    schema: RESEARCH_SESSION_SCHEMA,
    requestId, rootSessionId, depth,
    ...(tasks ? { tasks } : {}),
    ...(readOnly === true ? { readOnly: true } : {}),
    parentSessionId,
    creatorSessionId: parentSessionId,
    creatorAgent: "research_session",
    role,
    task,
    stage,
    charterHash,
    adoptionId,
    workflowCwd,
    spawnToken,
    createdAt: now().toISOString(),
    origin: "research_session",
    relation: "dispatch",
  };
}

function assertProvenance(value, childCwd) {
  if (!object(value) || value.schema !== RESEARCH_SESSION_SCHEMA ||
    !ID.test(value.parentSessionId ?? "") || value.creatorSessionId !== value.parentSessionId ||
    value.creatorAgent !== "research_session" || !ROLE.test(value.role ?? "") ||
    (value.readOnly !== undefined && value.readOnly !== true) ||
    !text(value.task, RESEARCH_SESSION_LIMITS.maxTaskChars) || !RESEARCH_SESSION_STAGES.includes(value.stage) ||
    !HASH.test(value.charterHash ?? "") || !ADOPTION.test(value.adoptionId ?? "") ||
    value.workflowCwd !== childCwd || !TOKEN.test(value.spawnToken ?? "") ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    value.origin !== "research_session" || value.relation !== "dispatch") fail(400, "research-session-provenance-invalid");
  return value;
}

/**
 * @param {object} deps
 * @param {(id:string)=>any} deps.getSession
 * @param {()=>Array<any>} deps.listSessions
 * @param {(args:object)=>Promise<object>} deps.verifyParent
 * @param {(cwd:string, identity:object, verified:object)=>Promise<object>} deps.prepareSpawn
 * @param {{file:Function, remove:Function}} deps.pendingPluginRefRegistry
 * @param {{file:Function, remove:Function}} deps.pendingPrincipalOwnerRegistry
 * @param {{enqueue:Function, remove?:Function}} deps.initialPrompts
 * @param {(cwd:string, options:object)=>Promise<object>} deps.spawn
 * @param {()=>string} [deps.spawnStrategy]
 * @param {(principal:unknown)=>boolean} deps.isLocalOperator
 * @param {()=>number} [deps.now]
 * @param {()=>string} [deps.mintToken]
 * @param {number} [deps.maxPerParent]
 * @param {number} [deps.maxTotal]
 */
export function createResearchSessionService(deps) {
  const now = deps.now ?? (() => new Date());
  const mintToken = deps.mintToken ?? randomUUID;
  const maxPerParent = deps.maxPerParent ?? RESEARCH_SESSION_LIMITS.maxPerParent;
  const maxTotal = deps.maxTotal ?? RESEARCH_SESSION_LIMITS.maxTotal;
  const inFlight = new Map();
  const requests = new Map();
  const released = new Set();

  function prune() {
    const cutoff = now().getTime() - 60_000;
    for (const [token, row] of inFlight) if (row.at < cutoff) inFlight.delete(token);
  }
  function sessions() {
    try { return deps.listSessions(); } catch { fail(503, "research-session-inventory-unavailable"); }
  }

  function assertOwner(parent, principal) {
    if (deps.isLocalOperator(principal)) return;
    if (principal) {
      if (!parent.principalOwner || !sameOwner(parent.principalOwner, principal)) fail(404, "research-session-parent-not-found");
      return;
    }
    if (parent.principalOwner) fail(404, "research-session-parent-not-found");
  }

  async function authorize(input) {
    const parent = deps.getSession(input.sessionId);
    if (!parent || typeof parent.cwd !== "string" || !parent.cwd.startsWith("/")) fail(404, "research-session-parent-not-found");
    assertOwner(parent, input.principal);
    const verified = await deps.verifyParent({ parent, principal: input.principal, expiresAt: input.expiresAt });
    if (!object(verified) || !HASH.test(verified.charterHash ?? "") || !ADOPTION.test(verified.adoptionId ?? "") ||
      (verified.cwd !== undefined && verified.cwd !== parent.cwd) || (verified.ownerKey !== undefined && typeof verified.ownerKey !== "string")) fail(404, "research-session-parent-not-joined");
    return { parent, ...verified, cwd: parent.cwd };
  }

  async function create(input) {
    const body = validateResearchSessionRequest(input.body);
    const verified = await authorize({ ...input, sessionId: body.parentSessionId });
    const parent = verified.parent;
    const requestKey = JSON.stringify([verified.ownerKey, parent.cwd, verified.adoptionId, verified.charterHash, body.parentSessionId, body.requestId]);
    const readOnly = body.readOnly === true || researchProvenanceOf(parent)?.readOnly === true;
    // Preserve the prior fingerprint when no narrowing is present. Children cannot clear a parent constraint.
    const fingerprint = JSON.stringify([body.role, body.task, body.stage, body.tasks ?? null, ...(readOnly ? [true] : [])]);
    const cached = requests.get(requestKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) fail(409, "research-session-idempotency-conflict");
      if (cached.result) return cached.result;
    }
    const existing = sessions().find(row => {
      const p = researchProvenanceOf(row);
      return p?.requestId === body.requestId && p.parentSessionId === body.parentSessionId && p.adoptionId === verified.adoptionId && p.workflowCwd === parent.cwd && p.charterHash === verified.charterHash;
    });
    if (existing) {
      const p = researchProvenanceOf(existing);
      if (JSON.stringify([p.role, p.task, p.stage, p.tasks ?? null, ...(p.readOnly === true ? [true] : [])]) !== fingerprint) fail(409, "research-session-idempotency-conflict");
      return compactSpawnReceipt(p, "registered", existing.id);
    }
    if (cached) fail(409, cached.unknown ? "research-session-spawn-outcome-unknown" : "research-session-spawn-in-progress");
    const ancestors = new Set([body.parentSessionId]);
    let cursor = parent, depth = 1, rootSessionId = parent.id;
    for (;;) {
      const p = researchProvenanceOf(cursor);
      if (!p) break;
      if (ancestors.has(p.parentSessionId) || p.adoptionId !== verified.adoptionId || p.charterHash !== verified.charterHash || p.workflowCwd !== parent.cwd) fail(409, "research-session-lineage-invalid");
      ancestors.add(p.parentSessionId); depth++;
      rootSessionId = p.rootSessionId ?? p.parentSessionId;
      cursor = deps.getSession(p.parentSessionId);
      if (!cursor) { depth = (p.depth ?? depth - 1) + 1; break; }
    }
    if (depth > (deps.maxDepth ?? RESEARCH_SESSION_LIMITS.maxDepth) || (body.tasks && depth >= (deps.maxDepth ?? RESEARCH_SESSION_LIMITS.maxDepth))) fail(409, "research-session-depth-limit");
    const parentRole = researchProvenanceOf(parent)?.role;
    if (parentRole && /(?:^|[-_])(ssh|agy|model-assessor|mainline-supervisor)(?:$|[-_])/.test(parentRole)) fail(409, "research-session-leaf-role");
    prune();
    const rows = sessions();
    const provenanceOf = researchProvenanceOf;
    for (const row of rows) {
      const provenance = provenanceOf(row);
      if (provenance && inFlight.get(provenance.spawnToken)?.parentSessionId === provenance.parentSessionId) inFlight.delete(provenance.spawnToken);
    }
    // Persistent dispatcher reservations survive host restarts. Exclude the
    // current request's ledger reservation: it is not a second process.
    const pending = new Map([...inFlight].map(([token, row]) => [row.requestId ?? token, row]));
    for (const row of deps.unregisteredReservations?.() ?? []) if (row.requestId !== body.requestId) pending.set(row.requestId, row);
    const family = rows.filter(row => provenanceOf(row)?.rootSessionId === rootSessionId && provenanceOf(row)?.adoptionId === verified.adoptionId);
    if (family.length + [...pending.values()].filter(row => row.rootSessionId === rootSessionId).length >= (deps.maxDescendants ?? RESEARCH_SESSION_LIMITS.maxDescendants)) fail(409, "research-session-budget-limit");
    const resident = rows.filter(row => provenanceOf(row) && (! ["ended", "closed", "archived"].includes(row.status) || deps.isRecoveringSession?.(row)));
    const active = resident.filter(row => !released.has(provenanceOf(row).spawnToken) && !deps.isCompleted?.(provenanceOf(row).spawnToken));
    const runnable = active.filter(row => !deps.isWaitingCoordinator?.(row.id));
    const activeParent = active.filter(row => provenanceOf(row).parentSessionId === body.parentSessionId).length;
    const pendingParent = [...pending.values()].filter(row => row.parentSessionId === body.parentSessionId).length;
    if (activeParent + pendingParent >= maxPerParent) fail(409, "research-session-concurrency-limit");
    if (runnable.length + pending.size >= maxTotal) fail(409, "research-session-capacity-limit");
    // Waiting coordinators still consume real processes and memory. A separate
    // finite resident cap plus OS/container memory admission prevents moving a
    // worker-slot deadlock into unbounded process growth.
    if (resident.length + pending.size >= (deps.maxResident ?? RESEARCH_SESSION_LIMITS.maxResident)) fail(409, "research-session-resident-limit");
    const available = deps.availableMemory?.() ?? (typeof process.availableMemory === "function" ? process.availableMemory() : freemem());
    if (!Number.isFinite(available) || available < (deps.minAvailableMemory ?? RESEARCH_SESSION_LIMITS.minAvailableMemory)) fail(409, "research-session-memory-limit");

    const spawnToken = mintToken();
    if (!TOKEN.test(spawnToken) || inFlight.has(spawnToken)) fail(503, "research-session-token-unavailable");
    if (requests.size >= 4096) { for (const [key, value] of requests) { if (value.result) { requests.delete(key); break; } } }
    if (requests.size >= 4096) fail(409, "research-session-request-capacity");
    inFlight.set(spawnToken, { parentSessionId: body.parentSessionId, requestId: body.requestId, rootSessionId, at: now().getTime() });
    requests.set(requestKey, { fingerprint });

    let refFiled = false;
    let ownerFiled = false;
    let promptQueued = false;
    let spawnAttempted = false;
    try {
      const provenance = provenanceFor({
        parentSessionId: body.parentSessionId, role: body.role, task: body.task, stage: body.stage,
        charterHash: verified.charterHash, adoptionId: verified.adoptionId, workflowCwd: parent.cwd,
        spawnToken, now, requestId: body.requestId, tasks: body.tasks, rootSessionId, depth, readOnly,
      });
      if (input.taskContext) {
        provenance.dispatchId = input.taskContext.dispatchId;
        provenance.taskId = input.taskContext.taskId;
      }
      assertProvenance(provenance, parent.cwd);
      const identity = {
        principal: input.principal ?? null,
        expiresAt: input.expiresAt ?? null,
        write: true,
      };
      const prepared = await deps.prepareSpawn(parent.cwd, identity, {
        ownerKey: verified.ownerKey,
        researchSession: provenance,
      });
      const ref = { ...prepared, researchSession: provenance };
      if (!deps.pendingPluginRefRegistry.file(spawnToken, ref, "res-workflow")) fail(409, "research-session-ref-unavailable");
      refFiled = true;
      if (parent.principalOwner) {
        if (!deps.pendingPrincipalOwnerRegistry.file(spawnToken, parent.principalOwner)) fail(409, "research-session-owner-unavailable");
        ownerFiled = true;
      }
      const prompt = buildResearchSessionInitialPrompt(provenance, input.taskContext);
      if (deps.initialPrompts.enqueue(parent.cwd, prompt, spawnToken) !== true) fail(409, "research-session-prompt-unavailable");
      promptQueued = true;
      // Revalidate the live task grant immediately before the actual process
      // boundary. This covers both direct research_session and queued dispatch.
      await deps.beforeSpawn?.({ parent, verified, body });
      spawnAttempted = true;
      const result = await deps.spawn(parent.cwd, { spawnToken, strategy: deps.spawnStrategy?.() ?? "headless" });
      if (!result || result.success !== true) {
        fail(502, "research-session-spawn-failed");
      }
      const reply = compactSpawnReceipt(provenance, "pending");
      requests.set(requestKey, { fingerprint, result: reply });
      return reply;
    } catch (error) {
      if (spawnAttempted && !(error instanceof ResearchSessionError)) {
        requests.set(requestKey, { fingerprint, unknown: true });
        fail(503, "research-session-spawn-outcome-unknown");
      }
      requests.delete(requestKey);
      if (promptQueued && typeof deps.initialPrompts.remove === "function") {
        try { deps.initialPrompts.remove(parent.cwd, spawnToken); } catch { /* bounded cleanup */ }
      }
      if (ownerFiled) deps.pendingPrincipalOwnerRegistry.remove(spawnToken);
      if (refFiled) deps.pendingPluginRefRegistry.remove(spawnToken);
      inFlight.delete(spawnToken);
      if (!(error instanceof ResearchSessionError)) {
        const code = typeof error?.code === "string" && /^[a-z0-9-]{1,100}$/.test(error.code) ? error.code : "research-session-preflight-failed";
        fail(409, code);
      }
      throw error;
    }
  }

  return { create, authorize, release: spawnToken => { released.add(spawnToken); inFlight.delete(spawnToken); } };
}
