import type { createResearchSessionService, UnregisteredResearchSession } from './research-session-service.mjs';
import type { ResearchDispatchTask, ResearchSessionStage } from '@blackbelt-technology/pi-dashboard-shared/research-session.js';
type Sessions = ReturnType<typeof createResearchSessionService>;
export type ResearchDispatchPlanMode = 'tasks' | 'delegate';
export type ResearchDispatchTerminalStatus = 'completed' | 'failed' | 'blocked';
/** Only this endpoint builds the single fixed-role coordinator task internally. */
export interface ResearchDelegatedObjectiveRequest {
  sessionId: string;
  action: 'delegate';
  planId: string;
  task: string;
  stage: ResearchSessionStage;
  readOnly?: true;
}
export interface ResearchDispatchBrief { task: string; role: string; stage: ResearchSessionStage; readOnly: boolean }
export interface ResearchDispatchReceipt { id: string; summary?: string; evidence?: string[] }
export interface ResearchDispatchTaskState extends ResearchDispatchTask {
  dependsOn: string[];
  status: 'queued' | 'launching' | 'running' | 'recovery-required' | ResearchDispatchTerminalStatus;
  requestId: string;
  spawnToken?: string;
  sessionId?: string;
  error?: string;
  summary?: string;
  evidence?: string[];
  launchedAt?: string;
  registeredAt?: string;
  lastSeenAt?: string;
  finishedAt?: string;
  reportedAt?: string;
  processUnconfirmed?: boolean;
}
export interface ResearchDispatchPlan {
  id: string;
  clientPlanId?: string;
  mode: ResearchDispatchPlanMode;
  parentSessionId: string;
  rootSessionId: string;
  status: 'running' | ResearchDispatchTerminalStatus;
  concurrency: number;
  readOnly?: true;
  error?: string;
  tasks: ResearchDispatchTaskState[];
  createdAt: string;
  updatedAt: string;
}
export interface ResearchDispatchSnapshot {
  status: 'ok';
  tool: 'research_dispatch';
  sessionId: string;
  plans: ResearchDispatchPlan[];
  atomicReason: string | null;
  collaborator: boolean;
  brief: ResearchDispatchBrief | null;
  assignment: { planId: string; taskId: string; status: ResearchDispatchTaskState['status']; error?: string; dependencies: ResearchDispatchReceipt[] } | null;
  declaredTasks: number;
  decisionRequired: boolean;
  childrenPending: boolean;
}
export const RESEARCH_DISPATCH_LIMITS: Readonly<{ maxTasks: number; maxConcurrency: number; maxRootTasks: number; maxPlans: number; maxPlanBytes: number; registrationGraceMs: number; receiptRetryMs: number }>;
export function createResearchDispatchStore(directory: string): { readAll(): any[]; write(row: any): void };
export function createResearchDispatchService(deps: {
  store?: { readAll(): any[]; write(row: any): void };
  listSessions(): any[];
  getSession(id: string): any;
  authorize: Sessions['authorize'];
  createSession: Sessions['create'];
  releaseSession?: Sessions['release'];
  principalForSession?(session: any): { iss: string; sub: string } | null;
  beforeLaunch?(input: { parent: any; verified: { cwd: string; charterHash: string; adoptionId: string; ownerKey?: string }; planId: string }): void | Promise<void>;
  notifyParent?(sessionId: string, text: string, promptId: string): boolean | Promise<boolean>;
  now?(): Date;
  registrationGraceMs?: number;
}): {
  handle(input: { body: unknown; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<ResearchDispatchSnapshot>;
  tick(): Promise<void>;
  acknowledgeReceipt(sessionId: string, promptId: string): Promise<void>;
  isCompleted(spawnToken: string): boolean;
  isWaitingCoordinator(sessionId: string): boolean;
  isRecoveringSession(session: any): boolean;
  unregisteredReservations(): UnregisteredResearchSession[];
  dispose(): void;
};
