/**
 * Backend for the native `research_session` tool.
 *
 * It creates a separate native Pi process with a recorded logical parent, joins it
 * through the SAME token-keyed res-workflow spawn preparation used by the
 * browser road, binds the parent's owner, and queues exactly one token-bound
 * initial prompt. No project/model/destination is accepted from the caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from "node:crypto";
import { freemem } from "node:os";

export const RESEARCH_SESSION_SCHEMA = "pi-research-session.v1";
export const RESEARCH_SESSION_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"];
export const RESEARCH_SESSION_LIMITS = Object.freeze({ maxPerParent: 4, maxTotal: 8, maxTaskChars: 4000, maxRoleChars: 40, maxDepth: 3, maxResident: 32, minAvailableMemory: 1024 * 1024 * 1024 });
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

/** A process may be created before its gateway registration is visible. Every
 * entry point, including direct research_session calls, therefore writes an
 * idempotency reservation BEFORE crossing the process boundary. An ambiguous
 * transport error or a server restart must never turn into a second process. */
export function createResearchSessionStore(directory) {
  const filename = key => createHash('sha256').update(key).digest('hex') + '.json';
  const safeDirectory = () => {
    const resolved = path.resolve(directory);
    let cursor = path.parse(resolved).root;
    for (const part of resolved.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail(503, 'research-session-store-unsafe');
    }
    fs.chmodSync(resolved, 0o700); return resolved;
  };
  const syncDirectory = directory => {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  return {
    readAll() {
      const dir = safeDirectory();
      const names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (names.length > 16384) fail(503, 'research-session-store-capacity');
      return names.map(name => {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail(503, 'research-session-store-unsafe');
        const row = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!object(row) || row.schema !== 'pi-research-session-request.v1' || typeof row.key !== 'string' || filename(row.key) !== name ||
          typeof row.fingerprint !== 'string' || !TOKEN.test(row.spawnToken ?? '') || !ID.test(row.parentSessionId ?? '') || !REQUEST_ID.test(row.requestId ?? '') ||
          !['launching', 'spawned', 'registered', 'unknown', 'released'].includes(row.phase)) fail(503, 'research-session-store-invalid');
        return row;
      });
    },
    write(row) {
      const dir = safeDirectory(), name = filename(row.key), file = path.join(dir, name), temporary = file + '.tmp';
      for (const candidate of [file, temporary]) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) fail(503, 'research-session-store-unsafe');
      if (fs.existsSync(file)) {
        const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (previous.key !== row.key || previous.spawnToken !== row.spawnToken) fail(409, 'research-session-request-already-reserved');
      }
      if (!fs.existsSync(file) && fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= 16384) fail(503, 'research-session-store-capacity');
      const serialized = JSON.stringify(row);
      if (Buffer.byteLength(serialized) > 256 * 1024) fail(503, 'research-session-store-too-large');
      const descriptor = fs.openSync(temporary, 'w', 0o600);
      try { fs.fchmodSync(descriptor, 0o600); fs.writeFileSync(descriptor, serialized); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file); syncDirectory(dir);
    },
    remove(key, spawnToken) {
      const dir = safeDirectory(), file = path.join(dir, filename(key));
      if (fs.existsSync(file)) {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail(503, 'research-session-store-unsafe');
        // A failed concurrent preflight can clean only its own reservation.
        const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (previous.key !== key || spawnToken && previous.spawnToken !== spawnToken) return;
        fs.unlinkSync(file); syncDirectory(dir);
      }
    },
  };
}

/** Bounded DAG, whose items are executed by the server, not merely prompt advice. */
export function validateResearchTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 64) fail(400, "research-dispatch-task-count-invalid");
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

/** The project policy is read at admission time, never cached in a worker.
 * A promoted former collaborator is a new root; its historical provenance is
 * evidence, not the parent of its new tenure. */
