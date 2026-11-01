import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), request: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:http", () => ({ request: mocks.request }));
import { createScienceNativeSessionProvider } from "../science-native-session.js";

const PROJECT = "proj_0123456789ab";
const FRAME = "10000000-0000-4000-8000-000000000001";
const binding = { projectId: PROJECT, taskId: FRAME, rootFrameId: FRAME, frameId: FRAME };
const partition = { ownerKey: "fixture-owner", cwd: "/fixture/canonical" };
const RAW = "http://localhost:18765/?nonce=fixture-private-nonce\n";
const PRIVATE = "fixture-private-auth";
const CSRF = "fixture-private-csrf";

class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter();
  kill = vi.fn(() => { queueMicrotask(() => this.emit("close", null, "SIGTERM")); return true; });
}
class Response extends EventEmitter {
  complete = true;
  destroy = vi.fn();
  statusCode: number;
  headers: Record<string, string | string[]>;
  constructor(statusCode: number, headers: Record<string, string | string[]> = {}) { super(); this.statusCode = statusCode; this.headers = headers; }
}
class Request extends EventEmitter {
  destroy = vi.fn();
  end = vi.fn();
}
type Plan = { status?: number; headers?: Record<string, string | string[]>; data?: Buffer; incomplete?: boolean; hold?: boolean; error?: boolean };
let children: Child[], requests: Request[], responses: Response[], plans: Plan[], cliPlans: Array<(child: Child) => void>;
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function dependencies() {
  return {
    scope: { partition: { ...partition }, binding: { ...binding }, revalidate: vi.fn(async () => {}) },
    assertCurrentRuntime: vi.fn(async () => {}),
    assertScope: vi.fn(async (_selection: unknown) => {}),
  };
}
function browser(task = true) {
  return { ...partition, projectId: PROJECT, revalidate: vi.fn(async () => {}), ...(task ? { binding: { ...binding } } : {}) };
}
function authPlans(): Plan[] {
  return [
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "set-cookie": [`operon_auth=${PRIVATE}; Path=/; HttpOnly`] }, data: Buffer.from("<html>fixture</html>") },
    { status: 204, headers: { "set-cookie": [`operon_csrf=${CSRF}; Path=/`] } },
  ];
}

