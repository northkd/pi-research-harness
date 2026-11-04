import type { ModelInfo, ResWorkflowParticipation } from "./types.js";
import type { ResearchSessionProvenance } from "./research-session.js";
export type { ResWorkflowParticipation } from "./types.js";

export const RES_WORKFLOW_MAX_HISTORY_SELECTION = 40;

/** Plugin-declared service intent, not an ordinary user's/legacy hidden flag. */
export function isResWorkflowServiceSession(session: { pluginHidden?: boolean; archiveOnEnd?: boolean }): boolean {
  return session.pluginHidden === true || session.archiveOnEnd === true;
}

export interface ResWorkflowHistoryCandidate {
  id: string;
  sessionId: string;
  name?: string;
  kind: "local" | "retained";
  registered: boolean;
  timestamp?: string;
  incomplete: boolean;
}

export interface ResWorkflowHistoryCandidatesResponse {
  candidates: ResWorkflowHistoryCandidate[];
  partial: boolean;
  skipped: ResWorkflowSkipped[];
}

export interface ResWorkflowConnection {
  cwd: string;
  adopted: boolean;
}

export interface ResWorkflowParticipantRequest {
  cwd: string;
  sessionId: string;
}

export interface ResWorkflowParticipantResponse {
  sessionId: string;
  resWorkflow: ResWorkflowParticipation;
  /** Present only for top-level native collaborators; never a subagent marker. */
  researchSession?: ResearchSessionProvenance;
}

export interface ResWorkflowParticipantFailure {
  sessionId: string;
  reason: string;
}

export type ResWorkflowStatus = "inventory" | "awaiting-model" | "analyzing" | "proposal-ready" | "confirmed" | "blocked" | "failed" | "cancelled";

export interface ResWorkflowModel {
  provider: string;
  id: string;
}

/** V2 grants never upgrade existing v1 consent or cancelled operations. */
export interface ResWorkflowAgentPolicy {
  id: "bounded-intake-v2";
  maxNodeAttempts: 3;
  maxJsonRepairsPerNode: 1;
  maxUnknownRetriesPerNode: 1;
  maxLengthEscalationsPerNode: 1;
  unknownRetryMayBillAgain: true;
  grantLifetimeMs: 86400000;
  initialOutputTokens: number;
  maxOutputTokens: number;
}
export interface ResWorkflowAgentGrant {
  analysisMode: "full-history-agent-v2";
  grantHash: string;
  materialPlanId: string;
  materialPlanHash: string;
  model: ResWorkflowModel;
  historySelection: string[];
  baseRequests: number;
  retryReserve: number;
  maxRequests: number;
  policy: ResWorkflowAgentPolicy;
}
export interface ResWorkflowAgentCreateRequest {
  cwd: string;
  requestId: string;
  historySelection: string[];
  model: ResWorkflowModel;
}
export interface ResWorkflowAgentAuthorizeRequest {
  cwd: string;
  requestId: string;
  model: ResWorkflowModel;
  budget?: ResWorkflowAgentBudgetChoice;
  consent: {
    analysisMode: "full-history-agent-v2";
    scope: "research-files-and-normal-messages";
    includeUnpublished: true;
    grantHash: string;
    maxRequests: number;
    policyId: "bounded-intake-v2";
    unknownRetryMayBillAgain: true;
  };
}
export interface ResWorkflowAgentBudgetConsent {
  scope: "this-job";
  budgetMayIncreaseCharges: true;
  unknownRetryMayBillAgain: true;
}
export interface ResWorkflowAgentBudgetChoice { maxRequests: number | null; consent: ResWorkflowAgentBudgetConsent }
export interface ResWorkflowAgentBudgetUpdateRequest extends ResWorkflowAgentBudgetChoice {
  cwd: string;
  requestId: string;
  grantHash: string;
  expectedRevision: number;
}
export interface ResWorkflowAgentResumeRequest { cwd: string; requestId: string; /** Omitted only for unfinished, unauthorized local preparation. */ grantHash?: string }
export type ResWorkflowAgentPhase = "preparing" | "awaiting-authorization" | "reviewing" | "repairing" | "merging" | "validating" | "awaiting-user" | "proposal-ready" | "cancelled";
export interface ResWorkflowAgentJob {
  mode: "full-history-agent-v2";
  phase: ResWorkflowAgentPhase;
  plan?: ResWorkflowHistoryReviewPlan;
  grant?: ResWorkflowAgentGrant;
  authorized: boolean;
  authorizedAt?: string;
  expiresAt?: string;
  workerActive: boolean;
  resumeRequired: boolean;
  preparation?: { phase: "scanning" | "packing"; historiesScanned: number; historiesTotal: number; normalMessages: number; normalBytes: number; packedBatches: number };
  coverage: ResWorkflowHistoryReviewCoverage;
  budget: { baseRequests: number; retryReserve: number; maxRequests: number; effectiveMaxRequests?: number | null; revision?: number; editable?: boolean; editBlockedReason?: "authorization-required" | "authorization-expired" | "cancelled" | "completed"; policy?: "original-bounded" | "total-requests" | "unlimited"; usedRequests: number; baseUsed: number; recoveryUsed: number; remainingRequests: number; inFlightRequests: number; unknownRequests: number; unlimited?: true; authorization?: { scope: "this-job"; authorizationHash: string; authorizedAt: string; expiresAt: string } };
  completedNodes: number;
  reusedCheckpoints: number;
  needsUserAction?: { reason: "authorization-required" | "authorization-expired" | "budget-exhausted" | "node-attempt-limit" | "model-changed" | "access-required" | "material-invalid" | "storage-unavailable" };
}

