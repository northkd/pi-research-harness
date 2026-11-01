import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScienceHostObservation } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import type { ScienceInstancesHost } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import type { ScienceViewPartition } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScienceHostClient } from "../res-workflow/science-host-client.js";
import { createScienceHostDaemon } from "../res-workflow/science-host-daemon.js";

const taskId = "si-11111111-1111-4111-8111-111111111111", artifactId = "sa-22222222-2222-4222-8222-222222222222";
const summary = { id: taskId, status: "completed" as const, createdAt: 1, lastObservedAt: 2, stale: false };
const content = new TextEncoder().encode("synthetic fixture\n");
const artifact = { id: artifactId, name: "fixture.csv", mediaType: "text/csv" as const, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
const detail = { ...summary, modelIds: ["ark-sci-deepseek-v4.1-flash"], usage: null, cost: null, artifacts: [artifact] };
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { noAuthority?: boolean; unconfigured?: boolean } = {}) {
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-records-host-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "science-records-cwd-"));
  cleanups.push(() => fs.rm(privateDir, { recursive: true, force: true }), () => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(privateDir, "viewer.secret"), randomBytes(32), { mode: 0o600 });
  const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd }; let allowed = true;
  const revalidate = vi.fn(async () => { if (!allowed) throw new Error("private-error-must-not-escape"); });
  const accessFor = vi.fn(async (selected: ScienceViewPartition) => allowed && selected.ownerKey === partition.ownerKey && selected.cwd === cwd ? { ...partition, revalidate } : null);
  const host = {
    list: vi.fn<ScienceInstancesHost["list"]>(async () => ({ availability: "ready", instances: [{ ...summary, privatePath: "/must-not-escape", prompt: "private prompt" }] } as never)),
    detail: vi.fn<ScienceInstancesHost["detail"]>(async () => ({ availability: "ready", instance: { ...detail, nativeId: "must-not-escape" } } as never)),
    readArtifact: vi.fn<ScienceInstancesHost["readArtifact"]>(async () => ({ availability: "ready", artifact: { ...artifact, sourcePath: "/must-not-escape" }, content } as never)),
  };
  const observations: ScienceHostObservation[] = [], observe = (event: Readonly<ScienceHostObservation>) => observations.push(event);
  const daemon = createScienceHostDaemon({ privateDir, instancesHost: options.unconfigured ? undefined : host, accessFor: options.noAuthority ? undefined : accessFor, observe });
  await daemon.start(); cleanups.push(() => daemon.close());
  const client = createScienceHostClient({ privateDir, observe }); cleanups.push(() => client.dispose());
  return { client, daemon, partition, host, revalidate, observations, revoke() { allowed = false; } };
}

