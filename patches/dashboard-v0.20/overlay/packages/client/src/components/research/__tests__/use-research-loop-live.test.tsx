/**
 * `useResearchLoopLive` IO contract.
 *
 * Pins the boundary between "file missing" (neutral empty project), explicit
 * transport/permission/corruption errors, and the scheduling invariants the
 * workbench relies on: debounce, single-flight, reconnect resync, 5 s visible
 * fallback, hidden pause, scope fencing, retained snapshot, stable identity.
 * See change: functional-stargazing-planet.
 */
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResearchLoopLive } from "../use-research-loop-live.js";

const CWD = "/proj";
const FILES = ["state.json", "ledger.jsonl", "events.jsonl", "auto-run.json"] as const;
const FETCHES_PER_LOAD = 1;

type FileAnswer = { status?: number; content?: string | null; type?: string; throw?: boolean } | null;

function stateJson(objective: string): string {
  return JSON.stringify({ charter: { objective, successCriteria: ["ok"] } });
}

function answersFor(objective: string): Record<string, FileAnswer> {
  return {
    "state.json": { content: stateJson(objective) },
    "ledger.jsonl": { content: "" },
    "events.jsonl": { content: "" },
    "auto-run.json": null, // 404 — no receipt yet
  };
}

function cwdOf(input: string | URL | Request): string {
  return new URL(String(input), "http://localhost").searchParams.get("cwd") ?? "";
}

