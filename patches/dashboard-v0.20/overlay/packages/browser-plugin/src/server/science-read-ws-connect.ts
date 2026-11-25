/** CONNECT is parsed locally as one fixed WS upgrade; no native TCP tunnel exists. */
import http, { type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

interface ConnectDeps {
  authenticated(request: IncomingMessage): boolean;
  revalidate(): Promise<void>;
  assertContract(): Promise<void>;
  upgrade(request: IncomingMessage, socket: Socket, head: Buffer, ready: () => void): void;
}
interface Pending { socket: Socket; done: boolean; parsed: boolean; timer?: ReturnType<typeof setTimeout>; rejectData(): void }
const AUTHORITY = "127.0.0.1:18765", ORIGIN = `http://${AUTHORITY}`;
const failure = () => new Error("science-read-ws-connect-unavailable");
function refuse(socket: Socket, status = 403) {
  if (socket.destroyed) return;
  if (!socket.writable || socket.writableEnded) { socket.destroy(); return; }
  socket.once("error", () => socket.destroy());
  const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="science-private"\r\n' : "";
  socket.end(`HTTP/1.1 ${status} Refused\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}
function singleHeaders(request: IncomingMessage): boolean {
  const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map(value => value.toLowerCase());
  return names.length <= 64 && new Set(names).size === names.length &&
    !["content-length", "transfer-encoding", "expect"].some(key => request.headers[key] !== undefined);
}
function outerAllowed(request: IncomingMessage, head: Buffer): boolean {
  return request.method === "CONNECT" && request.httpVersion === "1.1" && request.url === AUTHORITY &&
    request.headers.host === AUTHORITY && head.length === 0 && singleHeaders(request);
}
function innerTarget(request: IncomingMessage, head: Buffer): string | null {
  if (request.method !== "GET" || request.httpVersion !== "1.1" || request.headers.host !== AUTHORITY || head.length || !singleHeaders(request)) return null;
  if (request.headers.origin !== ORIGIN || request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers.connection?.toLowerCase() !== "upgrade" || request.headers["sec-websocket-version"] !== "13") return null;
  const key = request.headers["sec-websocket-key"], path = request.url;
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key || typeof path !== "string" || path.length > 4096 || !path.startsWith("/api/ws") || path.startsWith("//")) return null;
  try {
    const target = new URL(path, ORIGIN), query = [...target.searchParams];
    if (target.origin !== ORIGIN || target.pathname !== "/api/ws" || target.hash || target.username || target.password || path !== target.pathname + target.search) return null;
    if (query.length && !(query.length === 1 && query[0][0] === "user_id" && query[0][1].length > 0 && query[0][1].length <= 512 && !/[\0\r\n]/.test(query[0][1]))) return null;
    return target.href;
  } catch { return null; }
}

/** The private proxy creates this only for the compiled native origin + real WS lease. */
export function createScienceReadWsConnect(deps: ConnectDeps) {
  if (![deps.authenticated, deps.revalidate, deps.assertContract, deps.upgrade].every(value => typeof value === "function")) throw failure();
  const authenticated = deps.authenticated.bind(deps), revalidate = deps.revalidate.bind(deps), assertContract = deps.assertContract.bind(deps), upgrade = deps.upgrade.bind(deps);
  const pending = new Set<Pending>(), states = new WeakMap<Socket, Pending>();
  let closed = false;
  const cleanup = (state: Pending) => { state.done = true; if (state.timer) clearTimeout(state.timer); state.socket.removeListener("data", state.rejectData); pending.delete(state); };
  const deny = (state: Pending) => { if (state.done) return; cleanup(state); refuse(state.socket); };
  const deadline = (state: Pending, milliseconds: number) => { if (state.timer) clearTimeout(state.timer); state.timer = setTimeout(() => deny(state), milliseconds); state.timer.unref(); };
  const active = async (state: Pending) => {
    for (const check of [revalidate, assertContract, revalidate]) {
      if (closed || state.done || state.socket.destroyed || await check() !== undefined || closed || state.done || state.socket.destroyed) throw failure();
    }
  };
  // Never listen: Node's documented connection injection supplies only the owned socket.
  const parser = http.createServer({ maxHeaderSize: 16 * 1024, insecureHTTPParser: false }, request => { const state = states.get(request.socket); if (state) deny(state); else refuse(request.socket); });
  const denyRequest = (request: IncomingMessage) => { const state = states.get(request.socket); if (state) deny(state); else refuse(request.socket); };
  parser.on("checkContinue", denyRequest); parser.on("checkExpectation", denyRequest); parser.on("connect", denyRequest); parser.on("dropRequest", denyRequest);
  parser.on("clientError", (_error, socket) => { const state = states.get(socket as Socket); if (state) deny(state); else refuse(socket as Socket); });
  parser.on("upgrade", (request, rawSocket, head) => {
    const socket = rawSocket as Socket, state = states.get(socket), target = innerTarget(request, head);
    if (!state || state.done || state.parsed || !target) { if (state) deny(state); else refuse(socket); return; }
    state.parsed = true; socket.on("data", state.rejectData); deadline(state, 15000);
    void active(state).then(() => {
      request.url = target;
      // Keep the quarantine until the existing bridge has installed its WS parser.
      upgrade(request, socket, Buffer.alloc(0), () => { if (closed || state.done || socket.destroyed) throw failure(); cleanup(state); });
    }).catch(() => deny(state));
  });
  parser.maxHeadersCount = 64; parser.maxRequestsPerSocket = 1; parser.timeout = 0;
  return {
    connect(request: IncomingMessage, rawSocket: Socket, head: Buffer) {
      const socket = rawSocket;
      try {
        if (closed || pending.size >= 1 || !outerAllowed(request, head)) { refuse(socket); return; }
        if (!authenticated(request)) { refuse(socket, 407); return; }
      } catch { refuse(socket); return; }
      const state: Pending = { socket, done: false, parsed: false, rejectData: () => deny(state) };
      pending.add(state); states.set(socket, state); socket.once("close", () => cleanup(state)); socket.once("error", () => deny(state));
      socket.on("data", state.rejectData); socket.resume(); deadline(state, 15000);
      void active(state).then(() => {
        socket.pause(); socket.removeListener("data", state.rejectData); deadline(state, 5000);
        parser.emit("connection", socket);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); socket.resume();
      }).catch(() => deny(state));
    },
    close() { closed = true; for (const state of [...pending]) { cleanup(state); state.socket.destroy(); } },
  };
}
