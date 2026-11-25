import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSciencePrivateFile } from "../../science-runtime.js";
import { openScienceRegistry, type SciencePartition, type ScienceRegistry, type ScienceRegistryAction, type ScienceRegistryDriver } from "../science-registry.js";

vi.mock("../../science-runtime.js", async original => {
  const actual = await original<typeof import("../../science-runtime.js")>();
  return { ...actual, writeSciencePrivateFile: vi.fn(actual.writeSciencePrivateFile) };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link), lstat: vi.fn(actual.lstat) };
});

describe("host-only Science registry", () => {
  let root: string;
  let cwd: string;
  let registries: ScienceRegistry[];
  let allowed: boolean;
  let trustedArtifactRoot: string | null;
  const partition = () => ({ ownerKey: "fixture-owner", cwd });
  const binding = { projectId: "fixture-project", taskId: "fixture-task", rootFrameId: "fixture-root", frameId: "fixture-frame" };
  const input = () => ({ projectId: binding.projectId, prompt: "Calculate the sum of 1,2,3.", modelIds: ["ark-sci-deepseek-v4.1-flash"], materials: [{ name: "values.csv", bytes: 8, sha256: "a".repeat(64) }] });
  const authority = { async assert() { if (!allowed) throw new Error("private revoked identity text"); } };
  const driver = (): ScienceRegistryDriver => ({ submit: vi.fn(async () => binding), reconcile: vi.fn(async () => null), observe: vi.fn(async () => ({ ...binding, status: "running" as const })), cancel: vi.fn(async () => ({ ...binding, status: "cancelled" as const })) });
  async function open(remote = driver()) {
    const result = await openScienceRegistry(root, { authority, driver: remote, artifactRootFor: async () => trustedArtifactRoot });
    registries.push(result); return result;
  }
  beforeEach(async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const actualRuntime = await vi.importActual<typeof import("../../science-runtime.js")>("../../science-runtime.js");
    vi.mocked(writeSciencePrivateFile).mockReset().mockImplementation(actualRuntime.writeSciencePrivateFile);
    vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
    vi.mocked(fs.link).mockReset().mockImplementation(actualFs.link);
    vi.mocked(fs.lstat).mockReset().mockImplementation(actualFs.lstat);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "science-registry-private-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "science-registry-project-"));
    await fs.chmod(root, 0o700); allowed = true; registries = []; trustedArtifactRoot = null;
  });
  afterEach(async () => {
    for (const registry of registries) await registry.close();
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true });
  });
  it("holds an OS lock for its lifetime and releases it for a new registry", async () => {
    const registry = await open();
    await expect(open()).rejects.toMatchObject({ code: "registry-busy" });
    await registry.close();
    const reopened = await open(); expect(await reopened.list(partition())).toEqual([]);
  });
  it("refuses a public root and a symlinked root without changing either", async () => {
    await fs.chmod(root, 0o755); await expect(open()).rejects.toMatchObject({ code: "registry-unsafe-root" });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
    await fs.chmod(root, 0o700); const link = path.join(cwd, "private-link"); await fs.symlink(root, link);
    await expect(openScienceRegistry(link, { authority, driver: driver() })).rejects.toMatchObject({ code: "registry-unsafe-root" });
  });
  it("writes input, model scope and sending intent before exactly one upstream submit", async () => {
    const remote = driver();
    vi.mocked(remote.submit).mockImplementation(async request => {
      const stored = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8"));
      const row = stored.instances[0];
      expect(row.phase).toBe("sending"); expect(row.request).toEqual(input());
      expect(row.requestHash).toBe(request.requestHash); expect(row.authorization.materials).toEqual(input().materials);
      expect(row.authorization.modelIds).toEqual(input().modelIds);
      expect((await fs.stat(path.join(root, "registry.json"))).mode & 0o777).toBe(0o600);
      return binding;
    });
    const registry = await open(remote); await registry.bindProject(partition(), binding.projectId);
    const first = await registry.submit(partition(), input()); const second = await registry.submit(partition(), input());
    expect(first.id).toBe(second.id); expect(remote.submit).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("unknown"); expect(first.usage).toBeNull(); expect(first.cost).toBeNull();
  });
  it("never resubmits a lost response, including after host restart", async () => {
    const remote = driver(); vi.mocked(remote.submit).mockRejectedValue(new Error("private token-like failure"));
    let registry = await open(remote); await registry.bindProject(partition(), binding.projectId);
    const first = await registry.submit(partition(), input()); expect(first.status).toBe("unknown");
    await registry.close(); registry = await open(remote);
    const second = await registry.submit(partition(), input());
    expect(first.id).toBe(second.id); expect(remote.submit).toHaveBeenCalledTimes(1);
    await registry.reconcile(partition(), first.id); expect(remote.reconcile).toHaveBeenCalledTimes(1);
    expect(remote.submit).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(root, "registry.json"), "utf8")).not.toContain("token-like");
  });
  it("revalidates authority and canonical cwd for reads and does not restore disk grants", async () => {
    const registry = await open(); await registry.bindProject(partition(), binding.projectId);
    const instance = await registry.bind(partition(), binding);
    expect(await registry.resolveBinding(partition())).toMatchObject({ projectId: binding.projectId });
    allowed = false;
    await expect(registry.list(partition())).rejects.toMatchObject({ code: "registry-access-denied" });
    expect(await registry.accessFor(partition())).toBeNull(); expect(await registry.resolveBinding(partition())).toBeNull();
    allowed = true;
    await expect(registry.detail({ ...partition(), ownerKey: "another-owner" }, instance.id)).rejects.toMatchObject({ code: "registry-not-found" });
    await expect(registry.list({ ...partition(), cwd: `${cwd}/../${path.basename(cwd)}` })).rejects.toMatchObject({ code: "registry-access-denied" });
  });
  it("keeps exact last upstream observation stale while offline and never accepts claims", async () => {
    const remote = driver(); const registry = await open(remote);
    const instance = await registry.bind(partition(), binding);
    vi.mocked(remote.observe).mockResolvedValue({ ...binding, status: "waiting-approval" });
    const observed = await registry.observe(partition(), instance.id);
    expect(observed).toMatchObject({ status: "waiting-approval", stale: false });
    vi.mocked(remote.observe).mockRejectedValue(new Error("offline"));
    const offline = await registry.observe(partition(), instance.id);
    expect(offline).toMatchObject({ status: "waiting-approval", stale: true, lastObservedAt: observed.lastObservedAt });
    expect(offline).not.toHaveProperty("accepted"); expect(remote.cancel).not.toHaveBeenCalled();
  });
  it("separates local tracking stop from confirmed remote cancellation", async () => {
    const remote = driver(); const registry = await open(remote); const instance = await registry.bind(partition(), binding);
    await registry.stopTracking(partition(), instance.id); expect(remote.cancel).not.toHaveBeenCalled();
    const cancelled = await registry.cancel(partition(), instance.id); expect(cancelled.status).toBe("cancelled");
    await registry.cancel(partition(), instance.id); expect(remote.cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects model substitution and caller-provided material claims before upstream IO", async () => {
    const remote = driver(); const registry = await open(remote); await registry.bindProject(partition(), binding.projectId);
    await expect(registry.submit(partition(), { ...input(), modelIds: ["gpt-6.1-sol[1m]"] })).rejects.toMatchObject({ code: "registry-invalid-input" });
    await expect(registry.submit(partition(), { ...input(), materials: [{ name: "../private", bytes: 0, sha256: "a".repeat(64) }] })).rejects.toMatchObject({ code: "registry-invalid-input" });
    expect(remote.submit).not.toHaveBeenCalled();
  });
  it("returns a workspace binding only for one explicit project in that partition", async () => {
    const registry = await open(); expect(await registry.resolveBinding(partition())).toBeNull();
    await registry.bindProject(partition(), binding.projectId);
    const access = await registry.resolveBinding(partition()); expect(access).toMatchObject({ ...partition(), projectId: binding.projectId });
    allowed = false; await expect(access!.revalidate()).rejects.toMatchObject({ code: "registry-access-denied" }); allowed = true;
    await registry.bindProject(partition(), "another-project"); expect(await registry.resolveBinding(partition())).toBeNull();
  });
  it("imports only driver-bound regular artifacts and serves exact verified cached bytes", async () => {
    const data = Buffer.from("value\n1\n2\n3\n"); const sha256 = createHash("sha256").update(data).digest("hex");
    const artifactRoot = path.join(cwd, "only-task-artifacts"); await fs.mkdir(artifactRoot);
    trustedArtifactRoot = artifactRoot;
    await fs.writeFile(path.join(artifactRoot, "values.csv"), data);
    const remote = driver(); remote.artifacts = vi.fn(async () => [{ taskId: binding.taskId, root: artifactRoot, relativePath: "values.csv", name: "values.csv", mediaType: "text/csv" as const, bytes: data.length, sha256 }]);
    const registry = await open(remote); const instance = await registry.bind(partition(), binding);
    const collected = await registry.collectArtifacts(partition(), instance.id);
    expect(collected.artifacts).toHaveLength(1);
    const result = await registry.readArtifact(partition(), instance.id, collected.artifacts[0].id);
    expect(result.bytes).toEqual(data); expect(result.sha256).toBe(sha256);
    expect(await fs.readFile(path.join(artifactRoot, "values.csv"))).toEqual(data);
    const source = await registry.detail(partition(), instance.id); expect(source).not.toHaveProperty("request"); expect(source).not.toHaveProperty("ownerKey");
  });
  it("does not send when the second durable write fails and latches the writer", async () => {
    const remote = driver(); const registry = await open(remote); await registry.bindProject(partition(), binding.projectId);
    const actual = await vi.importActual<typeof import("../../science-runtime.js")>("../../science-runtime.js");
    vi.mocked(writeSciencePrivateFile).mockImplementationOnce(actual.writeSciencePrivateFile).mockRejectedValueOnce(new Error("private disk failure path"));
    await expect(registry.submit(partition(), input())).rejects.toMatchObject({ code: "registry-unavailable" });
    expect(remote.submit).not.toHaveBeenCalled();
    await expect(registry.submit(partition(), input())).rejects.toMatchObject({ code: "registry-writer-lost" });
    await registry.close();
    const reopened = await open(remote); const rows = await reopened.list(partition()); expect(rows).toHaveLength(1);
    await reopened.submit(partition(), input()); expect(remote.submit).not.toHaveBeenCalled();
  });
  it("keeps a cancellation response loss unknown without retrying it after restart", async () => {
    const remote = driver(); vi.mocked(remote.cancel).mockResolvedValue(null);
    let registry = await open(remote); const instance = await registry.bind(partition(), binding);
    const result = await registry.cancel(partition(), instance.id); expect(result.status).toBe("unknown");
    await registry.close(); registry = await open(remote);
    await registry.cancel(partition(), instance.id); expect(remote.cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects a project already bound to another owner/cwd partition", async () => {
    const registry = await open(); await registry.bindProject(partition(), binding.projectId);
    await expect(registry.bind({ ...partition(), ownerKey: "another-owner" }, binding)).rejects.toMatchObject({ code: "registry-not-found" });
    expect(await registry.list({ ...partition(), ownerKey: "another-owner" })).toEqual([]);
  });
  it("snapshots caller scope before asynchronous authority verification", async () => {
    let proceed!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { proceed = resolve; });
    const grant = { assert: vi.fn(async () => {}) };
    const registry = await openScienceRegistry(root, { authority: grant, driver: driver() }); registries.push(registry);
    const instance = await registry.bind(partition(), binding);
    grant.assert.mockImplementationOnce(async () => { entered(); await wait; });
    const mutable = partition(); const pending = registry.detail(mutable, instance.id); await started;
    mutable.ownerKey = "another-owner"; proceed();
    await expect(pending).resolves.toMatchObject({ id: instance.id });
  });
  it.each(["symlink", "hardlink", "escape", "wrong-task", "wrong-sha", "wrong-media", "oversize"])("refuses unsafe artifact %s without importing it", async kind => {
    const data = Buffer.from("value\n1\n"); const source = path.join(cwd, "artifact-source"); await fs.mkdir(source);
    trustedArtifactRoot = source;
    const original = path.join(cwd, "original.csv"); await fs.writeFile(original, data);
    const file = path.join(source, "values.csv");
    if (kind === "symlink") await fs.symlink(original, file);
    else if (kind === "hardlink") await fs.link(original, file);
    else await fs.writeFile(file, data);
    const remote = driver(); remote.artifacts = vi.fn(async () => [{ taskId: kind === "wrong-task" ? "another-task" : binding.taskId, root: source, relativePath: kind === "escape" ? "../original.csv" : "values.csv", name: "values.csv", mediaType: kind === "wrong-media" ? "image/png" as const : "text/csv" as const, bytes: kind === "oversize" ? 1024 * 1024 + 1 : data.length, sha256: kind === "wrong-sha" ? "f".repeat(64) : createHash("sha256").update(data).digest("hex") }]);
    const registry = await open(remote); const instance = await registry.bind(partition(), binding);
    await expect(registry.collectArtifacts(partition(), instance.id)).rejects.toMatchObject({ code: "registry-artifact-refused" });
    expect((await registry.detail(partition(), instance.id)).artifacts).toEqual([]);
    expect(await fs.readFile(original)).toEqual(data);
    expect((await fs.readdir(root)).some(name => name.startsWith("artifact-"))).toBe(false);
  });
  it("rejects an upstream observation for another binding without replacing last known status", async () => {
    const remote = driver(); const registry = await open(remote); const instance = await registry.bind(partition(), binding);
    await registry.observe(partition(), instance.id);
    vi.mocked(remote.observe).mockResolvedValue({ ...binding, taskId: "another-task", status: "completed" });
    expect(await registry.observe(partition(), instance.id)).toMatchObject({ status: "running", stale: true });
  });
  it.each(["submit", "cancel"])("does not release a %s result after the view authority is revoked", async method => {
    const remote = driver(); const registry = await open(remote);
    await registry.bindProject(partition(), binding.projectId);
    const instance = method === "cancel" ? await registry.bind(partition(), binding) : null;
    if (method === "submit") vi.mocked(remote.submit).mockImplementation(async () => { allowed = false; return binding; });
    else vi.mocked(remote.cancel).mockImplementation(async () => { allowed = false; return { ...binding, status: "cancelled" }; });
    await expect(method === "submit" ? registry.submit(partition(), input()) : registry.cancel(partition(), instance!.id)).rejects.toMatchObject({ code: "registry-access-denied" });
  });
  it("refuses an upstream root outside the independently configured task output root", async () => {
    const taskRoot = path.join(cwd, "trusted-only-task-output"); await fs.mkdir(taskRoot);
    const data = Buffer.from("outside this task output root"); await fs.writeFile(path.join(cwd, "other.txt"), data);
    const remote = driver(); remote.artifacts = vi.fn(async () => [{ taskId: binding.taskId, root: cwd, relativePath: "other.txt", name: "other.txt", mediaType: "text/plain" as const, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }]);
    const configured = { authority, driver: remote, artifactRootFor: async () => taskRoot };
    const registry = await openScienceRegistry(root, configured); registries.push(registry);
    const instance = await registry.bind(partition(), binding);
    await expect(registry.collectArtifacts(partition(), instance.id)).rejects.toMatchObject({ code: "registry-artifact-refused" });
    expect((await registry.detail(partition(), instance.id)).artifacts).toEqual([]);
  });
  it("never overwrites an immutable cache target inserted at the publication syscall", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const existing = "existing private data must survive";
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => { await actualFs.writeFile(to, existing, { mode: 0o600 }); await actualFs.rename(from, to); });
    vi.mocked(fs.link).mockImplementationOnce(async (from, to) => { await actualFs.writeFile(to, existing, { mode: 0o600 }); await actualFs.link(from, to); });
    await expect(writeSciencePrivateFile(root, "immutable.bin", "new cache bytes", { expectAbsent: true })).rejects.toMatchObject({ code: "science-write-unsafe-target", published: false });
    expect(await fs.readFile(path.join(root, "immutable.bin"), "utf8")).toBe(existing);
    expect(await fs.readdir(root)).toEqual(["immutable.bin"]);
  });
  it.each(["submit", "cancel"])("does not send %s after authority expires during the final writer check", async method => {
    const remote = driver(); const registry = await open(remote); await registry.bindProject(partition(), binding.projectId);
    const instance = method === "cancel" ? await registry.bind(partition(), binding) : null;
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const actualRuntime = await vi.importActual<typeof import("../../science-runtime.js")>("../../science-runtime.js");
    let mutationDurable = false;
    vi.mocked(writeSciencePrivateFile).mockImplementation(async (...args) => {
      await actualRuntime.writeSciencePrivateFile(...args);
      if (args[1] === "registry.json") {
        const value = JSON.parse(String(args[2]));
        mutationDurable = value.instances.some((row: { phase: string; cancelState: string }) => method === "submit" ? row.phase === "sending" : row.cancelState === "requesting");
      }
    });
    vi.mocked(fs.lstat).mockImplementation(async (...args) => { if (mutationDurable && args[0] === root) allowed = false; return actualFs.lstat(...args); });
    await expect(method === "submit" ? registry.submit(partition(), input()) : registry.cancel(partition(), instance!.id)).rejects.toMatchObject({ code: "registry-access-denied" });
    expect(method === "submit" ? remote.submit : remote.cancel).not.toHaveBeenCalled();
    vi.mocked(writeSciencePrivateFile).mockImplementation(actualRuntime.writeSciencePrivateFile);
  });
  it("publishes a new immutable cache entry with no replace operation and a single final link", async () => {
    await writeSciencePrivateFile(root, "immutable.bin", "cache bytes", { expectAbsent: true });
    expect(await fs.readFile(path.join(root, "immutable.bin"), "utf8")).toBe("cache bytes");
    expect((await fs.stat(path.join(root, "immutable.bin"))).nlink).toBe(1);
    expect((await fs.stat(path.join(root, "immutable.bin"))).mode & 0o777).toBe(0o600);
    expect(fs.link).toHaveBeenCalledTimes(1); expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual(["immutable.bin"]);
  });
  it("keeps an existing immutable entry unchanged and snapshots the caller option", async () => {
    await fs.writeFile(path.join(root, "immutable.bin"), "existing", { mode: 0o600 });
    const options = { expectAbsent: true };
    const result = writeSciencePrivateFile(root, "immutable.bin", "replacement", options); options.expectAbsent = false;
    await expect(result).rejects.toMatchObject({ code: "science-write-unsafe-target", published: false });
    expect(await fs.readFile(path.join(root, "immutable.bin"), "utf8")).toBe("existing");
    expect(fs.rename).not.toHaveBeenCalled();
  });
  it("reports an uncertain link result without retrying or overwriting its possible publication", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.link).mockImplementationOnce(async (...args) => { await actualFs.link(...args); throw new Error("synthetic private link error"); });
    await expect(writeSciencePrivateFile(root, "immutable.bin", "possible publication", { expectAbsent: true })).rejects.toMatchObject({ code: "science-write-unconfirmed", published: "unknown" });
    expect(await fs.readFile(path.join(root, "immutable.bin"), "utf8")).toBe("possible publication");
    await expect(writeSciencePrivateFile(root, "immutable.bin", "replacement", { expectAbsent: true })).rejects.toMatchObject({ code: "science-write-unsafe-target" });
    expect(fs.link).toHaveBeenCalledTimes(1);
  });
  it("refuses collection when no independent task-root resolver is configured", async () => {
    const remote = driver(); remote.artifacts = vi.fn(async () => []);
    const registry = await openScienceRegistry(root, { authority, driver: remote }); registries.push(registry);
    const instance = await registry.bind(partition(), binding);
    await expect(registry.collectArtifacts(partition(), instance.id)).rejects.toMatchObject({ code: "registry-artifact-refused" });
    expect(remote.artifacts).not.toHaveBeenCalled();
  });
  it("resolves each opaque task to its own immutable native binding and revalidates live scope", async () => {
    const registry = await open(); const mutable = { ...binding };
    const first = await registry.bind(partition(), mutable);
    const secondBinding = { ...binding, taskId: "second-task", rootFrameId: "second-root", frameId: "second-frame" };
    const second = await registry.bind(partition(), secondBinding);
    mutable.frameId = "caller-mutated-frame";
    const resolved = await registry.resolveBinding(partition(), first.id);
    expect(resolved).toMatchObject({ ...partition(), projectId: binding.projectId, instanceId: first.id, binding });
    expect(resolved && "binding" in resolved && Object.isFrozen(resolved.binding)).toBe(true);
    expect(await registry.resolveBinding(partition(), second.id)).toMatchObject({ instanceId: second.id, binding: secondBinding });
    await resolved!.revalidate();
    expect(await registry.resolveBinding({ ...partition(), ownerKey: "another-owner" }, first.id)).toBeNull();
    allowed = false; await expect(resolved!.revalidate()).rejects.toMatchObject({ code: "registry-access-denied" });
  });
  it("keeps unbound or invalid task handles unavailable while preserving the unique workspace binding", async () => {
    const remote = driver(); vi.mocked(remote.submit).mockRejectedValue(new Error("synthetic lost response"));
    const registry = await open(remote); await registry.bindProject(partition(), binding.projectId);
    const pending = await registry.submit(partition(), input());
    expect(await registry.resolveBinding(partition(), pending.id)).toBeNull();
    expect(await registry.resolveBinding(partition(), "")).toBeNull();
    const workspace = await registry.resolveBinding(partition());
    expect(workspace).toMatchObject({ ...partition(), projectId: binding.projectId });
    expect(workspace).not.toHaveProperty("binding"); expect(workspace).not.toHaveProperty("instanceId");
  });
  it("imports an existing task only with exact fresh partition and four-ID proof, without a submission", async () => {
    let freshProof = true;
    const proven = { async assert(scope: SciencePartition, action: ScienceRegistryAction) {
      if (!freshProof || scope.ownerKey !== partition().ownerKey || scope.cwd !== partition().cwd) throw new Error("synthetic source proof unavailable");
      if (action.kind !== "view") expect(action).toEqual({ kind: "bind", projectId: binding.projectId, binding });
    } };
    const remote = driver(); vi.mocked(remote.observe).mockResolvedValue({ ...binding, status: "waiting-approval" });
    let registry = await openScienceRegistry(root, { authority: proven, driver: remote }); registries.push(registry);
    const beforeImport = Date.now(); const imported = await registry.bind(partition(), binding); const afterImport = Date.now();
    expect(imported.createdAt).toBeGreaterThanOrEqual(beforeImport); expect(imported.createdAt).toBeLessThanOrEqual(afterImport);
    const privateRow = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8")).instances[0];
    expect(privateRow).toMatchObject({ binding, request: null, requestHash: null, authorization: null, phase: "bound" });
    expect(await registry.observe(partition(), imported.id)).toMatchObject({ id: imported.id, status: "waiting-approval" });
    const duplicate = await registry.bind(partition(), binding); expect(duplicate.id).toBe(imported.id); expect(duplicate.createdAt).toBe(imported.createdAt);
    await expect(registry.bind(partition(), { ...binding, rootFrameId: "unproven-root" })).rejects.toMatchObject({ code: "registry-access-denied" });
    await expect(registry.bind({ ...partition(), ownerKey: "another-owner" }, binding)).rejects.toMatchObject({ code: "registry-access-denied" });
    freshProof = false; await expect(registry.bind(partition(), binding)).rejects.toMatchObject({ code: "registry-access-denied" }); freshProof = true;
    await registry.close(); registry = await openScienceRegistry(root, { authority: proven, driver: remote }); registries.push(registry);
    expect((await registry.bind(partition(), binding)).id).toBe(imported.id);
    const recovered = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8"));
    expect(recovered.instances).toHaveLength(1); expect(recovered.instances[0].intentId).toBe(privateRow.intentId);
    expect(remote.submit).not.toHaveBeenCalled(); expect(remote.reconcile).not.toHaveBeenCalled(); expect(remote.cancel).not.toHaveBeenCalled();
  });
  it("requires view access before import and after a duplicate binding proof", async () => {
    let canView = false; let revokeOnBind = false;
    const grant = { async assert(_scope: SciencePartition, action: ScienceRegistryAction) {
      if (action.kind === "view" && !canView) throw new Error("synthetic revoked view");
      if (action.kind === "bind" && revokeOnBind) canView = false;
    } };
    const remote = driver(); const registry = await openScienceRegistry(root, { authority: grant, driver: remote }); registries.push(registry);
    await expect(registry.bind(partition(), binding)).rejects.toMatchObject({ code: "registry-access-denied" });
    expect(await fs.readdir(root)).toEqual(["writer.lock"]);
    canView = true; const imported = await registry.bind(partition(), binding);
    revokeOnBind = true;
    await expect(registry.bind(partition(), binding)).rejects.toMatchObject({ code: "registry-access-denied" });
    canView = true; expect((await registry.list(partition())).map(row => row.id)).toEqual([imported.id]);
    expect(remote.submit).not.toHaveBeenCalled(); expect(remote.observe).not.toHaveBeenCalled(); expect(remote.reconcile).not.toHaveBeenCalled(); expect(remote.cancel).not.toHaveBeenCalled();
  });
});