export async function readResearchSchedulingPolicy(deps, parent, verified) {
  if (!deps.getSchedulingPolicy) return null;
  const policy = await deps.getSchedulingPolicy({ parent, verified });
  if (!object(policy) || !Number.isSafeInteger(policy.maxMultiAgents) || policy.maxMultiAgents < 1 || policy.maxMultiAgents > 64 ||
    !Number.isSafeInteger(policy.maxSubagents) || policy.maxSubagents < 1 || policy.maxSubagents > 64 ||
    (policy.mainSessionId !== undefined && policy.mainSessionId !== null && !ID.test(policy.mainSessionId)) ||
    (policy.tenureId !== undefined && policy.tenureId !== null && !ID.test(policy.tenureId))) fail(503, 'research-scheduling-policy-invalid');
  return policy;
}

export function researchParentConcurrency(parent, policy, fallback = RESEARCH_SESSION_LIMITS.maxPerParent) {
  if (!policy) return fallback;
  const isMain = policy.mainSessionId ? parent.id === policy.mainSessionId : !researchProvenanceOf(parent);
  return isMain ? policy.maxMultiAgents : policy.maxSubagents;
}

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
  const dispatcherAssigned = typeof dispatchId === 'string' && ID.test(dispatchId) && typeof taskId === 'string' && ID.test(taskId);
  const prefix = [
    'You are a research collaborator in a fresh Pi session joined to the confirmed research workbench. No parent conversation is copied into this task.',
    `Role: ${provenance.role}`,
    `Stage: ${provenance.stage}`,
    `Parent session: ${provenance.parentSessionId}`,
    `Frozen charter: ${provenance.charterHash} (adoption ${provenance.adoptionId})`,
    'Use the verified workbench context for the workspace, current charter and permission scope. This assignment expands none of them.',
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
    'Use research_communication pending for formal parent/child messages. Send kind=request to your parent for help and reply to exact child requests. contact_supervisor serves ordinary subagents, not this formal parent link.',
    'Own subsequent decomposition of this approved branch. Schedule your own bounded children with research_dispatch plan; ordinary in-scope decomposition needs no repeated lead/user approval. Send cross-branch decisions and additional permission needs to the parent.',
    dispatcherAssigned
      ? 'Declared structured tasks are automatically scheduled. Coordinate their receipts instead of redoing the work. For several separable items submit a plan; for one indivisible item record atomic with a concrete reason. Leaf roles cannot delegate.'
      : 'This is a direct research_session. If verified status has no dispatcher assignment, execute the original bounded task without inventing an assignment or an atomic reason. Declared child tasks, if present, are scheduled automatically; coordinate their receipts.',
    dispatcherAssigned
      ? 'Use research_loop to record actual evidence. Finish an assigned task with research_dispatch report (completed, failed or blocked), a short summary and relative evidence paths. Wait for your own children and independent checks before claiming completion. Publication, provider access and workspace limits remain unchanged.'
      : 'Use research_loop to record actual evidence. With no dispatcher assignment, report your actual completed/partial/blocked/failed result using research_communication report with a stable requestId and evidence references. HANDOFF files may remain evidence artifacts; do not rely on project-specific watchers or retry research_dispatch report after assignment-not-found. Wait for your own children and checks. Delivery, scientific acceptance and native process exit are separate. Publication, provider access and workspace limits remain unchanged.',
    'Prefer research_communication report for assigned results too; the host forwards terminal reports to the real dispatcher assignment. No result receipt proves scientific acceptance or process exit.',
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
    ...(provenance.tenureId ? { tenureId: provenance.tenureId } : {}),
    ...(sessionId ? { sessionId } : {}),
    spawnToken: provenance.spawnToken, role: provenance.role, stage: provenance.stage,
    workflowCwd: provenance.workflowCwd, charterHash: provenance.charterHash, adoptionId: provenance.adoptionId,
    ...(provenance.readOnly === true ? { readOnly: true } : {}),
    initialPromptQueued: true,
  };
}

