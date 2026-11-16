import type { ResWorkflowAccess } from './adoption-service.js';
import type { ResearchCollaborationSnapshot } from '@blackbelt-technology/pi-dashboard-shared/research-collaboration.js';
export const COLLABORATION_SCHEMA: 'pi-research-collaboration.v1';
export const COLLABORATION_DEFAULT_LIMITS: Readonly<{ maxMultiAgents: 4; maxSubagents: 3 }>;
export const COLLABORATION_LIMIT_MAXIMUMS: Readonly<{ maxMultiAgents: number; maxSubagents: 32 }>;
export class ResearchCollaborationError extends Error { constructor(statusCode: number, code: string); statusCode: number; code: string }
export interface CollaborationActor { principal?: { iss: string; sub: string } | null; expiresAt?: number | null }
export interface CollaborationVerified { cwd: string; adoptionId: string; charterHash: string; ownerKey?: string; parent?: any }
export function createResearchCollaborationStore(directory: string): { readAll(): any[]; write(row: any): void };
export function createResearchCollaborationService(deps: {
  store?: { readAll(): any[]; write(row: any): void };
  listSessions(): any[];
  connection(access: ResWorkflowAccess): Promise<{ adopted: boolean }>;
  verifySelected?(parent: any, actor: CollaborationActor): Promise<CollaborationVerified>;
  join?(access: ResWorkflowAccess, sessionId: string): Promise<unknown>;
  detach?(access: ResWorkflowAccess, sessionId: string): Promise<unknown>;
  listPlans?(scope: { cwd: string; ownerKey: string }): any[];
  manageQueue?(input: { body: any; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<unknown>;
  suspendSessions?(sessionIds: string[], reason: string, tenureId?: string): Promise<void>;
  isSessionCompleted?(spawnToken: string): boolean;
  isRecoveringSession?(session: any): boolean;
  sendMainTask?(sessionId: string, text: string, promptId: string): boolean | Promise<boolean>;
  onChanged?(): void | Promise<void>;
  now?(): Date;
  mintId?(): string;
}): {
  snapshot(access: ResWorkflowAccess): Promise<ResearchCollaborationSnapshot>;
  mutate(access: ResWorkflowAccess, body: Record<string, any>, actor?: CollaborationActor): Promise<ResearchCollaborationSnapshot>;
  native(access: ResWorkflowAccess, body: Record<string, any>, actor?: CollaborationActor): Promise<Record<string, any>>;
  getSchedulingPolicy(input: { parent: any; verified: any }): { maxMultiAgents: number; maxSubagents: number; managed: true; tenureId?: string; mainSessionId?: string; isMainAgent: boolean; importLegacy: boolean };
  assertDispatchAllowed(input: { parent: any; verified: any }): void;
  assertParticipationAllowed(input: { cwd: string; sessionId: string; researchSession?: any; via: string }): void;
  isKnownManaged(parent: any): boolean;
  retainedBinding(parent: any): CollaborationVerified | null;
  acquireSchedulingReservation(input: { parent: any; verified: any; requestId: string; spawnToken: string; tenureId?: string | null; reactivation?: true }): Promise<void>;
  releaseSchedulingReservation(spawnToken: string): Promise<void>;
};
