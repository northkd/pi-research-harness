import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScienceViewFrame } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { registerScienceViewerRoutes } from "../routes/science-viewer-routes.js";
import type { HostPolicy } from "../identity/host-access.js";

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
const principal = { iss: "fixture", sub: "alice" };
const frame: ScienceViewFrame = { jpegBase64: "/9j/AA==", metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 } };
async function setup(options: { configured?: boolean; active?: boolean; expiresAt?: number; foreign?: boolean; policy?: HostPolicy; policyOnly?: boolean; tasks?: boolean } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "science-viewer-fixture-")); dirs.push(cwd);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "science-viewer-other-")); dirs.push(other);
  const app = Fastify(); apps.push(app);
  let owner = options.foreign ? { iss: "fixture", sub: "bob" } : principal;
  let known = [cwd, other];
  app.addHook("onRequest", async request => { (request as any).principal = principal; (request as any).principalExpiresAt = options.expiresAt; });
  const callbacks: Array<(f: unknown) => void> = [];
  const unavailable: Array<() => void> = [];
  const unsubscribe = vi.fn();
  const input = vi.fn(async () => {});
  const subscribe = vi.fn(async (cb: (f: unknown) => void, lost?: () => void) => { callbacks.push(cb); if (lost) unavailable.push(lost); return { unsubscribe, input }; });
  const openWorkspace = vi.fn(async () => ({ availability: "ready" as const, view: { subscribe } }));
  const openTask = vi.fn(async (_partition: unknown, _instanceId: string) => ({ availability: "ready" as const, view: { subscribe } }));
  const handlers = new Map<string, (msg: unknown, ws: any) => void>();
  let disconnect: (ws: any) => void = () => {};
  registerScienceViewerRoutes(app, {
    networkGuard: async () => {}, knownCwds: () => known,
    history: () => options.policyOnly ? [] : [{ id: "fixture", cwd, principalOwner: owner }, { id: "other", cwd: other, principalOwner: principal }],
    isResolverActive: () => options.active ?? true,
    hostPolicy: options.policy,
    host: options.configured === false ? undefined : { openWorkspace, ...(options.tasks ? { openTask } : {}) },
    gateway: { registerHandler: (type, fn) => { handlers.set(type, fn); }, registerDisconnectHandler: fn => { disconnect = fn; } },
  });
  const ws = () => ({ principal, readyState: 1, bufferedAmount: 0, send: vi.fn(), principalExpiresAt: options.expiresAt });
  const send = async (socket: ReturnType<typeof ws>, type: string, leaseId: string, extra: Record<string, unknown> = {}) => {
    await handlers.get(type)!({ type, cwd, leaseId, ...extra }, socket);
  };
  const open = (target: unknown = { kind: "workspace" }, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/res-workflow/science/view", payload: { cwd, target, ...extra } });
  return { app, cwd, other, open, ws, send, callbacks, unavailable, input, subscribe, unsubscribe, openWorkspace, openTask, disconnect: (socket: ReturnType<typeof ws>) => disconnect(socket), revoke: () => { known = []; }, transfer: () => { owner = { iss: "fixture", sub: "bob" }; } };
}

