import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGlobalApiBase } from "../api-context.js";
import { getResWorkflow, getResWorkflowConnection, getResWorkflowHistoryCandidates, joinResWorkflowSession } from "../res-workflow-api.js";

const CWD = "/isolated/research folder";
const candidate = { id: "hist-aaaaaaaaaaaaaaaaaaaaaaaa", sessionId: "session-one", name: "Research", kind: "local", registered: true, incomplete: false };
const participation = { canonicalCwd: CWD, joinedAt: "2026-10-24T00:00:00Z", via: "manual" };
function respond(value: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })));
}
beforeEach(() => setGlobalApiBase(""));
afterEach(() => { vi.unstubAllGlobals(); setGlobalApiBase(""); });

describe("res-workflow source and participation API", () => {
  it("preserves fixed HTTP refusal status for scientific cache invalidation without exposing raw errors", async () => {
    respond({ error: "private refusal payload" }, 403);
    await expect(getResWorkflow(CWD)).rejects.toMatchObject({ status: 403, message: "res-workflow HTTP 403" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private gateway", { status: 401, headers: { "content-type": "text/html" } })));
    await expect(getResWorkflow(CWD)).rejects.toMatchObject({ status: 401, message: "res-workflow HTTP 401" });
  });
  it("reads only candidate metadata through the scoped endpoint", async () => {
    const response = { candidates: [candidate], partial: false, skipped: [] };
    respond(response);
    expect(await getResWorkflowHistoryCandidates(CWD)).toEqual(response);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`/api/res-workflow/history-candidates?cwd=${encodeURIComponent(CWD)}`);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
  });

  it("rejects malformed candidate catalogues rather than treating them as empty", async () => {
    respond({ candidates: [{ ...candidate, sessionId: undefined }], partial: false, skipped: [] });
    await expect(getResWorkflowHistoryCandidates(CWD)).rejects.toThrow(/catalogue/);
  });

  it("preserves a failed candidate lookup instead of falling back to another API", async () => {
    respond({ error: "metadata-unavailable" }, 503);
    await expect(getResWorkflowHistoryCandidates(CWD)).rejects.toThrow("metadata-unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads adopted status without fetching research files or a model", async () => {
    respond({ cwd: CWD, adopted: true });
    expect(await getResWorkflowConnection(CWD)).toEqual({ cwd: CWD, adopted: true });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`/api/res-workflow/connection?cwd=${encodeURIComponent(CWD)}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not turn an invalid connection response into not-adopted", async () => {
    respond({ cwd: CWD, adopted: "true" });
    await expect(getResWorkflowConnection(CWD)).rejects.toThrow(/connection/);
  });

  it("associates exactly one real session without consent, model or prompt payloads", async () => {
    respond({ sessionId: "session-one", resWorkflow: participation });
    expect(await joinResWorkflowSession(CWD, "session-one")).toEqual({ sessionId: "session-one", resWorkflow: participation });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/res-workflow/participants");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ cwd: CWD, sessionId: "session-one" });
  });

  it("rejects a participation reply for a different session", async () => {
    respond({ sessionId: "another-session", resWorkflow: participation });
    await expect(joinResWorkflowSession(CWD, "session-one")).rejects.toThrow(/participant/);
  });
});
