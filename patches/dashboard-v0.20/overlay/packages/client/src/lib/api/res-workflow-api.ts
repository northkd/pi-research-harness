import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type {
  ResWorkflowAdoption, ResWorkflowAdoptionResponse, ResWorkflowAnalyzeRequest,
  ResWorkflowConfirmRequest, ResWorkflowConnection, ResWorkflowCreateRequest, ResWorkflowHistoryCandidatesResponse,
  ResWorkflowModelsResponse, ResWorkflowParticipantResponse, ResWorkflowSnapshot, ResWorkflowSourceResponse,
  ResWorkflowHistoryReviewPrepareRequest,
  ResWorkflowAgentCreateRequest, ResWorkflowAgentAuthorizeRequest, ResWorkflowAgentResumeRequest, ResWorkflowAgentBudgetUpdateRequest,
} from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { getApiBase } from "./api-context.js";
import { ApiHttpError, fetchJsonResponse } from "./fetch-json.js";
import { filterVisibleModels } from "./models-api.js";
import {
  isResWorkflowResearchBudget, isResWorkflowResearchBudgetUpdateRequest, RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES,
  type ResWorkflowResearchBudget, type ResWorkflowResearchBudgetErrorCode, type ResWorkflowResearchBudgetUpdateRequest,
} from "@blackbelt-technology/pi-dashboard-shared/research-budget.js";
export type { ResWorkflowResearchBudget, ResWorkflowResearchBudgetUpdateRequest } from "@blackbelt-technology/pi-dashboard-shared/research-budget.js";

export class ResWorkflowResearchBudgetApiError extends Error {
  readonly status: number;
  readonly code: ResWorkflowResearchBudgetErrorCode | null;
  constructor(status: number, code?: unknown) {
    const safeCode = typeof code === "string" && RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES.includes(code as ResWorkflowResearchBudgetErrorCode) ? code as ResWorkflowResearchBudgetErrorCode : null;
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    super(safeCode ?? `res-workflow research budget HTTP ${safeStatus}`);
    this.name = "ResWorkflowResearchBudgetApiError"; this.status = safeStatus; this.code = safeCode;
  }
}

const FULL_REVIEW_ERROR_CODES = [
  "analysis-full-output-too-large", "analysis-full-thinking-too-large", "analysis-full-output-incomplete",
  "analysis-full-result-unknown-no-replay", "analysis-full-known-invalid-new-plan-required",
  "analysis-full-known-invalid-output-new-plan-required", "analysis-full-known-invalid-source-new-plan-required",
  "known-invalid-output-new-plan-required", "known-invalid-source-new-plan-required",
  "result-unknown", "request-timeout-result-unknown",
  "analysis-full-output-event-too-large", "analysis-full-output-metadata-too-large",
  "analysis-full-recovery-request-invalid", "analysis-full-recovery-plan-mismatch", "analysis-full-new-plan-preparation-failed",
] as const;
export type ResWorkflowErrorCode = typeof FULL_REVIEW_ERROR_CODES[number];
export function knownResWorkflowErrorCode(value: unknown): ResWorkflowErrorCode | null {
  return typeof value === "string" && FULL_REVIEW_ERROR_CODES.includes(value as ResWorkflowErrorCode) ? value as ResWorkflowErrorCode : null;
}
/** Full-review errors expose only a bounded HTTP status and fixed local codes. */
export class ResWorkflowApiError extends Error {
  readonly status: number;
  readonly code: ResWorkflowErrorCode | null;
  constructor(status: number, code?: unknown) {
    const fixedCode = knownResWorkflowErrorCode(code);
    const boundedStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    super(fixedCode ?? `res-workflow HTTP ${boundedStatus}`);
    this.name = "ResWorkflowApiError"; this.status = boundedStatus; this.code = fixedCode;
  }
}
export function resWorkflowErrorCode(error: unknown): ResWorkflowErrorCode | null {
  return error instanceof ResWorkflowApiError ? error.code : null;
}
async function request<T>(path: string, init?: RequestInit, fullReviewErrors = false): Promise<T> {
  try {
    const { res, json } = await fetchJsonResponse<T & { error?: string }>(`${getApiBase()}/api/res-workflow${path}`, init);
    if (!res.ok) {
      if (fullReviewErrors) throw new ResWorkflowApiError(res.status, json?.error);
      throw new Error(json.error || `res-workflow HTTP ${res.status}`);
    }
    return json;
  } catch (error) {
    if (fullReviewErrors && error instanceof ApiHttpError) throw new ResWorkflowApiError(error.status);
    throw error;
  }
}
const query = (cwd: string) => `?cwd=${encodeURIComponent(cwd)}`;
const post = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const jobPath = (id: string) => `/adoptions/${encodeURIComponent(id)}`;

