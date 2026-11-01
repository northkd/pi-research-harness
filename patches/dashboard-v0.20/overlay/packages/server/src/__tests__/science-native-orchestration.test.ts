import type { ScienceNativeDriverDeps, ScienceNativeSessionProviderDeps } from "@blackbelt-technology/pi-dashboard-server/science-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceNativeReadonlyHost, type ScienceNativePageAdapters } from "../../../../claude-science/host/science-native-orchestration.js";

const traced = vi.hoisted(() => ({ events: [] as string[], hostDeps: undefined as any, driverDeps: undefined as ScienceNativeDriverDeps | undefined, sessionDeps: undefined as ScienceNativeSessionProviderDeps | undefined, retains: 0, invalidates: 0, sessionClosed: 0, driverFailed: false, prepareFailed: false, observationMissing: false, observerFailed: false, hostFailed: false, observerCalls: 0, visibleNames: [] as string[], materials: [] as unknown[], observerWait: undefined as Promise<void> | undefined }));
vi.mock("@blackbelt-technology/pi-dashboard-server/science-registry", async importOriginal => {
  const actual = await importOriginal<typeof import("@blackbelt-technology/pi-dashboard-server/science-registry")>();
  return { ...actual,
    createScienceNativeSessionProvider: (deps: ScienceNativeSessionProviderDeps) => {
      traced.sessionDeps = deps;
      return { retain() { const role = ++traced.retains === 1 ? 'driver' : 'browser'; return {
        privateSession: async () => { traced.events.push(`${role}-session`); return { authCookie: 'fake-auth', csrfCookie: 'fake-csrf' }; },
        getPrivateSession: async (binding: any) => ({ ownerKey: binding.ownerKey, cwd: binding.cwd, projectId: binding.projectId, frameId: binding.binding?.frameId ?? null, cookies: { operon_auth: 'fake-auth', operon_csrf: 'fake-csrf' } }),
        release() { traced.events.push(`release-${role}`); },
      }; }, invalidate() { traced.invalidates++; }, close() { traced.sessionClosed++; traced.events.push('session-close'); } };
    },
    createScienceNativeRegistryDriver: (deps: ScienceNativeDriverDeps) => { traced.driverDeps = deps; return { async observe(binding: any) {
      await deps.runtime.assertCapability('observe', { projectId: binding.projectId, binding }); await deps.privateSession();
      if (traced.driverFailed) throw new Error('401 private error must not escape');
      return { ...binding, status: 'running' };
    } }; },
  };
});
vi.mock("../../../../claude-science/host/science-host-composition.js", () => ({ createScienceReadonlyHost: async (deps: any) => {
  traced.hostDeps = deps; await deps.scope.revalidate();
  if (traced.hostFailed) throw new Error('private-start-failure');
  return { instanceId: 'si-11111111-1111-4111-8111-111111111111', async observe() { await deps.observeBinding(deps.scope.binding); return { status: 'running' }; }, async close() { traced.events.push('host-close'); } };
} }));

