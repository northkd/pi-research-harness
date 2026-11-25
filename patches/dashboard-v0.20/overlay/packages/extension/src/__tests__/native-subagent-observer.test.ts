/**
 * Native subagent observer — idle must be quiet, live work must stay fresh.
 *
 * The old observer used a 2 s poll plus a 20 s "stale" heartbeat that
 * republished an unchanged snapshot forever. On an idle session that produced
 * one 3.9 KB `native_subagents_snapshot` frame every ~20 s (measured live:
 * 20010 ms apart). These tests pin the replacement contract:
 *   - publish ONLY when the state signature changes (volatile timestamps
 *     stripped), never as a time-based heartbeat;
 *   - poll only while the snapshot contains queued/running work;
 *   - first load, reconnect refresh(), and real subagent events still kick a
 *     query — no starvation;
 *   - replies from a previous session are dropped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeNativeSubagents as observeForTest } from "../native-subagent-observer.js";

afterEach(() => vi.useRealTimers());

interface Harness {
  requests: Array<{ requestId: string; method: string; params: unknown }>;
  publish: ReturnType<typeof vi.fn>;
  stop: () => void;
  refresh: () => void;
  reply: (data: unknown) => void;
  emit: (channel: string, data?: unknown) => void;
  setOwner: (next: string | undefined) => void;
  handlerCount: () => number;
}

function harness(): Harness {
  vi.useFakeTimers();
  const handlers = new Map<string, Array<(data: any) => void>>();
  const requests: Harness["requests"] = [];
  const events = {
    on: (name: string, cb: (data: any) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), cb]);
      return () => {
        const list = handlers.get(name) ?? [];
        handlers.set(name, list.filter((entry) => entry !== cb));
      };
    },
    emit: (_name: string, data: any) => requests.push(data),
  };
  let owner: string | undefined = "session-a";
  const publish = vi.fn();
  const observer = observeForTest(events, () => owner, publish);
  return {
    requests,
    publish,
    stop: observer.dispose,
    refresh: observer.refresh,
    reply: (data) => {
      const requestId = requests.at(-1)?.requestId;
      if (!requestId) throw new Error("no request to reply to");
      for (const cb of handlers.get(`subagents:rpc:v1:reply:${requestId}`) ?? []) {
        cb({ success: true, data });
      }
    },
    emit: (channel, data = {}) => {
      for (const cb of handlers.get(channel) ?? []) cb(data);
    },
    setOwner: (next) => {
      owner = next;
    },
    handlerCount: () => [...handlers.values()].reduce((n, list) => n + list.length, 0),
  };
}

describe("native subagent observer — idle silence", () => {
  it("publishes the first snapshot once and never republishes unchanged idle state", () => {
    const h = harness();
    expect(h.requests).toHaveLength(1);
    h.reply({ asyncSnapshot: { generatedAt: 1, runs: [] } });
    expect(h.publish).toHaveBeenCalledTimes(1);
    // Idle snapshot: `live:false` so a projection can avoid an age-based
    // "disconnected" badge even though no heartbeat follows.
    expect(h.publish.mock.calls[0][0].live).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("does not let generatedAt/updatedAt churn bypass dedupe", () => {
    const h = harness();
    h.reply({
      asyncSnapshot: {
        generatedAt: 1,
        runs: [{ id: "r1", state: "running", startedAt: 1, updatedAt: 1 }],
      },
    });
    expect(h.publish).toHaveBeenCalledTimes(1);

    // Poll #2 while running: same state, new timestamps only.
    vi.advanceTimersByTime(2_000);
    expect(h.requests).toHaveLength(2);
    h.reply({
      asyncSnapshot: {
        generatedAt: 2,
        runs: [{ id: "r1", state: "running", startedAt: 1, updatedAt: 2 }],
      },
    });
    expect(h.publish).toHaveBeenCalledTimes(1);

    // Poll #3: terminal state is a real change and is published.
    vi.advanceTimersByTime(2_000);
    h.reply({
      asyncSnapshot: {
        generatedAt: 3,
        runs: [{ id: "r1", state: "complete", startedAt: 1, updatedAt: 3, endedAt: 3 }],
      },
    });
    expect(h.publish).toHaveBeenCalledTimes(2);

    // Terminal state stops the loop: no further requests.
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(3);
    h.stop();
  });

  it("polls while queued/running work exists, then stops at terminal state", () => {
    const h = harness();
    h.reply({ asyncSnapshot: { runs: [{ id: "r1", state: "queued" }] } });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0].live).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(h.requests).toHaveLength(2);
    h.reply({ asyncSnapshot: { runs: [{ id: "r1", state: "running" }] } });
    expect(h.publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    h.reply({ asyncSnapshot: { runs: [{ id: "r1", state: "failed" }] } });
    expect(h.publish).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(30_000);
    expect(h.requests).toHaveLength(3);
    h.stop();
  });

  it("keeps polling while the fleet reports active foreground work", () => {
    const h = harness();
    h.reply({ asyncSnapshot: { runs: [] }, fleet: { totalActive: 1, entries: [] } });
    expect(h.publish.mock.calls[0][0].live).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(h.requests).toHaveLength(2);
    h.reply({ asyncSnapshot: { runs: [] }, fleet: { totalActive: 0, entries: [] } });
    expect(h.publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(h.requests).toHaveLength(2);
    h.stop();
  });

  it("wakes when the producer announces readiness (late load order)", () => {
    const h = harness();
    h.reply({ asyncSnapshot: { runs: [] } });
    vi.advanceTimersByTime(30_000);
    expect(h.requests).toHaveLength(1);
    h.emit("subagents:rpc:v1:ready", {});
    vi.advanceTimersByTime(150);
    expect(h.requests).toHaveLength(2);
    h.stop();
  });

  it("wakes on a real subagent event while idle, without an idle poll", () => {
    const h = harness();
    h.reply({ asyncSnapshot: { generatedAt: 1, runs: [] } });
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(1);

    h.emit("subagent:async-started", { id: "r2" });
    vi.advanceTimersByTime(150);
    expect(h.requests).toHaveLength(2);
    h.reply({ asyncSnapshot: { generatedAt: 2, runs: [{ id: "r2", state: "running" }] } });
    expect(h.publish).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("refresh() republishes unchanged state after reconnect loses the projection", () => {
    const h = harness();
    h.reply({ asyncSnapshot: { runs: [] } });
    h.refresh();
    expect(h.requests).toHaveLength(2);
    h.reply({ asyncSnapshot: { runs: [] } });
    expect(h.publish).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("queues a new-session refresh while the old request is still in flight", async () => {
    const h = harness();
    h.setOwner("session-b");
    h.refresh();
    h.reply({ asyncSnapshot: { runs: [{ id: "old", state: "complete" }] } });
    await Promise.resolve();
    expect(h.requests).toHaveLength(2);
    expect(h.publish).not.toHaveBeenCalled();
    h.reply({ asyncSnapshot: { runs: [{ id: "new", state: "complete" }] } });
    expect(h.publish.mock.calls[0][0].snapshot.runs[0].id).toBe("new");
    h.stop();
  });

  it("drops replies owned by a previous session and refreshes for the new one", () => {
    const h = harness();
    h.setOwner("session-b");
    h.reply({ asyncSnapshot: { runs: [{ id: "leak", state: "running" }] } });
    expect(h.publish).not.toHaveBeenCalled();

    h.refresh();
    expect(h.requests).toHaveLength(2);
    h.reply({ asyncSnapshot: { runs: [{ id: "own", state: "running" }] } });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0].snapshot.runs[0].id).toBe("own");
    h.stop();
  });

  it("reports an unavailable adapter once, retries a bounded number of times, then stops", () => {
    const h = harness();
    vi.advanceTimersByTime(4_000); // request timeout
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0].available).toBe(false);
    vi.advanceTimersByTime(30_000);
    const bounded = h.requests.length;
    expect(bounded).toBeLessThanOrEqual(4);
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(bounded);
    expect(h.publish).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("disposes every bus subscription and timer", () => {
    const h = harness();
    h.reply({ asyncSnapshot: { runs: [{ id: "r1", state: "running" }] } });
    h.stop();
    expect(h.handlerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(1);
  });
});
