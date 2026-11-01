import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScienceNativeReadonlyHostDeps } from "../../../../claude-science/host/science-native-orchestration.js";
import { createScienceNativeReadonlyHost } from "../../../../claude-science/host/science-native-orchestration.js";

const trace = vi.hoisted(() => ({ deps: undefined as any, collectCalls: 0, closes: 0 }));
vi.mock("@blackbelt-technology/pi-dashboard-server/science-registry", async original => {
  const actual = await original<typeof import("@blackbelt-technology/pi-dashboard-server/science-registry")>();
  return { ...actual, createScienceNativeSessionProvider: () => ({ retain: () => ({ privateSession: async () => ({ authCookie: "fake", csrfCookie: "fake" }), release() {} }), invalidate() {}, close() {} }), createScienceNativeRegistryDriver: () => ({ observe: async (binding: unknown) => ({ ...(binding as object), status: "completed" }) }) };
});
vi.mock("../../../../claude-science/host/science-host-composition.js", () => ({ createScienceReadonlyHost: async (deps: any) => {
  trace.deps = deps;
  return { instanceId: "si-11111111-1111-4111-8111-111111111111", observe: async () => ({}), async collectArtifacts() {
    trace.collectCalls++;
    if (!deps.artifactProvider) throw new Error("unconfigured");
    await deps.artifactProvider.rootFor(deps.scope.partition, deps.scope.binding);
    await deps.artifactProvider.sourcesFor(deps.scope.binding);
    return { id: "si-11111111-1111-4111-8111-111111111111", status: "unknown", stale: true, artifacts: [] };
  }, close: async () => { trace.closes++; } };
} }));
beforeEach(() => { trace.deps = undefined; trace.collectCalls = 0; trace.closes = 0; });
async function fixture(provider = true) {
  let allowed = true, grant: unknown;
  const binding = { projectId: "proj_111111111111", taskId: "11111111-1111-4111-8111-111111111111", rootFrameId: "11111111-1111-4111-8111-111111111111", frameId: "11111111-1111-4111-8111-111111111111" };
  const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: "/fixture" };
  const rootFor = vi.fn(async () => "/fixture/output"), sourcesFor = vi.fn(async () => []), artifactProvider = { rootFor, sourcesFor };
  const runtime = vi.fn(async () => { throw new Error("native offline"); });
  const deps: ScienceNativeReadonlyHostDeps = { registryRoot: "/fixture/registry", chromePrivateDir: "/fixture/chrome", transportPrivateDir: "/fixture/ipc", scope: { partition, binding, revalidate: async () => { if (!allowed) throw new Error("revoked"); return grant as void; } }, assertCurrentRuntime: runtime, assertObserveContract: async () => {}, expectedVisibleProjectName: "synthetic-p0-fixture", nativePage: { loadPinnedAssets: () => ({}), createNativePageResolver: () => async () => null, createPrivateSessionPreparer: () => async () => false, observeNativeProject: async () => ({ observation: null }) }, chrome: { resolveBinary: () => "/fixture/chrome" }, ...(provider ? { artifactProvider } : {}) };
  const host = await createScienceNativeReadonlyHost(deps);
  return { host, deps, rootFor, sourcesFor, artifactProvider, runtime, revoke: () => { allowed = false; }, grant: (value: unknown) => { grant = value; } };
}
describe("native host-only collection propagation", () => {
  it("delegates the local provider and collection without native/session liveness", async () => {
    const f = await fixture();
    try { expect((await f.host.collectArtifacts()).stale).toBe(true); expect(f.rootFor).toHaveBeenCalledWith(f.deps.scope.partition, f.deps.scope.binding); expect(f.sourcesFor).toHaveBeenCalledTimes(1); expect(f.runtime).not.toHaveBeenCalled(); expect(trace.collectCalls).toBe(1); }
    finally { await f.host.close(); }
  });
  it("captures original provider code functions before asynchronous startup", async () => {
    const f = await fixture();
    try { f.artifactProvider.rootFor = vi.fn(async () => "/foreign"); f.artifactProvider.sourcesFor = vi.fn(async () => []); f.deps.artifactProvider = undefined; await f.host.collectArtifacts(); expect(f.rootFor).toHaveBeenCalledTimes(1); expect(f.sourcesFor).toHaveBeenCalledTimes(1); }
    finally { await f.host.close(); }
  });
  it("refuses revoked/non-void scope and closed hosts before delegating collection", async () => {
    const f = await fixture(); f.grant(true);
    await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(trace.collectCalls).toBe(0);
    f.grant(undefined); f.revoke(); await expect(f.host.collectArtifacts()).rejects.toThrow(); await f.host.close();
    await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(f.rootFor).not.toHaveBeenCalled(); expect(f.runtime).not.toHaveBeenCalled();
  });
  it("rejects an otherwise successful collection when scope expires during provider IO", async () => {
    const f = await fixture(); f.sourcesFor.mockImplementation(async () => { f.revoke(); return []; });
    try { await expect(f.host.collectArtifacts()).rejects.toThrow("science-native-orchestration-unavailable"); expect(trace.collectCalls).toBe(1); expect(f.runtime).not.toHaveBeenCalled(); }
    finally { await f.host.close(); }
  });
  it("keeps missing-provider refusal and sanitizes it without native IO", async () => {
    const f = await fixture(false);
    try { await expect(f.host.collectArtifacts()).rejects.toThrow("science-native-orchestration-unavailable"); expect(trace.deps.artifactProvider).toBeUndefined(); expect(f.rootFor).not.toHaveBeenCalled(); expect(f.runtime).not.toHaveBeenCalled(); }
    finally { await f.host.close(); }
  });
});
