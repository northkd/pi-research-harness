import type { SpawnStrategy } from '@blackbelt-technology/pi-dashboard-shared/config.js';
import type { ResearchSessionProvenance, ResearchDispatchTask, ResearchSessionStage } from '@blackbelt-technology/pi-dashboard-shared/research-session.js';
export type { ResearchSessionProvenance, ResearchDispatchTask };
export interface ResearchSessionRequest { parentSessionId: string; role: string; task: string; stage: ResearchSessionStage; requestId?: string; tasks?: ResearchDispatchTask[]; readOnly?: true }
export interface UnregisteredResearchSession { requestId: string; spawnToken?: string; parentSessionId: string; rootSessionId: string }
export interface CreateResearchSessionServiceDeps {
  getSession(id: string): any;
  listSessions(): any[];
  verifyParent(input: { parent: any; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<{ charterHash: string; adoptionId: string; cwd?: string; ownerKey?: string }>;
  prepareSpawn(cwd: string, identity: { principal: { iss: string; sub: string } | null; expiresAt: number | null; write: true }, verified: { ownerKey?: string; researchSession: ResearchSessionProvenance }): Promise<object>;
  pendingPluginRefRegistry: { file(token: string, ref: unknown, ownerId: string): boolean; remove(token: string): void };
  pendingPrincipalOwnerRegistry: { file(token: string, owner: { iss: string; sub: string }): boolean; remove(token: string): void };
  initialPrompts: { enqueue(cwd: string, prompt: string, spawnToken: string): boolean; remove?(cwd: string, spawnToken: string): boolean | void };
  spawn(cwd: string, options: { spawnToken: string; strategy?: SpawnStrategy }): Promise<{ success: boolean }>;
  beforeSpawn?(input: { parent: any; verified: { cwd: string; charterHash: string; adoptionId: string; ownerKey?: string }; body: ResearchSessionRequest }): void | Promise<void>;
  spawnStrategy?(): SpawnStrategy;
  isLocalOperator(principal: unknown): boolean;
  now?(): Date;
  mintToken?(): string;
  maxPerParent?: number;
  maxTotal?: number;
  maxDepth?: number;
  maxDescendants?: number;
  maxResident?: number;
  minAvailableMemory?: number;
  availableMemory?(): number;
  isCompleted?(spawnToken: string): boolean;
  isWaitingCoordinator?(sessionId: string): boolean;
  isRecoveringSession?(session: any): boolean;
  unregisteredReservations?(): UnregisteredResearchSession[];
}
export class ResearchSessionError extends Error { constructor(statusCode: number, code: string); statusCode: number; code: string }
export const RESEARCH_SESSION_LIMITS: Readonly<{ maxPerParent: number; maxTotal: number; maxTaskChars: number; maxRoleChars: number; maxDepth: number; maxDescendants: number; maxResident: number; minAvailableMemory: number }>;
export function validateResearchTasks(tasks: unknown): ResearchDispatchTask[];
export function researchProvenanceOf(row: any): ResearchSessionProvenance | undefined;
export function validateResearchSessionRequest(body: unknown): ResearchSessionRequest;
export const RESEARCH_SESSION_INITIAL_PROMPT_BYTES: number;
export function buildResearchSessionInitialPrompt(provenance: ResearchSessionProvenance, taskContext?: { dispatchId?: string; taskId?: string; prerequisiteResults?: Array<{ id: string }> }): string;
export function createResearchSessionService(deps: CreateResearchSessionServiceDeps): {
  create(input: { body: unknown; principal?: { iss: string; sub: string } | null; expiresAt?: number | null; taskContext?: { dispatchId: string; taskId: string; prerequisiteResults: any[] } }): Promise<Record<string, any>>;
  authorize(input: { sessionId: string; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<{ parent: any; cwd: string; charterHash: string; adoptionId: string; ownerKey?: string }>;
  release(spawnToken: string): void;
};
