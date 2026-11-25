import { describe, expect, it, vi } from "vitest";
import { createScienceReadWsFilter, SCIENCE_READ_WS_UPSTREAM_PATH, type ScienceReadWsBinding, type ScienceReadWsDecision } from "../science-read-ws.js";

const projectId = "proj_001122334455";
const rootFrameId = "22222222-2222-4222-8222-222222222222";
const frameId = "33333333-3333-4333-8333-333333333333";
const childId = "44444444-4444-4444-8444-444444444444";
const foreignId = "55555555-5555-4555-8555-555555555555";
const binding = (): ScienceReadWsBinding => ({ projectId, taskId: rootFrameId, rootFrameId, frameId });
const text = (overrides = {}) => ({ type: "text_chunk", root_frame_id: rootFrameId, frame_id: rootFrameId, block_type: "text", chunk: "synthetic visible text", ...overrides });
function decoded(value: ScienceReadWsDecision) { expect(value.action).toBe("forward"); return value.action === "forward" ? JSON.parse(value.message) : null; }
function fixture() {
  let active = true; let now = 0;
  const revalidate = vi.fn(async () => { if (!active) throw new Error("synthetic private scope failure"); });
  const filter = createScienceReadWsFilter({ binding: binding(), revalidate, now: () => now });
  return { filter, revalidate, revoke: () => { active = false; }, tick: () => { now += 1000; } };
}