async function researchBudgetRequest(path: string, init: RequestInit): Promise<ResWorkflowResearchBudget> {
  try {
    const { res, json } = await fetchJsonResponse<unknown>(`${getApiBase()}/api/res-workflow/research-budget${path}`, init);
    if (!res.ok) throw new ResWorkflowResearchBudgetApiError(res.status, json && typeof json === "object" && "code" in json ? json.code : undefined);
    if (!isResWorkflowResearchBudget(json)) throw new Error("Invalid res-workflow research budget response");
    return json;
  } catch (error) {
    if (error instanceof ApiHttpError) throw new ResWorkflowResearchBudgetApiError(error.status);
    throw error;
  }
}

export function getResWorkflowResearchBudget(cwd: string, signal?: AbortSignal): Promise<ResWorkflowResearchBudget> {
  return researchBudgetRequest(query(cwd), { signal });
}
export function updateResWorkflowResearchBudget(body: ResWorkflowResearchBudgetUpdateRequest, signal?: AbortSignal): Promise<ResWorkflowResearchBudget> {
  if (!isResWorkflowResearchBudgetUpdateRequest(body)) return Promise.reject(new ResWorkflowResearchBudgetApiError(400, "research-budget-invalid"));
  return researchBudgetRequest("", post(body, signal));
}

