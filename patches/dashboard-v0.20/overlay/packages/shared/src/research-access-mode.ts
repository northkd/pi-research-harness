/** Persistent operator choice for Pi sessions in one local workspace. */
export interface ResearchAccessMode {
  cwd: string;
  mode: 'default' | 'full-access';
  revision: string | null;
  updatedAt: string | null;
  inheritance: 'workspace-sessions';
}

export interface ResearchAccessModeUpdate {
  cwd: string;
  mode: ResearchAccessMode['mode'];
  expectedRevision: string | null;
  requestId: string;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const mode = (value: unknown) => value === 'default' || value === 'full-access';
const revision = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const cwd = (value: unknown) => typeof value === 'string' && !!value && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);

export function isResearchAccessModeUpdate(value: unknown): value is ResearchAccessModeUpdate {
  return object(value) && Object.keys(value).every(key => ['cwd', 'mode', 'expectedRevision', 'requestId'].includes(key))
    && cwd(value.cwd) && mode(value.mode) && revision(value.expectedRevision)
    && typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.requestId);
}

export function isResearchAccessMode(value: unknown): value is ResearchAccessMode {
  return object(value) && cwd(value.cwd) && mode(value.mode) && revision(value.revision)
    && (value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))
    && value.inheritance === 'workspace-sessions';
}
