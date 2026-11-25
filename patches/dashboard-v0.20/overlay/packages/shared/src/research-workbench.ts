/** Bounded, owner-gated observations. These never replace scientific state or confer acceptance. */
export const RESEARCH_WORKBENCH_SCHEMA = "res-workflow.workbench-observation.v1";
export const WORKBENCH_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"] as const;
export type WorkbenchStage = typeof WORKBENCH_STAGES[number];
export const WORKBENCH_STATUSES = ["registered", "active", "idle", "streaming", "ended", "queued", "started", "running", "completed", "complete", "failed", "blocked", "paused", "stopped", "cancelled", "waiting", "unknown", "pending", "partial", "stopping", "rejected"] as const;
export type WorkbenchStatus = typeof WORKBENCH_STATUSES[number];
export interface ResearchWorkbenchExecution {
  id: string; kind: "pi-session" | "native-subagent"; sessionId?: string; parentExecutionId?: string; nativeRunId?: string;
  role?: string; stage?: WorkbenchStage; status: WorkbenchStatus; observedModel?: string; currentTool?: string | null;
  startedAt?: string; endedAt?: string; lastActivityAt?: string;
  prompt?: string; output?: string; error?: string; recentOutput?: string[];
}
export interface ResearchWorkbenchRole { role: string; model?: string; skills?: string[]; purpose?: string; note?: string }
export interface ResearchWorkbenchConfiguration {
  stages: Partial<Record<WorkbenchStage, { roles?: Array<ResearchWorkbenchRole | string>; sequentialRole?: ResearchWorkbenchRole | string }>>;
}
export interface ResearchWorkbenchRelation {
  id: string; fromExecutionId: string; toExecutionId: string; kind: "dispatch" | "handoff";
  evidence: { source: "tool-call" | "native-event" | "native-status" | "explicit-record"; eventId: string };
}
export interface ResearchWorkbenchObservation {
  schema: typeof RESEARCH_WORKBENCH_SCHEMA; cwd: string; adoptionId: string; charterHash: string; revision: string;
  updatedAt: string; heartbeatAt: string;
  coverage: { partial: boolean; reasons: string[]; parentSessions: number; nativeRuns: number };
  executions: ResearchWorkbenchExecution[]; relations: ResearchWorkbenchRelation[];
  configuration?: ResearchWorkbenchConfiguration;
  configurationSource?: { kind: "stage-map" | "run-configuration"; sha256: string };
  observedUsage: { responses: number; inputTokens: number; outputTokens: number; inheritedExcluded: number; metric: "observed-assistant-responses" };
  actions?: Array<{ id: string; action: string; at: string; status: "completed" | "failed"; claimId?: string }>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const id = (value: unknown): value is string => text(value, 1024) && /^[A-Za-z0-9_./:@+()[\]-]+$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const optional = (value: unknown, test: (value: unknown) => boolean) => value === undefined || test(value);
function role(value: unknown): boolean {
  return id(value) || shape(value, ["role", "model", "skills", "purpose", "note"]) && id(value.role)
    && optional(value.model, v => text(v)) && optional(value.purpose, v => text(v, 1000)) && optional(value.note, v => text(v, 1000))
    && optional(value.skills, v => Array.isArray(v) && v.length <= 64 && v.every(id));
}
export function isResearchWorkbenchObservation(value: unknown): value is ResearchWorkbenchObservation {
  if (!shape(value, ["schema", "cwd", "adoptionId", "charterHash", "revision", "updatedAt", "heartbeatAt", "coverage", "executions", "relations", "configuration", "configurationSource", "observedUsage", "actions"])
    || value.schema !== RESEARCH_WORKBENCH_SCHEMA || !text(value.cwd, 4096) || !value.cwd.startsWith("/") || !id(value.adoptionId)
    || !hash(value.charterHash) || !hash(value.revision) || !iso(value.updatedAt) || !iso(value.heartbeatAt)) return false;
  const coverage = value.coverage, usage = value.observedUsage;
  if (!shape(coverage, ["partial", "reasons", "parentSessions", "nativeRuns"]) || typeof coverage.partial !== "boolean" || !count(coverage.parentSessions) || !count(coverage.nativeRuns)
    || !Array.isArray(coverage.reasons) || coverage.reasons.length > 32 || !coverage.reasons.every(v => text(v, 256))) return false;
  if (!shape(usage, ["responses", "inputTokens", "outputTokens", "inheritedExcluded", "metric"]) || usage.metric !== "observed-assistant-responses"
    || ![usage.responses, usage.inputTokens, usage.outputTokens, usage.inheritedExcluded].every(count)) return false;
  if (!Array.isArray(value.executions) || value.executions.length > 256 || !value.executions.every(row => shape(row, ["id", "kind", "sessionId", "parentExecutionId", "nativeRunId", "role", "stage", "status", "observedModel", "currentTool", "startedAt", "endedAt", "lastActivityAt", "prompt", "output", "error", "recentOutput"])
    && id(row.id) && ["pi-session", "native-subagent"].includes(row.kind as string) && WORKBENCH_STATUSES.includes(row.status as WorkbenchStatus)
    && ["sessionId", "parentExecutionId", "nativeRunId", "role"].every(key => optional(row[key], id))
    && optional(row.stage, v => WORKBENCH_STAGES.includes(v as WorkbenchStage)) && optional(row.observedModel, v => text(v))
    && (row.currentTool === null || optional(row.currentTool, id)) && ["startedAt", "endedAt", "lastActivityAt"].every(key => optional(row[key], iso))
    && optional(row.prompt, v => typeof v === "string" && v.length <= 65536) && optional(row.output, v => typeof v === "string" && v.length <= 65536)
    && optional(row.error, v => typeof v === "string" && v.length <= 8192)
    && optional(row.recentOutput, v => Array.isArray(v) && v.every(item => typeof item === "string" && item.length <= 4096)))) return false;
  const executions = value.executions as ResearchWorkbenchExecution[];
  const ids = new Set(executions.map(row => row.id));
  if (ids.size !== executions.length || executions.some(row => row.parentExecutionId !== undefined && (!ids.has(row.parentExecutionId) || row.parentExecutionId === row.id))) return false;
  if (!Array.isArray(value.relations) || value.relations.length > 512 || !value.relations.every(row => shape(row, ["id", "fromExecutionId", "toExecutionId", "kind", "evidence"])
    && id(row.id) && ids.has(row.fromExecutionId as string) && ids.has(row.toExecutionId as string) && row.fromExecutionId !== row.toExecutionId
    && ["dispatch", "handoff"].includes(row.kind as string) && shape(row.evidence, ["source", "eventId"])
    && ["tool-call", "native-event", "native-status", "explicit-record"].includes(row.evidence.source as string) && id(row.evidence.eventId))) return false;
  if (new Set((value.relations as ResearchWorkbenchRelation[]).map(row => row.id)).size !== value.relations.length) return false;
  if (value.configuration !== undefined && (!shape(value.configuration, ["stages"]) || !object(value.configuration.stages)
    || Object.entries(value.configuration.stages).some(([stage, entry]) => !WORKBENCH_STAGES.includes(stage as WorkbenchStage) || !shape(entry, ["roles", "sequentialRole"])
      || !optional(entry.roles, v => Array.isArray(v) && v.length <= 64 && v.every(role)) || !optional(entry.sequentialRole, role)))) return false;
  if (value.configurationSource !== undefined && (!shape(value.configurationSource, ["kind", "sha256"]) || !["stage-map", "run-configuration"].includes(value.configurationSource.kind as string)
    || typeof value.configurationSource.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.configurationSource.sha256))) return false;
  if ((value.configuration === undefined) !== (value.configurationSource === undefined)) return false;
  if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.length > 128 || !value.actions.every(row => shape(row, ["id", "action", "at", "status", "claimId"])
    && id(row.id) && id(row.action) && iso(row.at) && ["completed", "failed"].includes(row.status as string) && optional(row.claimId, id)))) return false;
  return JSON.stringify(value).length <= 2 * 1024 * 1024;
}
