import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openScienceRegistry, type ScienceNativeDriverDeps, type ScienceRegistryDriver } from "@blackbelt-technology/pi-dashboard-server/science-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceNativeReadonlyHost, type ScienceNativePageAdapters } from "../../../../claude-science/host/science-native-orchestration.js";
import { createScienceHostClient } from "../res-workflow/science-host-client.js";

const traced = vi.hoisted(() => ({ browser: undefined as any, nativeReads: 0, privateSessions: 0 }));
vi.mock("@blackbelt-technology/pi-dashboard-server/science-registry", async importOriginal => {
  const actual = await importOriginal<typeof import("@blackbelt-technology/pi-dashboard-server/science-registry")>();
  return { ...actual,
    createScienceNativeSessionProvider: () => ({ retain: () => ({ privateSession: async () => { traced.privateSessions++; return { authCookie: "fake-auth", csrfCookie: "fake-csrf" }; }, getPrivateSession: async () => { throw new Error("not-used"); }, release() {} }), invalidate() {}, close() {} }),
    createScienceNativeRegistryDriver: (deps: ScienceNativeDriverDeps): ScienceRegistryDriver => ({
      submit: async () => { throw new Error("not-used"); }, reconcile: async () => { throw new Error("not-used"); }, cancel: async () => { throw new Error("not-used"); },
      async observe(binding) { await deps.runtime.assertCapability("observe", { projectId: binding.projectId, binding }); await deps.privateSession(); traced.nativeReads++; return { ...binding, status: "running" }; },
    }),
  };
});
vi.mock("@blackbelt-technology/pi-dashboard-browser-plugin/science-host", () => ({ createScienceBrowserHost: (deps: unknown) => {
  traced.browser = deps; return { openWorkspace: async () => ({ availability: "unavailable", reason: "view-unavailable" }), close: async () => {} };
} }));

const binding = { projectId: "proj_111111111111", taskId: "11111111-1111-4111-8111-111111111111", rootFrameId: "11111111-1111-4111-8111-111111111111", frameId: "11111111-1111-4111-8111-111111111111" };
const cleanups: Array<() => Promise<unknown> | void> = [];
beforeEach(() => { traced.browser = undefined; traced.nativeReads = 0; traced.privateSessions = 0; });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(onlineInitially: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "science-native-offline-")); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const registryRoot = path.join(root, "registry"), chromePrivateDir = path.join(root, "chrome"), transportPrivateDir = path.join(root, "ipc"), cwd = path.join(root, "workspace"), output = path.join(root, "synthetic-output");
  for (const dir of [registryRoot, chromePrivateDir, transportPrivateDir, cwd, output]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(transportPrivateDir, "viewer.secret"), randomBytes(32), { mode: 0o600 });
  const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd };
  const bytes = Buffer.from("synthetic cached result\n"), sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(output, "fixture.txt"), bytes, { mode: 0o600 });
  const seed = await openScienceRegistry(registryRoot, { authority: { assert: async () => {} }, artifactRootFor: async () => output, driver: {
    submit: async () => { throw new Error("not-used"); }, reconcile: async () => null, cancel: async () => null,
    observe: async selected => ({ ...selected, status: "completed" }),
    artifacts: async () => [{ taskId: binding.taskId, root: output, relativePath: "fixture.txt", name: "fixture.txt", mediaType: "text/plain", bytes: bytes.length, sha256 }],
  } });
  let artifactId: string;
  try { const item = await seed.bind(partition, binding); await seed.observe(partition, item.id); await seed.collectArtifacts(partition, item.id); artifactId = (await seed.detail(partition, item.id)).artifacts[0].id; }
  finally { await seed.close(); }
  let online = onlineInitially, allowed = true;
  const revalidate = async () => { if (!allowed) throw new Error("scope-revoked"); };
  const nativePage: ScienceNativePageAdapters = { loadPinnedAssets: () => new Map(), observeNativeProject: async () => { throw new Error("not-used"); }, createNativePageResolver: () => async () => null, createPrivateSessionPreparer: () => async () => false };
  const host = await createScienceNativeReadonlyHost({ registryRoot, chromePrivateDir, transportPrivateDir, scope: { partition, binding, revalidate }, assertCurrentRuntime: async () => { if (!online) throw new Error("native-offline"); }, assertObserveContract: async () => {}, expectedVisibleProjectName: "synthetic-offline-cache", nativePage, chrome: { resolveBinary: () => "/fixture/chrome" } });
  cleanups.push(() => host.close()); const client = createScienceHostClient({ privateDir: transportPrivateDir }); cleanups.push(() => client.dispose());
  return { host, client, partition, artifactId, bytes: new Uint8Array(bytes), offline: () => { online = false; }, revoke: () => { allowed = false; } };
}

describe("authorized native offline cache", () => {
  it("starts IPC offline and reads the same persisted record/artifact without native or session IO", async () => {
    const f = await fixture(false);
    const observed = await f.host.observe(); expect(observed.stale).toBe(true); expect(observed.status).toBe("completed");
    const list = await f.client.list(f.partition); expect(list.availability).toBe("ready");
    if (list.availability === "ready") expect(list.instances).toEqual([expect.objectContaining({ id: f.host.instanceId, stale: true, status: "completed" })]);
    const detail = await f.client.detail(f.partition, f.host.instanceId); expect(detail.availability).toBe("ready");
    if (detail.availability === "ready") expect(detail.instance.stale).toBe(true);
    const artifact = await f.client.readArtifact(f.partition, f.host.instanceId, f.artifactId); expect(artifact.availability).toBe("ready");
    if (artifact.availability === "ready") expect(artifact.content).toEqual(f.bytes);
    expect(traced.nativeReads).toBe(0); expect(traced.privateSessions).toBe(0);
  });
  it("lets registry.observe persist offline/stale while keeping cached metadata readable", async () => {
    const f = await fixture(true); expect((await f.host.observe()).stale).toBe(false); expect(traced.nativeReads).toBe(1); f.offline();
    const observed = await f.host.observe(); expect(observed.stale).toBe(true); expect(observed.status).toBe("running");
    const detail = await f.client.detail(f.partition, f.host.instanceId); expect(detail.availability).toBe("ready");
    if (detail.availability === "ready") expect(detail.instance).toMatchObject({ status: "running", stale: true });
    const view = await traced.browser.resolveBinding(f.partition, f.host.instanceId); expect(view).not.toBeNull(); await expect(view.revalidate()).rejects.toThrow();
    expect(traced.nativeReads).toBe(1); expect(traced.privateSessions).toBe(1);
  });
  it("still rejects cached records and bytes immediately when host scope is revoked", async () => {
    const f = await fixture(true); f.offline(); f.revoke();
    expect(await f.client.list(f.partition)).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(await f.client.readArtifact(f.partition, f.host.instanceId, f.artifactId)).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    await expect(f.host.observe()).rejects.toThrow(); expect(traced.nativeReads).toBe(0);
  });
});
