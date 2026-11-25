import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ upgrade: vi.fn(), bridgeClose: vi.fn(async () => {}) }));
vi.mock("../science-read-ws-bridge.js", () => ({ createScienceReadWsBridge: () => ({ upgrade: fake.upgrade, close: fake.bridgeClose }) }));
import { startScienceReadonlyProxy } from "../science-readonly-proxy.js";

const authority = "127.0.0.1:18765", origin = `http://${authority}`;
class Wire extends Duplex {
  readonly output: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.output.push(Buffer.from(chunk)); callback(); }
  send(value: string | Buffer) { this.push(Buffer.from(value)); }
  text() { return Buffer.concat(this.output).toString("utf8"); }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}
const servers: http.Server[] = [], sockets: Wire[] = [], cleanups: (() => Promise<void>)[] = [];
const originalCreate = http.createServer;
const settle = async () => { for (let step = 0; step < 15; step++) await new Promise<void>(resolve => process.nextTick(resolve)); };
beforeEach(() => {
  vi.clearAllMocks(); fake.upgrade.mockImplementation((_request, _socket, _head, ready?: () => void) => ready?.());
  vi.spyOn(http, "createServer").mockImplementation((...args: Parameters<typeof http.createServer>) => { const server = originalCreate(...args); servers.push(server); return server; });
  vi.spyOn(http.Server.prototype, "listen").mockImplementation(function(this: http.Server, ...args: unknown[]) { const ready = args.findLast(value => typeof value === "function"); if (typeof ready === "function") ready.call(this); return this; });
  vi.spyOn(http.Server.prototype, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 9000 });
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("real-http-forbidden"); });
  vi.spyOn(net, "connect").mockImplementation(() => { throw new Error("real-net-forbidden"); });
  vi.spyOn(net, "createConnection").mockImplementation(() => { throw new Error("real-net-forbidden"); });
});
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); for (const close of cleanups.splice(0).reverse()) await close(); servers.splice(0); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(options: { origin?: string; ws?: boolean } = {}) {
  const scope = vi.fn(async (): Promise<void> => {}), contract = vi.fn(async (): Promise<void> => {});
  const proxy = await startScienceReadonlyProxy({ origin: options.origin ?? origin, resources: [], revalidate: scope,
    readWebSocket: options.ws === false ? undefined : { assertContract: contract, privateSession: async () => { throw new Error("fake-session-not-used"); }, createFilter: () => { throw new Error("fake-filter-not-used"); } } });
  cleanups.push(() => proxy.close()); const outer = servers[0]; const challenge = proxy.challenge("Proxy", proxy.server);
  if (challenge.response !== "ProvideCredentials") throw new Error("fixture");
  const authorization = `Basic ${Buffer.from(`${challenge.username}:${challenge.password}`).toString("base64")}`;
  const open = async (target = authority, auth: string | null = authorization, head = "", host = target) => {
    const wire = new Wire(); wire.on("error", () => {}); sockets.push(wire); outer.emit("connection", wire);
    wire.send(`CONNECT ${target} HTTP/1.1\r\nHost: ${host}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n${head}`); await settle(); return wire;
  };
  return { proxy, outer, scope, contract, authorization, open };
}
function upgrade(overrides: { path?: string; host?: string; origin?: string; extra?: string; key?: string; method?: string } = {}) {
  return `${overrides.method ?? "GET"} ${overrides.path ?? "/api/ws?user_id=fixture"} HTTP/1.1\r\nHost: ${overrides.host ?? authority}\r\nOrigin: ${overrides.origin ?? origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${overrides.key ?? "dGhlIHNhbXBsZSBub25jZQ=="}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: operon-csrf.fixture\r\n${overrides.extra ?? ""}\r\n`;
}

