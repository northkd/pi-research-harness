import { getApiBase } from './api-context.js';
import { fetchJsonResponse } from './fetch-json.js';
import { isResearchTaskPermissions, type ResearchTaskPermissionUpdate, type ResearchTaskPermissions } from '@blackbelt-technology/pi-dashboard-shared/research-task-permissions.js';
export type { ResearchTaskPermissionUpdate, ResearchTaskPermissions } from '@blackbelt-technology/pi-dashboard-shared/research-task-permissions.js';
async function request(suffix: string, init?: RequestInit): Promise<ResearchTaskPermissions> {
  const { res, json } = await fetchJsonResponse<unknown>(`${getApiBase()}/api/res-workflow/task-permissions${suffix}`, init);
  if (!res.ok || !isResearchTaskPermissions(json)) throw new Error(json && typeof json === 'object' && 'code' in json ? String(json.code) : 'task-permissions-unavailable');
  return json;
}
export const getResearchTaskPermissions = (cwd: string, signal?: AbortSignal) => request(`?cwd=${encodeURIComponent(cwd)}`, { signal });
export const updateResearchTaskPermissions = (body: ResearchTaskPermissionUpdate, signal?: AbortSignal) => request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
