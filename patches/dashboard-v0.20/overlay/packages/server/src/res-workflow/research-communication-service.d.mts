export interface ResearchCommunicationService {
  handle(input: { body: unknown; principal?: any; expiresAt?: number | null }): Promise<any>;
  tick(): Promise<void>;
  acknowledgeReceipt(sessionId: string, promptId: string): Promise<void>;
  isCompleted(spawnToken: string): boolean;
  dispose(): void;
}
export function createResearchCommunicationStore(directory: string): { directory: string; readAll(): any[]; write(row: any): void };
export function createResearchCommunicationService(deps: {
  store: { readAll(): any[]; write(row: any): void };
  authorize(input: any): Promise<any>;
  /** Retained exact membership may archive a result, never authorize new work. */
  authorizeRetainedReport?(input: any): Promise<any>;
  beforeResume?(input: { parent: any; verified: any; child: any; childVerified: any }): void | Promise<void>;
  getSession(id: string): any;
  listSessions(): any[];
  notifyParent?(sessionId: string, text: string, promptId: string): boolean | Promise<boolean>;
  principalForSession?(session: any): any;
  releaseSession?(spawnToken: string): void | Promise<void>;
  activateSession?(spawnToken: string): void | Promise<void>;
  reportAssignment?(input: any): Promise<any>;
  isAssignmentCompleted?(spawnToken: string): boolean;
  childrenPending?(sessionId: string): boolean;
  now?(): Date;
}): ResearchCommunicationService;
