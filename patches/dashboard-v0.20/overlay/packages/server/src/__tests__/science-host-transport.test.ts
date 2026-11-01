import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ScienceHostObservation } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import type { ScienceViewFrame, ScienceViewPartition } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScienceHostClient } from "../res-workflow/science-host-client.js";
import { createScienceHostDaemon } from "../res-workflow/science-host-daemon.js";

const dirs: string[] = [];
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const frame: ScienceViewFrame = { jpegBase64: "/9j/AA==", metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 } };
async function setup(options: { noAuthority?: boolean } = {}) {
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-host-fixture-")); dirs.push(privateDir);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "science-host-workspace-")); dirs.push(cwd);
  await fs.writeFile(path.join(privateDir, "viewer.secret"), randomBytes(32), { mode: 0o600 });
  const partition = { ownerKey: JSON.stringify(["fixture-issuer", "fixture-owner"]), cwd };
  let allowed = true;
  let extraCheck = async () => {};
  const authority = vi.fn(async (selected: ScienceViewPartition) => selected.ownerKey === partition.ownerKey && selected.cwd === cwd && allowed ? { ...partition, revalidate: async () => { await extraCheck(); if (!allowed) throw new Error("private authority failure must not escape"); } } : null);
  const callbacks: Array<(frame: ScienceViewFrame) => void> = [];
  const input = vi.fn(async () => {}), unsubscribe = vi.fn(), stop = vi.fn();
  const subscribe = vi.fn(async (callback: (frame: ScienceViewFrame) => void) => { callbacks.push(callback); return { input, unsubscribe }; });
  const host = { openWorkspace: vi.fn(async () => ({ availability: "ready" as const, view: { subscribe } })), stop };
  const observations: ScienceHostObservation[] = [];
  const observe = (event: Readonly<ScienceHostObservation>) => { observations.push(event); };
  const daemon = createScienceHostDaemon({ privateDir, host, accessFor: options.noAuthority ? undefined : authority, observe });
  await daemon.start(); cleanups.push(() => daemon.close());
  const client = createScienceHostClient({ privateDir, observe }); cleanups.push(() => client.dispose());
  return { privateDir, cwd, partition, daemon, client, authority, host, subscribe, callbacks, input, unsubscribe, stop, observations, revoke: () => { allowed = false; }, onRevalidate: (callback: () => Promise<void>) => { extraCheck = callback; } };
}

