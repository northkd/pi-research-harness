import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostArtifactRead, hostArtifactResult, hostDetailResult, hostListResult } from "../science-host-records.js";
import { clientPacket, serverPacket } from "../science-host-transport.js";

const instanceId = "si-11111111-1111-4111-8111-111111111111", artifactId = "sa-22222222-2222-4222-8222-222222222222";
const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: "/fixture" };
const content = new Uint8Array([1, 2, 3]);
const artifact = { id: artifactId, name: "fixture.txt", mediaType: "text/plain", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
const unknown = { availability: "unknown", reason: "invalid-host-response" };

describe("finite private record protocol", () => {
  it("admits exactly three read operations and refuses native/path/write riders", () => {
    const packets = [
      { type: "instances-list", id: 1, partition },
      { type: "instance-detail", id: 2, partition, instanceId },
      { type: "artifact-read", id: 3, partition, instanceId, artifactId },
    ];
    for (const packet of packets) {
      expect(clientPacket(packet)).toBe(true);
      for (const extra of [{ path: "/private" }, { projectId: "native" }, { action: "submit" }, { approve: true }]) expect(clientPacket({ ...packet, ...extra })).toBe(false);
    }
    expect(clientPacket({ ...packets[2], artifactId: "../file" })).toBe(false);
    expect(clientPacket({ ...packets[1], instanceId: "native-task" })).toBe(false);
    expect(clientPacket({ type: "read", id: 1, partition, method: "list" })).toBe(false);
    const v7 = "si-77777777-7777-7777-8777-777777777777";
    expect(clientPacket({ ...packets[1], instanceId: v7 })).toBe(true);
    expect(clientPacket({ type: "open", id: 1, partition, instanceId: v7 })).toBe(false);
  });
  it("rejects unprojected metadata and malformed response envelopes", () => {
    const summary = { id: instanceId, status: "unknown", createdAt: 1, lastObservedAt: null, stale: true };
    const safe = { availability: "ready", instances: [summary] };
    expect(serverPacket({ type: "instances", id: 1, result: safe })).toBe(true);
    expect(serverPacket({ type: "instances", id: 1, result: { ...safe, cwd: "/private" } })).toBe(false);
    expect(serverPacket({ type: "instances", id: 1, result: { ...safe, instances: [{ ...summary, prompt: "private" }] } })).toBe(false);
    expect(serverPacket({ type: "instances", id: 0, result: safe })).toBe(false);
    expect(hostListResult({ ...safe, instances: [{ ...summary, prompt: "private" }] })).toEqual(safe);
    expect(hostDetailResult({ availability: "ready", instance: {} }, instanceId)).toEqual(unknown);
  });
  it("accepts canonical base64 only and rechecks raw-byte identity on receive", () => {
    const wire = hostArtifactResult({ availability: "ready", artifact: { ...artifact, privatePath: "/private" }, content }, artifactId);
    expect(wire).toEqual({ availability: "ready", artifact, contentBase64: "AQID" });
    expect(serverPacket({ type: "artifact", id: 1, result: wire })).toBe(true);
    expect(hostArtifactRead(wire, artifactId)).toEqual({ availability: "ready", artifact, content });
    for (const encoded of ["AQID\n", "AQID=", "AR==", "AQIE", "AQID".repeat(400000)]) expect(hostArtifactRead({ ...wire, contentBase64: encoded }, artifactId)).toEqual(unknown);
    expect(serverPacket({ type: "artifact", id: 1, result: { ...wire, secret: "must-not-cross" } })).toBe(false);
  });
  it("copies host bytes and retains only allowlisted unavailable reasons", () => {
    const source = new Uint8Array([1, 2, 3]), wire = hostArtifactResult({ availability: "ready", artifact, content: source }, artifactId);
    source.fill(0);
    expect(hostArtifactRead(wire, artifactId)).toEqual({ availability: "ready", artifact, content });
    expect(hostListResult({ availability: "unknown", reason: "private-error", detail: "must-not-cross" })).toEqual(unknown);
  });
});