const binding = { projectId: 'proj_111111111111', taskId: '11111111-1111-4111-8111-111111111111', rootFrameId: '11111111-1111-4111-8111-111111111111', frameId: '11111111-1111-4111-8111-111111111111' };
const partition = { ownerKey: JSON.stringify(['fixture', 'owner']), cwd: '/fixture' };
beforeEach(() => { traced.events.length = 0; traced.hostDeps = undefined; traced.driverDeps = undefined; traced.sessionDeps = undefined; traced.retains = 0; traced.invalidates = 0; traced.sessionClosed = 0; traced.driverFailed = false; traced.prepareFailed = false; traced.observationMissing = false; traced.observerFailed = false; traced.hostFailed = false; traced.observerCalls = 0; traced.visibleNames.length = 0; traced.materials.length = 0; traced.observerWait = undefined; });
async function fixture(assertReadWsContract?: (expected: unknown) => Promise<void>) {
  let allowed = true, runtimeAllowed = true, grantReturn: unknown;
  const scope = { partition: { ...partition }, binding: { ...binding }, revalidate: vi.fn(async () => { if (!allowed) throw new Error('private-scope'); return grantReturn as void; }) };
  const assertCurrentRuntime = vi.fn(async () => { if (!runtimeAllowed) throw new Error('private-runtime'); });
  const assertObserveContract = vi.fn(async () => {});
  const nativePage: ScienceNativePageAdapters = {
    loadPinnedAssets: () => new Map(),
    createNativePageResolver: ({ getObservation }) => async selected => { const material = await getObservation(selected); traced.materials.push(material); return material ? { projectId: selected.projectId, entryUrl: 'http://127.0.0.1:18765/projects/fixture', resources: [], verifiedProjectScope: true } : null; },
    createPrivateSessionPreparer: ({ getPrivateSession }) => async selected => { await getPrivateSession(selected); return !traced.prepareFailed; },
    observeNativeProject: async ({ binding: selected, expectedVisibleProjectName, assertBoundary }) => {
      traced.observerCalls++; traced.visibleNames.push(expectedVisibleProjectName); await traced.observerWait;
      if (traced.observerFailed) throw new Error('401 private body');
      if (!await assertBoundary()) return { observation: null };
      return { summary: { scopeVerified: true, counts: 99 }, observation: traced.observationMissing ? null : { materialFor(value: typeof selected) { return value.projectId === selected.projectId ? { privateProof: selected.binding ? 'task' : 'workspace' } : null; } } } as never;
    },
  };
  const deps = { registryRoot: '/fixture/registry', chromePrivateDir: '/fixture/chrome', transportPrivateDir: '/fixture/ipc', scope, assertCurrentRuntime, assertObserveContract, assertReadWsContract, expectedVisibleProjectName: 'synthetic-p0-visible-fixture', nativePage, chrome: { resolveBinary: () => '/fixture/chrome-bin' } };
  const host = await createScienceNativeReadonlyHost(deps);
  const pageBinding = (task = true) => ({ ...partition, projectId: binding.projectId, ...(task ? { binding: { ...binding } } : {}), revalidate: scope.revalidate });
  return { host, deps, scope, assertCurrentRuntime, assertObserveContract, pageBinding, revoke: () => { allowed = false; }, revokeRuntime: () => { runtimeAllowed = false; }, grant: (value: unknown) => { grantReturn = value; } };
}

