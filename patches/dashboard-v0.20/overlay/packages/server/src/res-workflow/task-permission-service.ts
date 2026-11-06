import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isResearchTaskPermissions, isResearchTaskPermissionUpdate, type ResearchTaskPermissions, type ResearchTaskPermissionUpdate } from '@blackbelt-technology/pi-dashboard-shared/research-task-permissions.js';
import { ResWorkflowError, resolveInstalledResearchLoopRoot, type ResWorkflowAccess, type ResWorkflowService } from './adoption-service.js';

interface Backend {
  charterHash(cwd: string): string;
  readTaskPermissions(input: Record<string, unknown>): ResearchTaskPermissions;
  updateTaskPermissions(input: Record<string, unknown>): ResearchTaskPermissions;
  recordTaskPermissionBlock(input: Record<string, unknown>): void;
  taskPermissionPathDecision(profile: ResearchTaskPermissions, target: string, access?: string): 'allow' | 'out-of-scope' | null;
  readTaskPermissionContext(ctx: unknown, options?: Record<string, unknown>): { profile: ResearchTaskPermissions | null; binding?: Record<string, unknown>; unavailable?: boolean } | null;
}
let sharedBackend: Promise<Backend> | undefined;
async function loadBackend(root?: string): Promise<Backend> {
  const installed = root ?? await resolveInstalledResearchLoopRoot();
  const load = (file: string) => import(pathToFileURL(path.join(installed, 'src', file)).href);
  const [adoption, permissions, context] = await Promise.all([load('adoption.mjs'), load('task-permissions.mjs'), load('task-permission-context.mjs')]);
  return { ...permissions, charterHash: adoption.charterHash, readTaskPermissionContext: context.readTaskPermissionContext } as Backend;
}
const backend = (root?: string) => root ? loadBackend(root) : sharedBackend ??= loadBackend().catch(error => { sharedBackend = undefined; throw error; });
function failure(error: unknown): ResWorkflowError {
  if (error instanceof ResWorkflowError) return error;
  const code = (error as { code?: string })?.code;
  if (typeof code === 'string' && /^task-permissions-[a-z-]+$/.test(code)) return new ResWorkflowError(code.includes('invalid') ? 400 : code.includes('owner') ? 403 : 409, code);
  return new ResWorkflowError(503, 'task-permissions-unavailable');
}
export function createResWorkflowTaskPermissionService(deps: { researchLoopRoot?: string; connection: ResWorkflowService['connection']; storeDir?: string }) {
  const execute = async (access: ResWorkflowAccess, request?: ResearchTaskPermissionUpdate): Promise<ResearchTaskPermissions> => {
    try {
      if (request && (!access.write || !isResearchTaskPermissionUpdate(request) || request.cwd !== access.cwd)) throw new ResWorkflowError(403, 'task-permissions-write-required');
      await access.revalidate();
      const connection = await deps.connection(access);
      if (!connection.adopted || connection.cwd !== access.cwd) throw new ResWorkflowError(409, 'task-permissions-not-adopted');
      const native = await backend(deps.researchLoopRoot), charterHash = native.charterHash(access.cwd);
      await access.revalidate();
      const input = { ...request, cwd: access.cwd, charterHash, ownerKey: access.ownerKey, ...(deps.storeDir ? { storeDir: deps.storeDir } : {}) };
      const result = request ? native.updateTaskPermissions(input) : native.readTaskPermissions(input);
      await access.revalidate();
      if (native.charterHash(access.cwd) !== charterHash) throw new ResWorkflowError(409, 'task-permissions-scope-mismatch');
      if (!isResearchTaskPermissions(result) || result.cwd !== access.cwd) throw new Error('invalid permission projection');
      return result;
    } catch (error) { throw failure(error); }
  };
  return { read: (access: ResWorkflowAccess) => execute(access), update: (access: ResWorkflowAccess, request: ResearchTaskPermissionUpdate) => execute(access, request) };
}

/** The bridge's own connected session supplies identity, cwd and membership; none comes from the tool call. */
export async function decideResearchTaskPath(session: { id: string; cwd: string; sessionFile?: string; originDeviceId?: string; principalOwner?: { iss: string; sub: string }; driver?: string } | undefined, target: string, access: 'r' | 'w', tool: string, options: { researchLoopRoot?: string; contextOptions?: Record<string, unknown> } = {}): Promise<'auto-allow' | 'task-blocked' | null> {
  let configuredTask = false;
  try {
    if (!session?.sessionFile || session.originDeviceId || session.driver && session.driver !== 'pi') return null;
    const native = await backend(options.researchLoopRoot);
    const context = native.readTaskPermissionContext({ cwd: session.cwd, sessionManager: { getSessionId: () => session.id, getSessionFile: () => session.sessionFile } }, options.contextOptions);
    if (!context) return null;
    if (context.unavailable) return 'task-blocked';
    const profile = context.profile;
    if (!profile || profile.status === 'unconfigured') return null;
    configuredTask = true;
    const decision = native.taskPermissionPathDecision(profile, target, access);
    if (decision === 'allow') return 'auto-allow';
    if (context.binding) {
      try { native.recordTaskPermissionBlock({ ...context.binding, code: profile.status === 'active' ? 'file-access-out-of-scope' : `authorization-${profile.status}`, tool, target }); }
      catch { /* Diagnostics cannot turn a known denial into a broader legacy automatic grant. */ }
    }
    // An expired or revoked task never falls back to a broader automatic grant.
    return 'task-blocked';
  } catch { return configuredTask ? 'task-blocked' : null; }
}

/** Queued dispatch is a new action: check the live parent grant again at each launch, never only at plan creation. */
export async function assertResearchTaskDelegation(session: { id: string; cwd: string; sessionFile?: string; originDeviceId?: string; driver?: string } | undefined, options: { researchLoopRoot?: string; contextOptions?: Record<string, unknown> } = {}): Promise<ResearchTaskPermissions | null> {
  try {
    if (!session?.sessionFile || session.originDeviceId || session.driver && session.driver !== 'pi') throw new ResWorkflowError(409, 'task-permissions-context-unavailable');
    const native = await backend(options.researchLoopRoot);
    const context = native.readTaskPermissionContext({ cwd: session.cwd, sessionManager: { getSessionId: () => session.id, getSessionFile: () => session.sessionFile } }, options.contextOptions);
    if (!context || context.unavailable || !context.profile) throw new ResWorkflowError(409, 'task-permissions-context-unavailable');
    const profile = context.profile;
    // No extra preauthorization was configured; the existing membership/budget authorization still applies.
    if (profile.status === 'unconfigured') return null;
    if (profile.status === 'active' && profile.capabilities.delegation) return profile;
    const code = profile.status === 'active' ? 'delegation-out-of-scope' : `authorization-${profile.status}`;
    if (context.binding) { try { native.recordTaskPermissionBlock({ ...context.binding, code, tool: 'research_dispatch' }); } catch { /* A failed diagnostic must never authorize the action. */ } }
    throw new ResWorkflowError(409, `task-permissions-${code}`);
  } catch (error) { throw failure(error); }
}
