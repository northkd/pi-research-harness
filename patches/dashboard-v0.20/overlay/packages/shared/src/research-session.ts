/**
 * Provenance and metadata-only projections for top-level research collaborators.
 *
 * A research collaborator is an ordinary Pi session that was spawned as a
 * sibling of its creator and joined to the same confirmed res-workflow
 * adoption. It is NOT a native subagent: there is no fake execution row and no
 * model run created here. The persisted provenance below is enough for the UI
 * to label the child and to derive a dispatch relation from real session ids.
 */
import type { ResearchWorkbenchExecution, ResearchWorkbenchRelation } from "./research-workbench.js";

export const RESEARCH_SESSION_SCHEMA = "pi-research-session.v1" as const;
export const RESEARCH_SESSION_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"] as const;
export type ResearchSessionStage = typeof RESEARCH_SESSION_STAGES[number];
export const RESEARCH_SESSION_LIMITS = Object.freeze({
  maxPerParent: 4,
  maxTotal: 8,
  maxTaskChars: 4000,
  maxRoleChars: 40,
});

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROLE = /^[a-z][a-z0-9-]{1,39}$/;
const ADOPTION = /^adopt-[a-f0-9]{24}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const iso = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

export interface ResearchDispatchTask { id: string; role: string; task: string; stage: ResearchSessionStage; dependsOn?: string[] }

/** Persisted on the CHILD session as `researchSession` and in its plugin-ref bag. */
export interface ResearchSessionProvenance {
  schema: typeof RESEARCH_SESSION_SCHEMA;
  parentSessionId: string;
  creatorSessionId: string;
  creatorAgent: "research_session";
  role: string;
  task: string;
  stage: ResearchSessionStage;
  charterHash: string;
  adoptionId: string;
  workflowCwd: string;
  spawnToken: string;
  requestId?: string;
  rootSessionId?: string;
  depth?: number;
  tasks?: ResearchDispatchTask[];
  dispatchId?: string;
  taskId?: string;
  createdAt: string;
  origin: "research_session";
  relation: "dispatch";
}

export interface ResearchSessionProjection {
  provenance: ResearchSessionProvenance;
}

export function isResearchSessionProvenance(value: unknown): value is ResearchSessionProvenance {
  if (!object(value)) return false;
  const row = value as Partial<ResearchSessionProvenance>;
  return row.schema === RESEARCH_SESSION_SCHEMA &&
    ID.test(row.parentSessionId ?? "") && ID.test(row.creatorSessionId ?? "") &&
    row.parentSessionId === row.creatorSessionId &&
    row.creatorAgent === "research_session" && ROLE.test(row.role ?? "") &&
    text(row.task, RESEARCH_SESSION_LIMITS.maxTaskChars) &&
    RESEARCH_SESSION_STAGES.includes(row.stage as ResearchSessionStage) &&
    HASH.test(row.charterHash ?? "") && ADOPTION.test(row.adoptionId ?? "") &&
    text(row.workflowCwd, 4096) && row.workflowCwd.startsWith("/") &&
    TOKEN.test(row.spawnToken ?? "") && iso(row.createdAt) &&
    row.origin === "research_session" && row.relation === "dispatch" &&
    (row.requestId === undefined || TOKEN.test(row.requestId)) &&
    (row.rootSessionId === undefined || ID.test(row.rootSessionId)) &&
    (row.depth === undefined || (Number.isSafeInteger(row.depth) && row.depth >= 1 && row.depth <= 3)) &&
    (row.dispatchId === undefined || ID.test(row.dispatchId)) && (row.taskId === undefined || ID.test(row.taskId)) &&
    (row.tasks === undefined || (Array.isArray(row.tasks) && row.tasks.length >= 2 && row.tasks.length <= 12 && row.tasks.every(task =>
      object(task) && ID.test(task.id ?? "") && ROLE.test(task.role ?? "") && text(task.task, 4000) && RESEARCH_SESSION_STAGES.includes(task.stage) &&
      (task.dependsOn === undefined || (Array.isArray(task.dependsOn) && task.dependsOn.length <= 12 && task.dependsOn.every(id => typeof id === "string" && ID.test(id)))))));
}

export function normalizeResearchSessionProvenance(value: unknown): ResearchSessionProvenance {
  if (!isResearchSessionProvenance(value)) throw new Error("research-session-provenance-invalid");
  return {
    schema: value.schema, parentSessionId: value.parentSessionId, creatorSessionId: value.creatorSessionId,
    creatorAgent: value.creatorAgent, role: value.role, task: value.task, stage: value.stage,
    charterHash: value.charterHash, adoptionId: value.adoptionId, workflowCwd: value.workflowCwd,
    spawnToken: value.spawnToken, createdAt: value.createdAt, origin: value.origin, relation: value.relation,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    ...(value.rootSessionId === undefined ? {} : { rootSessionId: value.rootSessionId }),
    ...(value.depth === undefined ? {} : { depth: value.depth }),
    ...(value.dispatchId === undefined ? {} : { dispatchId: value.dispatchId }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.tasks === undefined ? {} : { tasks: value.tasks.map(task => ({ id: task.id, role: task.role, task: task.task, stage: task.stage, dependsOn: [...(task.dependsOn ?? [])] })) }),
  };
}