function provenanceFor({ parentSessionId, role, task, stage, charterHash, adoptionId, workflowCwd, spawnToken, now, requestId, tasks, rootSessionId, depth, readOnly, tenureId }) {
  return {
    schema: RESEARCH_SESSION_SCHEMA,
    requestId, rootSessionId, depth,
    ...(tenureId ? { tenureId } : {}),
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
  const maxTotal = deps.maxTotal ?? RESEARCH_SESSION_LIMITS.maxTotal;
  const durableRequests = (deps.store?.readAll() ?? []).map(row => structuredClone(row));
  const requests = new Map(durableRequests.map(row => [row.key, row]));
  const inFlight = new Map(durableRequests.filter(row => row.phase !== 'released').map(row => [row.spawnToken, {
    parentSessionId: row.parentSessionId, requestId: row.requestId, rootSessionId: row.rootSessionId,
    at: Date.parse(row.createdAt),
  }]));
  const released = new Set(durableRequests.filter(row => row.phase === 'released').map(row => row.spawnToken));
  // A restored worker must count while its previous completion receipt is
  // still being superseded by the durable communication outbox.
  const reactivated = new Set(durableRequests.filter(row => row.phase !== 'released' && row.reactivated === true).map(row => row.spawnToken));
  const persistRequest = (key, row) => {
    const next = structuredClone({ ...row, schema: 'pi-research-session-request.v1', key });
    deps.store?.write(next); requests.set(key, next); return next;
  };
  const removeRequest = (key, token) => { deps.store?.remove(key, token); requests.delete(key); };
  // Admission and reservation form one ordered critical section, including
  // direct research_session calls arriving while a queued launch is awaiting I/O.
  let createTail = Promise.resolve();
  const serialAdmission = operation => { const pending = createTail.then(operation); createTail = pending.catch(() => {}); return pending; };

  // An elapsed timeout is not proof that a process exited. Reservations remain
  // until registration, a witnessed launch failure, or an explicit completion.
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

  async function checkAdmission({ parent, verified, policy, requestId, rootSessionId, ownToken, resuming = false }) {
    const livePolicy = await readResearchSchedulingPolicy(deps, parent, verified);
    if (policy?.tenureId && livePolicy?.tenureId !== policy.tenureId) fail(409, 'research-dispatch-tenure-changed');
    const maxPerParent = researchParentConcurrency(parent, livePolicy, deps.maxPerParent ?? RESEARCH_SESSION_LIMITS.maxPerParent);
    const rows = sessions(), provenanceOf = researchProvenanceOf;
    const completed = token => !reactivated.has(token) && (released.has(token) || deps.isCompleted?.(token));
    for (const row of rows) {
      const provenance = provenanceOf(row);
      if (provenance && inFlight.get(provenance.spawnToken)?.parentSessionId === provenance.parentSessionId) inFlight.delete(provenance.spawnToken);
    }
    const pendingKey = row => JSON.stringify([row.parentSessionId, row.requestId ?? row.spawnToken]);
    const pending = new Map([...inFlight].filter(([token]) => token !== ownToken).map(([_token, row]) => [pendingKey(row), row]));
    for (const row of requests.values()) if (row.key && row.phase !== 'released' && row.spawnToken !== ownToken && !rows.some(session => provenanceOf(session)?.spawnToken === row.spawnToken) && !completed(row.spawnToken)) pending.set(pendingKey(row), row);
    for (const row of deps.unregisteredReservations?.() ?? []) if (row.requestId !== requestId || row.parentSessionId !== parent.id) pending.set(pendingKey(row), row);
    // No implicit lifetime budget: preserve an explicit operator-provided limit
    // only. Reactivating an existing process does not create another descendant.
    if (!resuming && deps.maxDescendants !== undefined) {
      const family = rows.filter(row => provenanceOf(row)?.rootSessionId === rootSessionId && provenanceOf(row)?.adoptionId === verified.adoptionId);
      if (family.length + [...pending.values()].filter(row => row.rootSessionId === rootSessionId).length >= deps.maxDescendants) fail(409, 'research-session-budget-limit');
    }
    const resident = rows.filter(row => provenanceOf(row) && (!ownToken || provenanceOf(row).spawnToken !== ownToken) && (!['ended', 'closed', 'archived'].includes(row.status) || deps.isRecoveringSession?.(row)));
    const active = resident.filter(row => !completed(provenanceOf(row).spawnToken));
    const runnable = active.filter(row => !deps.isWaitingCoordinator?.(row.id));
    const activeParent = active.filter(row => provenanceOf(row).parentSessionId === parent.id).length;
    const pendingParent = [...pending.values()].filter(row => row.parentSessionId === parent.id).length;
    if (activeParent + pendingParent >= maxPerParent) fail(409, 'research-session-concurrency-limit');
    if (runnable.length + pending.size >= maxTotal) fail(409, 'research-session-capacity-limit');
    // Waiting coordinators remain resident processes. Count the restored
    // process exactly once rather than treating it as a second spawn.
    if (resident.length + pending.size >= (deps.maxResident ?? RESEARCH_SESSION_LIMITS.maxResident)) fail(409, 'research-session-resident-limit');
    const available = deps.availableMemory?.() ?? (typeof process.availableMemory === 'function' ? process.availableMemory() : freemem());
    if (!Number.isFinite(available) || available < (deps.minAvailableMemory ?? RESEARCH_SESSION_LIMITS.minAvailableMemory)) fail(409, 'research-session-memory-limit');
  }

  async function create(input) {
    const body = validateResearchSessionRequest(input.body);
    const verified = await authorize({ ...input, sessionId: body.parentSessionId });
    const parent = verified.parent;
    await deps.assertDispatchAllowed?.({ parent, verified });
    const policy = await readResearchSchedulingPolicy(deps, parent, verified);
    const requestKey = JSON.stringify([verified.ownerKey, parent.cwd, verified.adoptionId, verified.charterHash, body.parentSessionId, body.requestId, ...(policy?.tenureId ? [policy.tenureId] : [])]);
    const readOnly = body.readOnly === true || researchProvenanceOf(parent)?.readOnly === true;
    // Preserve the prior fingerprint when no narrowing is present. Children cannot clear a parent constraint.
    const fingerprint = JSON.stringify([body.role, body.task, body.stage, body.tasks ?? null, ...(readOnly ? [true] : [])]);
    const cached = requests.get(requestKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) fail(409, "research-session-idempotency-conflict");
    }
    const existing = sessions().find(row => {
      const p = researchProvenanceOf(row);
      return p?.requestId === body.requestId && p.parentSessionId === body.parentSessionId && p.adoptionId === verified.adoptionId && p.workflowCwd === parent.cwd && p.charterHash === verified.charterHash && (!policy?.tenureId || p.tenureId === policy.tenureId || policy.importLegacy && !p.tenureId);
    });
    if (existing) {
      const p = researchProvenanceOf(existing);
      if (JSON.stringify([p.role, p.task, p.stage, p.tasks ?? null, ...(p.readOnly === true ? [true] : [])]) !== fingerprint) fail(409, "research-session-idempotency-conflict");
      const result = compactSpawnReceipt(p, "registered", existing.id);
      if (cached?.key) persistRequest(requestKey, { ...cached, result, phase: released.has(p.spawnToken) ? 'released' : 'registered' });
      inFlight.delete(p.spawnToken);
      return result;
    }
    if (cached?.result) return cached.result;
    if (cached) fail(409, cached.unknown || cached.key ? "research-session-spawn-outcome-unknown" : "research-session-spawn-in-progress");
    const ancestors = new Set([body.parentSessionId]);
    let cursor = parent, depth = 1, rootSessionId = parent.id;
    for (;;) {
      if (policy?.mainSessionId && cursor?.id === policy.mainSessionId) { rootSessionId = policy.mainSessionId; break; }
      const p = researchProvenanceOf(cursor);
      if (!p) break;
      if (ancestors.has(p.parentSessionId) || p.adoptionId !== verified.adoptionId || p.charterHash !== verified.charterHash || p.workflowCwd !== parent.cwd) fail(409, "research-session-lineage-invalid");
      ancestors.add(p.parentSessionId); depth++;
      rootSessionId = p.rootSessionId ?? p.parentSessionId;
      cursor = deps.getSession(p.parentSessionId);
      if (!cursor) { depth = (p.depth ?? depth - 1) + 1; break; }
    }
    if (depth > (deps.maxDepth ?? RESEARCH_SESSION_LIMITS.maxDepth) || (body.tasks && depth >= (deps.maxDepth ?? RESEARCH_SESSION_LIMITS.maxDepth))) fail(409, "research-session-depth-limit");
    const parentRole = policy?.mainSessionId === parent.id ? undefined : researchProvenanceOf(parent)?.role;
    if (parentRole && /(?:^|[-_])(ssh|agy|model-assessor|mainline-supervisor)(?:$|[-_])/.test(parentRole)) fail(409, "research-session-leaf-role");
    const admission = ownToken => checkAdmission({ parent, verified, policy, requestId: body.requestId, rootSessionId, ownToken });
    await admission();

    const spawnToken = mintToken();
    if (!TOKEN.test(spawnToken) || inFlight.has(spawnToken)) fail(503, "research-session-token-unavailable");
    // A bounded durable idempotency ledger is a storage guard, not an execution
    // budget. Never evict an acknowledged request merely to repeat its spawn.
    if (requests.size >= 16384) fail(503, "research-session-store-capacity");
    inFlight.set(spawnToken, { parentSessionId: body.parentSessionId, requestId: body.requestId, rootSessionId, at: now().getTime() });
    requests.set(requestKey, { fingerprint });

    let refFiled = false;
    let ownerFiled = false;
    let promptQueued = false;
    let spawnAttempted = false;
    let spawnConfirmedFailure = false;
    let schedulingReserved = false;
    try {
      const provenance = provenanceFor({
        parentSessionId: body.parentSessionId, role: body.role, task: body.task, stage: body.stage,
        charterHash: verified.charterHash, adoptionId: verified.adoptionId, workflowCwd: parent.cwd,
        spawnToken, now, requestId: body.requestId, tasks: body.tasks, rootSessionId, depth, readOnly, tenureId: policy?.tenureId,
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
      // Re-read after every asynchronous preflight: changing a live limit or
      // detaching/switching the main while spawn preparation waits is effective
      // before the process boundary, not just on the next browser refresh.
      const fresh = await authorize({ ...input, sessionId: body.parentSessionId });
      if (fresh.cwd !== verified.cwd || fresh.ownerKey !== verified.ownerKey || fresh.adoptionId !== verified.adoptionId || fresh.charterHash !== verified.charterHash) fail(409, 'research-session-scope-changed');
      await admission(spawnToken);
      await deps.assertDispatchAllowed?.({ parent: fresh.parent, verified: fresh });
      // Persist the uncertainty boundary even for direct launches that have no
      // dispatcher plan. A crash after this write fails closed on replay.
      persistRequest(requestKey, { fingerprint, spawnToken, requestId: body.requestId,
        parentSessionId: body.parentSessionId, rootSessionId, phase: 'launching', unknown: true, createdAt: now().toISOString() });
      await deps.acquireSchedulingReservation?.({ parent: fresh.parent, verified: fresh, requestId: body.requestId, spawnToken, tenureId: policy?.tenureId });
      schedulingReserved = true;
      await deps.assertDispatchAllowed?.({ parent: fresh.parent, verified: fresh });
      spawnAttempted = true;
      const result = await deps.spawn(parent.cwd, { spawnToken, strategy: deps.spawnStrategy?.() ?? "headless" });
      if (!result || result.success !== true) {
        spawnConfirmedFailure = true;
        fail(502, "research-session-spawn-failed");
      }
      const reply = compactSpawnReceipt(provenance, "pending");
      persistRequest(requestKey, { ...requests.get(requestKey), fingerprint, result: reply, phase: 'spawned', unknown: false });
      return reply;
    } catch (error) {
      if (spawnAttempted && !spawnConfirmedFailure) {
        // The write-ahead launching record already prevents a duplicate even
        // when persisting this more descriptive state fails after spawn.
        try { persistRequest(requestKey, { ...requests.get(requestKey), fingerprint, unknown: true, phase: 'unknown' }); } catch { /* keep durable launching reservation */ }
        fail(503, "research-session-spawn-outcome-unknown");
      }
      if (schedulingReserved) await deps.releaseSchedulingReservation?.(spawnToken);
      removeRequest(requestKey, spawnToken);
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

  async function activate(spawnToken) {
    const child = sessions().find(row => researchProvenanceOf(row)?.spawnToken === spawnToken);
    const p = researchProvenanceOf(child);
    if (!child || !p || ['ended', 'closed', 'archived'].includes(child.status)) fail(409, 'research-session-resume-unavailable');
    const parent = deps.getSession(p.parentSessionId);
    if (!parent || ['ended', 'closed', 'archived'].includes(parent.status)) fail(409, 'research-session-resume-unavailable');
    const principal = deps.principalForSession ? deps.principalForSession(parent) : parent.principalOwner ?? null;
    const verified = await authorize({ sessionId: parent.id, principal, expiresAt: null });
    if (p.workflowCwd !== verified.cwd || p.charterHash !== verified.charterHash || p.adoptionId !== verified.adoptionId) fail(409, 'research-session-scope-changed');
    const childVerified = await authorize({ sessionId: child.id, principal, expiresAt: null });
    await deps.assertDispatchAllowed?.({ parent: child, verified: childVerified });
    await deps.assertDispatchAllowed?.({ parent, verified });
    const policy = await readResearchSchedulingPolicy(deps, parent, verified);
    if (p.tenureId && policy?.tenureId !== p.tenureId) fail(409, 'research-dispatch-tenure-changed');
    await checkAdmission({ parent, verified, policy, requestId: p.requestId, rootSessionId: p.rootSessionId, ownToken: spawnToken, resuming: true });
    // A trusted internal reactivation is distinct from a duplicate spawn. The
    // shared native/session lease must be reacquired before any model wakeup.
    await deps.acquireSchedulingReservation?.({ parent, verified, requestId: p.requestId, spawnToken, tenureId: policy?.tenureId, reactivation: true });
    const key = [...requests].find(([, row]) => row.spawnToken === spawnToken)?.[0]
      ?? JSON.stringify([verified.ownerKey, parent.cwd, verified.adoptionId, verified.charterHash, parent.id, p.requestId, ...(policy?.tenureId ? [policy.tenureId] : [])]);
    const previous = requests.get(key);
    persistRequest(key, { ...previous, fingerprint: previous?.fingerprint ?? JSON.stringify([p.role, p.task, p.stage, p.tasks ?? null, ...(p.readOnly === true ? [true] : [])]),
      spawnToken, requestId: p.requestId, parentSessionId: parent.id, rootSessionId: p.rootSessionId ?? parent.id,
      phase: 'registered', reactivated: true, unknown: false, createdAt: previous?.createdAt ?? now().toISOString(), result: compactSpawnReceipt(p, 'registered', child.id) });
    reactivated.add(spawnToken); released.delete(spawnToken); inFlight.delete(spawnToken);
  }

  return {
    create: input => serialAdmission(() => create(input)),
    activate: spawnToken => serialAdmission(() => activate(spawnToken)),
    authorize,
    release: async spawnToken => {
      // Do not free either process pool until both durable ledgers acknowledge
      // the terminal receipt. Failure stays conservative and can be retried.
      for (const [key, row] of requests) if (row.spawnToken === spawnToken && row.key && row.phase !== 'released') persistRequest(key, { ...row, phase: 'released', reactivated: false });
      await deps.releaseSchedulingReservation?.(spawnToken);
      released.add(spawnToken); reactivated.delete(spawnToken); inFlight.delete(spawnToken);
    },
  };
}