function responseFor(answers: Record<string, FileAnswer>): Response {
  const status = Object.values(answers).find(answer => answer?.status && answer.status !== 200)?.status ?? 200;
  const research = Object.fromEntries(FILES.map(name => {
    const answer = answers[name];
    return [name, answer == null ? null : answer.type && answer.type !== "file" ? { type: answer.type } : answer.content ?? ""];
  }));
  const body = status === 200 ? { cwd: CWD, adopted: false, adoption: null, research } : { error: `status ${status}` };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Microtask flush under fake timers: each read awaits fetch + json + Promise.all. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useResearchLoopLive", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let answers: Record<string, FileAnswer>;

  beforeEach(() => {
    vi.useFakeTimers();
    answers = answersFor("goal");
    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (Object.values(answers).some(answer => answer?.throw)) throw new Error("network down");
      return responseFor(answers);
    });
    vi.stubGlobal("fetch", fetchMock);
    setHidden(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // Reset the property only (no event): dispatching here could poke a hook
    // that RTL has not unmounted yet with the real fetch restored.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  function renderLive(initial?: Partial<Parameters<typeof useResearchLoopLive>[0]>) {
    return renderHook(
      (props: Parameters<typeof useResearchLoopLive>[0]) => useResearchLoopLive(props),
      { initialProps: { cwd: CWD, refreshSignal: "", ...initial } },
    );
  }

  it("survives StrictMode's discarded mount and still completes the first read", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(
      (props: Parameters<typeof useResearchLoopLive>[0]) => useResearchLoopLive(props),
      { initialProps: { cwd: CWD }, wrapper },
    );
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot?.state?.charter?.objective).toBe("goal");
  });

  it("loads the four-file projection through one narrow directory snapshot without a session", async () => {
    const { result } = renderLive();
    expect(result.current.loading).toBe(true);

    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot?.state?.charter?.objective).toBe("goal");
    expect(result.current.snapshot?.attempts).toEqual([]);
    expect(result.current.snapshot?.receipt).toBeNull();
    expect(typeof result.current.checkedAt).toBe("string");
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/res-workflow");
    expect(url.searchParams.get("cwd")).toBe(CWD);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/file"))).toBe(false);
  });

  it("treats 404 as a missing file, not an error (neutral empty project)", async () => {
    answers = Object.fromEntries(FILES.map((name) => [name, null])) as Record<string, FileAnswer>;
    const { result } = renderLive();
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).not.toBeNull();
    expect(result.current.snapshot?.state).toBeNull();
    expect(result.current.snapshot?.receipt).toBeNull();
  });

  it("surfaces 403 instead of folding it into 'not initialized'", async () => {
    answers["state.json"] = { status: 403 };
    const { result } = renderLive();
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toContain("403");
    expect(result.current.error).toContain("无权");
  });

  it("surfaces network, non-file, oversized and corrupt responses explicitly", async () => {
    answers["state.json"] = { throw: true };
    const network = renderLive();
    await flush();
    expect(network.result.current.error).toContain("无法连接");
    network.unmount();

    answers = answersFor("goal");
    answers["auto-run.json"] = { type: "directory", content: "" };
    const nonFile = renderLive();
    await flush();
    expect(nonFile.result.current.error).toContain("不是普通文件");
    nonFile.unmount();

    answers = answersFor("goal");
    answers["events.jsonl"] = { status: 413 };
    const oversized = renderLive();
    await flush();
    expect(oversized.result.current.error).toContain("过大");
    oversized.unmount();

    answers = answersFor("goal");
    answers["state.json"] = { content: "{ definitely not json" };
    const corrupt = renderLive();
    await flush();
    expect(corrupt.result.current.error).toContain("损坏");
  });

  it("aborts a failed directory request so later polls do not leak requests", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return responseFor({ "state.json": { status: 403 } });
    });
    const { result } = renderLive();
    await flush();
    expect(result.current.error).toContain("403");
    expect(signals).toHaveLength(1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("retains the last good snapshot across a transient error and recovers", async () => {
    const { result, rerender } = renderLive();
    await flush();
    const first = result.current.snapshot;
    expect(first?.state?.charter?.objective).toBe("goal");

    answers["state.json"] = { status: 500 };
    act(() => result.current.refresh());
    await flush();

    expect(result.current.snapshot).toBe(first);
    expect(result.current.error).toContain("500");
    expect(result.current.refreshing).toBe(false);

    answers["state.json"] = { content: stateJson("recovered") };
    act(() => result.current.refresh());
    await flush();

    expect(result.current.error).toBeNull();
    expect(result.current.snapshot?.state?.charter?.objective).toBe("recovered");
    void rerender;
  });

  it("clears formal scientific records after a directory permission refusal while the shell scope remains unchanged", async () => {
    const { result } = renderLive(); await flush(); expect(result.current.snapshot?.state?.charter?.objective).toBe("goal");
    answers["state.json"] = { status: 403 }; act(() => result.current.refresh()); await flush();
    expect(result.current.snapshot).toBeNull(); expect(result.current.adoption).toBeNull(); expect(result.current.adopted).toBe(false);
    expect(result.current.error).toContain("403");
  });

  it("keeps snapshot identity when bytes are unchanged", async () => {
    const { result } = renderLive();
    await flush();
    const first = result.current.snapshot;

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();

    expect(result.current.snapshot).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);
  });

  it("debounces watch signals and coalesces a burst into one read", async () => {
    const { rerender } = renderLive();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);

    rerender({ cwd: CWD, refreshSignal: "a" });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    rerender({ cwd: CWD, refreshSignal: "b" });
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);
  });

  it("polls every 5 s while visible and pauses while hidden", async () => {
    const { result } = renderLive();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);

    await act(async () => {
      vi.advanceTimersByTime(4_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);

    act(() => setHidden(true));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);
    expect(result.current.loading).toBe(false);

    act(() => setHidden(false));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 3);
  });

  it("on reconnect resyncs the watch and reloads immediately", async () => {
    const resyncWatch = vi.fn();
    const { rerender } = renderLive({ connectionGeneration: 0, resyncWatch });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);

    rerender({ cwd: CWD, refreshSignal: "", connectionGeneration: 1, resyncWatch });
    await flush();

    expect(resyncWatch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);
  });

  it("re-declares the watch once a previously missing file appears", async () => {
    const resyncWatch = vi.fn();
    answers["state.json"] = null;
    const { rerender } = renderLive({ resyncWatch });
    await flush();
    expect(resyncWatch).not.toHaveBeenCalled();

    // State file gets created; the existing watcher could not attach to a
    // path that did not exist, so the reader asks for a re-declare.
    answers["state.json"] = { content: stateJson("created later") };
    rerender({ cwd: CWD, refreshSignal: "late", resyncWatch });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await flush();

    expect(resyncWatch).toHaveBeenCalledTimes(1);
  });

  it("never exposes the previous cwd snapshot during the first render of a new scope", async () => {
    const seen: Array<{ cwd: string; objective: string | undefined }> = [];
    const { rerender } = renderHook(({ cwd }: { cwd: string }) => {
      const live = useResearchLoopLive({ cwd });
      seen.push({ cwd, objective: live.snapshot?.state?.charter?.objective });
      return live;
    }, { initialProps: { cwd: CWD } });
    await flush();
    expect(seen.some(entry => entry.objective === "goal")).toBe(true);

    fetchMock.mockImplementation(async () => new Promise(() => {}));
    rerender({ cwd: "/next" });
    expect(seen.filter(entry => entry.cwd === "/next").every(entry => entry.objective === undefined)).toBe(true);
  });

  it("drops queued background work when the document becomes hidden", async () => {
    const { rerender } = renderLive();
    await flush();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      await gate;
      return responseFor(answers);
    });
    rerender({ cwd: CWD, refreshSignal: "first" });
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);
    rerender({ cwd: CWD, refreshSignal: "second" });
    await act(async () => { vi.advanceTimersByTime(200); });
    act(() => setHidden(true));
    release();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 2);

    act(() => setHidden(false));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD * 3);
  });

  it("fences a slow response from the previous cwd", async () => {
    let releaseOld: () => void = () => {};
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      if (cwdOf(input) === "/old") {
        await oldGate;
        return responseFor(answersFor("old"));
      }
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return responseFor(answers);
    });

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useResearchLoopLive>[0]) => useResearchLoopLive(props),
      { initialProps: { cwd: "/old", refreshSignal: "" } },
    );
    await flush();

    rerender({ cwd: CWD, refreshSignal: "" });
    await flush();
    expect(result.current.snapshot?.state?.charter?.objective).toBe("goal");

    releaseOld();
    await flush();

    expect(result.current.snapshot?.state?.charter?.objective).toBe("goal");
    expect(result.current.loading).toBe(false);
  });

  it("aborts the in-flight read and stops timers on unmount", async () => {
    let aborted = false;
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise(() => {});
      return responseFor({});
    });

    const { unmount } = renderLive();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_LOAD);

    unmount();
    expect(aborted).toBe(true);

    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
