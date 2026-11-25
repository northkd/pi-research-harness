export interface ResearchCharterBindingSession {
  sessionId: string;
  status: 'joined' | 'not-joined' | 'assignment-stale' | 'unavailable';
  error?: string;
}

export interface ResearchCharterSnapshot {
  revision: number;
  objective: string;
  successCriteria: string[];
  constraints?: string[];
  nonGoals?: string[];
  [key: string]: unknown;
}

/** Membership, original adoption and current target binding are separate facts. */
export interface ResearchCharterBinding {
  schema: 'pi-research-charter-binding.v1';
  cwd: string;
  adopted: boolean;
  adoptionId: string | null;
  status: 'current' | 'stale' | 'not-adopted' | 'unavailable';
  bindingRevision: number;
  boundCharterHash: string | null;
  /** Legacy confirmation receipts do not prove an old revision number. */
  boundCharterRevision: number | null;
  currentCharterHash: string | null;
  currentCharterRevision: number | null;
  currentObjective: string | null;
  currentCharter?: ResearchCharterSnapshot;
  canRebind: boolean;
  updatedAt: string | null;
  error?: string;
  session?: ResearchCharterBindingSession;
}

export interface ResearchCharterBindingUpdate {
  cwd: string;
  adoptionId: string;
  expectedBindingRevision: number;
  expectedBoundCharterHash: string;
  expectedCharterHash: string;
  requestId: string;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const revision = (value: unknown, minimum: number) => Number.isSafeInteger(value) && (value as number) >= minimum;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const adoption = (value: unknown): value is string => typeof value === 'string' && /^adopt-[a-f0-9]{24}$/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export function isResearchCharterBindingSession(value: unknown): value is ResearchCharterBindingSession {
  return object(value) && id(value.sessionId) && ['joined', 'not-joined', 'assignment-stale', 'unavailable'].includes(value.status) && (value.error === undefined || typeof value.error === 'string');
}

export function isResearchCharterBinding(value: unknown): value is ResearchCharterBinding {
  if (!object(value) || value.schema !== 'pi-research-charter-binding.v1' || typeof value.cwd !== 'string' || typeof value.adopted !== 'boolean' ||
    !(value.adoptionId === null || adoption(value.adoptionId)) || !['current', 'stale', 'not-adopted', 'unavailable'].includes(value.status) ||
    !revision(value.bindingRevision, 0) || !(value.boundCharterHash === null || hash(value.boundCharterHash)) || !(value.currentCharterHash === null || hash(value.currentCharterHash)) ||
    !(value.boundCharterRevision === null || revision(value.boundCharterRevision, 1)) || !(value.currentCharterRevision === null || revision(value.currentCharterRevision, 1)) ||
    !(value.currentObjective === null || typeof value.currentObjective === 'string') || typeof value.canRebind !== 'boolean' ||
    !(value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) ||
    value.error !== undefined && typeof value.error !== 'string' || value.session !== undefined && !isResearchCharterBindingSession(value.session)) return false;
  if (['current', 'stale'].includes(value.status)) {
    const charter = value.currentCharter;
    if (!value.adopted || !adoption(value.adoptionId) || !hash(value.boundCharterHash) || !hash(value.currentCharterHash) || !object(charter) ||
      !revision(charter.revision, 1) || charter.revision !== value.currentCharterRevision || charter.objective !== value.currentObjective ||
      typeof charter.objective !== 'string' || !charter.objective.trim() || !strings(charter.successCriteria) || !charter.successCriteria.length ||
      charter.constraints !== undefined && !strings(charter.constraints) || charter.nonGoals !== undefined && !strings(charter.nonGoals)) return false;
    if ((value.status === 'current') !== (value.boundCharterHash === value.currentCharterHash) || value.canRebind !== (value.status === 'stale')) return false;
  } else if (value.canRebind) return false;
  return true;
}

export function isResearchCharterBindingUpdate(value: unknown): value is ResearchCharterBindingUpdate {
  return object(value) && Object.keys(value).every(key => ['cwd', 'adoptionId', 'expectedBindingRevision', 'expectedBoundCharterHash', 'expectedCharterHash', 'requestId'].includes(key)) &&
    typeof value.cwd === 'string' && !!value.cwd && adoption(value.adoptionId) && revision(value.expectedBindingRevision, 0) && hash(value.expectedBoundCharterHash) && hash(value.expectedCharterHash) && id(value.requestId);
}