/** Read persisted metadata only; never invents a session or execution. */
export function projectResearchSession(session: {
  id?: unknown;
  researchSession?: unknown;
  pluginRefs?: Record<string, Record<string, unknown>>;
}): ResearchSessionProjection | null {
  // New rows store provenance in the res-workflow bag (same spawn association);
  // older/distinct owners may keep a dedicated research-session bag.
  const fromWorkflowBag = session.pluginRefs?.["res-workflow"]?.researchSession;
  const fromBag = session.pluginRefs?.["research-session"]?.researchSession;
  const candidate = session.researchSession ?? fromWorkflowBag ?? fromBag;
  if (!isResearchSessionProvenance(candidate)) return null;
  return { provenance: normalizeResearchSessionProvenance(candidate) };
}

/**
 * Stable metadata-derived relation over ACTUAL execution ids. Native sessions
 * are projected as `session-<sessionId>` by workbench-sync, so the raw session
 * ids are never used as endpoints unless a matching execution id exists.
 */
export function researchSessionRelation(
  provenance: ResearchSessionProvenance,
  endpoints: { parentExecutionId: string; childExecutionId: string },
): ResearchWorkbenchRelation {
  if (!ID.test(endpoints.parentExecutionId) || !ID.test(endpoints.childExecutionId) || endpoints.parentExecutionId === endpoints.childExecutionId) {
    throw new Error("research-session-endpoint-invalid");
  }
  return {
    id: `research-session:${provenance.spawnToken}`,
    fromExecutionId: endpoints.parentExecutionId,
    toExecutionId: endpoints.childExecutionId,
    kind: "dispatch",
    evidence: { source: "explicit-record", eventId: provenance.spawnToken },
  };
}

function executionIdForSession(executions: Array<Pick<ResearchWorkbenchExecution, "id"> & { sessionId?: string }>, sessionId: string): string | undefined {
  const direct = executions.find(row => row.sessionId === sessionId);
  if (direct) return direct.id;
  const prefixed = `session-${sessionId}`;
  if (executions.some(row => row.id === prefixed)) return prefixed;
  return executions.some(row => row.id === sessionId) ? sessionId : undefined;
}

/**
 * Project relations only for children and parents that already exist as real
 * executions. Missing endpoints are omitted rather than synthesized.
 */
export function deriveResearchSessionRelations(
  executions: Array<Pick<ResearchWorkbenchExecution, "id"> & { sessionId?: string }>,
  sessions: Array<{ id: string; researchSession?: unknown; pluginRefs?: Record<string, Record<string, unknown>> }>,
): ResearchWorkbenchRelation[] {
  const byId = new Map<string, ResearchWorkbenchRelation>();
  for (const session of sessions) {
    const projected = projectResearchSession(session);
    if (!projected) continue;
    const parentExecutionId = executionIdForSession(executions, projected.provenance.parentSessionId);
    const childExecutionId = executionIdForSession(executions, session.id);
    if (!parentExecutionId || !childExecutionId || parentExecutionId === childExecutionId) continue;
    const relation = researchSessionRelation(projected.provenance, { parentExecutionId, childExecutionId });
    byId.set(relation.id, relation);
  }
  return [...byId.values()];
}

/** The first prompt for the child, built from verified metadata only. */
export function buildResearchSessionInitialPrompt(provenance: ResearchSessionProvenance): string {
  const row = normalizeResearchSessionProvenance(provenance);
  return [
    `You are a research collaborator with a real parent session in the confirmed res-workflow at ${row.workflowCwd}.`,
    `Role: ${row.role}`,
    `Stage: ${row.stage}`,
    `Parent session: ${row.parentSessionId}`,
    `Frozen charter: ${row.charterHash} (adoption ${row.adoptionId})`,
    '',
    'Task:',
    row.task,
    '',
    'You run in a separate Pi process, but remain a child of the recorded parent. Keep the same workspace, owner, frozen charter, permission scope and shared task budget.',
    'First call research_dispatch status. Declared structured tasks are automatically scheduled by the server; coordinate their results instead of doing them locally. For several separable work items, submit a research_dispatch plan with dependencies before bulk work. For one indivisible item, use research_dispatch atomic with a concrete reason. Controlled child delegation is allowed within the shared limits; leaf roles cannot delegate.',
    'Use research_loop to record actual attempts and evidence. If status shows a dispatcher assignment, finish with research_dispatch report (completed, failed or blocked), a truthful summary and relative evidence paths. Wait for your own children before reporting completion. This assignment never expands the inherited permission scope, provider access, budget or workspace.',
  ].join('\n');
}
