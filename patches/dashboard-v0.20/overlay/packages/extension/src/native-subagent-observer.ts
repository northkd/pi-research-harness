/**
 * Read-only native pi-subagents RPC observer.
 *
 * Why this exists: the dashboard needs the executor-backed async snapshot, but
 * the status RPC is a poll. The previous implementation polled every 2 s and,
 * worse, republished an UNCHANGED snapshot on a 20 s heartbeat so the UI could
 * tell "no change" from "adapter stopped answering". On an idle session that
 * heartbeat wrote a `native_subagents_snapshot` event (≈3.9 KB) every ~20 s,
 * forever, which the shell then rendered as a chat row.
 *
 * Contract implemented here:
 *   - publish only when the state signature changes; volatile timestamps are
 *     stripped before comparing, so `generatedAt` churn cannot defeat dedupe;
 *   - no heartbeat and no idle polling. Poll at 2 s ONLY while the snapshot
 *     contains queued/running work; a terminal/idle snapshot stops the loop;
 *   - first load (the initial tick), explicit `refresh()` (session start,
 *     reconnect), and real subagent events still wake it, so it is never
 *     starved;
 *   - a bounded retry (3 attempts) when the adapter answers "unavailable", so a
 *     late-loading producer recovers without an unbounded idle poll;
 *   - replies are applied only if the session that asked is still the owner;
 *   - status queries only; no spawn/control or filesystem access.
 */
const REALTIME_EVENTS = [
  // Producer came up after us (load order): kick instead of polling.
  "subagents:rpc:v1:ready",
  "subagent:child-status",
  "subagent:async-started",
  "subagent:async-complete",
  "subagent:control-event",
  "subagent:process-terminal",
];
/** Coalesce bursts: a fan-out can emit many child-status lines in one tick. */
const REALTIME_DEBOUNCE_MS = 150;
/** Poll cadence while queued/running work exists (not while idle). */
const LIVE_POLL_MS = 2000;
/** Per-request timeout. */
const REQUEST_TIMEOUT_MS = 4000;
/** Bounded recovery when the adapter is not available yet. */
const AVAILABILITY_RETRY_MS = 2000;
const AVAILABILITY_RETRY_LIMIT = 3;
/**
 * Volatile keys that change on every read even when the subagent state is
 * identical. Stripped recursively before the dedupe signature is computed.
 */
const VOLATILE_KEY = /^(generatedAt|receivedAt|updatedAt|startedAt|endedAt|lastActivityAt|currentToolStartedAt|timestamp)$/;
/** States that mean "the executor still has work"; everything else is terminal. */
const LIVE_STATES = new Set(["queued", "running", "stopping", "pending"]);

interface EventsLike {
  on: (name: string, cb: (data: any) => void) => (() => void) | void;
  emit: (name: string, data: unknown) => void;
}

export interface NativeSubagentObserver {
  /** Release every bus subscription and timer. Idempotent. */
  dispose: () => void;
  /**
   * Republish current status after session start or reconnect. An in-flight
   * request queues one follow-up query rather than losing the refresh.
   */
  refresh: () => void;
}

/** True when `value` (snapshot or fleet projection) still contains live work. */
export function hasLiveNativeSubagentWork(value: unknown): boolean {
  return walkForLiveState(value, 0);
}

function walkForLiveState(value: unknown, depth: number): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (Array.isArray(value)) return value.some((entry) => walkForLiveState(entry, depth + 1));
  const record = value as Record<string, unknown>;
  const state = record.state ?? record.status;
  if (typeof state === "string" && LIVE_STATES.has(state.toLowerCase())) return true;
  // Fleet entries carry no state; `totalActive` is the foreground/async
  // activity signal. A foreground run still needs the status poll even when
  // `asyncSnapshot.runs` is empty.
  if (typeof record.totalActive === "number" && record.totalActive > 0) return true;
  for (const key of ["runs", "children", "tasks", "steps", "fleet", "agents"]) {
    if (walkForLiveState(record[key], depth + 1)) return true;
  }
  return false;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (key, entry) => (VOLATILE_KEY.test(key) ? undefined : entry));
}

