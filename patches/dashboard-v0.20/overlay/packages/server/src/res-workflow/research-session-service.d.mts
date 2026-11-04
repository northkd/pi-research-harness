export interface ResearchSessionRequest { parentSessionId: string; role: string; task: string; stage: string; requestId?: string }
export interface ResearchSessionProvenance {
  schema: "pi-research-session.v1"; parentSessionId: string; creatorSessionId: string;
  creatorAgent: "research_session"; role: string; task: string; stage: string;
  charterHash: string; adoptionId: string; workflowCwd: string; spawnToken: string;
  createdAt: string; origin: "research_session"; relation: "dispatch";
}
export interface CreateResearchSessionServiceDeps {
  getSession(id: string): any;
  listSessions(): any[];
  verifyParent(input: { parent: any; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<{ charterHash: string; adoptionId: string; cwd?: string; ownerKey?: string }>;
  prepareSpawn(cwd: string, identity: { principal: { iss: string; sub: string } | null; expiresAt: number | null; write: true }, verified: { ownerKey?: string; researchSession: ResearchSessionProvenance }): Promise<Record<string, unknown>>;
  pendingPluginRefRegistry: { file(token: string, ref: unknown, ownerId: string): boolean; remove(token: string): void };
  pendingPrincipalOwnerRegistry: { file(token: string, owner: { iss: string; sub: string }): boolean; remove(token: string): void };
  initialPrompts: { enqueue(cwd: string, prompt: string, spawnToken: string): boolean; remove?(cwd: string, spawnToken: string): boolean | void };
  spawn(cwd: string, options: { spawnToken: string; strategy?: string }): Promise<{ success: boolean; [key: string]: unknown }>;
  spawnStrategy?(): string;
  isLocalOperator(principal: unknown): boolean;
  now?(): Date;
  mintToken?(): string;
  maxPerParent?: number;
  maxTotal?: number;
}
export class ResearchSessionError extends Error { constructor(statusCode: number, code: string); statusCode: number; code: string }
export const RESEARCH_SESSION_LIMITS: Readonly<{ maxPerParent: number; maxTotal: number; maxTaskChars: number; maxRoleChars: number }>;
export function validateResearchSessionRequest(body: unknown): ResearchSessionRequest;
export function buildResearchSessionInitialPrompt(provenance: ResearchSessionProvenance): string;
export function createResearchSessionService(deps: CreateResearchSessionServiceDeps): {
  create(input: { body: unknown; principal?: { iss: string; sub: string } | null; expiresAt?: number | null }): Promise<Record<string, unknown>>;
};
