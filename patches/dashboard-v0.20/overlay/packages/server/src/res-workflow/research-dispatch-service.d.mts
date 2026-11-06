import type { createResearchSessionService, UnregisteredResearchSession } from './research-session-service.mjs';
type Sessions = ReturnType<typeof createResearchSessionService>;
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
  handle(input: { body: unknown; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<Record<string, any>>;
  tick(): Promise<void>;
  acknowledgeReceipt(sessionId: string, promptId: string): Promise<void>;
  isCompleted(spawnToken: string): boolean;
  isWaitingCoordinator(sessionId: string): boolean;
  isRecoveringSession(session: any): boolean;
  unregisteredReservations(): UnregisteredResearchSession[];
  dispose(): void;
};
