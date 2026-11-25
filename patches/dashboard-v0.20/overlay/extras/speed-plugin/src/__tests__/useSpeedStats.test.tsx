// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingPeriod } from "../billing-period.js";
import { useSessionStatsSnapshots, useSpeedStats } from "../useSpeedStats.js";

const response = (id: string, cost: number, active: unknown = null) => ({
  sessionId: id,
  status: active ? "streaming" : "idle",
  active,
  latest: null,
  history: [],
  averageTps: 0,
  recentCount: 0,
  billing: { sessionTotalCost: cost },
});
let pending: { url: string; resolve: (value: unknown) => void }[];
async function resolve(index: number, value: unknown) {
  await act(async () => {
    pending[index].resolve({ ok: true, json: async () => value });
  });
}
beforeEach(() => {
  pending = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) => new Promise((resolve) => pending.push({ url, resolve })),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("session-scoped polling", () => {
  it("clears old money together at midnight and retains performance during the shared refresh", async () => {
    vi.setSystemTime(new Date("2026-10-31T15:59:59.900Z"));
    const { result } = renderHook(() => ({
      folder: useSessionStatsSnapshots([{ id: "month-a" }, { id: "month-b" }]),
      header: useSpeedStats("month-a"),
    }));
    expect(pending).toHaveLength(2);
    await resolve(0, {
      ...response("month-a", 5, { startTime: 1, elapsedSeconds: 12 }),
      billingPeriod: billingPeriod("2026-10"),
      history: [{ id: "performance" }],
    });
    await resolve(1, {
      ...response("month-b", 6),
      billingPeriod: billingPeriod("2026-10"),
    });
    const history = result.current.header.stats?.history;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(pending).toHaveLength(4);
    expect(
      result.current.folder.every((snapshot) => !snapshot.stats?.billing),
    ).toBe(true);
    expect(result.current.header.stats?.history).toBe(history);
    expect(result.current.header.isStreaming).toBe(true);
    expect(result.current.header.elapsed).toBeGreaterThanOrEqual(12);
    await resolve(2, {
      ...response("month-a", 0),
      billingPeriod: billingPeriod("2026-11"),
    });
    await resolve(3, {
      ...response("month-b", 0),
      billingPeriod: billingPeriod("2026-11"),
    });
    expect(
      result.current.folder.map(
        (snapshot) => snapshot.stats?.billing?.sessionTotalCost,
      ),
    ).toEqual([0, 0]);
    expect(result.current.header.stats).toBe(result.current.folder[0].stats);
  });
  it("rejects an old-month response after a suspended tab wakes in a new month", async () => {
    vi.setSystemTime(new Date("2026-12-31T15:59:59.900Z"));
    const { result } = renderHook(() => useSpeedStats("year-change"));
    act(() => {
      vi.setSystemTime(new Date("2026-12-31T16:00:00.100Z"));
    });
    await resolve(0, {
      ...response("year-change", 99),
      billingPeriod: billingPeriod("2026-12"),
    });
    expect(result.current.stats?.billing).toBeUndefined();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(pending).toHaveLength(2);
    await resolve(1, {
      ...response("year-change", 0),
      billingPeriod: billingPeriod("2027-01"),
    });
    expect(result.current.stats?.billing?.sessionTotalCost).toBe(0);
    expect(result.current.stats?.billingPeriod?.month).toBe("2027-01");
  });
  it("keeps store identity when a large directory and its card mount in one commit", async () => {
    const targets = Array.from({ length: 70 }, (_, index) => ({
      id: `batch-${String(index).padStart(3, "0")}`,
      status: "idle",
    }));
    const { result } = renderHook(() => ({
      directory: useSessionStatsSnapshots(targets),
      card: useSpeedStats(targets[0].id, "idle"),
    }));
    expect(pending).toHaveLength(70);
    expect(
      pending.filter((request) => request.url.endsWith("batch-000")),
    ).toHaveLength(1);
    await resolve(0, response("batch-000", 7));
    expect(result.current.directory[0].stats).toBe(result.current.card.stats);
  });
  it("shares one request, poller and snapshot between a card and its header", async () => {
    const card = renderHook(() => useSpeedStats("shared", "idle"));
    const header = renderHook(() => useSpeedStats("shared", "idle"));
    expect(pending).toHaveLength(1);
    await resolve(0, response("shared", 0.487447488));
    expect(card.result.current.stats).toBe(header.result.current.stats);
    expect(card.result.current.stats?.billing?.sessionTotalCost).toBe(
      0.487447488,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(pending).toHaveLength(2);
    await resolve(1, response("shared", 0.75));
    expect(card.result.current.stats).toBe(header.result.current.stats);
    expect(header.result.current.stats?.billing?.sessionTotalCost).toBe(0.75);
    header.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(pending).toHaveLength(3);
    card.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(pending).toHaveLength(3);
  });
  it("keeps another subscriber's request when one consumer switches sessions", async () => {
    const card = renderHook(() => useSpeedStats("kept", "idle"));
    const header = renderHook(({ id }) => useSpeedStats(id, "idle"), {
      initialProps: { id: "kept" },
    });
    expect(pending).toHaveLength(1);
    header.rerender({ id: "next" });
    expect(pending).toHaveLength(2);
    await resolve(0, response("kept", 4));
    expect(card.result.current.stats?.billing?.sessionTotalCost).toBe(4);
    expect(header.result.current.stats).toBeNull();
    await resolve(1, response("next", 8));
    expect(header.result.current.stats?.billing?.sessionTotalCost).toBe(8);
    expect(card.result.current.stats?.billing?.sessionTotalCost).toBe(4);
  });
  it("does not subscribe or request for a disabled consumer", async () => {
    const disabled = renderHook(() =>
      useSpeedStats("disabled", "streaming", false),
    );
    expect(disabled.result.current.stats).toBeNull();
    expect(pending).toHaveLength(0);
  });
  it("rejects an old session's late response and clears old values immediately", async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSpeedStats(id, "idle"),
      { initialProps: { id: "A" } },
    );
    rerender({ id: "B" });
    await resolve(1, response("B", 2));
    expect(result.current.stats?.billing?.sessionTotalCost).toBe(2);
    await resolve(0, response("A", 99));
    expect(result.current.stats?.billing?.sessionTotalCost).toBe(2);
    rerender({ id: "C" });
    expect(result.current.stats).toBeNull();
  });
  it("does not treat running tools as active LLM generation", async () => {
    const { result } = renderHook(() => useSpeedStats("A", "streaming"));
    await resolve(
      0,
      response("A", 1, {
        sessionId: "A",
        startTime: Date.now() - 12000,
        elapsedSeconds: 12,
      }),
    );
    expect(result.current.isStreaming).toBe(true);
    act(() => {
      void result.current.refresh();
    });
    await resolve(1, response("A", 1));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.elapsed).toBe(0);
  });
  it("does not overlap periodic requests and clears active time at generation end", async () => {
    const { result } = renderHook(() => useSpeedStats("A", "streaming"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(pending).toHaveLength(1);
    await resolve(
      0,
      response("A", 1, {
        sessionId: "A",
        startTime: Date.now() - 12000,
        elapsedSeconds: 12,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(pending).toHaveLength(2);
    await resolve(1, response("A", 1));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.elapsed).toBe(0);
  });
});
