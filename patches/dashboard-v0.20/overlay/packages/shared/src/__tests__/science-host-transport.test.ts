import { describe, expect, it } from "vitest";
import { clientPacket, encodeHostPacket, hostChallenge, hostProof, ScienceHostDecoder, verifyHostProof } from "../science-host-transport.js";

describe("private host finite protocol", () => {
  it("decodes split headers/payloads and multiple packets with bounded allocation", () => {
    const values: unknown[] = []; const decoder = new ScienceHostDecoder(1024, value => values.push(value));
    const packet = { type: "auth" as const, proof: "a".repeat(43) };
    const bytes = Buffer.concat([encodeHostPacket(packet), encodeHostPacket(packet)]);
    for (const byte of bytes) decoder.push(Buffer.from([byte]));
    expect(values).toEqual([packet, packet]);
    const header = Buffer.alloc(4); header.writeUInt32BE(1025);
    expect(() => decoder.push(header)).toThrow("science-host-packet-limit");
  });
  it("binds role-separated proofs to one random challenge, without transmitting a secret", () => {
    const secret = Buffer.alloc(32, 7); const first = hostChallenge(secret), second = hostChallenge(secret);
    expect(first.nonce).not.toBe(second.nonce);
    expect(verifyHostProof(secret, "host", first.nonce, first.proof)).toBe(true);
    expect(verifyHostProof(secret, "client", first.nonce, first.proof)).toBe(false);
    expect(verifyHostProof(secret, "client", second.nonce, hostProof(secret, "client", first.nonce))).toBe(false);
    expect(JSON.stringify(first)).not.toContain(secret.toString("base64url"));
  });
  it("rejects generic RPC, task writes and URL/owner riders", () => {
    const valid = { type: "open", id: 1, partition: { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: "/fixture" } };
    expect(clientPacket(valid)).toBe(true);
    for (const packet of [{ ...valid, url: "http://private/?nonce=fixture" }, { ...valid, partition: { ...valid.partition, projectId: "spoof" } }, { type: "submit", id: 1, prompt: "must-not-send" }, { type: "approve", id: 1 }, { type: "rpc", method: "Runtime.evaluate" }]) expect(clientPacket(packet)).toBe(false);
  });
});
