/** Operator authorization for one confirmed research charter, inherited by its joined sessions. */
export interface ResearchTaskCapabilities {
  localExecution: boolean;
  delegation: boolean;
  publicResearch: boolean;
  projectDependencies: boolean;
}
export interface ResearchTaskBlocker { code: string; tool: string; target?: string; at: string; hits: number }
export interface ResearchTaskPermissions {
  cwd: string;
  charterHash: string;
  revision: string | null;
  status: 'unconfigured' | 'active' | 'expired' | 'revoked' | 'scope-changed';
  task: string;
  capabilities: ResearchTaskCapabilities;
  additionalRoots: string[];
  durationHours: 12 | 24 | 48 | 72;
  authorizedAt: string | null;
  expiresAt: string | null;
  inheritance: 'joined-workbench-descendants';
  blockers: ResearchTaskBlocker[];
}
export interface ResearchTaskPermissionUpdate {
  cwd: string;
  expectedRevision: string | null;
  requestId: string;
  action: 'authorize' | 'revoke';
  confirmed: true;
  task?: string;
  durationHours?: 12 | 24 | 48 | 72;
  capabilities?: ResearchTaskCapabilities;
  additionalRoots?: string[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const caps = (v: unknown): v is ResearchTaskCapabilities => object(v) && Object.keys(v).length === 4 && ['localExecution', 'delegation', 'publicResearch', 'projectDependencies'].every(k => typeof v[k] === 'boolean');
const revision = (v: unknown) => v === null || typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
export function isResearchTaskPermissionUpdate(v: unknown): v is ResearchTaskPermissionUpdate {
  if (!object(v) || Object.keys(v).some(k => !['cwd', 'expectedRevision', 'requestId', 'action', 'confirmed', 'task', 'durationHours', 'capabilities', 'additionalRoots'].includes(k))
    || typeof v.cwd !== 'string' || !v.cwd || v.cwd.length > 4096 || !revision(v.expectedRevision)
    || typeof v.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(v.requestId) || v.confirmed !== true) return false;
  return v.action === 'revoke' || v.action === 'authorize' && typeof v.task === 'string' && !!v.task.trim() && v.task.length <= 4000
    && [12, 24, 48, 72].includes(v.durationHours as number) && caps(v.capabilities)
    && Array.isArray(v.additionalRoots) && v.additionalRoots.length <= 16 && v.additionalRoots.every(r => typeof r === 'string' && !!r && r.length <= 4096);
}
export function isResearchTaskPermissions(v: unknown): v is ResearchTaskPermissions {
  return object(v) && typeof v.cwd === 'string' && typeof v.charterHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(v.charterHash) && revision(v.revision)
    && ['unconfigured', 'active', 'expired', 'revoked', 'scope-changed'].includes(v.status as string) && typeof v.task === 'string' && caps(v.capabilities)
    && Array.isArray(v.additionalRoots) && v.additionalRoots.every(p => typeof p === 'string') && [12, 24, 48, 72].includes(v.durationHours as number)
    && (v.authorizedAt === null || typeof v.authorizedAt === 'string') && (v.expiresAt === null || typeof v.expiresAt === 'string')
    && v.inheritance === 'joined-workbench-descendants' && Array.isArray(v.blockers) && v.blockers.length <= 20;
}
