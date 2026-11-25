import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScienceArtifactSource, ScienceRegistry, ScienceRegistryDeps } from "@blackbelt-technology/pi-dashboard-server/science-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceReadonlyHost, type ScienceReadonlyHostDeps } from "../../../../claude-science/host/science-host-composition.js";

const traced = vi.hoisted(() => ({ deps: undefined as ScienceRegistryDeps | undefined, registry: undefined as ScienceRegistry | undefined, daemon: undefined as any, opens: 0, beforeImport: undefined as ((deps: ScienceRegistryDeps) => Promise<void>) | undefined }));
vi.mock("@blackbelt-technology/pi-dashboard-server/science-registry", async original => {
  const actual = await original<typeof import("@blackbelt-technology/pi-dashboard-server/science-registry")>();
  return { ...actual, openScienceRegistry: async (...args: Parameters<typeof actual.openScienceRegistry>) => { traced.opens++; traced.deps = args[1]; traced.registry = await actual.openScienceRegistry(...args); await traced.beforeImport?.(args[1]); return traced.registry; } };
});
vi.mock("@blackbelt-technology/pi-dashboard-server/science-host-daemon", () => ({ createScienceHostDaemon: (deps: unknown) => { traced.daemon = deps; return { start: async () => {}, close: async () => {} }; } }));
vi.mock("@blackbelt-technology/pi-dashboard-browser-plugin/science-host", () => ({ createScienceBrowserHost: () => ({ close: async () => {} }) }));

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => { traced.deps = undefined; traced.registry = undefined; traced.daemon = undefined; traced.opens = 0; traced.beforeImport = undefined; });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(provider = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "science-collect-seam-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), registryRoot = path.join(root, "records"), outputRoot = path.join(root, "output");
  for (const dir of [cwd, registryRoot, outputRoot]) await fs.mkdir(dir, { mode: 0o700 });
  const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd }, binding = { projectId: "proj_fixture", taskId: "frame_fixture", rootFrameId: "frame_fixture", frameId: "frame_fixture" };
  const bytes = Buffer.from("row,value\none,1\ntwo,2\nthree,3\n");
  await fs.writeFile(path.join(outputRoot, "synthetic-values.csv"), bytes, { mode: 0o600 });
  const source: ScienceArtifactSource = { root: outputRoot, relativePath: "synthetic-values.csv", name: "synthetic-values.csv", mediaType: "text/csv", taskId: binding.taskId, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  let allowed = true, grantValue: unknown;
  const revalidate = vi.fn(async () => { if (!allowed) throw new Error("private-scope-detail"); return grantValue as void; });
  const rootFor = vi.fn(async () => outputRoot), sourcesFor = vi.fn(async () => [source]);
  const artifactProvider = { rootFor, sourcesFor };
  const assertViewRuntime = vi.fn(async () => { throw new Error("native offline"); });
  const deps: ScienceReadonlyHostDeps = { registryRoot, chromePrivateDir: path.join(root, "chrome"), transportPrivateDir: path.join(root, "ipc"), scope: { partition, binding, revalidate }, observeBinding: async selected => ({ ...selected, status: "completed" }), resolvePage: async () => null, prepareSession: async () => false, chrome: { resolveBinary: () => "/fixture/chrome" }, assertViewRuntime, ...(provider ? { artifactProvider } : {}) };
  const host = await createScienceReadonlyHost(deps); cleanups.push(() => host.close());
  return { host, deps, partition, binding, bytes, source, outputRoot, rootFor, sourcesFor, artifactProvider, revalidate, assertViewRuntime, revoke: () => { allowed = false; }, grant: (value: unknown) => { grantValue = value; } };
}

