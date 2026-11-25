import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startScienceReadonlyProxy } from "../science-readonly-proxy.js";
import type { ScienceReadWsAccess } from "../science-read-ws-bridge.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { allowsRead?: unknown; onRequest?(request: http.IncomingMessage, response: http.ServerResponse): void; readWebSocket?: ScienceReadWsAccess; onUnavailable?(reason: string): void } = {}) {
  const calls: string[] = []; let allowed = true;
  const upstream = http.createServer((request, response) => { calls.push(`${request.method} ${request.url}`); if (options.onRequest) options.onRequest(request, response); else response.end("fixed fixture"); });
  upstream.on("upgrade", (_request, socket) => { calls.push("websocket"); socket.destroy(); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => upstream.close(() => resolve())));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("fixture");
  const origin = `http://127.0.0.1:${address.port}`, url = `${origin}/project/fixture`;
  const proxy = await startScienceReadonlyProxy({ origin, resources: [{ url, method: "GET" }, { url, method: "HEAD" }], allowsRead: options.allowsRead as never, readWebSocket: options.readWebSocket, onUnavailable: options.onUnavailable, revalidate: async () => { if (!allowed) throw new Error("private authority failure"); } }); cleanups.push(() => proxy.close());
  const credentials = proxy.challenge("Proxy", proxy.server); if (credentials.response !== "ProvideCredentials") throw new Error("fixture");
  const auth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  const request = (method = "GET", target = url, headers: Record<string,string> = { "proxy-authorization": auth }) => new Promise<number>((resolve, reject) => { const req = http.request(proxy.server, { method, path: target, headers }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); }); req.once("error", reject); req.end(); });
  return { proxy, calls, origin, url, auth, request, revoke: () => { allowed = false; } };
}
describe("single-origin exact read proxy", () => {
  it("requires private Chrome proxy authentication and exact GET/HEAD", async () => {
    const f = await fixture(); expect(await f.request("GET", f.url, {})).toBe(407);
    expect(await f.request()).toBe(200); expect(await f.request("HEAD")).toBe(200);
    for (const [method,url] of [["POST",f.url],["PUT",f.url],["GET",`${f.url}?unknown=1`],["GET","http://169.254.169.254/"]]) expect(await f.request(method,url)).toBe(403);
    expect(f.calls).toEqual(["GET /project/fixture","HEAD /project/fixture"]);
  });
  it("blocks websocket/CONNECT and service worker scripts before any upstream request", async () => {
    const f = await fixture();
    expect(await f.request("GET", f.url, { "proxy-authorization": f.auth, "service-worker": "script" })).toBe(403);
    const target = new URL(f.proxy.server);
    for (const line of [`GET ${f.url} HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: fixed-fixture\r\n\r\n`,"CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: fixture\r\n\r\n"]) {
      const status = await new Promise<string>((resolve,reject) => { const socket=net.createConnection({host:target.hostname,port:Number(target.port)},()=>socket.write(line)); socket.once("data",data=>{resolve(data.toString().split("\r\n")[0]);socket.destroy();});socket.once("error",reject); }); expect(status).toContain("403");
    }
    expect(f.calls).toEqual([]);
  });
  it("revalidates every resource and handles malformed non-ASCII auth without crashing", async () => {
    const f = await fixture(); expect(await f.request("GET",f.url,{"proxy-authorization":"é".repeat(f.auth.length)})).toBe(407);
    f.revoke(); expect(await f.request()).toBe(403); expect(f.calls).toEqual([]);
  });
  it("admits later verified GET cursors while retaining the exact resource fallback", async () => {
    const f = await fixture({ allowsRead: (method: string, url: string) => method === "GET" && new URL(url).pathname === "/project/fixture" && new URL(url).search === "?cursor=2" });
    expect(await f.request("GET", `${f.url}?cursor=2`)).toBe(200); expect(await f.request()).toBe(200);
    expect(await f.request("HEAD", `${f.url}?cursor=2`)).toBe(403); expect(await f.request("GET", `${f.url}?cursor=3`)).toBe(403);
    expect(f.calls).toEqual(["GET /project/fixture?cursor=2", "GET /project/fixture"]);
  });
  it.each([false, "true", { accepted: true }, Promise.resolve(true)])("accepts only strict synchronous true from a function (%j)", async claim => {
    const f = await fixture({ allowsRead: () => claim }); expect(await f.request("GET", `${f.url}?cursor=2`)).toBe(403); expect(f.calls).toEqual([]);
  });
  it("does not restore a capability from JSON or invoke it before method/origin/secret checks", async () => {
    const json = await fixture({ allowsRead: { accepted: true } }); expect(await json.request("GET", `${json.url}?cursor=2`)).toBe(403);
    let calls = 0; const f = await fixture({ allowsRead: () => { calls++; return true; } });
    for (const [method, target] of [["POST", f.url], ["GET", "http://169.254.169.254/"], ["GET", `${f.url}?token=fixture`], ["GET", `${f.url}#fragment`]]) expect(await f.request(method, target)).toBe(403);
    expect(calls).toBe(0); expect(f.calls).toEqual([]);
  });
  it("rechecks authorization after the dynamic capability before any upstream request", async () => {
    let revoke = () => {}; const f = await fixture({ allowsRead: () => { revoke(); return true; } }); revoke = f.revoke;
    expect(await f.request("GET", `${f.url}?cursor=2`)).toBe(403); expect(f.calls).toEqual([]);
  });
  it("buffers a bounded response and rechecks authorization before returning native bytes", async () => {
    let revoke = () => {}; const f = await fixture({ onRequest: (_request, response) => { response.write("private fixture body"); revoke(); response.end(); } }); revoke = f.revoke;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(f.proxy.server, { path: f.url, headers: { "proxy-authorization": f.auth } }, response => { let body = ""; response.on("data", chunk => { body += chunk; }); response.once("end", () => resolve({ status: response.statusCode!, body })); }); request.once("error", reject); request.end();
    });
    expect(result).toEqual({ status: 403, body: "" }); expect(f.calls).toHaveLength(1);
  });
  it("invalidates native 401 with a fixed reason without returning the error body", async () => {
    const reasons: string[] = []; const f = await fixture({ onRequest: (_request, response) => { response.writeHead(401); response.end("private-error-secret"); }, onUnavailable: reason => { reasons.push(reason); } });
    expect(await f.request()).toBe(403); expect(reasons).toEqual(["auth-unavailable"]);
  });
  it("requires private proxy authentication before invoking an optional WS capability", async () => {
    let sessions = 0; const f = await fixture({ readWebSocket: { assertContract: async () => {}, privateSession: async () => { sessions++; return { authCookie: "fake", csrfCookie: "fake" }; }, createFilter: () => { throw new Error("unused"); } } });
    const target = new URL(f.proxy.server);
    const status = await new Promise<string>((resolve, reject) => { const socket = net.createConnection({ host: target.hostname, port: Number(target.port) }, () => socket.write(`GET ${f.origin}/api/ws HTTP/1.1\r\nHost: fixture\r\nOrigin: ${f.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: fixed-fixture\r\n\r\n`)); socket.once("data", data => { resolve(data.toString().split("\r\n")[0]); socket.destroy(); }); socket.once("error", reject); });
    expect(status).toContain("407"); expect(sessions).toBe(0); expect(f.calls).toEqual([]);
  });
});
