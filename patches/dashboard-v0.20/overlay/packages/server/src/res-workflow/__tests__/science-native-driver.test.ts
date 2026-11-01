import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScienceNativeRegistryDriver, ScienceNativeDriverError } from "../../science-registry.js";
import type { ScienceNativeExchange, ScienceNativeWireRequest } from "../science-native-driver.js";
import { openScienceRegistry } from "../science-registry.js";
const httpMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request: httpMock.request }));

const PROJECT = "proj_0123456789ab";
const FRAME = "11111111-1111-4111-8111-111111111111";
const OTHER_FRAME = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
const INTENT = "44444444-4444-4444-8444-444444444444";
const AUTH = "fake-owned-auth-private-only-0123456789";
const CSRF = "fake-owned-csrf-private-only-0123456789";
const ERROR = "fake-untrusted-error-private-only-0123456789";
const MODELS = ["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"];
const binding = { projectId: PROJECT, taskId: FRAME, rootFrameId: FRAME, frameId: FRAME };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); httpMock.request.mockReset(); vi.useRealTimers(); });

async function temporary() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "science-native-adapter-fake-")); await fs.chmod(root, 0o700); roots.push(root); return root; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function submission() {
  const request = { projectId: PROJECT, prompt: "Host authorized task text; preserve exactly.", modelIds: [...MODELS].sort(), materials: [] };
  return { ...request, intentId: INTENT, requestHash: hash(request) };
}
function row(status = "processing", extra: Record<string, unknown> = {}) { return { id: FRAME, root_frame_id: FRAME, project_id: PROJECT, status, input_data: { _intent_id: INTENT }, ...extra }; }
function json(value: unknown, status = 200) { return { status, contentType: "application/json", contentEncoding: "identity", complete: true, body: Buffer.from(JSON.stringify(value)) }; }
function harness(responses: (ReturnType<typeof json> | Error)[] = []) {
  const wire: ScienceNativeWireRequest[] = [];
  const runtime = { assertCapability: vi.fn(async (_operation: string, _context: unknown) => {}) };
  const privateSession = vi.fn(async () => ({ authCookie: AUTH, csrfCookie: CSRF }));
  const selectedModelFor = vi.fn(async (_request: unknown) => MODELS[0]);
  const exchange: ScienceNativeExchange = vi.fn(async request => {
    wire.push(request);
    const response = responses.shift(); if (response instanceof Error) throw response;
    if (!response) throw new Error(ERROR); return response;
  });
  const deps = { runtime, privateSession, selectedModelFor, exchange, artifactRootFor: vi.fn(async (_binding: unknown) => null as string | null) };
  return { driver: createScienceNativeRegistryDriver(deps), deps, wire, responses };
}

