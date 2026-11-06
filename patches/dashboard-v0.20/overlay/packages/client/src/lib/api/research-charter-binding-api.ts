import {
  isResearchCharterBinding, isResearchCharterBindingUpdate,
  type ResearchCharterBinding, type ResearchCharterBindingUpdate,
} from '@blackbelt-technology/pi-dashboard-shared/research-charter-binding.js';
import { getApiBase } from './api-context.js';
import { fetchJsonResponse } from './fetch-json.js';

export type { ResearchCharterBinding, ResearchCharterBindingUpdate };

/** Keep transport and concurrency failures distinct without displaying server internals. */
export class ResearchCharterBindingApiError extends Error {
  readonly status: number;
  constructor(status: number, code = 'research-charter-binding-unavailable') {
    super(/^research-charter-binding-[a-z-]+$/.test(code) ? code : 'research-charter-binding-unavailable');
    this.name = 'ResearchCharterBindingApiError';
    this.status = status;
  }
}

async function request(suffix: string, init?: RequestInit): Promise<ResearchCharterBinding> {
  try {
    const { res, json } = await fetchJsonResponse<unknown>(`${getApiBase()}/api/res-workflow/charter-binding${suffix}`, init);
    if (!res.ok) {
      const code = json && typeof json === 'object' && 'code' in json && typeof json.code === 'string' ? json.code : undefined;
      throw new ResearchCharterBindingApiError(res.status, code);
    }
    if (!isResearchCharterBinding(json)) throw new ResearchCharterBindingApiError(res.status, 'research-charter-binding-invalid-response');
    return json;
  } catch (error) {
    if (error instanceof ResearchCharterBindingApiError || init?.signal?.aborted) throw error;
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 0;
    throw new ResearchCharterBindingApiError(status);
  }
}

export async function getResearchCharterBinding(cwd: string, sessionId?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ cwd });
  if (sessionId) query.set('sessionId', sessionId);
  const value = await request(`?${query}`, { signal });
  // A current project binding alone cannot establish the selected conversation's membership.
  if (sessionId && value.session?.sessionId !== sessionId) throw new ResearchCharterBindingApiError(200, 'research-charter-binding-session-response-mismatch');
  return value;
}

export function updateResearchCharterBinding(body: ResearchCharterBindingUpdate, signal?: AbortSignal) {
  if (!isResearchCharterBindingUpdate(body)) throw new ResearchCharterBindingApiError(400, 'research-charter-binding-invalid-request');
  return request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
}
