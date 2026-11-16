import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchCollaborationSnapshot } from "@blackbelt-technology/pi-dashboard-shared/research-collaboration.js";
import { useResearchCollaboration } from "../use-research-collaboration.js";

const api = vi.hoisted(() => ({ base: "" }));
vi.mock("../../../lib/api/api-context.js", () => ({ useApiBase: () => api.base }));

function snapshot(cwd = "/project", revision = 1, main = "main-a"): ResearchCollaborationSnapshot {
  return { schema: "pi-research-collaboration.v1", cwd, adopted: true, revision,
    currentMainSessionId: main, currentTenureId: `tenure-${main}`,
    limits: { maxMultiAgents: 4, maxSubagents: 3 }, limitMaximums: { maxMultiAgents: 8, maxSubagents: 32 },
    tenures: [{ id: `tenure-${main}`, ordinal: revision, mainSessionId: main, startedAt: "2026-11-16T00:00:00Z", status: "current", sessionIds: [main] }],
    detachedSessionIds: [], plans: [], nativeQueue: [],
  };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { api.base = ""; window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("server-authoritative research collaboration", () => {
  it("uses the canonical workspace and current revision, not caller workspace overrides or browser preferences", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => response(init?.method === "POST" ? snapshot("/canonical", 2, "main-b") : snapshot("/canonical")));
    vi.stubGlobal("fetch", fetcher);
    window.localStorage.setItem("res_workflow_main_agent:/alias", "browser-only");
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/alias" }));
    await waitFor(() => expect(result.current.stale).toBe(false));
    expect(result.current.snapshot?.currentMainSessionId).toBe("main-a");
    await act(async () => { await result.current.mutate("select-main", { sessionId: "main-b", cwd: "/wrong", action: "detach" }); });
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ sessionId: "main-b", cwd: "/canonical", expectedRevision: 1, action: "select-main" });
    // The invalidation message contains no authoritative session selection.
    expect(window.localStorage.getItem("research_collaboration_revision")).toContain("/canonical");
    expect(window.localStorage.getItem("research_collaboration_revision")).not.toContain("main-b");
  });

  it("passes a frozen drag revision unchanged so a stale reorder fails CAS instead of silently rebasing", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? response({ error: "collaboration-revision-conflict" }, 409) : response(snapshot("/project", 4)));
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/project" }));
    await waitFor(() => expect(result.current.stale).toBe(false));
    await act(async () => { await expect(result.current.mutate("native-reorder", { sessionId: "worker-a", taskIds: ["queued-b", "queued-a"], expectedRevision: 3 })).rejects.toThrow("没有覆盖其他修改"); });
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ action: "native-reorder", expectedRevision: 3 });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("refreshes after a 409 without replaying a mutation or overwriting a newer selection", async () => {
    let reads = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return response({ error: "collaboration-revision-conflict" }, 409);
      return response(++reads === 1 ? snapshot() : snapshot("/project", 3, "other-user-main"));
    });
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/project", onChanged: changed }));
    await waitFor(() => expect(result.current.stale).toBe(false));
    await act(async () => { await expect(result.current.mutate("select-main", { sessionId: "main-b" })).rejects.toThrow("没有覆盖其他修改"); });
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));
    expect(result.current.snapshot?.currentMainSessionId).toBe("other-user-main");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps the last snapshot visibly stale after a failed read and blocks all mutations until resynced", async () => {
    let available = true;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => available ? response(snapshot()) : response({ error: "offline" }, 503));
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/project" }));
    await waitFor(() => expect(result.current.stale).toBe(false));
    available = false;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.snapshot?.currentMainSessionId).toBe("main-a");
    expect(result.current.stale).toBe(true);
    await act(async () => { await expect(result.current.mutate("limits", { maxMultiAgents: 6, maxSubagents: 4 })).rejects.toThrow("先同步"); });
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    available = true;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.stale).toBe(false);
  });

  it("explains a paused scheduler refusal and never retries start or implicitly resumes", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? response({ code: "research-dispatch-scheduling-paused" }, 409) : response(snapshot()));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/project", onChanged: changed }));
    await waitFor(() => expect(result.current.stale).toBe(false));
    await act(async () => { await expect(result.current.mutate("start", { planId: "plan", sessionId: "main-a", taskId: "queued", queueRevision: 2 })).rejects.toThrow("分发已暂停"); });
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body)).action).toBe("start");
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not admit malformed snapshots as writable state", async () => {
    const fetcher = vi.fn(async () => response({ ...snapshot(), limits: null }));
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/project" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toContain("状态不完整");
    await expect(result.current.mutate("detach", { sessionId: "main-a" })).rejects.toThrow("先同步");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores a late previous-workspace read and never uses it for the next mutation", async () => {
    const delayed = deferred<Response>();
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return response(snapshot("/other", 2, "other-main"));
      return String(url).includes("cwd=%2Fproject") ? delayed.promise : response(snapshot("/other", 1, "other-main"));
    });
    vi.stubGlobal("fetch", fetcher);
    const view = renderHook(({ cwd }) => useResearchCollaboration({ cwd }), { initialProps: { cwd: "/project" } });
    view.rerender({ cwd: "/other" });
    await waitFor(() => expect(view.result.current.snapshot?.cwd).toBe("/other"));
    await act(async () => { delayed.resolve(response(snapshot("/project", 99, "old-main"))); });
    expect(view.result.current.snapshot?.currentMainSessionId).toBe("other-main");
    await act(async () => { await view.result.current.mutate("limits", { maxMultiAgents: 4, maxSubagents: 3 }); });
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ cwd: "/other", expectedRevision: 1 });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("aborts a prior-workspace write and does not broadcast or announce its late acknowledgement", async () => {
    const delayed = deferred<Response>();
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? delayed.promise : response(snapshot(String(url).includes("cwd=%2Fother") ? "/other" : "/project")));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const view = renderHook(({ cwd }) => useResearchCollaboration({ cwd, onChanged: changed }), { initialProps: { cwd: "/project" } });
    await waitFor(() => expect(view.result.current.stale).toBe(false));
    let writing!: Promise<ResearchCollaborationSnapshot | null>;
    act(() => { writing = view.result.current.mutate("select-main", { sessionId: "main-b" }); });
    view.rerender({ cwd: "/other" });
    await waitFor(() => expect(view.result.current.snapshot?.cwd).toBe("/other"));
    await act(async () => { delayed.resolve(response(snapshot("/project", 2, "main-b"))); expect(await writing).toBeNull(); });
    expect(view.result.current.snapshot?.cwd).toBe("/other");
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[1]?.signal?.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("research_collaboration_revision")).toBeNull();
  });

  it("rejects a mutation acknowledgement for another directory and performs no automatic retry", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => response(init?.method === "POST" ? snapshot("/foreign", 2) : snapshot()));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const { result } = renderHook(() => useResearchCollaboration({ cwd: "/project", onChanged: changed }));
    await waitFor(() => expect(result.current.stale).toBe(false));
    await act(async () => { await expect(result.current.mutate("limits", { maxMultiAgents: 4, maxSubagents: 3 })).rejects.toThrow("不匹配"); });
    expect(result.current.snapshot?.cwd).toBe("/project");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it("shares successful changes between live surfaces but rejects older, foreign-host and foreign-workspace broadcasts", async () => {
    let current = snapshot();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") current = snapshot("/project", 2, "main-b");
      return response(current);
    });
    vi.stubGlobal("fetch", fetcher);
    const first = renderHook(() => useResearchCollaboration({ cwd: "/project" }));
    const second = renderHook(() => useResearchCollaboration({ cwd: "/project" }));
    await waitFor(() => expect(first.result.current.stale || second.result.current.stale).toBe(false));
    await act(async () => { await first.result.current.mutate("select-main", { sessionId: "main-b" }); });
    expect(second.result.current.snapshot?.currentMainSessionId).toBe("main-b");
    for (const detail of [
      { apiBase: "", value: snapshot("/project", 1, "old-main") },
      { apiBase: "https://other-host.invalid", value: snapshot("/project", 3, "wrong-host") },
      { apiBase: "", value: snapshot("/foreign", 3, "foreign-main") },
    ]) act(() => { window.dispatchEvent(new CustomEvent("research-collaboration-updated", { detail })); });
    expect(second.result.current.snapshot?.currentMainSessionId).toBe("main-b");
    expect(second.result.current.snapshot?.revision).toBe(2);
  });
});
