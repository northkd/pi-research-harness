interface ResearchActor {
  principal?: { iss: string; sub: string } | null;
  expiresAt?: number | null;
}

interface CollaborationAccess {
  cwd: string;
  ownerKey: string;
  write?: boolean;
  revalidate(): Promise<void>;
}

export class ResearchCollaborationError extends Error {
  constructor(statusCode: number, code: string);
  readonly statusCode: number;
  readonly code: string;
}

export class ResearchSessionError extends Error {
  constructor(statusCode: number, code: string);
  readonly statusCode: number;
  readonly code: string;
}

interface CollaborationService {
  snapshot(access: CollaborationAccess): Promise<unknown>;
  mutate(access: CollaborationAccess, body: Record<string, unknown>, actor: ResearchActor): Promise<unknown>;
  native(access: CollaborationAccess, body: Record<string, unknown>, actor: ResearchActor): Promise<unknown>;
  assertParticipationAllowed(input: {
    cwd: string;
    sessionId: string;
    via: string;
    researchSession?: { parentSessionId: string; tenureId?: string };
  }): void;
  isCurrentMainSession?(sessionId: string): boolean;
  hasActiveChildren?(sessionId: string): boolean;
  hasReactivatedReservation?(spawnToken: string): boolean;
}

interface ResearchServiceRequest extends ResearchActor { body: unknown }

export function createResearchServices(options: object): {
  collaboration: CollaborationService;
  dispatch: {
    handle(input: ResearchServiceRequest): Promise<unknown>;
    reopenAssignment?(input: object): Promise<unknown>;
    isCompleted(token: string): boolean;
    isAssignmentNonActive?(token: string): boolean;
    completedAt?(token: string): number | null;
    isWaitingCoordinator(sessionId: string): boolean;
  };
  communication: {
    handle(input: ResearchServiceRequest): Promise<unknown>;
    isCompleted(token: string): boolean;
    completedAt?(token: string): number | null;
    hasOpenRequests?(sessionId: string): boolean;
    hasOpenParentRequest?(sessionId: string): boolean;
    clearTerminalReport?(spawnToken: string, reopenedById: string): void;
    listForScope?(scope: { cwd: string; ownerKey: string; limit?: number }): unknown[];
  };
  sessions: { create(input: ResearchServiceRequest): Promise<unknown> };
  tick(): Promise<unknown>;
  dispose(): void;
};
