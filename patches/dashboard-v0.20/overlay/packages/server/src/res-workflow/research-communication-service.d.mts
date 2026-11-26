import type { ResearchDispatchPeer, ResearchDispatchPeerContext } from './research-dispatch-service.mjs';
export interface ResearchCommunicationService {
  handle(input: { body: unknown; principal?: any; expiresAt?: number | null }): Promise<any>;
  tick(): Promise<void>;
  bindDeferredPeerMessages(input: { planId: string; taskId: string; sessionId: string }): Promise<void>;
  expireDeferredPeerMessages(input: { planId: string; taskId: string }): Promise<void>;
  acknowledgeReceipt(sessionId: string, promptId: string): Promise<void>;
  isCompleted(spawnToken: string): boolean;
  dispose(): void;
}
export function createResearchCommunicationStore(directory: string): { directory: string; readAll(): any[]; write(row: any): void };
export function createResearchCommunicationService(deps: {
  store: { readAll(): any[]; write(row: any): void };
  authorize(input: any): Promise<any>;
  getSession(id: string): any;
  listSessions(): any[];
  getPeerContext?(sessionId: string): ResearchDispatchPeerContext | null;
  getPeerTask?(input: { planId: string; taskId: string }): ResearchDispatchPeer | null;
  notifyParent?(sessionId: string, text: string, promptId: string): boolean | Promise<boolean>;
  principalForSession?(session: any): any;
  releaseSession?(spawnToken: string): void;
  activateSession?(spawnToken: string): void;
  reportAssignment?(input: any): Promise<any>;
  isAssignmentCompleted?(spawnToken: string): boolean;
  childrenPending?(sessionId: string): boolean;
  now?(): Date;
}): ResearchCommunicationService;
