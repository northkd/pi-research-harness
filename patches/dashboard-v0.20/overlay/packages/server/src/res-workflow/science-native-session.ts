/** Host-only private authentication. Import/construction/retain perform no IO.
 * Call only inside the verified Science service mount namespace and cgroup,
 * already the unprivileged application. This module never enters namespaces,
 * changes credentials, starts Science serve, reads checkpoints/config/key files,
 * or grants a task capability. All returned cookie material stays in host code.
 */
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { inspect } from "node:util";

const BINARY = "/opt/pi-claude-science/stdin-20261025/science";
const PRIVATE_HOME = "/home/science/.csswitch/sandbox/home";
const DATA_DIR = `${PRIVATE_HOME}/.claude-science`;
const ORIGIN = "http://127.0.0.1:18765";
const BOOTSTRAP_MS = 10_000;
const CLI_MS = 5_000;
const CACHE_MS = 60_000;
const COOKIE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/;
const PROJECT = /^proj_[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Code = "science-native-session-refused" | "science-native-session-closed" | "science-native-session-deadline" | "science-native-session-cli-invalid" | "science-native-session-authentication-failed";
export class ScienceNativeSessionError extends Error {
  readonly code: Code;
  constructor(code: Code) { super(code); this.name = "ScienceNativeSessionError"; this.code = code; }
}
export interface ScienceSessionTaskBinding { projectId: string; taskId: string; rootFrameId: string; frameId: string }
export interface ScienceSessionSelection {
  readonly ownerKey: string; readonly cwd: string; readonly projectId: string;
  readonly binding?: Readonly<ScienceSessionTaskBinding>;
}
export interface ScienceSessionBrowserBinding extends ScienceSessionSelection { revalidate(): Promise<void> }
type Cookies = { operon_auth: string; operon_csrf: string };
export interface ScienceNativeSessionProviderDeps {
  scope: {
    partition: { ownerKey: string; cwd: string };
    revalidate(): Promise<void>;
  } & ({ binding: ScienceSessionTaskBinding; projectId?: never } | { projectId: string; binding?: never });
  /** Strict void after current owned runtime, alias mount/cgroup, application
   * UID/groups/zero capabilities/NNP, listener and public ELF SHA2139... checks.
   * A receipt/JSON boolean alone does not establish current runtime authority. */
  assertCurrentRuntime(): Promise<void>;
  /** Fresh host authority for this exact owner/canonical cwd/project/task.
   * An explicitly requested project-only browser view is a separate selection. */
  assertScope(selection: ScienceSessionSelection): Promise<void>;
}
export interface ScienceNativeSessionLease {
  privateSession(): Promise<{ authCookie: string; csrfCookie: string }>;
  getPrivateSession(binding: ScienceSessionBrowserBinding): Promise<{
    ownerKey: string; cwd: string; projectId: string; frameId: string | null; cookies: Cookies;
  }>;
  release(): void;
}
export interface ScienceNativeSessionProvider {
  retain(): ScienceNativeSessionLease;
  /** Host calls on an observed 401/invalid-cookie result. This never retries an
   * application request or replays the consumed nonce. Next explicit acquisition
   * may run a fresh CLI url and a new two-request authentication. */
  invalidate(): void;
  close(): void;
}

function requireValue(value: unknown, code: Code = "science-native-session-refused"): asserts value {
  if (!value) throw new ScienceNativeSessionError(code);
}
function safeError(error: unknown, fallback: Code = "science-native-session-refused"): ScienceNativeSessionError {
  return error instanceof ScienceNativeSessionError ? error : new ScienceNativeSessionError(fallback);
}
function privateObject<T extends object>(value: T): Readonly<T> {
  Object.defineProperties(value, {
    [inspect.custom]: { value: () => "[SciencePrivateSession]" },
    toJSON: { value: () => "[SciencePrivateSession]" },
  });
  return Object.freeze(value);
}
function checkedTask(value: ScienceSessionTaskBinding): Readonly<ScienceSessionTaskBinding> {
  requireValue(value && typeof value.projectId === "string" && PROJECT.test(value.projectId)
    && typeof value.rootFrameId === "string" && UUID.test(value.rootFrameId)
    && typeof value.frameId === "string" && UUID.test(value.frameId) && value.taskId === value.rootFrameId);
  return Object.freeze({ projectId: value.projectId, taskId: value.taskId, rootFrameId: value.rootFrameId, frameId: value.frameId });
}
function sameTask(a: ScienceSessionTaskBinding, b: ScienceSessionTaskBinding): boolean {
  return a.projectId === b.projectId && a.taskId === b.taskId && a.rootFrameId === b.rootFrameId && a.frameId === b.frameId;
}
function aborted(signal: AbortSignal): ScienceNativeSessionError {
  return safeError(signal.reason, "science-native-session-closed");
}
function raceSignal<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted(signal));
    signal.addEventListener("abort", stop, { once: true });
    value.then(result => { signal.removeEventListener("abort", stop); resolve(result); }, error => { signal.removeEventListener("abort", stop); reject(safeError(error)); });
    if (signal.aborted) stop();
  });
}
function cliNonce(raw: Buffer): string {
  try {
    requireValue(raw.length <= 16384 && raw.every(byte => byte < 128), "science-native-session-cli-invalid");
    const links = raw.toString("ascii").split(/[\r\n]+/).map(line => line.trim()).filter(line => /^(?:http|https):\/\//.test(line)).map(line => line.split(/\s+/)[0]);
    requireValue(links.length === 1 && links[0].length <= 2048 && /^[\x21-\x7e]+$/.test(links[0]), "science-native-session-cli-invalid");
    const url = new URL(links[0]), entries = [...url.searchParams];
    requireValue(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "18765"
      && !url.username && !url.password && !/^http:\/\/[^/?#]*@/i.test(links[0]) && !url.hash && entries.length === 1 && entries[0][0] === "nonce"
      && /^[A-Za-z0-9._~-]{1,512}$/.test(entries[0][1]), "science-native-session-cli-invalid");
    return entries[0][1];
  } catch { throw new ScienceNativeSessionError("science-native-session-cli-invalid"); }
}
function runUrl(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let finished = false, exited = false, bytes = 0, stderrBytes = 0;
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn> | undefined, forceKill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => finish(new ScienceNativeSessionError("science-native-session-deadline")), CLI_MS);
    const stop = () => finish(aborted(signal));
    function finish(error?: ScienceNativeSessionError) {
      if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (error && child && !exited) {
        try { child.kill("SIGTERM"); } catch { /* Only this owned child; never expose an OS error. */ }
        forceKill = setTimeout(() => { if (!exited) { try { child?.kill("SIGKILL"); } catch { /* Owned child already gone. */ } } }, 250);
      }
      const raw = error ? undefined : Buffer.concat(chunks, bytes);
      for (const chunk of chunks) chunk.fill(0); chunks.length = 0;
      if (error) { reject(error); return; }
      try { resolve(cliNonce(raw!)); } catch (failure) { reject(safeError(failure, "science-native-session-cli-invalid")); }
      finally { raw?.fill(0); }
    }
    try {
      requireValue(!signal.aborted, "science-native-session-closed");
      child = spawn(BINARY, ["url", "--data-dir", DATA_DIR], {
        cwd: "/", env: { HOME: PRIVATE_HOME, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", XDG_CONFIG_HOME: `${PRIVATE_HOME}/.config`, XDG_DATA_HOME: `${PRIVATE_HOME}/.local/share`, XDG_CACHE_HOME: `${PRIVATE_HOME}/.cache`, XDG_STATE_HOME: `${PRIVATE_HOME}/.local/state` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      signal.addEventListener("abort", stop, { once: true });
      child.stdout!.on("data", (value: Buffer) => {
        if (finished) return;
        if (!Buffer.isBuffer(value) || (bytes += value.length) > 16384) { finish(new ScienceNativeSessionError("science-native-session-cli-invalid")); return; }
        chunks.push(Buffer.from(value));
      });
      child.stderr!.on("data", (value: Buffer) => {
        if (!finished && (!Buffer.isBuffer(value) || (stderrBytes += value.length) > 65536)) finish(new ScienceNativeSessionError("science-native-session-cli-invalid"));
      });
      child.stdout!.on("error", () => finish(new ScienceNativeSessionError("science-native-session-cli-invalid")));
      child.stderr!.on("error", () => finish(new ScienceNativeSessionError("science-native-session-cli-invalid")));
      child.on("error", () => finish(new ScienceNativeSessionError("science-native-session-cli-invalid")));
      child.on("close", code => { exited = true; if (forceKill) clearTimeout(forceKill); finish(code === 0 ? undefined : new ScienceNativeSessionError("science-native-session-cli-invalid")); });
      if (signal.aborted) stop();
    } catch { finish(new ScienceNativeSessionError("science-native-session-cli-invalid")); }
  });
}
function responseCookies(headers: string | string[] | undefined): Partial<Cookies> {
  const result: Partial<Cookies> = {};
  requireValue(headers === undefined || Array.isArray(headers), "science-native-session-authentication-failed");
  for (const field of headers ?? []) {
    requireValue(typeof field === "string" && field.length <= 8192, "science-native-session-authentication-failed");
    const pair = field.split(";", 1)[0], separator = pair.indexOf("="), name = pair.slice(0, separator);
    if (name !== "operon_auth" && name !== "operon_csrf") continue;
    const value = pair.slice(separator + 1);
    requireValue(separator > 0 && !Object.hasOwn(result, name) && COOKIE.test(value), "science-native-session-authentication-failed");
    result[name] = value;
  }
  return result;
}
/** Exactly one request per phase; bodies are counted/discarded in memory. */
function authenticate(phase: "nonce" | "csrf", signal: AbortSignal, nonce?: string, auth?: string): Promise<Partial<Cookies>> {
  return new Promise((resolve, reject) => {
    let finished = false, req: ReturnType<typeof httpRequest> | undefined, response: import("node:http").IncomingMessage | undefined;
    let size = 0, contentLength: number | undefined;
    let cookies: Partial<Cookies> = {};
    const body = phase === "nonce" ? Buffer.from(new URLSearchParams({ nonce: nonce!, dest: "/" }).toString(), "ascii") : undefined;
    const stop = () => finish(aborted(signal));
    function finish(error?: ScienceNativeSessionError) {
      if (finished) return; finished = true; signal.removeEventListener("abort", stop); body?.fill(0);
      if (error) {
        try { response?.destroy(); } catch { /* No diagnostic output. */ }
        try { req?.destroy(); } catch { /* No diagnostic output. */ }
        cookies = {}; reject(error);
      } else resolve(cookies);
    }
    try {
      requireValue(!signal.aborted, "science-native-session-closed");
      req = httpRequest({ hostname: "127.0.0.1", port: 18765, method: phase === "nonce" ? "POST" : "GET", path: phase === "nonce" ? "/api/auth/nonce" : "/api/csrf", agent: false, maxHeaderSize: 16384,
        headers: { Origin: ORIGIN, "Accept-Encoding": "identity", ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length } : {}), ...(auth ? { Cookie: `operon_auth=${auth}` } : {}) },
      }, res => {
        response = res;
        res.on("error", () => finish(new ScienceNativeSessionError("science-native-session-authentication-failed")));
        res.on("aborted", () => finish(new ScienceNativeSessionError("science-native-session-authentication-failed")));
        try {
          requireValue(res.statusCode === (phase === "nonce" ? 200 : 204), "science-native-session-authentication-failed");
          const encoding = res.headers["content-encoding"];
          requireValue(encoding === undefined || typeof encoding === "string" && ["", "identity"].includes(encoding.trim().toLowerCase()), "science-native-session-authentication-failed");
          requireValue(phase !== "nonce" || typeof res.headers["content-type"] === "string" && res.headers["content-type"].split(";", 1)[0].trim().toLowerCase() === "text/html", "science-native-session-authentication-failed");
          const declared = res.headers["content-length"];
          if (declared !== undefined) {
            requireValue(typeof declared === "string" && /^\d{1,7}$/.test(declared) && Number(declared) <= 1024 * 1024, "science-native-session-authentication-failed");
            contentLength = Number(declared);
            requireValue(phase !== "csrf" || contentLength === 0, "science-native-session-authentication-failed");
          }
          cookies = responseCookies(res.headers["set-cookie"]);
          requireValue(phase === "nonce" ? !!cookies.operon_auth : !!cookies.operon_csrf, "science-native-session-authentication-failed");
        } catch { finish(new ScienceNativeSessionError("science-native-session-authentication-failed")); return; }
        res.on("data", (chunk: Buffer) => {
          if (!finished && (!Buffer.isBuffer(chunk) || (size += chunk.length) > (phase === "nonce" ? 1024 * 1024 : 0))) finish(new ScienceNativeSessionError("science-native-session-authentication-failed"));
        });
        res.on("end", () => {
          if (!finished) finish(res.complete && (contentLength === undefined || contentLength === size) ? undefined : new ScienceNativeSessionError("science-native-session-authentication-failed"));
        });
      });
      req.on("error", () => finish(new ScienceNativeSessionError("science-native-session-authentication-failed")));
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop(); else req.end(body);
    } catch { finish(new ScienceNativeSessionError("science-native-session-authentication-failed")); }
  });
}

