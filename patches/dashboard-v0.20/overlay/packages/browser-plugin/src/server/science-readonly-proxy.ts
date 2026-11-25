/** One private Chrome context -> one fixed Science origin. No arbitrary forwarding. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { createScienceReadWsBridge, type ScienceReadUnavailable, type ScienceReadWsAccess } from "./science-read-ws-bridge.js";
import { createScienceReadWsConnect } from "./science-read-ws-connect.js";

export interface ScienceReadResource { url: string; method: "GET" | "HEAD" }
export interface ScienceReadonlyProxyDeps {
  origin: string;
  resources: readonly ScienceReadResource[];
  revalidate(): Promise<void>;
  allowsRead?(method: "GET" | "HEAD", url: string): boolean;
  readWebSocket?: ScienceReadWsAccess;
  onUnavailable?(reason: ScienceReadUnavailable): void;
}
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const HEADERS = new Set(["accept", "accept-language", "user-agent", "cookie", "if-none-match", "if-modified-since", "range", "cache-control", "pragma", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
async function receiveRead(result: http.IncomingMessage, response: http.ServerResponse, revalidate: () => Promise<void>, unavailable: (reason: ScienceReadUnavailable) => void) {
  try {
    if (result.statusCode === 401 || result.statusCode === 403) { unavailable("auth-unavailable"); throw new Error("science-readonly-unavailable"); }
    if (Number(result.headers["content-length"] ?? 0) > MAX_RESOURCE_BYTES) throw new Error("science-readonly-unavailable");
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      result.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_RESOURCE_BYTES) { result.destroy(); reject(new Error("science-readonly-unavailable")); } else chunks.push(chunk); });
      result.once("end", () => resolve(Buffer.concat(chunks, size))); result.once("error", reject); result.once("aborted", () => reject(new Error("science-readonly-unavailable")));
    });
    await revalidate();
    if (response.destroyed) return;
    response.writeHead(result.statusCode ?? 502, result.headers); response.end(bytes);
  } catch { result.destroy(); unavailable("stream-unavailable"); if (!response.headersSent) response.writeHead(403, { "cache-control": "no-store" }); response.end(); }
}
export async function startScienceReadonlyProxy(deps: ScienceReadonlyProxyDeps) {
  const origin = new URL(deps.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password || origin.href !== `${origin.origin}/` && origin.href !== origin.origin || deps.resources.length > 512) throw new Error("science-readonly-origin-invalid");
  const resources = new Set<string>();
  for (const resource of deps.resources) {
    const url = new URL(resource.url);
    if (!["GET", "HEAD"].includes(resource.method) || resource.url.length > 4096 || url.origin !== origin.origin || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /nonce|token|secret|api.?key|authorization/i.test(key))) throw new Error("science-readonly-resource-invalid");
    resources.add(`${resource.method} ${url.href}`);
  }
  const password = randomBytes(32).toString("base64url");
  const authentication = `Basic ${Buffer.from(`science:${password}`).toString("base64")}`;
  const authenticationBytes = Buffer.from(authentication);
  const sockets = new Set<Socket>();
  let pending = 0, closed = false;
  let reported = false;
  const checkScope = deps.revalidate;
  const onUnavailable = deps.onUnavailable;
  const allowsRead = typeof deps.allowsRead === "function" ? deps.allowsRead.bind(deps) : undefined;
  const unavailable = (reason: ScienceReadUnavailable) => { if (closed || reported) return; reported = true; try { onUnavailable?.(reason); } catch { /* Sanitized host callback only. */ } };
  const authenticated = (request: http.IncomingMessage) => { const supplied = request.headers["proxy-authorization"]; return typeof supplied === "string" && Buffer.byteLength(supplied) === authenticationBytes.length && timingSafeEqual(Buffer.from(supplied), authenticationBytes); };
  const revalidate = async () => { if (closed || await checkScope() !== undefined || closed) throw new Error("science-readonly-scope-unavailable"); };
  const wsAccess = deps.readWebSocket;
  const wsUnavailable = wsAccess?.onUnavailable?.bind(wsAccess);
  const bridge = wsAccess ? createScienceReadWsBridge({ origin: origin.origin, access: {
    assertContract: wsAccess.assertContract.bind(wsAccess), privateSession: wsAccess.privateSession.bind(wsAccess), createFilter: wsAccess.createFilter.bind(wsAccess), release: wsAccess.release?.bind(wsAccess),
    onUnavailable: reason => { try { wsUnavailable?.(reason); } finally { unavailable(reason); } },
  }, revalidate }) : undefined;
  const blocked = (response: http.ServerResponse) => { if (!response.headersSent) response.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" }); response.end("science-readonly-denied"); };
  const permitted = async (method: "GET" | "HEAD", target: URL) => {
    await revalidate(); const result = resources.has(`${method} ${target.href}`) || allowsRead?.(method, target.href) === true; await revalidate(); return result;
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    if (!authenticated(request)) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="science-private"', "cache-control": "no-store" }); response.end(); return;
    }
    if (closed || pending >= 16 || !["GET", "HEAD"].includes(request.method ?? "") || request.headers.upgrade || request.headers["sec-websocket-key"] || request.headers["service-worker"] || request.headers["sec-fetch-dest"] === "serviceworker" || request.headers["transfer-encoding"] || request.headers["content-length"] && request.headers["content-length"] !== "0") { blocked(response); return; }
    let target: URL;
    try { target = new URL(request.url ?? ""); } catch { blocked(response); return; }
    if (target.href.length > 4096 || target.origin !== origin.origin || target.username || target.password || target.hash || [...target.searchParams.keys()].some(key => /nonce|token|secret|api.?key|authorization/i.test(key))) { blocked(response); return; }
    pending++;
    const completed = new Promise<void>(resolve => { response.once("finish", resolve); response.once("close", resolve); });
    void permitted(request.method as "GET" | "HEAD", target).then(allowed => {
      if (!allowed) { blocked(response); return; }
      if (closed || response.destroyed) { response.destroy(); return; }
      const headers: http.OutgoingHttpHeaders = { host: origin.host };
      for (const [key, value] of Object.entries(request.headers)) if (HEADERS.has(key) && typeof value === "string") headers[key] = value;
      const upstream = http.request(target, { method: request.method, headers, timeout: 5000 }, result => { void receiveRead(result, response, revalidate, unavailable); });
      const deadline = setTimeout(() => upstream.destroy(new Error("science-readonly-unavailable")), 5000); deadline.unref();
      response.once("close", () => clearTimeout(deadline)); response.once("finish", () => clearTimeout(deadline));
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("upgrade", (_result, socket) => { socket.destroy(); blocked(response); });
      upstream.on("error", () => { unavailable("stream-unavailable"); if (!response.headersSent) { response.writeHead(502, { "cache-control": "no-store" }); response.end("science-readonly-unavailable"); } else response.destroy(); });
      response.on("close", () => upstream.destroy()); request.on("aborted", () => upstream.destroy()); upstream.end();
    }).catch(() => { unavailable("scope-unavailable"); blocked(response); }).then(() => completed).finally(() => { pending--; });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const connect = bridge && wsAccess && origin.origin === "http://127.0.0.1:18765" ? createScienceReadWsConnect({ authenticated, revalidate, assertContract: wsAccess.assertContract.bind(wsAccess), upgrade: (request, socket, head, ready) => bridge.upgrade(request, socket, head, ready) }) : undefined;
  server.on("connect", (request, socket, head) => { if (connect) connect.connect(request, socket as Socket, head); else socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
  server.on("upgrade", (request, socket, head) => {
    if (!bridge) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    if (!authenticated(request)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="science-private"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    bridge.upgrade(request, socket as Socket, head);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.maxConnections = 32; server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("science-readonly-proxy-unavailable");
  const proxyOrigin = `http://127.0.0.1:${address.port}`;
  return {
    server: proxyOrigin,
    /** Only for the private host's Fetch.authRequired handler, never browser JS/wire. */
    challenge(source: string, challengeOrigin: string) {
      return source === "Proxy" && challengeOrigin === proxyOrigin ? { response: "ProvideCredentials" as const, username: "science", password } : { response: "CancelAuth" as const };
    },
    async close() { closed = true; connect?.close(); for (const socket of sockets) socket.destroy(); await bridge?.close(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