describe("fixed native CONNECT to a local one-upgrade parser", () => {
  it("accepts only the fixed authenticated CONNECT and normalizes an inner origin-form websocket for the existing bridge", async () => {
    const f = await fixture(); const wire = await f.open(); expect(wire.text()).toContain("200 Connection Established");
    wire.send(upgrade()); await settle(); expect(fake.upgrade).toHaveBeenCalledOnce();
    expect(fake.upgrade.mock.calls[0][0].url).toBe(`${origin}/api/ws?user_id=fixture`);
    expect(fake.upgrade.mock.calls[0][2]).toEqual(Buffer.alloc(0)); expect(f.scope.mock.calls.length).toBeGreaterThanOrEqual(4); expect(f.contract.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(http.request).not.toHaveBeenCalled(); expect(net.connect).not.toHaveBeenCalled(); expect(net.createConnection).not.toHaveBeenCalled();
    expect(http.Server.prototype.listen).toHaveBeenCalledOnce();
  });

  it.each(["localhost:18765", "127.0.0.1:443", "127.0.0.1:18766", "[::1]:18765", "user@127.0.0.1:18765"])("rejects other CONNECT targets %s before any host capability", async target => {
    const f = await fixture(); const wire = await f.open(target); expect(wire.text()).toContain("403"); expect(f.contract).not.toHaveBeenCalled(); expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it("challenges missing private proxy authentication before reading scope and rejects a mismatched Host", async () => {
    const f = await fixture(); const missing = await f.open(authority, null);
    expect(missing.text()).toContain("407"); expect(missing.text()).toContain("Proxy-Authenticate: Basic"); expect(f.scope).not.toHaveBeenCalled();
    const mismatch = await f.open(authority, f.authorization, "", "localhost:18765"); expect(mismatch.text()).toContain("403"); expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it("rejects already buffered outer payload and never grants CONNECT without the fixed origin or WS contract", async () => {
    let f = await fixture(); let wire = await f.open(authority, f.authorization, upgrade()); expect(wire.text()).toContain("403"); expect(fake.upgrade).not.toHaveBeenCalled();
    await f.proxy.close(); cleanups.pop(); servers.splice(0); f = await fixture({ ws: false }); wire = await f.open(); expect(wire.text()).toContain("403");
    await f.proxy.close(); cleanups.pop(); servers.splice(0); f = await fixture({ origin: "http://127.0.0.1:18888" }); wire = await f.open(); expect(wire.text()).toContain("403");
  });

  it.each([
    { path: "/api/projects" }, { path: "/api/ws?token=fixture" }, { path: `${origin}/api/ws` }, { host: "localhost:18765" }, { origin: "http://example.invalid" },
    { method: "POST" }, { key: "not-a-key" }, { extra: "Content-Length: 0\r\n" }, { extra: "Transfer-Encoding: chunked\r\n" }, { extra: `Host: ${authority}\r\n` },
  ])("rejects other inner messages %j without reaching the bridge", async options => {
    const f = await fixture(); const wire = await f.open(); wire.send(upgrade(options)); await settle(); expect(wire.text()).toContain("403"); expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it.each(["GET / HTTP/1.1\r\nHost: 127.0.0.1:18765\r\n\r\n", "CONNECT 127.0.0.1:18765 HTTP/1.1\r\nHost: 127.0.0.1:18765\r\n\r\n", Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00])])("rejects ordinary HTTP, nested CONNECT and TLS", async bytes => {
    const f = await fixture(); const wire = await f.open(); wire.send(bytes); await settle(); expect(wire.destroyed || wire.text().includes("403")).toBe(true); expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it("rejects both same-packet and later pipelined bytes before the existing bridge completes its browser handshake", async () => {
    const f = await fixture(); let wire = await f.open(); wire.send(`${upgrade()}GET /extra HTTP/1.1\r\nHost: ${authority}\r\n\r\n`); await settle(); expect(fake.upgrade).not.toHaveBeenCalled();
    fake.upgrade.mockImplementation(() => {}); wire = await f.open(); wire.send(upgrade()); await settle(); expect(fake.upgrade).toHaveBeenCalledOnce();
    wire.send(`GET /extra HTTP/1.1\r\nHost: ${authority}\r\n\r\n`); await settle(); expect(wire.destroyed).toBe(true); expect(http.request).not.toHaveBeenCalled();
  });

  it("requires strict fresh scope and contract before CONNECT and again before bridge handoff", async () => {
    const f = await fixture(); f.contract.mockResolvedValueOnce(true as never); let wire = await f.open(); expect(wire.text()).toContain("403"); expect(wire.text()).not.toContain("200 Connection Established");
    wire = await f.open(); expect(wire.text()).toContain("200 Connection Established"); f.scope.mockRejectedValueOnce(new Error("private-authority-token")); wire.send(upgrade()); await settle();
    expect(fake.upgrade).not.toHaveBeenCalled(); expect(wire.text()).not.toContain("private-authority-token");
  });

  it("bounds silent inner headers and closes pending admissions without replay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); const f = await fixture(); const wire = await f.open(); expect(wire.text()).toContain("200 Connection Established");
    await vi.advanceTimersByTimeAsync(5001); await settle(); expect(wire.destroyed).toBe(true); expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it("rejects separately arriving payload before the outer scope check finishes and ignores a late approval", async () => {
    const f = await fixture(); let release: (() => void) | undefined;
    f.scope.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const wire = await f.open(); expect(wire.text()).not.toContain("200 Connection Established");
    wire.send(upgrade()); await settle(); expect(wire.destroyed).toBe(true); release?.(); await settle();
    expect(wire.text()).not.toContain("200 Connection Established"); expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it("accepts fragmented inner headers through the real in-memory HTTP parser", async () => {
    const f = await fixture(); const wire = await f.open(); const packet = upgrade();
    wire.send(packet.slice(0, 33)); await settle(); expect(fake.upgrade).not.toHaveBeenCalled();
    wire.send(packet.slice(33)); await settle(); expect(fake.upgrade).toHaveBeenCalledOnce();
    expect(fake.upgrade.mock.calls[0][0].url).toBe(`${origin}/api/ws?user_id=fixture`); expect(http.request).not.toHaveBeenCalled();
  });

  it("leaves later transport errors to the existing WS bridge after handoff", async () => {
    const f = await fixture(); const wire = await f.open(); wire.send(upgrade()); await settle(); expect(fake.upgrade).toHaveBeenCalledOnce();
    wire.emit("error", new Error("private-after-handoff")); await settle(); expect(wire.text()).not.toContain("403"); expect(wire.text()).not.toContain("private-after-handoff");
  });
});