describe("three fixed read-only host operations", () => {
  it("projects list/detail/artifact through the same authenticated host without private metadata", async () => {
    const f = await fixture();
    expect(await f.client.list(f.partition)).toEqual({ availability: "ready", instances: [summary] });
    expect(await f.client.detail(f.partition, taskId)).toEqual({ availability: "ready", instance: detail });
    const read = await f.client.readArtifact(f.partition, taskId, artifactId);
    expect(read).toEqual({ availability: "ready", artifact, content });
    expect(f.host.list).toHaveBeenCalledWith(f.partition); expect(f.host.detail).toHaveBeenCalledWith(f.partition, taskId); expect(f.host.readArtifact).toHaveBeenCalledWith(f.partition, taskId, artifactId);
    expect(f.revalidate.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(f.observations.filter(event => event.side === "client" && event.phase === "auth" && event.outcome === "ok")).toHaveLength(1);
  });
  it("refuses foreign selectors and missing live authority before any host record call", async () => {
    const f = await fixture();
    expect(await f.client.list({ ...f.partition, ownerKey: JSON.stringify(["fixture", "foreign"]) })).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(f.host.list).not.toHaveBeenCalled();
    const no = await fixture({ noAuthority: true });
    expect(await no.client.detail(no.partition, taskId)).toEqual({ availability: "unavailable", reason: "binding-unavailable" }); expect(no.host.detail).not.toHaveBeenCalled();
    const unconfigured = await fixture({ unconfigured: true });
    expect(await unconfigured.client.list(unconfigured.partition)).toEqual({ availability: "unavailable", reason: "host-unconfigured" });
  });
  it("uses the record ID contract for v7 list/detail/artifact without widening viewer task admission", async () => {
    const f = await fixture(), v7 = "si-77777777-7777-7777-8777-777777777777";
    f.host.list.mockResolvedValue({ availability: "ready", instances: [{ ...summary, id: v7 }] });
    f.host.detail.mockResolvedValue({ availability: "ready", instance: { ...detail, id: v7 } });
    expect(await f.client.list(f.partition)).toEqual({ availability: "ready", instances: [{ ...summary, id: v7 }] });
    expect(await f.client.detail(f.partition, v7)).toEqual({ availability: "ready", instance: { ...detail, id: v7 } });
    expect((await f.client.readArtifact(f.partition, v7, artifactId)).availability).toBe("ready");
    expect(f.host.readArtifact).toHaveBeenCalledWith(f.partition, v7, artifactId);
    expect(await f.client.openTask!(f.partition, v7)).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
  });
  it("validates opaque IDs before opening a transport and never accepts filesystem selectors", async () => {
    const f = await fixture();
    expect(await f.client.detail(f.partition, "../private")).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(await f.client.readArtifact(f.partition, taskId, "/tmp/file")).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(f.host.detail).not.toHaveBeenCalled(); expect(f.host.readArtifact).not.toHaveBeenCalled(); expect(f.observations).toEqual([]);
  });
  it("discards a record result if authority is revoked while reading", async () => {
    const f = await fixture();
    f.host.readArtifact.mockImplementation(async () => { f.revoke(); return { availability: "ready", artifact, content }; });
    expect(await f.client.readArtifact(f.partition, taskId, artifactId)).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
  });
  it("rejects oversized lists and mismatched instance identity", async () => {
    const f = await fixture();
    f.host.list.mockResolvedValue({ availability: "ready", instances: Array.from({ length: 129 }, () => summary) });
    expect(await f.client.list(f.partition)).toEqual({ availability: "unknown", reason: "invalid-host-response" });
    f.host.detail.mockResolvedValue({ availability: "ready", instance: { ...detail, id: "si-33333333-3333-4333-8333-333333333333" } });
    expect(await f.client.detail(f.partition, taskId)).toEqual({ availability: "unknown", reason: "invalid-host-response" });
  });
  it("checks artifact identity, raw-byte limit, length and SHA before sending content", async () => {
    const f = await fixture();
    for (const invalid of [
      { artifact: { ...artifact, id: "sa-33333333-3333-4333-8333-333333333333" }, content },
      { artifact, content: new Uint8Array(1024 * 1024 + 1) },
      { artifact: { ...artifact, bytes: content.length + 1 }, content },
      { artifact: { ...artifact, sha256: "0".repeat(64) }, content },
    ]) {
      f.host.readArtifact.mockResolvedValue({ availability: "ready", ...invalid });
      expect(await f.client.readArtifact(f.partition, taskId, artifactId)).toEqual({ availability: "unknown", reason: "invalid-host-response" });
    }
  });
  it("transfers a 1MiB artifact without applying a 1MiB limit to base64", async () => {
    const f = await fixture(), bytes = new Uint8Array(1024 * 1024).fill(42);
    const metadata = { ...artifact, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    f.host.readArtifact.mockResolvedValue({ availability: "ready", artifact: metadata, content: bytes });
    const result = await f.client.readArtifact(f.partition, taskId, artifactId);
    expect(result.availability).toBe("ready"); if (result.availability === "ready") expect(result.content).toEqual(bytes);
  });
  it("returns unknown on disconnect without replaying a read and logs only finite fields", async () => {
    const f = await fixture();
    f.host.list.mockImplementation(async () => { void f.daemon.close(); return { availability: "ready", instances: [summary] }; });
    expect(await f.client.list(f.partition)).toEqual({ availability: "unknown", reason: "host-offline" }); expect(f.host.list).toHaveBeenCalledTimes(1);
    expect(f.observations.some(event => event.phase === "instances-list")).toBe(true);
    for (const event of f.observations) expect(Object.keys(event).sort()).toEqual(["elapsedMs", "error", "event", "outcome", "phase", "requestId", "side"]);
    expect(JSON.stringify(f.observations)).not.toMatch(/private-error|privatePath|sourcePath|nativeId|nonce|proof|fixture|records-host|records-cwd|content|sha256/);
  });
});
