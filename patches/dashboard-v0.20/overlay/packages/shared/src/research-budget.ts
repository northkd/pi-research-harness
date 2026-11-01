/** Null read limits mean unconfigured, never unlimited. Updates require both explicit limits. */
export interface ResWorkflowResearchBudget {
  cwd: string;
  revision: string | null;
  limits: { attempts: number | null; modelRequests: number | null };
  usage: { attempts: number; modelRequests: number; inFlight: number; unknown: number };
  updatedAt: string | null;
  enforcement: {
    attempts: boolean;
    modelRequests: boolean;
    scope: "native-research-workflow";
    physicalTransport: "sse-http";
  };
}

export interface ResWorkflowResearchBudgetUpdateRequest {
  cwd: string;
  expectedRevision: string | null;
  requestId: string;
  limits: { attempts: number; modelRequests: number };
}

export const RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES = [
  "research-budget-invalid", "research-budget-not-adopted", "research-budget-not-configured",
  "research-budget-revision-conflict", "research-budget-request-conflict",
  "research-budget-attempts-exhausted", "research-budget-model-requests-exhausted",
  "research-budget-scope-mismatch", "research-budget-unavailable",
] as const;
export type ResWorkflowResearchBudgetErrorCode = typeof RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES[number];

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const revision = (value: unknown): value is string | null => value === null || typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);

export function isResWorkflowResearchBudgetUpdateRequest(value: unknown): value is ResWorkflowResearchBudgetUpdateRequest {
  return exact(value, ["cwd", "expectedRevision", "requestId", "limits"])
    && typeof value.cwd === "string" && !!value.cwd && value.cwd.length <= 4096 && !value.cwd.includes("\0")
    && revision(value.expectedRevision) && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)
    && exact(value.limits, ["attempts", "modelRequests"]) && count(value.limits.attempts) && count(value.limits.modelRequests);
}

export function isResWorkflowResearchBudget(value: unknown): value is ResWorkflowResearchBudget {
  return object(value) && typeof value.cwd === "string" && !!value.cwd && value.cwd.length <= 4096 && !value.cwd.includes("\0")
    && revision(value.revision) && (value.updatedAt === null || typeof value.updatedAt === "string" && value.updatedAt.length <= 64 && Number.isFinite(Date.parse(value.updatedAt)))
    && object(value.limits) && (value.limits.attempts === null || count(value.limits.attempts)) && (value.limits.modelRequests === null || count(value.limits.modelRequests))
    && object(value.usage) && count(value.usage.attempts) && count(value.usage.modelRequests) && count(value.usage.inFlight) && count(value.usage.unknown)
    && object(value.enforcement) && typeof value.enforcement.attempts === "boolean" && typeof value.enforcement.modelRequests === "boolean"
    && value.enforcement.scope === "native-research-workflow" && value.enforcement.physicalTransport === "sse-http";
}