describe("fixed-scope native Science read WS contract", () => {
  it("creates only a fixed host subscription and never accepts a browser-selected URL", async () => {
    const current = binding(); const f = createScienceReadWsFilter({ binding: current, revalidate: async () => {} });
    current.rootFrameId = foreignId;
    expect(f.upstreamPath).toBe(SCIENCE_READ_WS_UPSTREAM_PATH); expect(f.upstreamPath).toBe("/api/ws?explicit_subscribe=1");
    expect(decoded(await f.hostSubscribe())).toEqual({ type: "subscribe", root_frame_id: rootFrameId });
    expect((await f.hostSubscribe()).action).toBe("drop");
    expect((await f.fromBrowser(JSON.stringify({ type: "subscribe", root_frame_id: rootFrameId, url: "ws://foreign.invalid/api/ws" }))).action).toBe("drop");
  });
  it("allows only fixed heartbeat control and ignores exact view presence", async () => {
    const { filter } = fixture();
    expect(decoded(await filter.fromBrowser('{"type":"ping"}'))).toEqual({ type: "ping" });
    expect(decoded(await filter.fromServer('{"type":"pong"}'))).toEqual({ type: "pong" });
    for (const type of ["view_session", "unview_session", "session_attention"]) {
      expect((await filter.fromBrowser(JSON.stringify({ type, root_frame_id: rootFrameId }))).action).toBe("drop");
    }
  });
  it.each(["subscribe", "subscribe_project", "kernel_user_exec", "kernel_user_interrupt", "file_watch", "job_log_subscribe", "request", "approve", "unknown"])("blocks browser %s without upstream writes", async type => {
    const { filter } = fixture();
    expect((await filter.fromBrowser(JSON.stringify({ type, root_frame_id: rootFrameId, project_id: projectId }))).action).toBe("drop");
  });
  it("forwards only the two bound frames or a freshly proven child from the same root", async () => {
    const { filter } = fixture();
    expect(decoded(await filter.fromServer(JSON.stringify(text())))).toEqual(text());
    expect(decoded(await filter.fromServer(JSON.stringify(text({ frame_id: frameId }))))).toEqual(text({ frame_id: frameId }));
    expect((await filter.fromServer(JSON.stringify(text({ frame_id: childId })))).action).toBe("drop");
    const assertFrame = vi.fn(async (id: string, scope: Readonly<ScienceReadWsBinding>) => { expect(id).toBe(childId); expect(scope).toEqual(binding()); });
    const proven = createScienceReadWsFilter({ binding: binding(), revalidate: async () => {}, assertFrame });
    expect(decoded(await proven.fromServer(JSON.stringify(text({ frame_id: childId }))))).toEqual(text({ frame_id: childId }));
    expect(assertFrame).toHaveBeenCalledTimes(1);
  });
  it("projects status updates without forwarding optional native metadata or URLs", async () => {
    const { filter } = fixture();
    const input = { type: "frame_update", project_id: projectId, root_frame_id: rootFrameId, frame_id: rootFrameId, status: "awaiting_plan_approval", message_count: 4, user_message_count: 1, name: "http://127.0.0.1/auth?nonce=synthetic-only", plan_pointers: { url: "synthetic-private-metadata" }, pending_input_requests: [{ secret: "fake-metadata" }] };
    const result = await filter.fromServer(JSON.stringify(input));
    expect(decoded(result)).toEqual({ type: "frame_update", project_id: projectId, root_frame_id: rootFrameId, frame_id: rootFrameId, status: "awaiting_plan_approval", message_count: 4, user_message_count: 1 });
    expect(JSON.stringify(result)).not.toMatch(/nonce|synthetic-private|pending_input|secret/);
  });
  it("reduces message deltas to the native null invalidation form, without nested content", async () => {
    const { filter } = fixture();
    const input = { type: "frame_messages_delta", root_frame_id: rootFrameId, frame_id: rootFrameId, base_idx: 4, appended: [{ role: "assistant", content: "synthetic private nested content", url: "http://127.0.0.1/?nonce=synthetic" }] };
    expect(decoded(await filter.fromServer(JSON.stringify(input)))).toEqual({ type: "frame_messages_delta", root_frame_id: rootFrameId, frame_id: rootFrameId, base_idx: 4, appended: null });
    expect(decoded(await filter.fromServer(JSON.stringify({ type: "text_reset", root_frame_id: rootFrameId, frame_id: rootFrameId })))).toEqual({ type: "text_reset", root_frame_id: rootFrameId, frame_id: rootFrameId });
  });
  it.each([
    text({ root_frame_id: foreignId }),
    text({ root_frame_id: undefined }),
    text({ frame_id: foreignId }),
    text({ block_type: "hidden_reasoning" }),
    text({ block_type: ["text"] }),
    text({ url: "http://127.0.0.1/?nonce=synthetic" }),
    text({ cookie: "synthetic-cookie" }),
    text({ authorization: "synthetic-authorization" }),
    text({ chunk: "http://127.0.0.1/auth?nonce=synthetic" }),
    { type: "frame_update", project_id: "proj_aabbccddeeff", root_frame_id: rootFrameId, frame_id: rootFrameId, status: "processing" },
    { type: "frame_update", project_id: projectId, root_frame_id: foreignId, frame_id: rootFrameId, status: "processing" },
    { type: "frame_update", project_id: projectId, root_frame_id: rootFrameId, frame_id: rootFrameId, status: "not-native" },
    { type: "frame_update", project_id: projectId, root_frame_id: rootFrameId, frame_id: rootFrameId, status: "processing", message_count: -1 },
    { type: "frame_messages_delta", root_frame_id: rootFrameId, frame_id: rootFrameId, base_idx: 0, appended: "malformed" },
    { type: "environment_status", environments: [] }, { type: "auth_status_changed" }, { type: "connector_snapshot", items: [] },
    { type: "artifact_created", project_id: projectId }, { type: "unknown", root_frame_id: rootFrameId },
  ])("rejects foreign, unscoped, malformed or sensitive shape %#", async input => {
    const { filter } = fixture(); const result = await filter.fromServer(JSON.stringify(input));
    expect(result.action).toBe("drop"); expect(result).not.toHaveProperty("message");
  });
  it.each(['[', 'null', '[]', '{"type":"pong","type":"frame_update"}', '{ "type": "pong" }', '{"type":"pong","rawURL":"synthetic"}'])("rejects malformed or noncanonical JSON %s", async input => {
    const { filter } = fixture(); expect((await filter.fromServer(input)).action).toBe("drop");
  });
  it("rejects binary and closes a channel whose message exceeds the byte ceiling", async () => {
    const binary = fixture(); expect((await binary.filter.fromServer(Buffer.from("synthetic binary"))).action).toBe("close");
    expect((await binary.filter.fromServer('{"type":"pong"}')).action).toBe("close");
    const { filter } = fixture();
    expect((await filter.fromServer("x".repeat(65537))).action).toBe("close");
    expect((await filter.fromServer(JSON.stringify(text()))).action).toBe("close");
  });
  it("bounds message rate and recovers only after creating a new channel", async () => {
    const f = fixture(); let result: ScienceReadWsDecision | undefined;
    for (let i = 0; i < 201; i++) result = await f.filter.fromServer('{"type":"pong"}');
    expect(result?.action).toBe("close"); f.tick(); expect((await f.filter.fromServer('{"type":"pong"}')).action).toBe("close");
    const renewed = fixture(); for (let i = 0; i < 120; i++) await renewed.filter.fromServer('{"type":"pong"}');
    renewed.tick(); expect((await renewed.filter.fromServer('{"type":"pong"}')).action).toBe("forward");
  });
  it("bounds aggregate bytes independently of message count", async () => {
    const { filter } = fixture(); let result: ScienceReadWsDecision | undefined;
    for (let i = 0; i < 100; i++) { result = await filter.fromServer(JSON.stringify(text({ chunk: "x".repeat(8192) }))); if (result.action === "close") break; }
    expect(result?.action).toBe("close");
  });
  it("closes before forwarding after revocation, including revocation during child proof", async () => {
    const f = fixture(); f.revoke(); expect((await f.filter.fromServer(JSON.stringify(text()))).action).toBe("close");
    expect((await f.filter.hostSubscribe()).action).toBe("close"); expect((await f.filter.fromBrowser('{"type":"ping"}')).action).toBe("close");
    let release!: () => void; let entered!: () => void; let active = true;
    const begun = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const during = createScienceReadWsFilter({ binding: binding(), revalidate: async () => { if (!active) throw new Error("synthetic revoked scope"); }, assertFrame: async () => { entered(); await wait; } });
    const pending = during.fromServer(JSON.stringify(text({ frame_id: childId }))); await begun; active = false; release();
    expect((await pending).action).toBe("close");
  });
  it("does not treat JSON booleans from authority or child proof as grants", async () => {
    const wrongAuthority = createScienceReadWsFilter({ binding: binding(), revalidate: (async () => true) as unknown as () => Promise<void> });
    expect((await wrongAuthority.fromServer(JSON.stringify(text()))).action).toBe("close");
    const wrongFrame = createScienceReadWsFilter({ binding: binding(), revalidate: async () => {}, assertFrame: (async () => true) as unknown as () => Promise<void> });
    expect((await wrongFrame.fromServer(JSON.stringify(text({ frame_id: childId })))).action).toBe("drop");
  });
  it("keeps the installed authority callback immutable for the channel lifetime", async () => {
    let active = true;
    const deps = { binding: binding(), revalidate: async () => { if (!active) throw new Error("synthetic revoked original authority"); } };
    const filter = createScienceReadWsFilter(deps); active = false; deps.revalidate = async () => {};
    expect((await filter.fromServer(JSON.stringify(text()))).action).toBe("close");
  });
  it("bounds pending validations and never releases queued packets after closure", async () => {
    let release!: () => void; let entered!: () => void;
    const begun = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const filter = createScienceReadWsFilter({ binding: binding(), revalidate: async () => { entered(); await wait; } });
    const first = filter.fromServer(JSON.stringify(text())); await begun;
    const pending = Array.from({ length: 20 }, () => filter.fromServer(JSON.stringify(text())));
    release(); const decisions = await Promise.all([first, ...pending]);
    expect(decisions.every(value => value.action === "close")).toBe(true);
  });
  it("accepts only the pinned project format and a root-frame task anchor", async () => {
    const revalidate = async () => {};
    expect(createScienceReadWsFilter({ binding: binding(), revalidate }).upstreamPath).toBe(SCIENCE_READ_WS_UPSTREAM_PATH);
    for (const invalid of ["11111111-1111-4111-8111-111111111111", "proj_wrong", "proj_00112233445566", "arbitrary-project"]) {
      expect(() => createScienceReadWsFilter({ binding: { ...binding(), projectId: invalid }, revalidate })).toThrow("science-read-ws-invalid-context");
    }
    expect(() => createScienceReadWsFilter({ binding: { ...binding(), taskId: foreignId }, revalidate })).toThrow("science-read-ws-invalid-context");
  });
  it("closes unsupported nontext traffic before it can bypass per-channel budgets", async () => {
    const small = fixture();
    for (let i = 0; i < 201; i++) expect((await small.filter.fromBrowser(Buffer.from("x"))).action).toBe("close");
    expect((await small.filter.fromBrowser('{"type":"ping"}')).action).toBe("close");
    const large = fixture(); expect((await large.filter.fromServer(Buffer.alloc(65537))).action).toBe("close");
    expect((await large.filter.hostSubscribe()).action).toBe("close");
  });
});