export function createScienceNativeSessionProvider(deps: ScienceNativeSessionProviderDeps): ScienceNativeSessionProvider {
  requireValue(deps && typeof deps.assertCurrentRuntime === "function" && typeof deps.assertScope === "function" && deps.scope && typeof deps.scope.revalidate === "function");
  const { ownerKey, cwd } = deps.scope.partition;
  requireValue(typeof ownerKey === "string" && ownerKey.length > 0 && ownerKey.length <= 512 && !/[\0\r\n]/.test(ownerKey)
    && typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096 && !/[\0\r\n]/.test(cwd));
  const projectOnly = Object.hasOwn(deps.scope, "projectId");
  requireValue(!projectOnly || !Object.hasOwn(deps.scope, "binding") && typeof deps.scope.projectId === "string" && PROJECT.test(deps.scope.projectId));
  const task = projectOnly ? undefined : checkedTask(deps.scope.binding!);
  const projectId = task?.projectId ?? deps.scope.projectId!;
  const selectedTask = Object.freeze({ ownerKey, cwd, projectId, ...(task ? { binding: task } : {}) });
  const runtime = deps.assertCurrentRuntime, authority = deps.assertScope, revalidate = deps.scope.revalidate;
  let closed = false, generation = 0;
  const leases = new Set<symbol>();
  const pending = new Map<symbol, Set<AbortController>>();
  let cache: { cookies: Cookies; until: number } | undefined;
  let flight: { controller: AbortController; promise: Promise<Cookies> } | undefined;
  function abortLease(lease: symbol, code: Code = "science-native-session-closed") {
    const controllers = pending.get(lease); pending.delete(lease);
    for (const controller of controllers ?? []) controller.abort(new ScienceNativeSessionError(code));
  }
  function invalidate(code: Code = "science-native-session-closed") {
    generation++; cache = undefined;
    const previous = flight; flight = undefined;
    previous?.controller.abort(new ScienceNativeSessionError(code));
    for (const lease of [...pending.keys()]) abortLease(lease, code);
  }
  function alive(lease: symbol) { requireValue(!closed && leases.has(lease), "science-native-session-closed"); }
  async function guard(selection: ScienceSessionSelection, signal: AbortSignal, selectedRevalidate?: () => Promise<void>) {
    requireValue(process.getuid?.() === 1000 && process.geteuid?.() === 1000 && process.getgid?.() === 1000 && process.getegid?.() === 1000
      && !process.env.NODE_DEBUG && !process.env.NODE_DEBUG_NATIVE);
    for (const check of [runtime, revalidate, () => authority(selection), ...(selectedRevalidate ? [selectedRevalidate, () => authority(selection)] : [])]) {
      requireValue(await raceSignal(Promise.resolve().then(check), signal) === undefined);
    }
  }
  function ensureSession(selection: ScienceSessionSelection): Promise<Cookies> {
    if (cache && performance.now() < cache.until) return Promise.resolve(cache.cookies);
    cache = undefined;
    if (flight) return flight.promise;
    const epoch = generation, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ScienceNativeSessionError("science-native-session-deadline")), BOOTSTRAP_MS);
    const promise = Promise.resolve().then(async () => {
      await guard(selection, controller.signal);
      const nonce = await runUrl(controller.signal);
      await guard(selection, controller.signal);
      const authenticated = await authenticate("nonce", controller.signal, nonce);
      await guard(selection, controller.signal);
      const csrf = await authenticate("csrf", controller.signal, undefined, authenticated.operon_auth);
      await guard(selection, controller.signal);
      requireValue(epoch === generation && !closed && leases.size > 0 && !controller.signal.aborted, "science-native-session-closed");
      const cookies = { operon_auth: authenticated.operon_auth!, operon_csrf: csrf.operon_csrf! };
      cache = { cookies, until: performance.now() + CACHE_MS };
      return cookies;
    });
    flight = { controller, promise };
    const cleanup = () => { clearTimeout(timer); if (flight?.promise === promise) flight = undefined; };
    promise.then(cleanup, cleanup);
    return promise;
  }
  async function acquire(lease: symbol, selection: ScienceSessionSelection, selectedRevalidate?: () => Promise<void>): Promise<Cookies> {
    alive(lease);
    const epoch = generation, controller = new AbortController();
    const controllers = pending.get(lease) ?? new Set<AbortController>();
    pending.set(lease, controllers); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new ScienceNativeSessionError("science-native-session-deadline")), BOOTSTRAP_MS);
    try {
      await guard(selection, controller.signal, selectedRevalidate); alive(lease);
      const cookies = await raceSignal(ensureSession(selection), controller.signal);
      await guard(selection, controller.signal, selectedRevalidate); alive(lease);
      requireValue(epoch === generation, "science-native-session-closed");
      return cookies;
    } catch (error) { const safe = safeError(error); if (epoch === generation && !closed && leases.has(lease)) invalidate(safe.code); throw safe; }
    finally {
      clearTimeout(timer); controllers.delete(controller);
      if (controllers.size === 0 && pending.get(lease) === controllers) pending.delete(lease);
    }
  }
  return Object.freeze({
    retain() {
      requireValue(!closed, "science-native-session-closed");
      const lease = Symbol(); leases.add(lease);
      return Object.freeze({
        async privateSession() {
          requireValue(task !== undefined);
          const cookies = await acquire(lease, selectedTask);
          return privateObject({ authCookie: cookies.operon_auth, csrfCookie: cookies.operon_csrf });
        },
        async getPrivateSession(value: ScienceSessionBrowserBinding) {
          alive(lease);
          requireValue(value && value.ownerKey === ownerKey && value.cwd === cwd && value.projectId === projectId && typeof value.revalidate === "function");
          const binding = value.binding === undefined ? undefined : checkedTask(value.binding);
          requireValue(!binding || task !== undefined && sameTask(binding, task));
          const selection = Object.freeze({ ownerKey, cwd, projectId, ...(binding ? { binding } : {}) });
          const selectedRevalidate = value.revalidate;
          const cookies = await acquire(lease, selection, selectedRevalidate);
          return privateObject({ ownerKey, cwd, projectId, frameId: binding?.frameId ?? null, cookies: privateObject({ ...cookies }) });
        },
        release() { if (leases.delete(lease)) { abortLease(lease); if (leases.size === 0) invalidate(); } },
      });
    },
    invalidate() { invalidate(); },
    close() { if (!closed) { closed = true; leases.clear(); invalidate(); } },
  });
}
