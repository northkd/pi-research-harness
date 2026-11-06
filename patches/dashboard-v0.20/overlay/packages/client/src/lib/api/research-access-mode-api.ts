import { getApiBase } from './api-context.js';
import { fetchJsonResponse } from './fetch-json.js';
import { isResearchAccessMode, type ResearchAccessMode, type ResearchAccessModeUpdate } from '@blackbelt-technology/pi-dashboard-shared/research-access-mode.js';
export type { ResearchAccessMode, ResearchAccessModeUpdate } from '@blackbelt-technology/pi-dashboard-shared/research-access-mode.js';

async function request(suffix: string, init?: RequestInit): Promise<ResearchAccessMode> {
  const { res, json } = await fetchJsonResponse<unknown>(`${getApiBase()}/api/res-workflow/access-mode${suffix}`, init);
  if (!res.ok || !isResearchAccessMode(json)) throw new Error(json && typeof json === 'object' && 'code' in json ? String(json.code) : 'access-mode-unavailable');
  return json;
}

export const getResearchAccessMode = (cwd: string, signal?: AbortSignal) => request(`?cwd=${encodeURIComponent(cwd)}`, { signal });
export const updateResearchAccessMode = (body: ResearchAccessModeUpdate, signal?: AbortSignal) => request('', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
});
