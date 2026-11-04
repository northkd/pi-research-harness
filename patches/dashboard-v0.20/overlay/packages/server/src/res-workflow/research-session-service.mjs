/**
 * Backend for the native `research_session` tool.
 *
 * It creates a real top-level Pi session (a sibling, not a subagent), joins it
 * through the SAME token-keyed res-workflow spawn preparation used by the
 * browser road, binds the parent's owner, and queues exactly one token-bound
 * initial prompt. No project/model/destination is accepted from the caller.
 */
import { randomUUID } from "node:crypto";

export const RESEARCH_SESSION_SCHEMA = "pi-research-session.v1";
export const RESEARCH_SESSION_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"];
export const RESEARCH_SESSION_LIMITS = Object.freeze({ maxPerParent: 4, maxTotal: 8, maxTaskChars: 4000, maxRoleChars: 40 });
const ROLE = /^[a-z][a-z0-9-]{1,39}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ADOPTION = /^adopt-[a-f0-9]{24}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const ALLOWED_KEYS = new Set(["parentSessionId", "role", "task", "stage", "requestId"]);
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

export function validateResearchSessionRequest(body) {
  if (!object(body)) fail(400, "research-session-invalid-request");
  for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) fail(400, "research-session-unknown-field");
  if (typeof body.parentSessionId !== "string" || !ID.test(body.parentSessionId)) fail(400, "research-session-parent-invalid");
  if (typeof body.role !== "string" || !ROLE.test(body.role)) fail(400, "research-session-role-invalid");
  if (!text(body.task, RESEARCH_SESSION_LIMITS.maxTaskChars)) fail(400, "research-session-task-invalid");
  if (!RESEARCH_SESSION_STAGES.includes(body.stage)) fail(400, "research-session-stage-invalid");
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId))) fail(400, "research-session-request-id-invalid");
  return {
    parentSessionId: body.parentSessionId,
    role: body.role,
    task: body.task,
    stage: body.stage,
    requestId: body.requestId ?? randomUUID(),
  };
}

export function buildResearchSessionInitialPrompt(provenance) {
  return [
    `You are a top-level research collaborator in the confirmed res-workflow at ${provenance.workflowCwd}.`,
    `Role: ${provenance.role}`,
    `Stage: ${provenance.stage}`,
    `Parent session: ${provenance.parentSessionId}`,
    `Frozen charter: ${provenance.charterHash} (adoption ${provenance.adoptionId})`,
    "",
    "Task:",
    provenance.task,
    "",
    "You are a separate top-level session, not a subagent. Work only inside this exact joined workspace and the confirmed adoption.",
    "Use the existing research_loop tool to record real attempts, stage changes and claims. Do not create another research collaborator unless the parent explicitly asks for one.",
    "Do not treat this assignment as user authorization to start, restart, publish, install software, raise budgets, or leave the joined workspace.",
  ].join("\n");
}

function provenanceFor({ parentSessionId, role, task, stage, charterHash, adoptionId, workflowCwd, spawnToken, now }) {
  return {
    schema: RESEARCH_SESSION_SCHEMA,
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

  async function create(input) {
    const body = validateResearchSessionRequest(input.body);
    const parent = deps.getSession(body.parentSessionId);
    if (!parent || typeof parent.cwd !== "string" || !parent.cwd.startsWith("/")) fail(404, "research-session-parent-not-found");
    assertOwner(parent, input.principal);
    const verified = await deps.verifyParent({
      parent,
      principal: input.principal,
      expiresAt: input.expiresAt,
    });
    if (!object(verified) || !HASH.test(verified.charterHash ?? "") || !ADOPTION.test(verified.adoptionId ?? "")) {
      fail(404, "research-session-parent-not-joined");
    }
    if (verified.cwd !== undefined && verified.cwd !== parent.cwd) fail(404, "research-session-parent-not-joined");
    if (verified.ownerKey !== undefined && typeof verified.ownerKey !== "string") fail(404, "research-session-parent-not-joined");

    prune();
    const rows = sessions();
    const provenanceOf = row => row?.researchSession?.parentSessionId
      ? row.researchSession
      : row?.pluginRefs?.["res-workflow"]?.researchSession;
    for (const row of rows) {
      const provenance = provenanceOf(row);
      if (provenance && inFlight.get(provenance.spawnToken)?.parentSessionId === provenance.parentSessionId) inFlight.delete(provenance.spawnToken);
    }
    const live = rows.filter(row => provenanceOf(row) && !["ended", "closed", "archived"].includes(row.status));
    const activeParent = live.filter(row => provenanceOf(row).parentSessionId === body.parentSessionId).length;
    const pendingParent = [...inFlight.values()].filter(row => row.parentSessionId === body.parentSessionId).length;
    if (activeParent + pendingParent >= maxPerParent) fail(409, "research-session-concurrency-limit");
    if (live.length + inFlight.size >= maxTotal) fail(409, "research-session-capacity-limit");

    const spawnToken = mintToken();
    if (!TOKEN.test(spawnToken) || inFlight.has(spawnToken)) fail(503, "research-session-token-unavailable");
    inFlight.set(spawnToken, { parentSessionId: body.parentSessionId, at: now().getTime() });

    let refFiled = false;
    let ownerFiled = false;
    let promptQueued = false;
    try {
      const provenance = provenanceFor({
        parentSessionId: body.parentSessionId, role: body.role, task: body.task, stage: body.stage,
        charterHash: verified.charterHash, adoptionId: verified.adoptionId, workflowCwd: parent.cwd,
        spawnToken, now,
      });
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
      const prompt = buildResearchSessionInitialPrompt(provenance);
      if (deps.initialPrompts.enqueue(parent.cwd, prompt, spawnToken) !== true) fail(409, "research-session-prompt-unavailable");
      promptQueued = true;
      const result = await deps.spawn(parent.cwd, { spawnToken, strategy: deps.spawnStrategy?.() ?? "headless" });
      if (!result || result.success !== true) {
        fail(502, "research-session-spawn-failed");
      }
      return {
        status: "spawned",
        registration: "pending",
        requestId: body.requestId,
        parentSessionId: body.parentSessionId,
        spawnToken,
        role: body.role,
        stage: body.stage,
        workflowCwd: parent.cwd,
        provenance,
        initialPromptQueued: true,
      };
    } catch (error) {
      if (promptQueued && typeof deps.initialPrompts.remove === "function") {
        try { deps.initialPrompts.remove(parent.cwd, spawnToken); } catch { /* bounded cleanup */ }
      }
      if (ownerFiled) deps.pendingPrincipalOwnerRegistry.remove(spawnToken);
      if (refFiled) deps.pendingPluginRefRegistry.remove(spawnToken);
      inFlight.delete(spawnToken);
      throw error;
    }
  }

  return { create };
}