export async function getResWorkflow(cwd: string, signal?: AbortSignal): Promise<ResWorkflowSnapshot> {
  try {
    const { res, json } = await fetchJsonResponse<ResWorkflowSnapshot>(`${getApiBase()}/api/res-workflow${query(cwd)}`, { signal });
    if (!res.ok) throw new ResWorkflowApiError(res.status);
    return json;
  } catch (error) {
    if (error instanceof ApiHttpError) throw new ResWorkflowApiError(error.status);
    throw error;
  }
}
export async function getResWorkflowHistoryCandidates(cwd: string, signal?: AbortSignal): Promise<ResWorkflowHistoryCandidatesResponse> {
  const result = await request<ResWorkflowHistoryCandidatesResponse>(`/history-candidates${query(cwd)}`, { signal });
  if (!Array.isArray(result?.candidates) || typeof result.partial !== "boolean" || !Array.isArray(result.skipped)
    || result.candidates.some(candidate => !candidate || typeof candidate.id !== "string" || !candidate.id || typeof candidate.sessionId !== "string" || !candidate.sessionId
      || !["local", "retained"].includes(candidate.kind) || typeof candidate.registered !== "boolean" || typeof candidate.incomplete !== "boolean"
      || candidate.name !== undefined && typeof candidate.name !== "string" || candidate.timestamp !== undefined && typeof candidate.timestamp !== "string")
    || result.skipped.some(skip => !skip || typeof skip.label !== "string" || typeof skip.reason !== "string")) throw new Error("Invalid res-workflow history catalogue");
  return result;
}
export async function getResWorkflowConnection(cwd: string, signal?: AbortSignal): Promise<ResWorkflowConnection> {
  const result = await request<ResWorkflowConnection>(`/connection${query(cwd)}`, { signal });
  if (!result || typeof result.cwd !== "string" || !result.cwd || typeof result.adopted !== "boolean") throw new Error("Invalid res-workflow connection status");
  return result;
}
export async function joinResWorkflowSession(cwd: string, sessionId: string, signal?: AbortSignal): Promise<ResWorkflowParticipantResponse> {
  const result = await request<ResWorkflowParticipantResponse>("/participants", post({ cwd, sessionId }, signal));
  const participation = result?.resWorkflow;
  if (result?.sessionId !== sessionId || !participation || typeof participation.canonicalCwd !== "string" || !participation.canonicalCwd
    || typeof participation.joinedAt !== "string" || !Number.isFinite(Date.parse(participation.joinedAt)) || !["spawn", "manual", "adoption"].includes(participation.via)) throw new Error("Invalid res-workflow participant response");
  return result;
}
export async function getResWorkflowModels(cwd: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const result = await request<ResWorkflowModelsResponse>(`/models${query(cwd)}`, { signal });
  if (!Array.isArray(result.models)) throw new Error("Invalid res-workflow model catalogue");
  return filterVisibleModels(result.models);
}
export async function createResWorkflowAdoption(body: ResWorkflowCreateRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>("/adoptions", post(body, signal))).adoption;
}
export async function createResWorkflowAgent(body: ResWorkflowAgentCreateRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>("/adoptions/agent", post(body, signal), true)).adoption;
}
export async function authorizeResWorkflowAgent(id: string, body: ResWorkflowAgentAuthorizeRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/agent/authorize`, post(body, signal), true)).adoption;
}
export async function resumeResWorkflowAgent(id: string, body: ResWorkflowAgentResumeRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/agent/resume`, post(body, signal), true)).adoption;
}
/** Budget edits are policy-only writes. Never retry or resume a paid task here. */
export class ResWorkflowIntakeBudgetApiError extends Error {
  constructor(readonly status: number) { super(`res-workflow intake budget HTTP ${status}`); this.name = "ResWorkflowIntakeBudgetApiError"; }
}
export async function updateResWorkflowAgentBudget(id: string, body: ResWorkflowAgentBudgetUpdateRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  if (!id || !body.cwd || !body.requestId || !body.grantHash || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
    !(body.maxRequests === null || Number.isSafeInteger(body.maxRequests) && body.maxRequests >= 0) ||
    body.consent?.scope !== "this-job" || body.consent.budgetMayIncreaseCharges !== true || body.consent.unknownRetryMayBillAgain !== true) throw new ResWorkflowIntakeBudgetApiError(400);
  try {
    const { res, json } = await fetchJsonResponse<ResWorkflowAdoptionResponse>(`${getApiBase()}/api/res-workflow${jobPath(id)}/agent/budget`, post(body, signal));
    if (!res.ok) throw new ResWorkflowIntakeBudgetApiError(res.status);
    const next = json?.adoption, budget = next?.agentJob?.budget;
    if (next?.id !== id || next.cwd !== body.cwd || next.agentJob?.mode !== "full-history-agent-v2" || next.agentJob.grant?.grantHash !== body.grantHash ||
      !budget || !Number.isSafeInteger(budget.revision) || budget.revision! <= body.expectedRevision || budget.effectiveMaxRequests !== body.maxRequests ||
      (budget.unlimited === true) !== (body.maxRequests === null) ||
      budget.policy !== (body.maxRequests === null ? "unlimited" : "total-requests")) throw new ResWorkflowIntakeBudgetApiError(0);
    return next;
  } catch (error) {
    if (error instanceof ApiHttpError) throw new ResWorkflowIntakeBudgetApiError(error.status);
    throw error;
  }
}
export async function analyzeResWorkflowAdoption(id: string, body: ResWorkflowAnalyzeRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/analyze`, post(body, signal))).adoption;
}
export async function prepareResWorkflowHistoryReview(id: string, body: ResWorkflowHistoryReviewPrepareRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/history-review/prepare`, post(body, signal), true)).adoption;
}
export async function analyzeResWorkflowHistoryReview(id: string, body: ResWorkflowAnalyzeRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/history-review/analyze`, post(body, signal), true)).adoption;
}
export async function confirmResWorkflowAdoption(id: string, body: ResWorkflowConfirmRequest, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/confirm`, post(body, signal))).adoption;
}
export async function cancelResWorkflowAdoption(id: string, cwd: string, signal?: AbortSignal): Promise<ResWorkflowAdoption> {
  return (await request<ResWorkflowAdoptionResponse>(`${jobPath(id)}/cancel`, post({ cwd }, signal))).adoption;
}
export function getResWorkflowSource(cwd: string, id: string, sourceId: string, signal?: AbortSignal): Promise<ResWorkflowSourceResponse> {
  return request(`${jobPath(id)}/sources/${encodeURIComponent(sourceId)}${query(cwd)}`, { signal });
}
