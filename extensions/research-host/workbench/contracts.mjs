// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/research-workbench.ts
var RESEARCH_WORKBENCH_SCHEMA = "res-workflow.workbench-observation.v1";
var WORKBENCH_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"];
var WORKBENCH_STATUSES = ["registered", "active", "idle", "streaming", "ended", "queued", "started", "running", "completed", "complete", "failed", "blocked", "paused", "stopped", "cancelled", "waiting", "unknown", "pending", "partial", "stopping", "rejected"];
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var shape = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
var text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
var id = (value) => text(value, 1024) && /^[A-Za-z0-9_./:@+()[\]-]+$/.test(value);
var hash = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
var count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var iso = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
var optional = (value, test) => value === void 0 || test(value);
function role(value) {
  return id(value) || shape(value, ["role", "model", "skills", "purpose", "note"]) && id(value.role) && optional(value.model, (v) => text(v)) && optional(value.purpose, (v) => text(v, 1e3)) && optional(value.note, (v) => text(v, 1e3)) && optional(value.skills, (v) => Array.isArray(v) && v.length <= 64 && v.every(id));
}
function isResearchWorkbenchObservation(value) {
  if (!shape(value, ["schema", "cwd", "adoptionId", "charterHash", "revision", "updatedAt", "heartbeatAt", "coverage", "executions", "relations", "configuration", "configurationSource", "observedUsage", "actions"]) || value.schema !== RESEARCH_WORKBENCH_SCHEMA || !text(value.cwd, 4096) || !value.cwd.startsWith("/") || !id(value.adoptionId) || !hash(value.charterHash) || !hash(value.revision) || !iso(value.updatedAt) || !iso(value.heartbeatAt)) return false;
  const coverage = value.coverage, usage = value.observedUsage;
  if (!shape(coverage, ["partial", "reasons", "parentSessions", "nativeRuns"]) || typeof coverage.partial !== "boolean" || !count(coverage.parentSessions) || !count(coverage.nativeRuns) || !Array.isArray(coverage.reasons) || coverage.reasons.length > 32 || !coverage.reasons.every((v) => text(v, 256))) return false;
  if (!shape(usage, ["responses", "inputTokens", "outputTokens", "inheritedExcluded", "metric"]) || usage.metric !== "observed-assistant-responses" || ![usage.responses, usage.inputTokens, usage.outputTokens, usage.inheritedExcluded].every(count)) return false;
  if (!Array.isArray(value.executions) || value.executions.length > 256 || !value.executions.every((row) => shape(row, ["id", "kind", "sessionId", "parentExecutionId", "nativeRunId", "role", "stage", "status", "observedModel", "currentTool", "startedAt", "endedAt", "lastActivityAt", "prompt", "output", "error", "recentOutput"]) && id(row.id) && ["pi-session", "native-subagent"].includes(row.kind) && WORKBENCH_STATUSES.includes(row.status) && ["sessionId", "parentExecutionId", "nativeRunId", "role"].every((key) => optional(row[key], id)) && optional(row.stage, (v) => WORKBENCH_STAGES.includes(v)) && optional(row.observedModel, (v) => text(v)) && (row.currentTool === null || optional(row.currentTool, id)) && ["startedAt", "endedAt", "lastActivityAt"].every((key) => optional(row[key], iso)) && optional(row.prompt, (v) => typeof v === "string" && v.length <= 65536) && optional(row.output, (v) => typeof v === "string" && v.length <= 65536) && optional(row.error, (v) => typeof v === "string" && v.length <= 8192) && optional(row.recentOutput, (v) => Array.isArray(v) && v.every((item) => typeof item === "string" && item.length <= 4096)))) return false;
  const executions = value.executions;
  const ids = new Set(executions.map((row) => row.id));
  if (ids.size !== executions.length || executions.some((row) => row.parentExecutionId !== void 0 && (!ids.has(row.parentExecutionId) || row.parentExecutionId === row.id))) return false;
  if (!Array.isArray(value.relations) || value.relations.length > 512 || !value.relations.every((row) => shape(row, ["id", "fromExecutionId", "toExecutionId", "kind", "evidence"]) && id(row.id) && ids.has(row.fromExecutionId) && ids.has(row.toExecutionId) && row.fromExecutionId !== row.toExecutionId && ["dispatch", "handoff"].includes(row.kind) && shape(row.evidence, ["source", "eventId"]) && ["tool-call", "native-event", "native-status", "explicit-record"].includes(row.evidence.source) && id(row.evidence.eventId))) return false;
  if (new Set(value.relations.map((row) => row.id)).size !== value.relations.length) return false;
  if (value.configuration !== void 0 && (!shape(value.configuration, ["stages"]) || !object(value.configuration.stages) || Object.entries(value.configuration.stages).some(([stage, entry]) => !WORKBENCH_STAGES.includes(stage) || !shape(entry, ["roles", "sequentialRole"]) || !optional(entry.roles, (v) => Array.isArray(v) && v.length <= 64 && v.every(role)) || !optional(entry.sequentialRole, role)))) return false;
  if (value.configurationSource !== void 0 && (!shape(value.configurationSource, ["kind", "sha256"]) || !["stage-map", "run-configuration"].includes(value.configurationSource.kind) || typeof value.configurationSource.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.configurationSource.sha256))) return false;
  if (value.configuration === void 0 !== (value.configurationSource === void 0)) return false;
  if (value.actions !== void 0 && (!Array.isArray(value.actions) || value.actions.length > 128 || !value.actions.every((row) => shape(row, ["id", "action", "at", "status", "claimId"]) && id(row.id) && id(row.action) && iso(row.at) && ["completed", "failed"].includes(row.status) && optional(row.claimId, id)))) return false;
  return JSON.stringify(value).length <= 2 * 1024 * 1024;
}
export {
  RESEARCH_WORKBENCH_SCHEMA,
  WORKBENCH_STAGES,
  WORKBENCH_STATUSES,
  isResearchWorkbenchObservation
};
