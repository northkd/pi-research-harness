import { createHash } from "node:crypto";
import { SCIENCE_RECORD_LIMITS } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { describe, expect, it, vi } from "vitest";
import { createScienceInstancesHost } from "../../science-registry.js";
import type { ScienceRegistryReads } from "../science-instances-host.js";

const partition = { ownerKey: "fixture-owner", cwd: "/fixture/project" };
const taskId = "si-00000000-0000-4000-8000-000000000001";
const artifactId = "sa-00000000-0000-4000-8000-000000000002";
const otherId = "si-00000000-0000-4000-8000-000000000003";
const content = Buffer.from("value\n1\n");
const artifact = { id: artifactId, name: "result.csv", mediaType: "text/csv" as const, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
const summary = { id: taskId, status: "completed" as const, createdAt: 1000, lastObservedAt: 2000, stale: true };
const instance = { ...summary, modelIds: ["gpt-6.1-sol(max)"], usage: null, cost: null, artifacts: [artifact] };
const unavailable = { availability: "unavailable", reason: "binding-unavailable" };
const invalid = { availability: "unknown", reason: "invalid-host-response" };
function fixture() {
  const bytes = Buffer.from(content);
  const registry = {
    list: vi.fn<ScienceRegistryReads["list"]>().mockResolvedValue([{ ...summary, ownerKey: "private-owner", cwd: "/private/root" } as typeof summary]),
    detail: vi.fn<ScienceRegistryReads["detail"]>().mockResolvedValue({ ...instance, prompt: "private prompt", url: "http://private/?nonce=secret" } as typeof instance),
    readArtifact: vi.fn<ScienceRegistryReads["readArtifact"]>().mockResolvedValue({ bytes, name: artifact.name, mediaType: artifact.mediaType, sha256: artifact.sha256 }),
  };
  return { registry, bytes, host: createScienceInstancesHost(registry) };
}

describe("read-only registry to Science instances host adapter", () => {
  it("starts no registry work at construction and exposes only the three reads", () => {
    const f = fixture();
    expect(Object.keys(f.host).sort()).toEqual(["detail", "list", "readArtifact"]);
    expect(f.registry.list).not.toHaveBeenCalled(); expect(f.registry.detail).not.toHaveBeenCalled(); expect(f.registry.readArtifact).not.toHaveBeenCalled();
  });
  it("projects records without prompts, paths or authority and preserves truthful observations", async () => {
    const f = fixture();
    expect(await f.host.list(partition)).toEqual({ availability: "ready", instances: [summary] });
    expect(await f.host.detail(partition, taskId)).toEqual({ availability: "ready", instance });
    expect(f.registry.list).toHaveBeenCalledWith(partition); expect(f.registry.detail).toHaveBeenCalledWith(partition, taskId);
  });
  it.each(["bad-task", "bad-artifact"])("refuses %s before invoking the registry", async kind => {
    const f = fixture();
    expect(await f.host.readArtifact(partition, kind === "bad-task" ? "../secret" : taskId, kind === "bad-artifact" ? "../secret" : artifactId)).toEqual(unavailable);
    if (kind === "bad-task") expect(await f.host.detail(partition, "../secret")).toEqual(unavailable);
    expect(f.registry.detail).not.toHaveBeenCalled(); expect(f.registry.readArtifact).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "oversize", "malformed"])("refuses a %s record list", async kind => {
    const f = fixture();
    const rows = kind === "duplicate" ? [summary, summary] : kind === "oversize" ? Array(SCIENCE_RECORD_LIMITS.instances + 1).fill(summary) : [{ ...summary, lastObservedAt: "invented" }];
    f.registry.list.mockResolvedValue(rows);
    expect(await f.host.list(partition)).toEqual(invalid);
  });
  it("refuses mismatched task metadata and never reads its artifact", async () => {
    const f = fixture(); f.registry.detail.mockResolvedValue({ ...instance, id: otherId });
    expect(await f.host.detail(partition, taskId)).toEqual(invalid);
    expect(await f.host.readArtifact(partition, taskId, artifactId)).toEqual(invalid);
    expect(f.registry.readArtifact).not.toHaveBeenCalled();
  });
  it("reads only an exact artifact listed for the requested task", async () => {
    const f = fixture(); f.registry.detail.mockResolvedValue({ ...instance, artifacts: [] });
    expect(await f.host.readArtifact(partition, taskId, artifactId)).toEqual(unavailable);
    expect(f.registry.readArtifact).not.toHaveBeenCalled();
  });
  it("returns a verified owned byte copy without raw registry metadata", async () => {
    const f = fixture(); const result = await f.host.readArtifact(partition, taskId, artifactId);
    expect(result).toEqual({ availability: "ready", artifact, content: new Uint8Array(content) });
    expect(f.registry.readArtifact).toHaveBeenCalledWith(partition, taskId, artifactId);
    if (result.availability !== "ready") throw new Error("fixture did not return ready");
    f.bytes.fill(0); expect(Buffer.from(result.content)).toEqual(content);
    expect(Object.keys(result).sort()).toEqual(["artifact", "availability", "content"]);
  });
  it.each(["name", "type", "metadata-hash", "actual-hash", "length", "oversize"])("refuses %s mismatch in collected bytes", async kind => {
    const f = fixture();
    const value = { bytes: Buffer.from(content), name: artifact.name, mediaType: artifact.mediaType, sha256: artifact.sha256 };
    if (kind === "name") value.name = "other.csv";
    if (kind === "type") Object.assign(value, { mediaType: "text/plain" });
    if (kind === "metadata-hash") value.sha256 = "0".repeat(64);
    if (kind === "actual-hash") value.bytes.fill(32);
    if (kind === "length") value.bytes = Buffer.from("short");
    if (kind === "oversize") value.bytes = Buffer.alloc(SCIENCE_RECORD_LIMITS.artifactBytes + 1);
    f.registry.readArtifact.mockResolvedValue(value);
    expect(await f.host.readArtifact(partition, taskId, artifactId)).toEqual(invalid);
  });
  it.each(["registry-not-found", "registry-access-denied", "registry-artifact-refused", "registry-writer-lost", "unexpected"])("sanitizes %s across all read methods", async code => {
    const f = fixture(); const error = Object.assign(new Error("private /credential nonce=value"), { code });
    const expected = ["registry-not-found", "registry-access-denied", "registry-artifact-refused"].includes(code) ? unavailable : { availability: "unknown", reason: "host-offline" };
    f.registry.list.mockRejectedValue(error); expect(await f.host.list(partition)).toEqual(expected);
    f.registry.detail.mockRejectedValue(error); expect(await f.host.detail(partition, taskId)).toEqual(expected);
    f.registry.detail.mockResolvedValue(instance); f.registry.readArtifact.mockRejectedValue(error);
    expect(await f.host.readArtifact(partition, taskId, artifactId)).toEqual(expected);
  });
  it("keeps one partition snapshot across asynchronous artifact reads", async () => {
    const f = fixture(); const selected = { ...partition }; let finish!: (value: typeof instance) => void;
    f.registry.detail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.host.readArtifact(selected, taskId, artifactId);
    selected.ownerKey = "different-owner"; selected.cwd = "/different/project";
    finish(instance); expect((await pending).availability).toBe("ready");
    expect(f.registry.readArtifact).toHaveBeenCalledWith(partition, taskId, artifactId);
  });
});