describe("fixed private Unix host transport", () => {
  it("cancels a connecting socket immediately on disposal before any authentication", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-host-pending-")); dirs.push(privateDir);
    const socketPath = path.join(privateDir, "viewer.sock"); await fs.writeFile(path.join(privateDir, "viewer.secret"), randomBytes(32), { mode: 0o600 });
    let accepted!: (socket: Socket) => void; const acceptedSocket = new Promise<Socket>(resolve => { accepted = resolve; });
    const server = net.createServer(socket => accepted(socket));
    await new Promise<void>(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const client = createScienceHostClient({ privateDir }); cleanups.push(() => client.dispose());
    const opening = client.openWorkspace({ ownerKey: JSON.stringify(["fixture", "owner"]), cwd: privateDir });
    const peer = await acceptedSocket; const closed = vi.fn(), received = vi.fn(); peer.on("close", closed); peer.on("data", received);
    client.dispose();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1), { timeout: 400 });
    expect(await opening).toEqual({ availability: "unknown", reason: "host-offline" }); expect(received).not.toHaveBeenCalled();
  });
  it("is a public factory usable by the existing ServerConfig.scienceViewHost injection", () => {
    expect(createRequire(import.meta.url).resolve("@blackbelt-technology/pi-dashboard-server/science-host-client")).toMatch(/src\/res-workflow\/science-host-client\.ts$/);
  });
  it("authenticates and streams only an authority-bound partition; disconnect only detaches", async () => {
    const f = await setup(); const opened = await f.client.openWorkspace(f.partition); expect(opened.availability).toBe("ready");
    if (opened.availability !== "ready") throw new Error("fixture failed");
    const received: ScienceViewFrame[] = []; const unavailable = vi.fn(); const stream = await opened.view.subscribe(value => received.push(value), unavailable);
    f.callbacks[0]({ ...frame, metadata: { ...frame.metadata, title: "must-strip" } } as ScienceViewFrame);
    await vi.waitFor(() => expect(received).toEqual([frame]));
    await stream.input({ kind: "mouse", x: 0.5, y: 0.5 }); expect(f.input).toHaveBeenCalledTimes(1);
    f.client.dispose(); await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(1)); expect(unavailable).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled();
  });
  it("does not trust client owner/cwd selectors or an absent registry authority", async () => {
    const f = await setup();
    expect(await f.client.openWorkspace({ ...f.partition, ownerKey: JSON.stringify(["fixture-issuer", "foreign"]) })).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(f.host.openWorkspace).not.toHaveBeenCalled();
    const none = await setup({ noAuthority: true });
    expect(await none.client.openWorkspace(none.partition)).toEqual({ availability: "unavailable", reason: "binding-unavailable" }); expect(none.host.openWorkspace).not.toHaveBeenCalled();
  });
  it("refuses private-file mode drift, wrong shared credentials and path aliases", async () => {
    const f = await setup(); const secret = path.join(f.privateDir, "viewer.secret");
    await fs.chmod(secret, 0o640);
    expect((await f.client.openWorkspace(f.partition)).availability).toBe("unknown");
    await fs.chmod(secret, 0o600); await fs.writeFile(secret, randomBytes(32));
    expect((await f.client.openWorkspace(f.partition)).availability).toBe("unknown"); expect(f.host.openWorkspace).not.toHaveBeenCalled();
    const alias = path.join(f.privateDir, "alias"); await fs.symlink(f.privateDir, alias);
    const other = createScienceHostClient({ privateDir: alias }); cleanups.push(() => other.dispose());
    expect((await other.openWorkspace(f.partition)).availability).toBe("unknown");
  });
  it("does not overwrite an existing socket-path file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "science-host-existing-")); dirs.push(root);
    await fs.writeFile(path.join(root, "viewer.secret"), randomBytes(32), { mode: 0o600 });
    const target = path.join(root, "viewer.sock"); await fs.writeFile(target, "user-owned-original", { mode: 0o600 });
    const daemon = createScienceHostDaemon({ privateDir: root }); cleanups.push(() => daemon.close());
    await expect(daemon.start()).rejects.toThrow("science-host-socket-exists"); expect(await fs.readFile(target, "utf8")).toBe("user-owned-original");
  });
  it("keeps two subscribers independent and refuses input after local unsubscribe", async () => {
    const f = await setup(); const opened = await f.client.openWorkspace(f.partition); if (opened.availability !== "ready") throw new Error("fixture failed");
    const first: ScienceViewFrame[] = [], second: ScienceViewFrame[] = [];
    const a = await opened.view.subscribe(value => first.push(value)); const b = await opened.view.subscribe(value => second.push(value));
    a.unsubscribe(); await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(1));
    await expect(a.input({ kind: "key", text: "must-not-send" })).rejects.toThrow("science-host-transport-unavailable");
    f.callbacks[1](frame); await vi.waitFor(() => expect(second).toEqual([frame])); expect(first).toEqual([]);
    b.unsubscribe(); expect(f.stop).not.toHaveBeenCalled();
  });
  it("rechecks registry authority before frames and input", async () => {
    const f = await setup(); const opened = await f.client.openWorkspace(f.partition); if (opened.availability !== "ready") throw new Error("fixture failed");
    const received: ScienceViewFrame[] = []; const stream = await opened.view.subscribe(value => received.push(value));
    f.revoke(); f.callbacks[0](frame); await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(1));
    await expect(stream.input({ kind: "key", text: "must-not-send" })).rejects.toThrow("science-host-transport-unavailable"); expect(f.input).not.toHaveBeenCalled(); expect(received).toEqual([]);
  });
  it("records bounded phases and opaque IDs without private fields on success or failure", async () => {
    const f = await setup(); await f.client.openWorkspace(f.partition); f.client.dispose();
    const other = createScienceHostClient({ privateDir: `${f.privateDir}-absent`, observe: event => f.observations.push(event) }); cleanups.push(() => other.dispose());
    await other.openWorkspace(f.partition);
    expect(f.observations.some(event => event.phase === "auth" && event.outcome === "ok")).toBe(true);
    expect(f.observations.some(event => event.outcome === "unknown")).toBe(true);
    for (const event of f.observations) expect(Object.keys(event).sort()).toEqual(["elapsedMs", "error", "event", "outcome", "phase", "requestId", "side"]);
    expect(JSON.stringify(f.observations)).not.toMatch(/nonce|proof|title|jpeg|fixture-issuer|fixture-owner|workspace-|host-fixture|requestbody/);
  });
  it("refuses a task without an authoritative task method instead of opening the workspace", async () => {
    const f = await setup();
    expect(await f.client.openTask!(f.partition, "si-11111111-1111-4111-8111-111111111111")).toEqual({ availability: "unavailable", reason: "binding-unavailable" }); expect(f.host.openWorkspace).not.toHaveBeenCalled();
  });
  it("rechecks view expiry after asynchronous authority before input", async () => {
    const f = await setup(); const opened = await f.client.openWorkspace(f.partition); if (opened.availability !== "ready") throw new Error("fixture failed");
    const stream = await opened.view.subscribe(() => {}); const now = Date.now();
    f.onRevalidate(async () => { vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000); });
    await expect(stream.input({ kind: "key", text: "must-not-send" })).rejects.toThrow("science-host-transport-unavailable"); expect(f.input).not.toHaveBeenCalled(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("preserves a replacement file and directory on shutdown", async () => {
    const f = await setup(); const target = path.join(f.privateDir, "viewer.sock");
    await fs.unlink(target); await fs.writeFile(target, "replacement-user-file", { mode: 0o640 }); await f.daemon.close();
    expect(await fs.readFile(target, "utf8")).toBe("replacement-user-file"); expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    const other = await setup(); const moved = `${other.privateDir}-moved`; dirs.push(moved);
    await fs.rename(other.privateDir, moved); await fs.mkdir(other.privateDir, { mode: 0o700 }); const replacement = path.join(other.privateDir, "viewer.sock"); await fs.writeFile(replacement, "keep", { mode: 0o600 }); await other.daemon.close();
    expect(await fs.readFile(replacement, "utf8")).toBe("keep");
  });
});