export function observeNativeSubagents(
  events: EventsLike,
  session: () => string | undefined,
  publish: (data: Record<string, unknown>) => void,
): NativeSubagentObserver {
  let disposed = false;
  let pending = false;
  let refreshQueued = false;
  let release: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let lastSignature: string | undefined;

  const clearTimeoutHandle = (handle: ReturnType<typeof setTimeout> | undefined) => {
    if (handle !== undefined) clearTimeout(handle);
  };
  const clearPoll = () => {
    clearTimeoutHandle(pollTimer);
    pollTimer = undefined;
  };
  const clearRetry = () => {
    clearTimeoutHandle(retryTimer);
    retryTimer = undefined;
  };
  const clearDebounce = () => {
    clearTimeoutHandle(debounce);
    debounce = undefined;
  };

  const schedulePoll = () => {
    if (disposed || pending || pollTimer !== undefined) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      tick();
    }, LIVE_POLL_MS);
    pollTimer.unref?.();
  };

  const scheduleAvailabilityRetry = () => {
    if (disposed || retryTimer !== undefined || retries >= AVAILABILITY_RETRY_LIMIT) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      tick();
    }, AVAILABILITY_RETRY_MS);
    retryTimer.unref?.();
  };

  function tick(): void {
    if (disposed) return;
    if (pending) {
      refreshQueued = true;
      return;
    }
    const owner = session();
    if (!owner) {
      clearPoll();
      return;
    }
    pending = true;
    const requestId = crypto.randomUUID();
    const done = () => {
      pending = false;
      release?.();
      release = undefined;
      clearTimeoutHandle(timeout);
      timeout = undefined;
      if (refreshQueued) {
        refreshQueued = false;
        queueMicrotask(() => tick());
      }
    };
    const deliver = (data: Record<string, unknown>) => {
      if (disposed || session() !== owner) {
        clearPoll();
        return;
      }
      const live = hasLiveNativeSubagentWork(data.snapshot) || hasLiveNativeSubagentWork(data.fleet);
      if (live) schedulePoll();
      else clearPoll();

      const signature = canonicalize([owner, data]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      // `live` lets a projection scope its staleness badge to actual running
      // work. An idle/completed snapshot may be old without meaning the
      // executor disconnected, and this observer deliberately stops pushing
      // unchanged state (no heartbeat).
      publish({ ...data, receivedAt: Date.now(), live });
    };
    const off = events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
      done();
      const ok = reply?.success === true;
      if (ok) {
        retries = 0;
        clearRetry();
      } else {
        retries += 1;
      }
      deliver({
        available: ok,
        snapshot: ok ? reply?.data?.asyncSnapshot : undefined,
        fleet: ok ? reply?.data?.fleet : undefined,
      });
      if (!ok) scheduleAvailabilityRetry();
    });
    release = typeof off === "function" ? off : undefined;
    timeout = setTimeout(() => {
      done();
      retries += 1;
      deliver({ available: false });
      scheduleAvailabilityRetry();
    }, REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
    } catch {
      done();
      retries += 1;
      deliver({ available: false });
      scheduleAvailabilityRetry();
    }
  }

  /** Any real subagent activity schedules an immediate refresh (debounced). */
  const schedule = () => {
    if (disposed || debounce !== undefined) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      clearRetry();
      tick();
    }, REALTIME_DEBOUNCE_MS);
    debounce.unref?.();
  };

  const unsubscribes = REALTIME_EVENTS.map((name) => {
    try {
      return events.on(name, () => schedule());
    } catch {
      return undefined;
    }
  });

  const refresh = () => {
    if (disposed) return;
    clearRetry();
    retries = 0;
    // A reconnect loses the server projection, even if executor state did not change.
    lastSignature = undefined;
    tick();
  };

  // First load. If the session is not ready yet this is a no-op; the bridge
  // calls refresh() once sessionReady flips true.
  tick();

  return {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearPoll();
      clearRetry();
      clearDebounce();
      clearTimeoutHandle(timeout);
      timeout = undefined;
      release?.();
      release = undefined;
      for (const off of unsubscribes) if (typeof off === "function") off();
    },
  };
}