beforeEach(() => {
  children = []; requests = []; responses = []; plans = authPlans(); cliPlans = [];
  vi.spyOn(process, "getuid").mockReturnValue(1000); vi.spyOn(process, "geteuid").mockReturnValue(1000);
  vi.spyOn(process, "getgid").mockReturnValue(1000); vi.spyOn(process, "getegid").mockReturnValue(1000);
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new Child(); children.push(child);
    const next = cliPlans.shift();
    queueMicrotask(() => { if (next) next(child); else { child.stdout.emit("data", Buffer.from(RAW)); child.emit("close", 0, null); } });
    return child;
  });
  mocks.request.mockReset().mockImplementation((_options, callback) => {
    const req = new Request(); requests.push(req);
    const plan = plans.shift();
    req.end.mockImplementation(() => queueMicrotask(() => {
      if (!plan || plan.hold) return;
      if (plan.error) { req.emit("error", new Error("fixture-private-error")); return; }
      const res = new Response(plan.status ?? 200, plan.headers); responses.push(res); res.complete = !plan.incomplete;
      callback(res);
      queueMicrotask(() => { if (plan.data) res.emit("data", plan.data); res.emit("end"); });
    }));
    return req;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("host-only private native session", () => {
  it("bounds a stalled final browser-binding check by the whole acquisition deadline", async () => {
    vi.useFakeTimers();
    const selected = browser();
    let checks = 0, finishBindingCheck: (() => void) | undefined;
    selected.revalidate.mockImplementation(async () => {
      if (++checks === 2) await new Promise<void>(resolve => { finishBindingCheck = resolve; });
    });
    const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
    const pending = lease.getPrivateSession(selected).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(finishBindingCheck).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ code: "science-native-session-deadline" });
    finishBindingCheck!(); lease.release(); provider.close();
  });

  it("last release aborts a stalled final browser-binding check promptly", async () => {
    const selected = browser();
    let checks = 0, finishBindingCheck: (() => void) | undefined;
    selected.revalidate.mockImplementation(async () => {
      if (++checks === 2) await new Promise<void>(resolve => { finishBindingCheck = resolve; });
    });
    const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
    let settled = false;
    const pending = lease.getPrivateSession(selected).catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(finishBindingCheck).toBeTypeOf("function"));
    lease.release(); await settle();
    const promptlyClosed = settled;
    finishBindingCheck!();
    expect(await pending).toMatchObject({ code: "science-native-session-closed" });
    provider.close(); expect(promptlyClosed).toBe(true);
  });

  it("refuses cookies when live scope expires during the final browser-binding revalidation", async () => {
    const deps = dependencies(); let live = true;
    deps.assertScope.mockImplementation(async () => { if (!live) throw new Error("synthetic grant expired"); });
    const selected = browser(); let checks = 0, finishBindingCheck: (() => void) | undefined;
    selected.revalidate.mockImplementation(async () => {
      if (++checks === 2) await new Promise<void>(resolve => { finishBindingCheck = resolve; });
    });
    const provider = createScienceNativeSessionProvider(deps), lease = provider.retain();
    const pending = lease.getPrivateSession(selected).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(finishBindingCheck).toBeTypeOf("function"));
    live = false; finishBindingCheck!();
    const result = await pending; lease.release(); provider.close();
    expect(result).toMatchObject({ error: { code: "science-native-session-refused" } }); expect(result).not.toHaveProperty("value");
  });

  it.each(["invalidate", "close"] as const)("%s aborts a stalled final guard and only a later explicit acquisition can authenticate again", async action => {
    const selected = browser(); let checks = 0, finishBindingCheck: (() => void) | undefined;
    selected.revalidate.mockImplementation(async () => {
      if (++checks === 2) await new Promise<void>(resolve => { finishBindingCheck = resolve; });
    });
    const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
    let settled = false;
    const pending = lease.getPrivateSession(selected).catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(finishBindingCheck).toBeTypeOf("function"));
    provider[action](); await settle();
    const promptlyClosed = settled;
    finishBindingCheck!(); expect(await pending).toMatchObject({ code: "science-native-session-closed" });
    expect(promptlyClosed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(2);
    if (action === "invalidate") {
      plans.push(...authPlans()); await lease.privateSession();
      expect(mocks.spawn).toHaveBeenCalledTimes(2); expect(mocks.request).toHaveBeenCalledTimes(4);
    } else await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-closed" });
    lease.release(); provider.close();
  });

  it("constructs and retains without any CLI or HTTP", () => {
    const provider = createScienceNativeSessionProvider(dependencies());
    const lease = provider.retain();
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
    lease.release(); provider.close();
  });

  it("shares one bounded authentication across driver/browser leases with fixed alias and loopback", async () => {
    const deps = dependencies(), provider = createScienceNativeSessionProvider(deps);
    const a = provider.retain(), b = provider.retain();
    const [native, material] = await Promise.all([a.privateSession(), b.getPrivateSession(browser())]);
    expect(native.authCookie === PRIVATE && native.csrfCookie === CSRF).toBe(true);
    expect(material.cookies.operon_auth === PRIVATE && material.cookies.operon_csrf === CSRF).toBe(true);
    expect(material.frameId === FRAME && material.ownerKey === partition.ownerKey).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(2);
    const [file, argv, options] = mocks.spawn.mock.calls[0];
    expect(file).toBe("/opt/pi-claude-science/stdin-20261025/science");
    expect(argv).toEqual(["url", "--data-dir", "/home/science/.csswitch/sandbox/home/.claude-science"]);
    expect(options.cwd).toBe("/"); expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env.HOME).toBe("/home/science/.csswitch/sandbox/home");
    expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
    for (const [request] of mocks.request.mock.calls) {
      expect(request.hostname).toBe("127.0.0.1"); expect(request.port).toBe(18765);
      expect(request.headers.Origin).toBe("http://127.0.0.1:18765"); expect(request.agent).toBe(false);
    }
    expect(mocks.request.mock.calls.map(([r]) => [r.method, r.path])).toEqual([["POST", "/api/auth/nonce"], ["GET", "/api/csrf"]]);
    expect(deps.assertScope.mock.calls.every(([selection]) => (selection as typeof binding).projectId === PROJECT)).toBe(true);
    const safe = inspect(native) + JSON.stringify(native) + inspect(material) + JSON.stringify(material);
    expect([PRIVATE, CSRF, "fixture-private-nonce"].some(secret => safe.includes(secret))).toBe(false);
    a.release(); b.release(); provider.close();
  });

  it("retains cache for a second lease, erases it on the last release, then obtains a new CLI nonce", async () => {
    const provider = createScienceNativeSessionProvider(dependencies()), a = provider.retain(), b = provider.retain();
    await a.privateSession(); a.release(); await b.privateSession();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    b.release(); plans.push(...authPlans()); const c = provider.retain(); await c.privateSession();
    expect(mocks.spawn).toHaveBeenCalledTimes(2); c.release(); provider.close();
  });

  it("releasing one in-flight lease does not abort the other lease's shared authentication", async () => {
    let childReady: Child | undefined;
    cliPlans.push(child => { childReady = child; });
    const provider = createScienceNativeSessionProvider(dependencies()), a = provider.retain(), b = provider.retain();
    const first = a.privateSession().catch((error: unknown) => error), second = b.privateSession();
    await settle(); a.release();
    childReady!.stdout.emit("data", Buffer.from(RAW)); childReady!.emit("close", 0, null);
    expect(await first).toMatchObject({ code: "science-native-session-closed" });
    expect((await second).authCookie === PRIVATE).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(2);
    b.release(); provider.close();
  });

  it("does not expose a raw stdout/stderr stream error", async () => {
    for (const name of ["stdout", "stderr"] as const) {
      cliPlans.push(child => child[name].emit("error", new Error("fixture-private-stream-error")));
      const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
      const error = await lease.privateSession().catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "science-native-session-cli-invalid" });
      expect(String(error).includes("fixture-private-stream-error")).toBe(false);
      expect(mocks.request).not.toHaveBeenCalled(); lease.release(); provider.close();
    }
  });

  it("invalidates cookies explicitly without reusing a consumed nonce", async () => {
    const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
    await lease.privateSession(); provider.invalidate();
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(2);
    plans.push(...authPlans()); await lease.privateSession();
    expect(mocks.spawn).toHaveBeenCalledTimes(2); expect(mocks.request).toHaveBeenCalledTimes(4);
    lease.release(); provider.close();
  });

  it("expires short-lived memory cookies instead of persisting them", async () => {
    vi.useFakeTimers();
    const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
    await lease.privateSession(); vi.advanceTimersByTime(60_001); plans.push(...authPlans()); await lease.privateSession();
    expect(mocks.spawn).toHaveBeenCalledTimes(2); lease.release(); provider.close();
  });

  it("rejects foreign owner/cwd/task bindings before CLI or HTTP", async () => {
    const provider = createScienceNativeSessionProvider(dependencies()), lease = provider.retain();
    for (const wrong of [{ ...browser(), ownerKey: "other" }, { ...browser(), cwd: "/other" }, { ...browser(), binding: { ...binding, frameId: "20000000-0000-4000-8000-000000000002" } }]) {
      await expect(lease.getPrivateSession(wrong)).rejects.toMatchObject({ code: "science-native-session-refused" });
    }
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); lease.release(); provider.close();
  });

  it("supports only an explicitly revalidated same-project workspace view", async () => {
    const deps = dependencies(), provider = createScienceNativeSessionProvider(deps), lease = provider.retain(), selected = browser(false);
    const result = await lease.getPrivateSession(selected);
    expect(result.frameId).toBeNull(); expect(selected.revalidate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deps.assertScope.mock.calls.some(([selection]) => !Object.hasOwn(selection as object, "binding"))).toBe(true);
    lease.release(); provider.close();
  });

  it("requires strict void runtime and scope proofs, and the application uid", async () => {
    for (const field of ["assertCurrentRuntime", "assertScope"] as const) {
      const deps = dependencies(); deps[field] = vi.fn(async () => true) as never;
      const p = createScienceNativeSessionProvider(deps), lease = p.retain();
      await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-refused" }); lease.release(); p.close();
    }
    vi.mocked(process.geteuid!).mockReturnValue(0);
    const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
    await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-refused" });
    expect(mocks.spawn).not.toHaveBeenCalled(); lease.release(); p.close();
  });

  it("revalidates after bootstrap and withholds cookies if scope was revoked", async () => {
    const deps = dependencies(); let denied = false;
    deps.assertScope.mockImplementation(async () => { if (denied) throw new Error("fixture-private-revocation"); });
    cliPlans.push(child => { child.stdout.emit("data", Buffer.from(RAW)); child.emit("close", 0, null); denied = true; });
    const p = createScienceNativeSessionProvider(deps), lease = p.retain();
    await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-refused" });
    expect(mocks.request).not.toHaveBeenCalled(); lease.release(); p.close();
  });

  it.each(["http://localhost:8317/?nonce=x", "http://evil.invalid:18765/?nonce=x", "http://user@127.0.0.1:18765/?nonce=x", "http://127.0.0.1:18765/?nonce=x&nonce=y", "http://localhost:18765/?nonce=x#private"])("does not connect for an invalid CLI URL", async value => {
    cliPlans.push(child => { child.stdout.emit("data", Buffer.from(value)); child.emit("close", 0, null); });
    const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
    await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-cli-invalid" });
    expect(mocks.request).not.toHaveBeenCalled(); lease.release(); p.close();
  });

  it.each([
    [{ ...authPlans()[0], status: 201 }, authPlans()[1]],
    [{ ...authPlans()[0], headers: { ...authPlans()[0].headers, "content-type": "application/json" } }, authPlans()[1]],
    [{ ...authPlans()[0], headers: { "content-type": "text/html", "set-cookie": [`operon_auth=${PRIVATE}`, `operon_csrf=${CSRF}`] } }, { status: 204 }],
    [authPlans()[0], { ...authPlans()[1], data: Buffer.from("unexpected") }],
    [{ ...authPlans()[0], incomplete: true }, authPlans()[1]],
    [{ ...authPlans()[0], status: 302 }, authPlans()[1]],
  ])("strictly rejects incomplete or incorrect authentication without a retry", async (nonce, csrf) => {
    plans = [nonce, csrf]; const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
    await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-authentication-failed" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.request.mock.calls.length).toBeLessThanOrEqual(2);
    lease.release(); p.close();
  });

  it("rejects duplicate/invalid cookies and unexpected encoding or oversized bodies", async () => {
    const cases: Plan[] = [
      { ...authPlans()[0], headers: { "content-type": "text/html", "set-cookie": [`operon_auth=${PRIVATE}`, `operon_auth=${PRIVATE}`] } },
      { ...authPlans()[0], headers: { "content-type": "text/html", "set-cookie": ["operon_auth=bad value"] } },
      { ...authPlans()[0], headers: { ...authPlans()[0].headers, "content-encoding": "gzip" } },
      { ...authPlans()[0], data: Buffer.alloc(1024 * 1024 + 1) },
    ];
    for (const plan of cases) {
      plans = [plan]; const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
      await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-authentication-failed" }); lease.release(); p.close();
    }
    expect(mocks.request).toHaveBeenCalledTimes(cases.length);
  });

  it("bounds CLI stdout/stderr while they arrive and reports no raw errors", async () => {
    for (const field of ["stdout", "stderr"] as const) {
      cliPlans.push(child => child[field].emit("data", Buffer.alloc(field === "stdout" ? 16385 : 65537)));
      const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
      await expect(lease.privateSession()).rejects.toMatchObject({ code: "science-native-session-cli-invalid" });
      expect(children.at(-1)?.kill).toHaveBeenCalled(); lease.release(); p.close();
    }
    mocks.spawn.mockImplementationOnce(() => { throw new Error("fixture-private-error"); });
    const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
    const error = await lease.privateSession().catch((value: unknown) => value);
    expect(String(error).includes("fixture-private-error")).toBe(false); expect(inspect(error).includes("fixture-private-error")).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled(); lease.release(); p.close();
  });

  it("has a hard whole-bootstrap deadline that covers stalled headers", async () => {
    vi.useFakeTimers(); plans = [{ hold: true }];
    const p = createScienceNativeSessionProvider(dependencies()), lease = p.retain();
    const outcome = lease.privateSession().catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await outcome).toMatchObject({ code: "science-native-session-deadline" });
    expect(requests[0].destroy).toHaveBeenCalled(); expect(mocks.request).toHaveBeenCalledTimes(1); lease.release(); p.close();
  });

  it("bounds a stalled preflight and kills only its own pending CLI on release", async () => {
    vi.useFakeTimers(); const deps = dependencies(); deps.assertCurrentRuntime.mockImplementation(() => new Promise(() => {}));
    const p = createScienceNativeSessionProvider(deps), a = p.retain();
    const outcome = a.privateSession().catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(10_001);
    expect(await outcome).toMatchObject({ code: "science-native-session-deadline" }); expect(mocks.spawn).not.toHaveBeenCalled(); a.release(); p.close();
    cliPlans.push(() => {});
    const q = createScienceNativeSessionProvider(dependencies()), b = q.retain();
    const pending = b.privateSession().catch((error: unknown) => error); await settle(); b.release();
    expect(await pending).toMatchObject({ code: "science-native-session-closed" });
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM"); expect(mocks.request).not.toHaveBeenCalled(); q.close();
  });

  it("a released lease and a closed provider cannot expose cached cookies", async () => {
    const p = createScienceNativeSessionProvider(dependencies()), a = p.retain(), b = p.retain();
    await a.privateSession(); a.release(); await expect(a.privateSession()).rejects.toMatchObject({ code: "science-native-session-closed" });
    p.close(); await expect(b.privateSession()).rejects.toMatchObject({ code: "science-native-session-closed" });
    expect(() => p.retain()).toThrow("science-native-session-closed"); b.release();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
