import { EventEmitter } from "node:events";
import { encodeHostPacket, hostChallenge } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ create: vi.fn(), secret: vi.fn(async () => Buffer.alloc(32, 7)), verify: vi.fn(async () => ({ dev: 1, ino: 2 })) }));
vi.mock("node:net", () => ({ default: { createConnection: fake.create } }));
vi.mock("@blackbelt-technology/pi-dashboard-shared/science-host-files.js", () => ({ readScienceHostSecret: fake.secret, verifyScienceHostSocket: fake.verify, scienceHostPaths: () => ({ socket: "/fixture/viewer.sock" }) }));

import { createScienceHostClient } from "../science-host-client.js";

const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: "/fixture/workspace" };
const instance = "si-11111111-1111-4111-8111-111111111111";
const viewId = `hv-${"a".repeat(48)}`;
type Packet = { type: string; id?: number };
class FakeSocket extends EventEmitter {
  writableLength = 0; destroyed = false;
  readonly request: (packet: Packet, socket: FakeSocket) => void;
  constructor(request: (packet: Packet, socket: FakeSocket) => void) { super(); this.request = request; }
  pause() { return this; }
  resume() { queueMicrotask(() => this.deliver(hostChallenge(Buffer.alloc(32, 7)))); return this; }
  write(bytes: Buffer) {
    if (bytes.readUInt32BE(0) !== bytes.length - 4) throw new Error("fixture-invalid-packet");
    const packet = JSON.parse(bytes.subarray(4).toString("utf8")) as Packet;
    if (packet.type === "auth") queueMicrotask(() => this.deliver({ type: "authenticated" }));
    else this.request(packet, this);
    return true;
  }
  deliver(packet: object) { if (!this.destroyed) this.emit("data", encodeHostPacket(packet as never)); }
  destroy(error?: Error) { if (!this.destroyed) { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); } return this; }
}
const clients: ReturnType<typeof createScienceHostClient>[] = [];
const peers: FakeSocket[] = [];
function client(request: (packet: Packet, socket: FakeSocket) => void) {
  fake.create.mockImplementation((options: { signal: AbortSignal }) => {
    const peer = new FakeSocket(request); peers.push(peer); options.signal.addEventListener("abort", () => peer.destroy(), { once: true });
    queueMicrotask(() => peer.emit("connect")); return peer;
  });
  const value = createScienceHostClient({ privateDir: "/fixture" }); clients.push(value); return value;
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { for (const value of clients.splice(0)) value.dispose(); peers.splice(0); vi.useRealTimers(); });

describe("bounded cold open deadline", () => {
  it("allows a scoped workspace open to finish after the normal 5 second request limit", async () => {
    const value = client((packet, peer) => { if (packet.type === "open") setTimeout(() => peer.deliver({ type: "view", id: packet.id, availability: "ready", viewId }), 6000); });
    const opened = value.openWorkspace(partition); await vi.advanceTimersByTimeAsync(6001);
    expect((await opened).availability).toBe("ready"); expect(peers[0].destroyed).toBe(false);
  });

  it("gives task opens and an explicit view reopen the same bounded cold-open budget", async () => {
    let opens = 0;
    const value = client((packet, peer) => {
      if (packet.type === "open") { opens++; const reply = () => peer.deliver({ type: "view", id: packet.id, availability: "ready", viewId }); if (opens === 1) queueMicrotask(reply); else setTimeout(reply, 6000); }
      if (packet.type === "subscribe") queueMicrotask(() => peer.deliver({ type: "ack", id: packet.id, ok: true }));
    });
    const initial = value.openTask!(partition, instance); await vi.advanceTimersByTimeAsync(0); const opened = await initial;
    if (opened.availability !== "ready") throw new Error("fixture-open-failed");
    const first = await opened.view.subscribe(() => {}); first.unsubscribe();
    const reopening = opened.view.subscribe(() => {}).then(stream => stream, () => undefined); await vi.advanceTimersByTimeAsync(6001);
    const second = await reopening; expect(second).toBeDefined(); second?.unsubscribe(); expect(opens).toBe(2); expect(peers[0].destroyed).toBe(false);
  });

  it.each(["list", "detail", "readArtifact"] as const)("keeps %s at five seconds", async method => {
    const value = client(() => {});
    const pending = method === "list" ? value.list(partition) : method === "detail" ? value.detail(partition, instance) : value.readArtifact(partition, instance, "sa-22222222-2222-4222-8222-222222222222");
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).availability).toBe("unknown"); expect(peers[0].destroyed).toBe(true);
  });

  it("caps an unresponsive open at sixty seconds without replay", async () => {
    const requests = vi.fn(); const value = client(requests); let settled = false;
    const opening = value.openWorkspace(partition).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(59000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1001); expect((await opening).availability).toBe("unknown");
    expect(requests.mock.calls.filter(([packet]) => packet.type === "open")).toHaveLength(1); expect(fake.create).toHaveBeenCalledOnce();
  });

  it("disposal interrupts a pending long open and does not retry a late response", async () => {
    const requests = vi.fn(); const value = client(requests); const opening = value.openWorkspace(partition);
    await vi.advanceTimersByTimeAsync(1000); value.dispose(); expect((await opening).availability).toBe("unknown");
    peers[0].deliver({ type: "view", id: 1, availability: "ready", viewId }); await vi.advanceTimersByTimeAsync(60000);
    expect(fake.create).toHaveBeenCalledOnce(); expect(requests.mock.calls.filter(([packet]) => packet.type === "open")).toHaveLength(1);
  });
});
