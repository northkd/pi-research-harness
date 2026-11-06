import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalApiBase } from '../api-context.js';
import { getResearchCharterBinding, updateResearchCharterBinding } from '../research-charter-binding-api.js';

const cwd = '/canonical/research folder';
const currentHash = 'sha256:' + 'a'.repeat(64);
const oldHash = 'sha256:' + 'b'.repeat(64);
const value = {
  schema: 'pi-research-charter-binding.v1', cwd, adopted: true, adoptionId: 'adopt-' + '1'.repeat(24),
  status: 'current', bindingRevision: 1, boundCharterHash: currentHash, boundCharterRevision: 2,
  currentCharterHash: currentHash, currentCharterRevision: 2, currentObjective: '验证已声明的研究目标',
  currentCharter: { revision: 2, objective: '验证已声明的研究目标', successCriteria: ['保留反例与未定结果'], constraints: [], nonGoals: [] },
  canRebind: false, updatedAt: '2026-11-06T10:00:00.000Z', session: { sessionId: 'main-session', status: 'joined' },
};
const update = { cwd, adoptionId: value.adoptionId, expectedBindingRevision: 0, expectedBoundCharterHash: oldHash, expectedCharterHash: currentHash, requestId: 'request-one' };
function respond(body: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => setGlobalApiBase(''));
afterEach(() => { vi.unstubAllGlobals(); setGlobalApiBase(''); });

describe('charter binding API transport and identity checks', () => {
  it('reads the selected session in the requested workspace and accepts the admitted canonical path', async () => {
    setGlobalApiBase('https://fixture.invalid');
    const fetcher = respond(value), controller = new AbortController();
    expect(await getResearchCharterBinding('/project alias', 'main-session', controller.signal)).toEqual(value);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const request = new URL(String(url));
    expect(request.origin).toBe('https://fixture.invalid');
    expect(request.pathname).toBe('/api/res-workflow/charter-binding');
    expect([...request.searchParams]).toEqual([['cwd', '/project alias'], ['sessionId', 'main-session']]);
    expect(init?.signal).toBe(controller.signal);
    expect(init?.body).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { sessionId: 'other-session', status: 'joined' }])('refuses a missing or different selected-session receipt', async session => {
    respond({ ...value, session });
    await expect(getResearchCharterBinding(cwd, 'main-session')).rejects.toMatchObject({ message: 'research-charter-binding-session-response-mismatch' });
  });

  it('does not treat a malformed or inconsistent success body as a confirmed binding', async () => {
    respond({ ...value, boundCharterHash: oldHash });
    await expect(getResearchCharterBinding(cwd, 'main-session')).rejects.toMatchObject({ status: 200, message: 'research-charter-binding-invalid-response' });
  });

  it('sends only the explicit compare-and-swap fields and accepts an update receipt without membership', async () => {
    const { session: _session, ...receipt } = value;
    respond(receipt);
    expect(await updateResearchCharterBinding(update)).toEqual(receipt);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/res-workflow/charter-binding');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(update);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves conflict status but never exposes an arbitrary server error or retries a mutation', async () => {
    respond({ code: 'research-charter-binding-conflict', error: 'private runtime detail' }, 409);
    await expect(updateResearchCharterBinding(update)).rejects.toMatchObject({ status: 409, message: 'research-charter-binding-conflict' });
    expect(fetch).toHaveBeenCalledTimes(1);
    respond({ code: 'private error code' }, 503);
    await expect(getResearchCharterBinding(cwd)).rejects.toMatchObject({ status: 503, message: 'research-charter-binding-unavailable' });
  });

  it('retains the HTTP status of a gateway failure without surfacing its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>private proxy details</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    await expect(getResearchCharterBinding(cwd)).rejects.toMatchObject({ status: 502, message: 'research-charter-binding-unavailable' });
  });

  it('does not retry an unconfirmed transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private connection detail')));
    await expect(updateResearchCharterBinding(update)).rejects.toMatchObject({ status: 0, message: 'research-charter-binding-unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects extra mutation fields before sending them', () => {
    respond(value);
    expect(() => updateResearchCharterBinding({ ...update, ownerProof: 'not-a-client-field' } as typeof update)).toThrow('research-charter-binding-invalid-request');
    expect(fetch).not.toHaveBeenCalled();
  });
});
