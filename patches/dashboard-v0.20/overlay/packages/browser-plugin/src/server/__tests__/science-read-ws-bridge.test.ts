import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceReadWsFilter } from "../../../../server/src/res-workflow/science-read-ws.js";
import { createScienceReadWsBridge, type ScienceReadWsAccess } from "../science-read-ws-bridge.js";

const wire = vi.hoisted(() => ({ upstream: [] as any[], browser: [] as any[] }));
vi.mock("ws", async () => {
  const { EventEmitter: Events } = await import("node:events");
  class Peer extends Events {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    readyState = 0; bufferedAmount = 0; sent: string[] = [];
    url?: unknown; protocols?: unknown; options?: unknown;
    constructor(url?: unknown, protocols?: unknown, options?: unknown) { super(); this.url = url; this.protocols = protocols; this.options = options; if (url) wire.upstream.push(this); }
    send(value: string, _options?: unknown, done?: (error?: Error) => void) { this.sent.push(value); done?.(); }
    pong(_value: unknown, _mask?: unknown, done?: (error?: Error) => void) { done?.(); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
    close() { this.terminate(); }
  }
  class Server {
    options: unknown;
    constructor(options: unknown) { this.options = options; }
    handleUpgrade(_request: unknown, _socket: unknown, _head: unknown, callback: (peer: Peer) => void) { const peer = new Peer(); peer.readyState = 1; wire.browser.push(peer); callback(peer); }
    close(callback: () => void) { callback(); }
  }
  return { default: Peer, WebSocket: Peer, WebSocketServer: Server };
});
class RawSocket extends EventEmitter {
  destroyed = false; output = "";
  end(value?: string) { this.output += value ?? ""; this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
}
const binding = { projectId: "proj_111111111111", taskId: "11111111-1111-4111-8111-111111111111", rootFrameId: "11111111-1111-4111-8111-111111111111", frameId: "11111111-1111-4111-8111-111111111111" };
const origin = "http://127.0.0.1:18765";
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { wire.upstream.length = 0; wire.browser.length = 0; });
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function request(protocol: string | undefined = "operon-csrf.browser-cookie") {
  return { method: "GET", url: `${origin}/api/ws?user_id=browser-untrusted`, headers: { origin, ...(protocol ? { "sec-websocket-protocol": protocol } : {}) } } as IncomingMessage;
}
function fixture(options: { contract?: unknown; contractCheck?: () => Promise<void>; createFilter?: ScienceReadWsAccess["createFilter"]; privateSession?: () => Promise<{ authCookie: string; csrfCookie: string }> } = {}) {
  let allowed = true;
  const revalidate = vi.fn(async () => { if (!allowed) throw new Error("private grant must not escape"); });
  const session = vi.fn(options.privateSession ?? (async () => ({ authCookie: "host-auth", csrfCookie: "host%2541" })));
  const notify = vi.fn(), release = vi.fn();
  const access: ScienceReadWsAccess = { assertContract: options.contractCheck ?? (async () => options.contract as void), privateSession: session, createFilter: options.createFilter ?? (() => createScienceReadWsFilter({ binding, revalidate })), onUnavailable: notify, release };
  const bridge = createScienceReadWsBridge({ origin, access, revalidate }); cleanups.push(() => bridge.close());
  const socket = new RawSocket(); bridge.upgrade(request(), socket as unknown as Socket, Buffer.alloc(0));
  const open = async () => { await vi.waitFor(() => expect(wire.upstream).toHaveLength(1)); wire.upstream[0].readyState = 1; wire.upstream[0].emit("open"); await vi.waitFor(() => expect(wire.browser).toHaveLength(1)); };
  return { bridge, socket, access, session, notify, release, revalidate, open, revoke: () => { allowed = false; } };
}

describe("fixed scoped private websocket bridge", () => {
  it("uses only host cookies, one decoded CSRF tag and explicit root subscription", async () => {
    const f = fixture(); await f.open(); const upstream = wire.upstream[0];
    expect(upstream.url).toBe("ws://127.0.0.1:18765/api/ws?explicit_subscribe=1"); expect(upstream.protocols).toEqual(["operon-csrf.host%41"]);
    expect(upstream.options.headers).toEqual({ Origin: origin, Cookie: "operon_auth=host-auth; operon_csrf=host%2541" });
    expect(upstream.options).toMatchObject({ maxPayload: 65536, followRedirects: false, perMessageDeflate: false, skipUTF8Validation: false, autoPong: false });
    expect(upstream.sent).toEqual([JSON.stringify({ type: "subscribe", root_frame_id: binding.rootFrameId })]); expect(JSON.stringify(upstream.options)).not.toContain("browser");
  });
  it("forwards only canonical exact-root events and ignores browser task writes/presence", async () => {
    const f = fixture(); await f.open(); const upstream = wire.upstream[0], browser = wire.browser[0];
    const event = { type: "text_chunk", root_frame_id: binding.rootFrameId, frame_id: binding.frameId, chunk: "synthetic stream", block_type: "text" };
    upstream.emit("message", Buffer.from(JSON.stringify({ ...event, root_frame_id: "22222222-2222-4222-8222-222222222222" })), false);
    upstream.emit("message", Buffer.from(JSON.stringify(event)), false);
    browser.emit("message", Buffer.from(JSON.stringify({ type: "subscribe_project", project_id: binding.projectId })), false);
    browser.emit("message", Buffer.from(JSON.stringify({ type: "approve", root_frame_id: binding.rootFrameId })), false);
    browser.emit("message", Buffer.from(JSON.stringify({ type: "view_session", root_frame_id: binding.rootFrameId })), false);
    browser.emit("message", Buffer.from('{"type":"ping"}'), false);
    await vi.waitFor(() => expect(browser.sent).toEqual([JSON.stringify(event)]));
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(2)); expect(upstream.sent[1]).toBe('{"type":"ping"}');
  });
  it.each([true, false, { accepted: true }])("refuses non-void contract grants before creating an upstream (%j)", async contract => {
    const f = fixture({ contract }); await vi.waitFor(() => expect(f.socket.destroyed).toBe(true)); expect(wire.upstream).toHaveLength(0); expect(f.session).not.toHaveBeenCalled();
  });
  it("rejects bearer/multiple protocols and pipelined bytes before private session lookup", async () => {
    const f = fixture({ contract: true }); await vi.waitFor(() => expect(f.socket.destroyed).toBe(true));
    for (const protocol of ["Bearer-client-token", "operon-csrf.one, operon-csrf.two"]) { const socket = new RawSocket(); f.bridge.upgrade(request(protocol), socket as unknown as Socket, Buffer.alloc(0)); expect(socket.destroyed).toBe(true); }
    const socket = new RawSocket(); f.bridge.upgrade(request(), socket as unknown as Socket, Buffer.from("pipelined")); expect(socket.destroyed).toBe(true); expect(f.session).not.toHaveBeenCalled();
  });
  it("closes on binary data without interpreting it as native JSON", async () => {
    const f = fixture(); await f.open(); wire.upstream[0].emit("message", Buffer.from('{"type":"pong"}'), true);
    await vi.waitFor(() => expect(wire.upstream[0].readyState).toBe(3)); expect(wire.browser[0].sent).toEqual([]); expect(f.notify).toHaveBeenCalledWith("stream-unavailable");
  });
  it("drops late results after scope revocation and closes only this connection", async () => {
    const f = fixture(); await f.open(); f.revoke(); wire.upstream[0].emit("message", Buffer.from('{"type":"pong"}'), false);
    await vi.waitFor(() => expect(wire.upstream[0].readyState).toBe(3)); expect(wire.browser[0].sent).toEqual([]); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("does not create a late upstream after the browser disconnects during session lookup", async () => {
    let finish!: (value: { authCookie: string; csrfCookie: string }) => void;
    const f = fixture({ privateSession: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); f.socket.destroy(); finish({ authCookie: "host-auth", csrfCookie: "host-csrf" });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(wire.upstream).toHaveLength(0);
  });
  it("closes on queue or buffered output overflow and never sends queued writes", async () => {
    const f = fixture(); await f.open(); wire.browser[0].bufferedAmount = 262145; wire.upstream[0].emit("message", Buffer.from('{"type":"pong"}'), false);
    await vi.waitFor(() => expect(wire.upstream[0].readyState).toBe(3)); expect(wire.browser[0].sent).toEqual([]);
  });
  it("maps upstream 401 failure to a fixed private invalidation without following a redirect", async () => {
    const f = fixture(); await vi.waitFor(() => expect(wire.upstream).toHaveLength(1)); const response = { statusCode: 401, destroy: vi.fn() }, req = { destroy: vi.fn() };
    wire.upstream[0].emit("unexpected-response", req, response); await vi.waitFor(() => expect(f.socket.destroyed).toBe(true)); expect(f.notify).toHaveBeenCalledWith("auth-unavailable"); expect(response.destroy).toHaveBeenCalled();
  });
  it("revalidates scope after a delayed final contract check before forwarding", async () => {
    let watch = false, checks = 0, entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ contractCheck: async () => { if (watch && ++checks === 2) { entered(); await hold; } } });
    await f.open(); watch = true;
    wire.upstream[0].emit("message", Buffer.from(JSON.stringify({ type: "text_reset", root_frame_id: binding.rootFrameId, frame_id: binding.frameId })), false);
    await reached; f.revoke(); release();
    await vi.waitFor(() => expect(wire.browser[0].readyState).toBe(3)); expect(wire.browser[0].sent).toEqual([]);
  });
  it("closes promptly during a hung contract and never connects after it settles", async () => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ contractCheck: async () => { entered(); await hold; } }); await reached;
    await f.bridge.close(); expect(wire.upstream).toEqual([]); release();
    await new Promise<void>(resolve => setImmediate(resolve)); expect(wire.upstream).toEqual([]);
  });
  it("closes a late filter created after the context has already closed", async () => {
    let finish!: (value: ReturnType<typeof createScienceReadWsFilter>) => void;
    const f = fixture({ createFilter: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await f.bridge.close();
    const filter = createScienceReadWsFilter({ binding, revalidate: async () => {} }), close = vi.spyOn(filter, "close"); finish(filter);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1)); expect(wire.upstream).toEqual([]);
  });
  it("counts control pings in the same per-direction rate limit", async () => {
    const f = fixture(); await f.open(); const browser = wire.browser[0], pong = vi.spyOn(browser, "pong");
    for (let n = 0; n < 201; n++) { browser.emit("ping", Buffer.alloc(0)); for (let k = 0; k < 40; k++) await Promise.resolve(); }
    expect(browser.readyState).toBe(3); expect(pong.mock.calls.length).toBeLessThanOrEqual(200);
  });
});