describe("host-only artifact collection seam", () => {
  it("collects through the existing verified cache and keeps cached metadata/bytes available offline", async () => {
    const f = await fixture();
    const result = await f.host.collectArtifacts();
    expect(result.id).toBe(f.host.instanceId); expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ name: f.source.name, sha256: f.source.sha256, bytes: f.bytes.length, mediaType: "text/csv" });
    expect(f.rootFor).toHaveBeenCalledWith(f.partition, f.binding); expect(f.sourcesFor).toHaveBeenCalledWith(f.binding);
    const read = await traced.daemon.instancesHost.readArtifact(f.partition, f.host.instanceId, result.artifacts[0].id);
    expect(read.availability).toBe("ready"); expect(Buffer.from(read.content)).toEqual(f.bytes);
    expect(f.assertViewRuntime).not.toHaveBeenCalled();
    expect(traced.daemon).not.toHaveProperty("collectArtifacts");
    expect(Object.keys(traced.daemon.instancesHost).sort()).toEqual(["detail", "list", "readArtifact"]);
  });
  it("keeps collection refused without a code provider and exposes no driver/root callback", async () => {
    const f = await fixture(false);
    await expect(f.host.collectArtifacts()).rejects.toThrow("science-host-composition-unavailable");
    expect(traced.deps!.driver.artifacts).toBeUndefined(); expect(traced.deps!.artifactRootFor).toBeUndefined();
    await expect(traced.deps!.authority.assert(f.partition, { kind: "collect-artifacts", instanceId: f.host.instanceId, binding: f.binding })).rejects.toThrow();
    expect(f.rootFor).not.toHaveBeenCalled(); expect(f.sourcesFor).not.toHaveBeenCalled();
  });
  it("rejects foreign owner/cwd/instance/binding before touching provider functions", async () => {
    const f = await fixture(), deps = traced.deps!;
    const action = { kind: "collect-artifacts" as const, instanceId: f.host.instanceId, binding: f.binding };
    for (const partition of [{ ...f.partition, ownerKey: "foreign" }, { ...f.partition, cwd: "/foreign" }]) await expect(deps.authority.assert(partition, action)).rejects.toThrow();
    await expect(deps.authority.assert(f.partition, { ...action, instanceId: "si-foreign" })).rejects.toThrow();
    await expect(deps.authority.assert(f.partition, { ...action, binding: { ...f.binding, frameId: "foreign" } })).rejects.toThrow();
    await expect(deps.artifactRootFor!(f.partition, { ...f.binding, taskId: "foreign" })).rejects.toThrow();
    await expect(deps.driver.artifacts!({ ...f.binding, projectId: "foreign" })).rejects.toThrow();
    expect(f.rootFor).not.toHaveBeenCalled(); expect(f.sourcesFor).not.toHaveBeenCalled();
  });
  it("does not authorize submit/cancel/reconcile when artifact collection is configured", async () => {
    const f = await fixture(), deps = traced.deps!;
    await expect(deps.driver.submit({} as never)).rejects.toThrow(); await expect(deps.driver.cancel(f.binding)).rejects.toThrow(); await expect(deps.driver.reconcile({} as never)).rejects.toThrow();
    await expect(deps.authority.assert(f.partition, { kind: "bind", projectId: f.binding.projectId })).rejects.toThrow();
    expect(f.rootFor).not.toHaveBeenCalled();
  });
  it("refuses collection callbacks until the exact instance has actually been imported", async () => {
    traced.beforeImport = async deps => { await expect(deps.driver.artifacts!({ projectId: "proj_fixture", taskId: "frame_fixture", rootFrameId: "frame_fixture", frameId: "frame_fixture" })).rejects.toThrow(); };
    const f = await fixture(); expect(f.sourcesFor).not.toHaveBeenCalled();
    expect((await f.host.collectArtifacts()).artifacts).toHaveLength(1);
  });
  it("rejects serialized provider flags before opening another writer", async () => {
    const f = await fixture(false), before = traced.opens;
    await expect(createScienceReadonlyHost({ ...f.deps, artifactProvider: { allowed: true, rootFor: "/fixture", sourcesFor: [] } } as never)).rejects.toThrow("science-host-composition-unavailable");
    expect(traced.opens).toBe(before);
  });
  it("refuses a revoked or non-void scope before starting collection", async () => {
    const f = await fixture(); f.grant(true);
    await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(f.rootFor).not.toHaveBeenCalled();
    f.grant(undefined); f.revoke(); await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(f.rootFor).not.toHaveBeenCalled();
  });
  it("discards a root resolver result after scope revocation without reading sources", async () => {
    const f = await fixture(); f.rootFor.mockImplementation(async () => { f.revoke(); return f.outputRoot; });
    await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(f.rootFor).toHaveBeenCalledTimes(1); expect(f.sourcesFor).not.toHaveBeenCalled();
    expect((await fs.readdir(f.deps.registryRoot)).filter(name => name.startsWith("artifact-"))).toEqual([]);
  });
  it("discards sources after revocation without writing an artifact cache", async () => {
    const f = await fixture(); f.sourcesFor.mockImplementation(async () => { f.revoke(); return [f.source]; });
    await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(f.sourcesFor).toHaveBeenCalledTimes(1);
    expect((await fs.readdir(f.deps.registryRoot)).filter(name => name.startsWith("artifact-"))).toEqual([]);
  });
  it("rejects collection after close and a late provider result during close", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(done => { entered = done; });
    const wait = new Promise<void>(done => { release = done; });
    f.rootFor.mockImplementation(async () => { entered(); await wait; return f.outputRoot; });
    const pending = f.host.collectArtifacts(); await ready; const closing = f.host.close(); release();
    await expect(pending).rejects.toThrow(); await closing; await expect(f.host.collectArtifacts()).rejects.toThrow(); expect(f.sourcesFor).not.toHaveBeenCalled();
    expect((await fs.readdir(f.deps.registryRoot)).filter(name => name.startsWith("artifact-"))).toEqual([]);
  });
  it("captures the code provider functions instead of rereading mutable dependency slots", async () => {
    const f = await fixture();
    f.deps.artifactProvider = { rootFor: async () => "/foreign", sourcesFor: async () => [] };
    f.artifactProvider.rootFor = vi.fn(async () => "/foreign"); f.artifactProvider.sourcesFor = vi.fn(async () => []);
    const result = await f.host.collectArtifacts(); expect(result.artifacts).toHaveLength(1); expect(f.rootFor).toHaveBeenCalledTimes(1); expect(f.sourcesFor).toHaveBeenCalledTimes(1);
  });
  it("reuses the existing registry SHA refusal without adding alternate copying", async () => {
    const f = await fixture(); f.sourcesFor.mockResolvedValue([{ ...f.source, sha256: "0".repeat(64) }]);
    await expect(f.host.collectArtifacts()).rejects.toThrow();
    expect((await fs.readdir(f.deps.registryRoot)).filter(name => name.startsWith("artifact-"))).toEqual([]);
  });
});