describe('native readonly orchestration', () => {
  it('uses two session leases, actual private observation material, and at most workspace/task caches', async () => {
    const f = await fixture(); expect(traced.retains).toBe(2); expect(traced.observerCalls).toBe(0);
    await traced.hostDeps.resolvePage(f.pageBinding()); await traced.hostDeps.resolvePage(f.pageBinding());
    await traced.hostDeps.resolvePage(f.pageBinding(false)); await traced.hostDeps.resolvePage(f.pageBinding(false));
    expect(traced.observerCalls).toBe(2); expect(traced.materials).toEqual([{ privateProof: 'task' }, { privateProof: 'task' }, { privateProof: 'workspace' }, { privateProof: 'workspace' }]);
    expect(traced.visibleNames).toEqual([f.deps.expectedVisibleProjectName, f.deps.expectedVisibleProjectName]);
    await f.host.observe(); expect(f.assertObserveContract).toHaveBeenCalled(); expect(traced.events).toContain('driver-session'); await f.host.close();
  });
  it('hard-denies submit and foreign native IDs before any session or contract call', async () => {
    const f = await fixture(), runtime = traced.driverDeps!.runtime;
    await expect(runtime.assertCapability('submit', {} as never)).rejects.toThrow('science-native-orchestration-unavailable');
    await expect(runtime.assertCapability('observe', { projectId: binding.projectId, binding: { ...binding, frameId: 'other' } })).rejects.toThrow();
    expect(f.assertObserveContract).not.toHaveBeenCalled(); expect(traced.events).not.toContain('driver-session'); await f.host.close();
  });
  it('never uses summary/counts as proof and invalidates an observer failure without retry', async () => {
    const f = await fixture(); traced.observationMissing = true;
    expect(await traced.hostDeps.resolvePage(f.pageBinding())).toBeNull(); expect(traced.observerCalls).toBe(1); expect(traced.invalidates).toBeGreaterThan(0);
    traced.observationMissing = false; traced.observerFailed = true;
    expect(await traced.hostDeps.resolvePage(f.pageBinding())).toBeNull(); expect(traced.observerCalls).toBe(2); await f.host.close();
  });
  it('invalidates cached proof/cookies on driver or prepare authentication failure', async () => {
    const f = await fixture(); await traced.hostDeps.resolvePage(f.pageBinding()); traced.driverFailed = true;
    await expect(f.host.observe()).rejects.toThrow('science-native-orchestration-unavailable');
    traced.driverFailed = false; await traced.hostDeps.resolvePage(f.pageBinding()); expect(traced.observerCalls).toBe(2);
    traced.prepareFailed = true; expect(await traced.hostDeps.prepareSession(f.pageBinding(), {})).toBe(false);
    traced.prepareFailed = false; await traced.hostDeps.resolvePage(f.pageBinding()); expect(traced.observerCalls).toBe(3); await f.host.close();
  });
  it('rechecks revoked scope/runtime on cache hits and never calls the observer', async () => {
    const f = await fixture(); await traced.hostDeps.resolvePage(f.pageBinding()); f.revokeRuntime();
    expect(await traced.hostDeps.resolvePage(f.pageBinding())).toBeNull(); expect(traced.observerCalls).toBe(1);
    await expect(f.host.observe()).rejects.toThrow(); await f.host.close();
  });
  it('deduplicates one selected observation and discards a late result after revocation', async () => {
    const f = await fixture(); let finish!: () => void; traced.observerWait = new Promise(resolve => { finish = resolve; });
    const first = traced.hostDeps.resolvePage(f.pageBinding()), second = traced.hostDeps.resolvePage(f.pageBinding());
    await vi.waitFor(() => expect(traced.observerCalls).toBe(1)); f.revoke(); finish();
    expect(await first).toBeNull(); expect(await second).toBeNull(); expect(traced.observerCalls).toBe(1); await f.host.close();
  });
  it('rejects truthy grants and closes host before releases and provider close', async () => {
    const f = await fixture(); f.grant(true);
    expect(await traced.hostDeps.resolvePage(f.pageBinding())).toBeNull(); await f.host.close(); await f.host.close();
    expect(traced.events.slice(-4)).toEqual(['host-close', 'release-driver', 'release-browser', 'session-close']); expect(traced.sessionClosed).toBe(1);
  });
  it('rejects foreign selections and missing adapters without producing any private observation', async () => {
    const f = await fixture();
    expect(await traced.hostDeps.resolvePage({ ...f.pageBinding(), projectId: 'proj_222222222222' })).toBeNull();
    expect(await traced.hostDeps.resolvePage({ ...f.pageBinding(), binding: { ...binding, frameId: 'other' } })).toBeNull();
    expect(traced.observerCalls).toBe(0);
    await expect(createScienceNativeReadonlyHost({ ...f.deps, nativePage: { ...f.deps.nativePage, observeNativeProject: undefined } } as never)).rejects.toThrow('science-native-orchestration-unavailable');
    expect(traced.retains).toBe(2); await f.host.close();
  });
  it('releases both sessions if the underlying host cannot start', async () => {
    traced.hostFailed = true; await expect(fixture()).rejects.toThrow('science-native-orchestration-unavailable');
    expect(traced.events).toEqual(['release-driver', 'release-browser', 'session-close']); expect(traced.sessionClosed).toBe(1);
  });
  it('keeps a failed-generation flight bounded and requires another explicit attempt after it settles', async () => {
    const f = await fixture(); let finish!: () => void; traced.observerWait = new Promise(resolve => { finish = resolve; });
    const first = traced.hostDeps.resolvePage(f.pageBinding()); await vi.waitFor(() => expect(traced.observerCalls).toBe(1));
    traced.driverFailed = true; await expect(f.host.observe()).rejects.toThrow();
    const secondSettled = vi.fn();
    const second = traced.hostDeps.resolvePage(f.pageBinding()).then((value: unknown) => { secondSettled(value); return value; });
    try { await vi.waitFor(() => expect(secondSettled).toHaveBeenCalledWith(null), { timeout: 400 }); }
    finally { finish(); }
    expect(traced.observerCalls).toBe(1);
    expect(await first).toBeNull(); expect(await second).toBeNull(); expect(traced.observerCalls).toBe(1);
    traced.driverFailed = false; traced.observerWait = undefined; await traced.hostDeps.resolvePage(f.pageBinding()); expect(traced.observerCalls).toBe(2); await f.host.close();
  });
  it('closes during a delayed observation without publishing a proof or retaining a session', async () => {
    const f = await fixture(); let finish!: () => void; traced.observerWait = new Promise(resolve => { finish = resolve; });
    const opening = traced.hostDeps.resolvePage(f.pageBinding()); await vi.waitFor(() => expect(traced.observerCalls).toBe(1));
    const closing = f.host.close(); await vi.waitFor(() => expect(traced.sessionClosed).toBe(1)); finish();
    await closing; expect(await opening).toBeNull(); expect(traced.materials).toEqual([]); expect(traced.events.slice(-4)).toEqual(['host-close', 'release-driver', 'release-browser', 'session-close']);
  });
  it('rejects a JSON contract claim before looking up cookies', async () => {
    const f = await fixture(); f.assertObserveContract.mockResolvedValue({ accepted: true } as never);
    await expect(f.host.observe()).rejects.toThrow('science-native-orchestration-unavailable'); expect(traced.events).not.toContain('driver-session'); await f.host.close();
  });
  it('leaves WS denied unless main supplies the contract callback', async () => {
    const f = await fixture(); expect(traced.hostDeps.readWebSocket).toBeUndefined(); expect(traced.events).not.toContain('browser-session'); await f.host.close();
  });
  it('reuses the private browser lease and pins one root subscription without child access', async () => {
    const contract = vi.fn(async (_expected: unknown) => {}), f = await fixture(contract), access = await traced.hostDeps.readWebSocket(f.pageBinding());
    expect(traced.retains).toBe(2); expect(await access.privateSession()).toEqual({ authCookie: 'fake-auth', csrfCookie: 'fake-csrf' });
    expect(contract.mock.calls[0][0]).toMatchObject({ mainJsSha256: 'efede46f82c2c615bfb352c633795e8fe9e86b16406a682046d0f82754cb468d' });
    const filter = await access.createFilter(); expect(await filter.hostSubscribe()).toEqual({ action: 'forward', message: JSON.stringify({ type: 'subscribe', root_frame_id: binding.rootFrameId }) });
    expect(await filter.fromBrowser(JSON.stringify({ type: 'approve', root_frame_id: binding.rootFrameId }))).toMatchObject({ action: 'drop' });
    expect(await filter.fromServer(JSON.stringify({ type: 'text_reset', root_frame_id: binding.rootFrameId, frame_id: '22222222-2222-4222-8222-222222222222' }))).toMatchObject({ action: 'drop', reason: 'frame-unverified' });
    filter.close(); await f.host.close();
  });
  it.each([true, false, { accepted: true }])('refuses non-void WS proof before touching a session (%j)', async claim => {
    const f = await fixture(async () => claim as never), access = await traced.hostDeps.readWebSocket(f.pageBinding());
    await expect(access.privateSession()).rejects.toThrow(); expect(traced.events).not.toContain('browser-session'); await f.host.close();
  });
  it('rechecks scope after WS proof and invalidates old access on auth failure', async () => {
    const contract = vi.fn(async (_expected: unknown) => {}), f = await fixture(contract), access = await traced.hostDeps.readWebSocket(f.pageBinding());
    traced.hostDeps.onReadUnavailable('auth-unavailable'); await expect(access.privateSession()).rejects.toThrow(); expect(traced.events).not.toContain('browser-session');
    const current = await traced.hostDeps.readWebSocket(f.pageBinding()); contract.mockImplementation(async () => { f.revoke(); });
    await expect(current.privateSession()).rejects.toThrow(); expect(traced.events).not.toContain('browser-session'); await f.host.close();
  });
});
