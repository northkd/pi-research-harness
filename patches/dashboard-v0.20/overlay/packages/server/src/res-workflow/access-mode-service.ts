import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isResearchAccessMode, isResearchAccessModeUpdate, type ResearchAccessMode, type ResearchAccessModeUpdate } from '@blackbelt-technology/pi-dashboard-shared/research-access-mode.js';
import { ResWorkflowError, resolveInstalledResearchLoopRoot, type ResWorkflowAccess } from './adoption-service.js';

interface Backend {
  readResearchAccessMode(input: Record<string, unknown>): ResearchAccessMode;
  updateResearchAccessMode(input: Record<string, unknown>): ResearchAccessMode;
  researchAccessOwnerKey(principal?: { iss: string; sub: string }): string;
}
let sharedBackend: Promise<Backend> | undefined;
async function loadBackend(root?: string): Promise<Backend> {
  const installed = root ?? await resolveInstalledResearchLoopRoot();
  return import(pathToFileURL(path.join(installed, 'src', 'access-mode.mjs')).href) as Promise<Backend>;
}
const backend = (root?: string) => root ? loadBackend(root) : sharedBackend ??= loadBackend().catch(error => { sharedBackend = undefined; throw error; });
function failure(error: unknown): ResWorkflowError {
  if (error instanceof ResWorkflowError) return error;
  const code = (error as { code?: string })?.code;
  if (typeof code === 'string' && /^access-mode-[a-z-]+$/.test(code)) return new ResWorkflowError(code.includes('invalid') ? 400 : code === 'access-mode-unavailable' ? 503 : 409, code);
  return new ResWorkflowError(503, 'access-mode-unavailable');
}

/** The workspace route already owns identity/path admission; no research setup is required. */
export function createResWorkflowAccessModeService(deps: { researchLoopRoot?: string; storeDir?: string } = {}) {
  const execute = async (access: ResWorkflowAccess, request?: ResearchAccessModeUpdate): Promise<ResearchAccessMode> => {
    try {
      if (request && (!access.write || !isResearchAccessModeUpdate(request) || request.cwd !== access.cwd)) throw new ResWorkflowError(403, 'access-mode-write-required');
      await access.revalidate();
      const native = await backend(deps.researchLoopRoot);
      await access.revalidate();
      const input = { ...request, cwd: access.cwd, ownerKey: access.ownerKey, ...(deps.storeDir ? { storeDir: deps.storeDir } : {}) };
      const result = request ? native.updateResearchAccessMode(input) : native.readResearchAccessMode(input);
      if (!isResearchAccessMode(result) || result.cwd !== access.cwd) throw new Error('invalid access mode projection');
      return result;
    } catch (error) { throw failure(error); }
  };
  return { read: (access: ResWorkflowAccess) => execute(access), update: (access: ResWorkflowAccess, request: ResearchAccessModeUpdate) => execute(access, request) };
}

export type ResearchAccessSession = {
  id: string;
  cwd: string;
  originDeviceId?: string;
  principalOwner?: { iss: string; sub: string };
  driver?: string;
};

/** Only the gateway's authenticated session supplies identity. Remote hosts never inherit. */
export async function readSessionResearchAccessMode(session: ResearchAccessSession | undefined, options: { researchLoopRoot?: string; storeDir?: string } = {}): Promise<ResearchAccessMode | null> {
  if (!session?.id || session.originDeviceId || session.driver && session.driver !== 'pi') return null;
  try {
    const native = await backend(options.researchLoopRoot);
    const cwd = fs.realpathSync(session.cwd);
    const result = native.readResearchAccessMode({ cwd, ownerKey: native.researchAccessOwnerKey(session.principalOwner), ...(options.storeDir ? { storeDir: options.storeDir } : {}) });
    if (!isResearchAccessMode(result) || result.cwd !== cwd) throw new Error('invalid access mode projection');
    return result;
  } catch (error) { throw failure(error); }
}
