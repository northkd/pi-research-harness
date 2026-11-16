/** Host-authoritative coordination, independent of transcripts and charter content. */
export interface ResearchCollaborationLimits { maxMultiAgents: number; maxSubagents: number }
export interface ResearchCollaborationSessionSnapshot {
  title?: string; model?: string; role?: string; status?: string;
  parentSessionId?: string;
  origin?: "user-selected" | "agent-dispatch" | "manual-join";
}
export interface ResearchCollaborationTenure {
  id: string;
  ordinal: number;
  mainSessionId: string;
  startedAt: string;
  endedAt?: string;
  status: "current" | "historical" | "removed";
  sessionIds: string[];
  detachedSessionIds?: string[];
  snapshots?: Record<string, ResearchCollaborationSessionSnapshot>;
}
export interface ResearchCollaborationTask {
  id: string; role: string; task: string; stage?: string; dependsOn: string[];
  status: string; rank?: number; sessionId?: string; error?: string; queueReason?: string;
  [key: string]: unknown;
}
export interface ResearchCollaborationPlan {
  id: string; clientPlanId?: string; parentSessionId: string; rootSessionId: string;
  tenureId?: string; status: string; revision: number; concurrency: number;
  schedulingPaused?: boolean;
  effectiveConcurrency?: number; tasks: ResearchCollaborationTask[];
  createdAt: string; updatedAt?: string; error?: string;
}
export interface ResearchNativeQueueItem {
  id: string; requestId: string; parentSessionId: string; tenureId: string;
  kind: "subagent"; role: string; model?: string; task?: string;
  status: "queued" | "launching" | "running" | "released" | "cancelled" | "recovery-required";
  rank: number; createdAt: string; startedAt?: string; finishedAt?: string;
  childSessionId?: string; queueReason?: string;
}
export interface ResearchCollaborationSnapshot {
  schema: "pi-research-collaboration.v1";
  cwd: string;
  adopted: boolean;
  revision: number;
  currentTenureId: string | null;
  currentMainSessionId: string | null;
  limits: ResearchCollaborationLimits;
  limitMaximums: ResearchCollaborationLimits;
  operationalLimits?: { maxTotal: number; maxResident: number; minAvailableMemoryBytes: number };
  tenures: ResearchCollaborationTenure[];
  detachedSessionIds: string[];
  plans: ResearchCollaborationPlan[];
  nativeQueue: ResearchNativeQueueItem[];
  queueAction?: unknown;
  promptReceipt?: { success: true; transmitted: true; promptId: string; simulated?: boolean };
  queuedPromptId?: string;
  warnings?: string[];
}