describe("code-owned native Science registry adapter", () => {
  it("requires a live host runtime gate before session or HTTP, never capability booleans", async () => {
    const h = harness(); h.deps.runtime.assertCapability.mockRejectedValue(new Error(ERROR));
    await expect(h.driver.observe(binding)).rejects.toMatchObject({ code: "science-native-unavailable" });
    expect(h.deps.privateSession).not.toHaveBeenCalled(); expect(h.wire).toEqual([]);
    expect(() => createScienceNativeRegistryDriver({ capabilities: { observe: true } } as never)).toThrow(ScienceNativeDriverError);
  });

  it("revalidates the host gate after a delayed private-session lookup before sending", async () => {
    let live = true; const h = harness();
    h.deps.runtime.assertCapability.mockImplementation(async () => { if (!live) throw new Error(ERROR); });
    h.deps.privateSession.mockImplementation(async () => { live = false; return { authCookie: AUTH, csrfCookie: CSRF }; });
    await expect(h.driver.observe(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(h.wire).toEqual([]);
  });

  it.each([ ["processing", "running"], ["completed", "completed"], ["success", "completed"], ["failed", "failed"], ["replaced", "unknown"], ["cancelled", "cancelled"], ["awaiting_plan_approval", "waiting-approval"], ["awaiting_user_response", "waiting-approval"] ])("maps only the pinned upstream status %s", async (upstream, expected) => {
    const h = harness([json(row(upstream))]);
    await expect(h.driver.observe(binding)).resolves.toEqual({ ...binding, status: expected });
    expect(h.wire[0].path).toBe(`/api/frames/${FRAME}?shallow=true`);
    expect(h.wire[0].headers.Origin).toBe("http://127.0.0.1:18765");
  });

  it("detects permission cards while processing and does not expose their content", async () => {
    const h = harness([json(row("processing", { context_data: { _pending_input_requests: [{ kind: "credential_request", text: ERROR }] } }))]);
    const result = await h.driver.observe(binding); expect(result.status).toBe("waiting-approval"); expect(JSON.stringify(result)).not.toContain(ERROR);
    expect(h.wire).toHaveLength(1); expect(h.wire[0].method).toBe("GET");
  });

  it("treats empty card arrays as absent and unknown/prototype status keys as unknown", async () => {
    const empty = harness([json(row("processing", { output_data: { pending_input_requests: [] }, context_data: { _pending_input_requests: [] } }))]);
    await expect(empty.driver.observe(binding)).resolves.toMatchObject({ status: "running" });
    for (const status of ["toString", "constructor", "__proto__", ERROR]) {
      const h = harness([json(row(status))]); await expect(h.driver.observe(binding)).resolves.toMatchObject({ status: "unknown" });
    }
  });

  it("rejects mistaken boolean capability results and non-ASCII credential values before HTTP", async () => {
    const h = harness(); h.deps.runtime.assertCapability.mockResolvedValue(false as never);
    await expect(h.driver.observe(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(h.wire).toEqual([]);
    const bad = harness(); bad.deps.privateSession.mockResolvedValue({ authCookie: AUTH + "€", csrfCookie: CSRF });
    await expect(bad.driver.observe(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(bad.wire).toEqual([]);
  });

  it("rejects wrong project/root/frame, URL-shaped IDs and malformed private sessions", async () => {
    for (const bad of [{ ...binding, frameId: "../../api/auth" }, { ...binding, projectId: "http://127.0.0.1:8317" }]) {
      const h = harness(); await expect(h.driver.observe(bad)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(h.wire).toEqual([]);
    }
    const h = harness([json(row("processing", { project_id: "proj_ffffffffffff" }))]);
    await expect(h.driver.observe(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError);
    const bad = harness(); bad.deps.privateSession.mockResolvedValue({ authCookie: AUTH + "; injected=1", csrfCookie: CSRF });
    await expect(bad.driver.observe(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(bad.wire).toEqual([]);
  });

  it("reconciles only exact project and native intent through bounded read-only routes", async () => {
    const h = harness([json([{ id: FRAME, project_id: PROJECT }]), json(row())]);
    await expect(h.driver.reconcile({ projectId: PROJECT, intentId: INTENT, requestHash: "a".repeat(64) })).resolves.toEqual(binding);
    expect(h.wire.every(request => request.method === "GET")).toBe(true); expect(h.wire[0].path).toContain(`project_id=${PROJECT}&root_only=true&limit=8`);
    const ambiguous = harness([json([{ id: FRAME, project_id: PROJECT }, { id: OTHER_FRAME, project_id: PROJECT }]), json(row()), json(row("processing", { id: OTHER_FRAME, root_frame_id: OTHER_FRAME }))]);
    await expect(ambiguous.driver.reconcile({ projectId: PROJECT, intentId: INTENT, requestHash: "a".repeat(64) })).resolves.toBeNull();
    expect(ambiguous.wire.every(request => request.method === "GET")).toBe(true);
  });

  it("forwards the authorized user prompt, explicit selected default selector and native intent", async () => {
    const h = harness([json({ root_frame_id: FRAME, frame_id: FRAME, status: "accepted" })]); const request = submission();
    await expect(h.driver.submit(request)).resolves.toEqual(binding);
    const body = JSON.parse(h.wire[0].body!.toString()); expect(body.input_data).toEqual({ request: request.prompt });
    expect(body.model).toBe("claude-pi-science-default"); expect(body.intent_id).toBe(INTENT);
    expect(h.wire[0].headers["x-operon-csrf"]).toBe(CSRF); expect(h.deps.selectedModelFor).toHaveBeenCalled();
    expect(h.deps.runtime.assertCapability).toHaveBeenCalledWith("submit", expect.objectContaining({ permittedModelIds: request.modelIds, selectedModelId: MODELS[0] }));
  });

  it("uses the exact actual-P0 HTTP payload with mandatory top-level plan_mode true", async () => {
    const h = harness([json({ root_frame_id: FRAME, frame_id: FRAME, status: "accepted" })]); const request = submission();
    await h.driver.submit(request);
    expect(JSON.parse(h.wire[0].body!.toString())).toEqual({ input_data: { request: request.prompt }, model: "claude-pi-science-default", intent_id: INTENT, task_source: "user", plan_mode: true });
  });

  it("sends only one mutation when the same intent concurrently clears asynchronous selection", async () => {
    const h = harness([json({ root_frame_id: FRAME, frame_id: FRAME, status: "accepted" }), json({ root_frame_id: FRAME, frame_id: FRAME, status: "accepted" })]);
    const releases: ((model: string) => void)[] = [];
    h.deps.selectedModelFor.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const first = h.driver.submit(submission()), second = h.driver.submit(submission()); expect(releases).toHaveLength(2);
    releases.forEach(release => release(MODELS[0]));
    const results = await Promise.allSettled([first, second]);
    expect(h.wire.filter(request => request.method === "POST")).toHaveLength(1);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  it("sends only one cancellation when two callers concurrently clear the initial host gate", async () => {
    const h = harness(); let release!: () => void, entered = 0; const barrier = new Promise<void>(resolve => { release = resolve; });
    h.deps.runtime.assertCapability.mockImplementation(async action => { if (action === "cancel" && entered < 2) { entered += 1; await barrier; } });
    const driver = createScienceNativeRegistryDriver({ ...h.deps, exchange: async request => { h.wire.push(request); return request.method === "GET" ? json(row()) : json({ cancelled_frames: [FRAME] }); } });
    const first = driver.cancel(binding), second = driver.cancel(binding); expect(entered).toBe(2); release(); await Promise.all([first, second]);
    expect(h.wire.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("refuses missing or unsupported selection, unauthorized Ark, changed hash and material upload", async () => {
    for (const which of ["missing", "unsupported", "no-ark", "hash", "materials"]) {
      const h = harness(); const request = submission();
      if (which === "missing") h.deps.selectedModelFor.mockResolvedValue(undefined as never);
      if (which === "unsupported") h.deps.selectedModelFor.mockResolvedValue(MODELS[1]);
      if (which === "no-ark") { request.modelIds = [MODELS[1]]; request.requestHash = hash({ projectId: request.projectId, prompt: request.prompt, modelIds: request.modelIds, materials: [] }); }
      if (which === "hash") request.requestHash = "f".repeat(64);
      if (which === "materials") { (request.materials as unknown[]).push({ name: "input.csv", bytes: 2, sha256: "a".repeat(64) }); request.requestHash = hash({ projectId: request.projectId, prompt: request.prompt, modelIds: request.modelIds, materials: request.materials }); }
      await expect(h.driver.submit(request)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(h.wire).toEqual([]);
    }
  });

  it("does not retry lost submit or cancellation and confirms cancel only via GET", async () => {
    const h = harness([new Error(ERROR)]); await expect(h.driver.submit(submission())).rejects.toMatchObject({ code: "science-native-outcome-unknown" });
    await expect(h.driver.submit(submission())).rejects.toMatchObject({ code: "science-native-outcome-unknown" }); expect(h.wire).toHaveLength(1);
    const running = harness([json(row()), json({ cancelled_frames: [FRAME] }), json(row())]); await expect(running.driver.cancel(binding)).resolves.toBeNull();
    await expect(running.driver.cancel(binding)).resolves.toBeNull(); expect(running.wire).toHaveLength(3);
    const stopped = harness([json(row()), new Error(ERROR), json(row("cancelled"))]); await expect(stopped.driver.cancel(binding)).resolves.toEqual({ ...binding, status: "cancelled" });
    expect(stopped.wire.map(request => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("freshly verifies project membership before cancelling a possibly stale remote binding", async () => {
    const h = harness([json(row("processing", { project_id: "proj_ffffffffffff" }))]);
    await h.driver.cancel(binding).catch(() => null);
    expect(h.wire.map(request => request.method)).toEqual(["GET"]);
  });

  it("returns fixed errors for untrusted HTTP status, body, truncation and compression", async () => {
    for (const response of [json({ error: ERROR }, 500), { ...json({}), body: Buffer.from(ERROR) }, { ...json(row()), complete: false }, { ...json(row()), contentEncoding: "gzip" }]) {
      const h = harness([response]); const error = await h.driver.observe(binding).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ScienceNativeDriverError); expect(String(error)).not.toContain(ERROR);
    }
  });

  it("downloads only an exact task version to the independent host root and ignores upstream paths", async () => {
    const root = await temporary(); const bytes = Buffer.from("value\n1\n2\n3\n");
    const h = harness([json([{ id: "opaque-artifact", version_id: VERSION, project_id: PROJECT, root_frame_id: FRAME, filename: "values.csv", content_type: "text/csv", size_bytes: bytes.length,
                             file_path: "/root/" + ERROR, ref_host_path: "/etc/" + ERROR, is_user_upload: false, is_intermediate: false }]),
                       { status: 200, contentType: "text/csv", contentEncoding: "identity", complete: true, body: bytes }]);
    h.deps.artifactRootFor.mockResolvedValue(root);
    const sources = await h.driver.artifacts!(binding); expect(sources).toHaveLength(1); expect(sources[0]).toMatchObject({ taskId: FRAME, root, name: "values.csv", mediaType: "text/csv", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(sources[0].relativePath).toMatch(/^native-[0-9a-f]{64}\.bin$/); expect(h.wire[1].path).toBe(`/api/artifacts/versions/${VERSION}`);
    expect(await fs.readFile(path.join(root, sources[0].relativePath))).toEqual(bytes);
    const stat = await fs.lstat(path.join(root, sources[0].relativePath)); expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1);
    expect(JSON.stringify(sources)).not.toContain(ERROR);
  });

  it("does not download foreign, uploaded, intermediate artifacts or accept a symlink host root", async () => {
    const root = await temporary(); const h = harness([json([{ version_id: VERSION, project_id: PROJECT, root_frame_id: OTHER_FRAME, filename: "foreign.csv", content_type: "text/csv", size_bytes: 12 }])]);
    h.deps.artifactRootFor.mockResolvedValue(root); await expect(h.driver.artifacts!(binding)).resolves.toEqual([]); expect(h.wire).toHaveLength(1);
    const link = path.join(root, "link"); await fs.symlink(root, link); const unsafe = harness(); unsafe.deps.artifactRootFor.mockResolvedValue(link);
    await expect(unsafe.driver.artifacts!(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(unsafe.wire).toEqual([]);
  });

  it("connects to the registry durable intent/unknown/reconcile pipeline using only fake HTTP", async () => {
    const root = await temporary(), cwd = await temporary(); const h = harness(); let liveIntent = "";
    h.deps.exchange = vi.fn(async request => {
      h.wire.push(request);
      if (request.method === "POST") {
        const stored = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8"));
        expect(stored.instances[0].phase).toBe("sending"); liveIntent = stored.instances[0].intentId; throw new Error(ERROR);
      }
      return request.path.startsWith("/api/frames?") ? json([{ id: FRAME, project_id: PROJECT }]) : json(row("processing", { input_data: { _intent_id: liveIntent } }));
    });
    const driver = createScienceNativeRegistryDriver(h.deps); const partition = { ownerKey: "fake-owner", cwd };
    const registry = await openScienceRegistry(root, { driver, authority: { assert: async () => {} } });
    try {
      await registry.bindProject(partition, PROJECT); const request = submission(); const { intentId: _, requestHash: __, ...input } = request;
      const first = await registry.submit(partition, input); const second = await registry.submit(partition, input);
      expect(first.id).toBe(second.id); expect(h.wire.filter(value => value.method === "POST")).toHaveLength(1);
      await registry.reconcile(partition, first.id); const observed = await registry.observe(partition, first.id); expect(observed.status).toBe("running");
    } finally { await registry.close(); }
  });

  it("uses the real Node HTTP code against only an in-memory request mock with a fixed peer", async () => {
    httpMock.request.mockImplementation((_options, callback) => {
      const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      outgoing.destroy = vi.fn(); outgoing.end = () => queueMicrotask(() => {
        const incoming = Object.assign(new EventEmitter(), { complete: true, statusCode: 200, headers: { "content-type": "application/json" }, destroy: vi.fn() });
        callback(incoming); incoming.emit("data", Buffer.from(JSON.stringify(row()))); incoming.emit("end");
      }); return outgoing;
    });
    const h = harness(); const driver = createScienceNativeRegistryDriver({ ...h.deps, exchange: undefined });
    await expect(driver.observe(binding)).resolves.toMatchObject({ status: "running" });
    expect(httpMock.request).toHaveBeenCalledTimes(1);
    expect(httpMock.request.mock.calls[0][0]).toMatchObject({ hostname: "127.0.0.1", port: 18765, agent: false, method: "GET", path: `/api/frames/${FRAME}?shallow=true`, headers: { Origin: "http://127.0.0.1:18765" } });
  });

  it("bounds slow headers by a total deadline without any socket or provider error output", async () => {
    vi.useFakeTimers(); const outgoing = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    httpMock.request.mockReturnValue(outgoing);
    const h = harness(); const driver = createScienceNativeRegistryDriver({ ...h.deps, exchange: undefined });
    const assertion = expect(driver.observe(binding)).rejects.toBeInstanceOf(ScienceNativeDriverError);
    await vi.advanceTimersByTimeAsync(10001); await assertion; expect(outgoing.destroy).toHaveBeenCalled();
  });
});