export interface ResWorkflowConsent {
  scope: "research-files-and-normal-messages";
  includeUnpublished: true;
  /** Absent on existing frozen requests; new authorization selects the bounded assistant. */
  analysisMode?: "snapshot-agent-v1" | "full-history-review-v1";
  /** Fresh full-history consent is bound to one locally prepared immutable plan. */
  planId?: string;
  planHash?: string;
  maxRequests?: number;
}

export interface ResWorkflowHistoryReviewHistory {
  id: string;
  sessionId: string;
  eligibleMessages: number;
  eligibleBytes: number;
  chunkCount: number;
  /** Explicitly explains a completely read history with no eligible normal text. */
  emptyReason?: string;
  normalMessages?: number;
  normalBytes?: number;
  sensitiveFilteredMessages?: number;
  timestampUnknownMessages?: number;
  blockers?: string[];
  filteredCounts?: {
    toolMessages: number; nonTextMessages: number; customEntries: number; compactionEntries: number;
    thinkingParts: number; toolParts: number; imageParts: number; offBranchEntries: number;
  };
}

export interface ResWorkflowHistoryReviewPlan {
  planId: string;
  planHash: string;
  model: ResWorkflowModel;
  contextWindow: number;
  maxTokens: number;
  maxRequests: number;
  /** A resumed authorization charges only remaining nodes; immutable total stays visible. */
  totalRequests?: number;
  reusedRequests?: number;
  batchCount: number;
  mergeCallCount: number;
  eligibleMessages: number;
  eligibleBytes: number;
  histories: ResWorkflowHistoryReviewHistory[];
  blockers: string[];
  directorySnapshot?: { sourceCount: number; bytes: number; batchCount: number; metadataOnlyArtifacts: number; bounded: true };
}

export interface ResWorkflowHistoryReviewCoverage {
  selectedHistories: number;
  completedHistories: number;
  eligibleMessages: number;
  completedMessages: number;
  eligibleBytes: number;
  completedBytes: number;
  completedBatches: number;
  totalBatches: number;
  /** Locally verified empty histories require no model call; shown separately from reviewed text. */
  emptyHistories?: number;
}

export interface ResWorkflowHistoryReview {
  status: "unprepared" | "blocked" | "prepared" | "running" | "interrupted" | "complete";
  plan?: ResWorkflowHistoryReviewPlan;
  coverage: ResWorkflowHistoryReviewCoverage;
  canConfirm: boolean;
  previousAttempt?: {
    planId: string;
    planHash: string;
    requestIntents: number;
    completedRequests: number;
    outcome: "unknown" | "known-invalid" | "incomplete";
    /** Fixed local error code only; never provider text or response content. */
    errorCode?: string;
  };
}

export interface ResWorkflowHistoryReviewPrepareRequest {
  cwd: string;
  requestId: string;
  model: ResWorkflowModel;
  /** Local-only recovery leaves old unknown requests untouched and needs new paid consent. */
  recovery?: { mode: "new-plan"; previousPlanId: string; previousPlanHash: string };
}

export interface ResWorkflowSource {
  id: string;
  kind: "file" | "session-message" | "artifact";
  label: string;
  path?: string;
  sessionId?: string;
  entryId?: string;
  timestamp?: string;
  /** Digest/size of the finite snapshot; artifact records describe metadata, not unread file bytes. */
  sha256: string;
  bytes: number;
  incomplete: boolean;
  unverified: true;
}

export interface ResWorkflowSkipped {
  label: string;
  reason: string;
}

export interface ResWorkflowProposal {
  summary: string;
  objective: string;
  successCriteria: string[];
  unresolved: string[];
  items: Array<{ text: string; sourceIds: string[]; unverified: true }>;
}

export interface ResWorkflowAdoption {
  agentJob?: ResWorkflowAgentJob;
  id: string;
  cwd: string;
  status: ResWorkflowStatus;
  createdAt: string;
  updatedAt: string;
  partial: boolean;
  progress: { files: number; sessions: number; bytes: number };
  agentProgress?: {
    phase: "preparing" | "waiting-model" | "reading-sources" | "drafting" | "completed";
    requests: number;
    toolCalls: number;
    readSources: number;
    readBytes: number;
    startedAt: string;
    updatedAt: string;
  };
  sources: ResWorkflowSource[];
  skipped: ResWorkflowSkipped[];
  model?: ResWorkflowModel;
  proposal?: ResWorkflowProposal;
  proposalHash?: string;
  charterHash: string;
  /** Absent only on legacy frozen operations; never interpreted as all histories. */
  historySelection?: string[];
  selectedHistories?: ResWorkflowHistoryCandidate[];
  participantFailures?: ResWorkflowParticipantFailure[];
  historyReview?: ResWorkflowHistoryReview;
  error?: string;
}

export interface ResWorkflowSnapshot {
  cwd: string;
  adopted: boolean;
  research: Record<"state.json" | "ledger.jsonl" | "events.jsonl" | "auto-run.json", string | null>;
  adoption: ResWorkflowAdoption | null;
}

export interface ResWorkflowCreateRequest {
  cwd: string;
  requestId: string;
  historySelection: string[];
  model?: ResWorkflowModel;
  consent?: ResWorkflowConsent;
}

export interface ResWorkflowAnalyzeRequest {
  cwd: string;
  requestId: string;
  model: ResWorkflowModel;
  consent: ResWorkflowConsent;
}

export interface ResWorkflowConfirmRequest {
  cwd: string;
  proposalHash: string;
  objective: string;
  successCriteria: string[];
}

export interface ResWorkflowAdoptionResponse { adoption: ResWorkflowAdoption }
export interface ResWorkflowModelsResponse { models: ModelInfo[] }
export interface ResWorkflowSourceResponse { source: ResWorkflowSource; content: string }
