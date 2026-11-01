import type { ResWorkflowAgentGrant, ResWorkflowAgentPhase, ResWorkflowProposal, ResWorkflowSource } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import type { ResolvedAnalysisModel } from "./strict-model.js";
import type { AnalysisAgentFactory } from "./analysis-agent.js";
import type { FullHistoryReviewExecutionPlan } from "./full-history-review.js";

export type FullHistoryAgentAttemptKind = "initial" | "retry-length" | "retry-unknown" | "repair-json";
export type FullHistoryAgentStopReason = "stop" | "length" | "toolUse" | "deferred" | "error" | "aborted" | "none";
export type FullHistoryAgentOutcome = "valid" | "invalid-output" | "invalid-source" | "incomplete" | "unknown";
export interface FullHistoryAgentUsage { input?: number; output?: number; totalTokens?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
/** Append-only count authority. Does not replace or renew the original grant. */
export interface FullHistoryAgentBudgetAuthorization {
  unlimited?: true;
  /** Absent only on the historical unlimited sibling. */
  maxRequests?: number | null;
  revision?: number;
  authorizationHash: string;
  authorizedAt: string;
  jobId: string;
  grantHash: string;
  materialPlanHash: string;
  modelFingerprint: string;
  promptSchemaHash: string;
  expiresAt: string;
}

/** Service assigns identity/slot and durably commits before returning. */
export interface FullHistoryAgentAttemptDraft {
  nodeId: string;
  nodeAttempt: number;
  kind: FullHistoryAgentAttemptKind;
  baseInputHash: string;
  requestHash: string;
  promptSchemaHash: string;
  modelFingerprint: string;
  requestBytes: number;
  maxTokens: number;
}
export interface FullHistoryAgentAttemptIntent extends FullHistoryAgentAttemptDraft {
  schema: "pi-full-agent-attempt-intent.v2";
  jobId: string;
  workerEpoch: string;
  grantHash: string;
  materialPlanHash: string;
  attemptId: string;
  slot: number;
  bucket: "base" | "reserve";
}
export interface FullHistoryAgentAttemptReceipt {
  schema: "pi-full-agent-attempt-receipt.v2";
  attemptId: string;
  nodeId: string;
  slot: number;
  requestHash: string;
  outcome: FullHistoryAgentOutcome;
  sdkStopReason: FullHistoryAgentStopReason;
  providerTerminalObserved: boolean;
  usage?: FullHistoryAgentUsage;
  errorCode?: "analysis-full-output-invalid" | "analysis-output-invalid-source" | "analysis-full-output-incomplete" | "analysis-full-result-unknown" | "analysis-full-output-too-large";
  /** Bounded structured text only. Never thinking, headers or provider error text. */
  raw?: string;
  rawHash?: string;
}
export interface FullHistoryAgentAttempt { intent: FullHistoryAgentAttemptIntent; receipt?: FullHistoryAgentAttemptReceipt }
export interface FullHistoryAgentCheckpoint {
  schema: "pi-full-agent-node-checkpoint.v2";
  jobId: string;
  materialPlanHash: string;
  nodeId: string;
  baseInputHash: string;
  requestHash: string;
  modelFingerprint: string;
  promptSchemaHash: string;
  acceptedAttemptId: string;
  receiptHash: string;
  raw: string;
  rawHash: string;
  sourceIds: string[];
  terminal: "stop";
  validation: "valid";
}
export interface FullHistoryAgentRunnerDeps {
  jobId: string;
  workerEpoch: string;
  grant: ResWorkflowAgentGrant;
  plan: FullHistoryReviewExecutionPlan;
  resolved: ResolvedAnalysisModel & { agentFactory: AnalysisAgentFactory };
  signal: AbortSignal;
  /** Pure local verification: require every valid CP; never dispatch, repair or publish progress. */
  verifyOnly?: boolean;
  getBudgetAuthorization?(): Promise<FullHistoryAgentBudgetAuthorization | null>;
  assertScope(): Promise<void>;
  assertHistoryOwnership(): Promise<void>;
  resolveCurrentModel(): Promise<ResolvedAnalysisModel>;
  readBatch(nodeId: string): Promise<{ prompt: string; sources: ResWorkflowSource[] }>;
  readAttempts(nodeId: string): Promise<FullHistoryAgentAttempt[]>;
  readCheckpoint(nodeId: string): Promise<FullHistoryAgentCheckpoint | null>;
  onBeforeSend(draft: FullHistoryAgentAttemptDraft): Promise<FullHistoryAgentAttemptIntent>;
  onReceipt(receipt: FullHistoryAgentAttemptReceipt): Promise<{ receiptHash: string }>;
  onCheckpoint(checkpoint: FullHistoryAgentCheckpoint): Promise<void>;
  onProgress(value: { phase: ResWorkflowAgentPhase; completedNodes: number; reusedCheckpoints: number }): Promise<void>;
  timeoutMs?: number;
}
export interface FullHistoryAgentRunnerResult {
  outcome: "complete" | "awaiting-user";
  reason?: "budget-exhausted" | "node-attempt-limit";
  proposal?: ResWorkflowProposal;
  sources: ResWorkflowSource[];
  checkpoints: FullHistoryAgentCheckpoint[];
}