describe("Science's owner/cwd-bound viewing roads", () => {
  it("marks a lost host unavailable and ignores a retired loss callback after reopening", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    await f.send(socket, "science_view_subscribe", leaseId); f.unavailable[0]();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1); expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "science_view_status", leaseId, state: "unavailable", reason: "view-unavailable" }));
    await f.send(socket, "science_view_subscribe", leaseId); f.unavailable[0](); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("reuses only the same target and separates workspace, task one and task two", async () => {
    const f = await setup({ tasks: true });
    const one = "si-11111111-1111-4111-8111-111111111111", two = "si-22222222-2222-4222-8222-222222222222";
    const workspace = (await f.open()).json();
    const [a, again] = await Promise.all([f.open({ kind: "task", taskId: one }), f.open({ kind: "task", taskId: one })]);
    const b = (await f.open({ kind: "task", taskId: two })).json();
    expect(a.json()).toEqual(again.json()); expect(new Set([workspace.leaseId, a.json().leaseId, b.leaseId]).size).toBe(3);
    expect(f.openWorkspace).toHaveBeenCalledTimes(1); expect(f.openTask).toHaveBeenCalledTimes(2);
    expect(f.openTask.mock.calls.map(call => call[1])).toEqual([one, two]);
    expect((await f.open({ kind: "task", taskId: "client-native-id" })).json()).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
  });
  it("leaves unconfigured and unbound task views explicitly unavailable without opening anything", async () => {
    const absent = await setup({ configured: false });
    expect((await absent.open()).json()).toEqual({ availability: "unavailable", reason: "host-unconfigured" });
    const f = await setup();
    expect((await f.open({ kind: "task", taskId: "client-supplied" })).json()).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(f.openWorkspace).not.toHaveBeenCalled();
    expect(await fs.readdir(f.cwd)).toEqual([]);
  });

  it("rejects owner, endpoint, target and query riders before host access", async () => {
    const f = await setup();
    for (const extra of [{ ownerKey: "bob" }, { url: "http://private/?nonce=fixture" }, { cdpUrl: "ws://private" }]) expect((await f.open(undefined, extra)).statusCode).toBe(400);
    expect((await f.open({ kind: "workspace", url: "http://private" })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/api/res-workflow/science/view?url=http://private", payload: { cwd: f.cwd, target: { kind: "workspace" } } })).statusCode).toBe(400);
    const foreign = await setup({ foreign: true });
    expect((await foreign.open()).statusCode).toBe(404);
    const expired = await setup({ expiresAt: Date.now() - 1 });
    expect((await expired.open()).statusCode).toBe(403);
    expect(f.openWorkspace).not.toHaveBeenCalled(); expect(foreign.openWorkspace).not.toHaveBeenCalled(); expect(expired.openWorkspace).not.toHaveBeenCalled();
  });

  it("opens a workspace once and passes only the canonical trusted partition to its host", async () => {
    const f = await setup();
    const first = (await f.open()).json(); const second = (await f.open()).json();
    expect(first).toMatchObject({ availability: "ready", leaseId: expect.stringMatching(/^sv-[a-f0-9]{48}$/), expiresAt: expect.any(Number) });
    expect(second).toEqual(first); expect(f.openWorkspace).toHaveBeenCalledTimes(1);
    expect(f.openWorkspace).toHaveBeenCalledWith({ ownerKey: JSON.stringify([principal.iss, principal.sub]), cwd: f.cwd });
    expect(Object.keys(first).sort()).toEqual(["availability", "expiresAt", "leaseId"]);
  });

  it("delivers frames only to its subscribed owner/cwd/socket and strips host metadata", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId;
    const a = f.ws(), b = f.ws();
    await f.send(a, "science_view_subscribe", leaseId);
    f.callbacks[0]({ ...frame, title: "fixture-secret", url: "http://private/?nonce=fixture" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(a.send).toHaveBeenCalledWith(JSON.stringify({ type: "science_view_frame", leaseId, ...frame }));
    expect(b.send).not.toHaveBeenCalled(); expect(JSON.stringify(a.send.mock.calls)).not.toMatch(/nonce|fixture-secret|private/);
    const foreign = { ...f.ws(), principal: { iss: "fixture", sub: "bob" } };
    await f.send(foreign, "science_view_subscribe", leaseId);
    await f.send(b, "science_view_subscribe", leaseId, { cwd: f.other });
    expect(f.subscribe).toHaveBeenCalledTimes(1);
  });

  it("revalidates input and every frame after owner transfer, and closes only the view subscription", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    await f.send(socket, "science_view_subscribe", leaseId);
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "mouse", x: 0.5, y: 0.5 } }); expect(f.input).toHaveBeenCalledTimes(1);
    f.transfer();
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "key", text: "must-not-send" } });
    f.callbacks[0](frame); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.input).toHaveBeenCalledTimes(1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0])).filter(msg => msg.type === "science_view_frame")).toEqual([]);
    f.disconnect(socket); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops arbitrary CDP and malformed input without forwarding, then unsubscribe prevents future frames", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    await f.send(socket, "science_view_subscribe", leaseId);
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "navigate", url: "http://private" } });
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "key", text: "x", method: "Runtime.evaluate" } });
    await f.send(socket, "science_view_unsubscribe", leaseId);
    f.callbacks[0](frame); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.input).not.toHaveBeenCalled(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0])).some(msg => msg.type === "science_view_frame")).toBe(false);
  });

  it("sanitizes host failures and rechecks authority after a delayed host open", async () => {
    const f = await setup();
    f.openWorkspace.mockRejectedValueOnce(new Error("http://private/?nonce=fixture-secret"));
    const failure = await f.open(); expect(failure.json()).toEqual({ availability: "unknown", reason: "host-offline" }); expect(failure.body).not.toContain("nonce");
    let done!: (value: any) => void;
    f.openWorkspace.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = f.open(); await vi.waitFor(() => expect(typeof done).toBe("function")); f.revoke(); done({ availability: "ready", view: { subscribe: f.subscribe } });
    expect((await pending).statusCode).toBe(404); expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes while host subscription is pending without a late frame or upstream stop", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    let ready!: (value: any) => void;
    f.subscribe.mockImplementationOnce(cb => { f.callbacks.push(cb); return new Promise(resolve => { ready = resolve; }); });
    const pending = f.send(socket, "science_view_subscribe", leaseId);
    await vi.waitFor(() => expect(typeof ready).toBe("function"));
    const detached = f.send(socket, "science_view_unsubscribe", leaseId);
    f.callbacks[0](frame); ready({ unsubscribe: f.unsubscribe, input: f.input }); await pending; await detached;
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("keeps a later subscribe after a queued unsubscribe and drops the old queued input", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    let ready!: (value: any) => void;
    f.subscribe.mockImplementationOnce(cb => { f.callbacks.push(cb); return new Promise(resolve => { ready = resolve; }); });
    const first = f.send(socket, "science_view_subscribe", leaseId);
    await vi.waitFor(() => expect(typeof ready).toBe("function"));
    const staleInput = f.send(socket, "science_view_input", leaseId, { input: { kind: "key", text: "stale" } });
    const detached = f.send(socket, "science_view_unsubscribe", leaseId);
    const later = f.send(socket, "science_view_subscribe", leaseId);
    ready({ unsubscribe: f.unsubscribe, input: f.input }); await Promise.all([first, staleInput, detached, later]);
    expect(f.subscribe).toHaveBeenCalledTimes(2); expect(f.unsubscribe).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled();
    f.callbacks[1](frame); await new Promise(resolve => setTimeout(resolve, 20));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "science_view_frame", leaseId, ...frame }));
  });

  it("renews only the viewing lease after the same owner's HTTP identity refreshes", async () => {
    const now = Date.now(); const options = { expiresAt: now + 1000 }; const f = await setup(options);
    const first = (await f.open()).json();
    vi.spyOn(Date, "now").mockReturnValue(now + 2000); options.expiresAt = now + 100000;
    const second = await f.open();
    expect(second.statusCode).toBe(200); expect(second.json().availability).toBe("ready"); expect(second.json().leaseId).not.toBe(first.leaseId);
    expect(f.openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("refuses expired socket identity and expired lease input or frames", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    await f.send(socket, "science_view_subscribe", leaseId);
    socket.principalExpiresAt = Date.now() - 1;
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "key", text: "expired" } }); expect(f.input).not.toHaveBeenCalled();
    const other = await setup(); const id = (await other.open()).json().leaseId; const otherSocket = other.ws();
    await other.send(otherSocket, "science_view_subscribe", id);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
    other.callbacks[0](frame); await new Promise(resolve => setTimeout(resolve, 20));
    expect(otherSocket.send.mock.calls.map(call => JSON.parse(call[0])).some(msg => msg.type === "science_view_frame")).toBe(false);
    expect(other.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rechecks the current write grant after a later read-only authorization revokes writes", async () => {
    let writes = 0, writeAllowed = true;
    const f = await setup({ policyOnly: true, policy: { hasPolicy: () => true, authorize: async ({ action }) => {
      if (action === "workspace.write") { writes++; return writeAllowed; }
      if (action === "workspace.read" && writes >= 2) writeAllowed = false;
      return action === "workspace.read";
    } } });
    const leaseId = (await f.open()).json().leaseId; const socket = f.ws();
    await f.send(socket, "science_view_subscribe", leaseId);
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "key", text: "must-not-send" } });
    expect(writes).toBeGreaterThanOrEqual(3); expect(f.input).not.toHaveBeenCalled();
  });

  it("honors live socket tier downgrade for input and revocation for outbound frames", async () => {
    const f = await setup(); const leaseId = (await f.open()).json().leaseId;
    let tier: "operate" | "observe" | null = "operate";
    const socket = { ...f.ws(), sessionTier: () => tier };
    await f.send(socket, "science_view_subscribe", leaseId); tier = "observe";
    await f.send(socket, "science_view_input", leaseId, { input: { kind: "key", text: "must-not-send" } }); expect(f.input).not.toHaveBeenCalled();
    await f.send(socket, "science_view_subscribe", leaseId); tier = null;
    f.callbacks[1](frame); await new Promise(resolve => setTimeout(resolve, 20));
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0])).some(msg => msg.type === "science_view_frame")).toBe(false);
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
