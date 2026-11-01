/** Private read-only native socket. Browser headers never authorize the upstream. */
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

export type ScienceReadWsDecision = { action: "forward"; message: string } | { action: "drop" | "close"; reason: string };
export interface ScienceReadWsFilter {
  upstreamPath: string;
  hostSubscribe(): Promise<ScienceReadWsDecision>;
  fromBrowser(raw: unknown): Promise<ScienceReadWsDecision>;
  fromServer(raw: unknown): Promise<ScienceReadWsDecision>;
  close(): void;
}
export type ScienceReadUnavailable = "auth-unavailable" | "scope-unavailable" | "stream-unavailable";
export interface ScienceReadWsAccess {
  /** Main's actual contract proof, not a JSON flag. Missing/non-void denies before connect. */
  assertContract(): Promise<void>;
  privateSession(): Promise<{ authCookie: string; csrfCookie: string }>;
  createFilter(): ScienceReadWsFilter | Promise<ScienceReadWsFilter>;
  onUnavailable?(reason: ScienceReadUnavailable): void;
  /** Local per-context capability cleanup; never stop/cancel Science. */
  release?(): void;
}
interface BridgeDeps { origin: string; access: ScienceReadWsAccess; revalidate(): Promise<void> }
const UPSTREAM_PATH = "/api/ws?explicit_subscribe=1", MAX_BYTES = 65536, MAX_BUFFERED = 262144;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/;
const failure = () => new Error("science-read-ws-unavailable");
function browserProtocol(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 4120 || value.includes(",")) throw failure();
  const protocol = value.trim();
  if (!protocol.startsWith("operon-csrf.") || protocol.length <= 12 || !TOKEN.test(protocol)) throw failure();
  return protocol;
}
function hostHeaders(value: { authCookie: string; csrfCookie: string }, origin: string) {
  if (!value || typeof value.authCookie !== "string" || typeof value.csrfCookie !== "string" || !COOKIE.test(value.authCookie) || !COOKIE.test(value.csrfCookie)) throw failure();
  const protocol = `operon-csrf.${decodeURIComponent(value.csrfCookie)}`;
  if (protocol.length > 4120 || !TOKEN.test(protocol)) throw failure();
  return { protocol, headers: { Origin: origin, Cookie: `operon_auth=${value.authCookie}; operon_csrf=${value.csrfCookie}` } };
}
function textMessage(value: unknown, binary: boolean): string | null {
  if (binary || !Buffer.isBuffer(value) || value.length > MAX_BYTES) return null;
  const text = value.toString("utf8"); return Buffer.from(text).equals(value) ? text : null;
}
function refused(socket: Socket, status = 403) { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
function requestAllowed(request: IncomingMessage, origin: URL, head: Buffer) {
  if (request.method !== "GET" || head.length || request.headers.origin !== origin.origin) return false;
  try {
    const target = new URL(request.url ?? "");
    if (!["http:", "ws:"].includes(target.protocol) || target.hostname !== origin.hostname || target.port !== origin.port || target.username || target.password || target.hash || target.pathname !== "/api/ws") return false;
    const query = [...target.searchParams];
    return query.length === 0 || query.length === 1 && query[0][0] === "user_id" && query[0][1].length > 0 && query[0][1].length <= 512 && !/[\0\r\n]/.test(query[0][1]);
  } catch { return false; }
}

export function createScienceReadWsBridge(deps: BridgeDeps) {
  const origin = new URL(deps.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw failure();
  const access = deps.access;
  if (!access || ![access.assertContract, access.privateSession, access.createFilter, deps.revalidate].every(value => typeof value === "function")) throw failure();
  const assertContract = access.assertContract.bind(access), privateSession = access.privateSession.bind(access), createFilter = access.createFilter.bind(access), revalidate = deps.revalidate;
  const notify = access.onUnavailable?.bind(access), release = access.release?.bind(access);
  const states = new Set<{ stop(notify?: ScienceReadUnavailable): void; finished: Promise<void> }>();
  let closed = false;
  const server = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_BYTES, perMessageDeflate: false, skipUTF8Validation: false, autoPong: false,
    handleProtocols: protocols => { const values = [...protocols]; return values.length === 1 ? browserProtocol(values[0]) ?? false : false; },
  });
  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer, onUpgraded?: () => void) {
    try { if (closed || states.size >= 1 || !requestAllowed(request, origin, head)) throw failure(); browserProtocol(request.headers["sec-websocket-protocol"]); }
    catch { refused(socket); return; }
    let ended = false, initializing = true, filter: ScienceReadWsFilter | undefined, upstream: WebSocket | undefined, browser: WebSocket | undefined;
    let pending = 0, tail: Promise<void> = Promise.resolve();
    const waiting: string[] = []; let waitingBytes = 0;
    const budget = { browser: { at: performance.now(), bytes: 0, messages: 0 }, server: { at: performance.now(), bytes: 0, messages: 0 } };
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    const state = { stop, finished }; states.add(state);
    const timer = setTimeout(() => stop("stream-unavailable"), 15000); timer.unref();
    function closeTransport(reason?: ScienceReadUnavailable) {
      try { filter?.close(); } catch { /* Private boundary only. */ }
      upstream?.terminate(); browser?.terminate();
      if (!browser) refused(socket, reason ? 502 : 403); else socket.destroy();
    }
    function releaseLocal() {
      try { release?.(); } catch { /* Local capability cleanup. */ }
    }
    function notifyUnavailable(reason?: ScienceReadUnavailable) {
      if (reason && !closed) { try { notify?.(reason); } catch { /* Sanitized callback boundary. */ } }
    }
    function stop(reason?: ScienceReadUnavailable) {
      if (ended) return; ended = true; clearTimeout(timer); waiting.length = 0;
      closeTransport(reason); releaseLocal(); notifyUnavailable(reason);
      finish(); if (!initializing) states.delete(state);
    }
    async function active() {
      for (const check of [revalidate, assertContract, revalidate]) {
        if (ended || closed || socket.destroyed || await check() !== undefined || ended || closed || socket.destroyed) throw failure();
      }
    }
    function consume(direction: "browser" | "server", bytes: number) {
      const row = budget[direction], now = performance.now();
      if (now - row.at >= 1000) { row.at = now; row.bytes = 0; row.messages = 0; }
      row.bytes += bytes; row.messages++;
      if (row.messages > 200 || row.bytes > 524288) { stop("stream-unavailable"); return false; }
      return true;
    }
    function send(peer: WebSocket, message: string) {
      if (ended || closed || peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > MAX_BUFFERED || Buffer.byteLength(message) > MAX_BYTES) throw failure();
      peer.send(message, { binary: false, compress: false }, error => { if (error) stop("stream-unavailable"); });
    }
    function deliverServer(message: string) {
      if (browser) { send(browser, message); return; }
      if (waiting.length >= 16 || (waitingBytes += Buffer.byteLength(message)) > MAX_BUFFERED) throw failure();
      waiting.push(message);
    }
    async function decision(direction: "browser" | "server", message: string) {
      await active(); const result = await (direction === "server" ? filter!.fromServer(message) : filter!.fromBrowser(message)); await active();
      if (result.action === "close") { stop("stream-unavailable"); return; }
      if (result.action !== "forward") return;
      if (direction === "browser") send(upstream!, result.message);
      else deliverServer(result.message);
    }
    function enqueue(work: () => Promise<void>) {
      if (ended || closed) return;
      if (pending >= 16) { stop("stream-unavailable"); return; }
      pending++; tail = tail.then(async () => { if (!ended && !closed) await work(); }).catch(() => stop("stream-unavailable")).finally(() => { pending--; });
    }
    function receive(direction: "browser" | "server", data: unknown, binary: boolean) {
      const text = textMessage(data, binary);
      if (text === null) { stop("stream-unavailable"); return; }
      if (!consume(direction, Buffer.byteLength(text))) return;
      enqueue(() => decision(direction, text));
    }
    function ping(direction: "browser" | "server", peer: WebSocket, data: Buffer) {
      if (data.length > 125) { stop("stream-unavailable"); return; }
      if (!consume(direction, data.length)) return;
      enqueue(async () => { await active(); if (ended || peer.readyState !== WebSocket.OPEN) throw failure(); peer.pong(data, undefined, error => { if (error) stop("stream-unavailable"); }); });
    }
    async function ready() {
      try {
        await active(); const subscribed = await filter!.hostSubscribe(); await active();
        if (subscribed.action !== "forward") throw failure(); send(upstream!, subscribed.message); clearTimeout(timer);
        server.handleUpgrade(request, socket, Buffer.alloc(0), peer => {
          if (ended || closed) { peer.terminate(); return; }
          browser = peer; peer.on("message", (value, binary) => receive("browser", value, binary)); peer.on("ping", value => ping("browser", peer, value));
          peer.on("close", () => stop()); peer.on("error", () => stop("stream-unavailable"));
          if (onUpgraded && onUpgraded() !== undefined) throw failure();
          enqueue(async () => { for (const message of waiting.splice(0)) { await active(); send(peer, message); } waitingBytes = 0; });
        });
      } catch { stop("scope-unavailable"); }
    }
    socket.once("close", () => stop()); socket.once("error", () => stop("stream-unavailable"));
    void (async () => {
      try {
        await active(); const selected = await createFilter();
        if (ended || closed || socket.destroyed) { selected?.close(); throw failure(); }
        filter = selected;
        if (!filter || filter.upstreamPath !== UPSTREAM_PATH || ![filter.hostSubscribe, filter.fromBrowser, filter.fromServer, filter.close].every(value => typeof value === "function")) throw failure();
        await active(); const session = await privateSession(); await active(); const credentials = hostHeaders(session, origin.origin);
        const target = new URL(UPSTREAM_PATH, origin.origin); target.protocol = "ws:";
        upstream = new WebSocket(target.href, [credentials.protocol], { headers: credentials.headers, handshakeTimeout: 5000, maxPayload: MAX_BYTES, followRedirects: false, perMessageDeflate: false, skipUTF8Validation: false, autoPong: false });
        upstream.on("open", () => { void ready(); }); upstream.on("message", (value, binary) => receive("server", value, binary)); upstream.on("ping", value => ping("server", upstream!, value));
        upstream.on("close", () => stop("stream-unavailable")); upstream.on("error", () => stop("stream-unavailable"));
        upstream.on("unexpected-response", (req, response) => { response.destroy(); req.destroy(); stop(response.statusCode === 401 || response.statusCode === 403 ? "auth-unavailable" : "stream-unavailable"); });
      } catch { stop("scope-unavailable"); }
      finally { initializing = false; if (ended) { states.delete(state); finish(); } }
    })();
  }
  return { upgrade, async close() { if (closed) return; closed = true; const pending = [...states]; for (const state of pending) state.stop(); await Promise.allSettled(pending.map(state => state.finished)); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
