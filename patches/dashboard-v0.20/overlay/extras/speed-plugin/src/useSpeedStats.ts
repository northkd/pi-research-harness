import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { billingPeriod } from "./billing-period.js";
import type { SpeedStatsResponse } from "./types.js";

export interface SpeedMonitorState {
  stats: SpeedStatsResponse | null;
  loading: boolean;
  elapsed: number;
  isStreaming: boolean;
  refresh: () => Promise<void>;
}
export interface SessionStatsTarget {
  id?: string;
  status?: string;
}
interface Snapshot {
  stats: SpeedStatsResponse | null;
  loading: boolean;
  receivedAt: number;
}
interface Subscriber {
  notify: () => void;
  status: () => string | undefined;
}
interface Store {
  id?: string;
  snapshot: Snapshot;
  subscribers: Set<Subscriber>;
  version: number;
  controller?: AbortController;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
const EMPTY: Snapshot = { stats: null, loading: true, receivedAt: 0 };
const DISABLED: Snapshot = { ...EMPTY, loading: false };
const stores = new Map<string, Store>();
let subscribers = 0;
let displayedMonth: string | undefined;
let monthTimer: ReturnType<typeof setTimeout> | undefined;

function syncBillingMonth() {
  clearTimeout(monthTimer);
  if (!subscribers) return;
  const period = billingPeriod();
  const changed =
    displayedMonth !== undefined && displayedMonth !== period.month;
  displayedMonth = period.month;
  if (changed) {
    for (const store of stores.values()) {
      if (!store.subscribers.size) continue;
      const previous = store.snapshot;
      if (previous.stats)
        publish(store, {
          ...previous,
          loading: true,
          stats: {
            ...previous.stats,
            billing: undefined,
            billingPeriod: period,
            billingHistory: [],
            billingMainHistory: [],
            billingSubagentHistory: [],
          },
        });
      void poll(store, true);
    }
  }
  // A 31-day delay exceeds the browser's signed 32-bit timeout limit.
  monthTimer = setTimeout(
    syncBillingMonth,
    Math.max(1, Math.min(86400000, period.endTime - Date.now())),
  );
}

function resumeBillingMonth() {
  if (typeof document === "undefined" || !document.hidden) syncBillingMonth();
}

function getStore(id?: string): Store {
  const key = id ?? "";
  let store = stores.get(key);
  if (!store) {
    store = { id, snapshot: EMPTY, subscribers: new Set(), version: 0 };
    stores.set(key, store);
  }
  return store;
}

function publish(store: Store, snapshot: Snapshot) {
  store.snapshot = snapshot;
  for (const subscriber of store.subscribers) subscriber.notify();
}

function poll(store: Store, force = false): Promise<void> {
  if (!store.subscribers.size) return Promise.resolve();
  if (store.pending && !force) return store.pending;
  clearTimeout(store.timer);
  store.controller?.abort();
  const controller = new AbortController();
  store.controller = controller;
  const version = ++store.version;
  const requestedMonth = billingPeriod().month;
  const current = () =>
    !controller.signal.aborted &&
    version === store.version &&
    store.subscribers.size > 0;
  const work = (async () => {
    try {
      const url = store.id
        ? `/api/speed-monitor/stats?sessionId=${encodeURIComponent(store.id)}`
        : "/api/speed-monitor/stats";
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return;
      const data: SpeedStatsResponse = await response.json();
      if (
        !current() ||
        (store.id && data.sessionId && data.sessionId !== store.id) ||
        requestedMonth !== billingPeriod().month ||
        (data.billingPeriod && data.billingPeriod.month !== requestedMonth)
      )
        return;
      publish(store, {
        stats: data,
        loading: false,
        receivedAt: performance.now(),
      });
    } catch {
      // Keep the last shared snapshot during a transient network failure.
    } finally {
      if (current()) {
        store.pending = undefined;
        store.controller = undefined;
        if (store.snapshot.loading)
          publish(store, { ...store.snapshot, loading: false });
        const busy =
          !!store.snapshot.stats?.active ||
          [...store.subscribers].some(
            (subscriber) => subscriber.status() === "streaming",
          );
        store.timer = setTimeout(
          () => {
            void poll(store);
          },
          busy ? 1500 : 4000,
        );
      }
    }
  })();
  if (store.controller === controller) store.pending = work;
  return work;
}

function subscribe(
  store: Store,
  notify: () => void,
  status: Subscriber["status"],
) {
  const subscriber = { notify, status };
  store.subscribers.add(subscriber);
  if (++subscribers === 1) {
    displayedMonth = billingPeriod().month;
    syncBillingMonth();
    if (typeof window !== "undefined")
      window.addEventListener("focus", resumeBillingMonth);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", resumeBillingMonth);
  }
  if (store.subscribers.size === 1) void poll(store);
  return () => {
    store.subscribers.delete(subscriber);
    if (--subscribers === 0) {
      clearTimeout(monthTimer);
      if (typeof window !== "undefined")
        window.removeEventListener("focus", resumeBillingMonth);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", resumeBillingMonth);
    }
    if (store.subscribers.size) return;
    clearTimeout(store.timer);
    store.controller?.abort();
    store.version++;
    store.pending = undefined;
    store.controller = undefined;
    store.snapshot = EMPTY;
  };
}

/** Cards, folder totals and headers subscribe to the same session snapshots. */
export function useSessionStatsSnapshots(
  targets: readonly SessionStatsTarget[],
): readonly Snapshot[] {
  const status = useRef(new Map<string | undefined, string | undefined>());
  status.current = new Map(targets.map((target) => [target.id, target.status]));
  const key = JSON.stringify([...status.current.keys()].sort());
  const entries = useMemo(
    () =>
      (JSON.parse(key) as (string | null)[]).map((id) =>
        getStore(id ?? undefined),
      ),
    [key],
  );
  const getSnapshot = useMemo(() => {
    let previous: Snapshot[] = [];
    return () => {
      const next = entries.map((entry) => entry.snapshot);
      if (
        next.length !== previous.length ||
        next.some((value, index) => value !== previous[index])
      )
        previous = next;
      return previous;
    };
  }, [entries]);
  const listen = useCallback(
    (notify: () => void) => {
      const unsubscribes = entries.map((entry) =>
        subscribe(entry, notify, () => status.current.get(entry.id)),
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [entries],
  );
  return useSyncExternalStore(listen, getSnapshot, getSnapshot);
}

export function useSessionStats(
  sessionId?: string,
  sessionStatus?: string,
  enabled = true,
) {
  const snapshots = useSessionStatsSnapshots(
    enabled ? [{ id: sessionId, status: sessionStatus }] : [],
  );
  const snapshot = snapshots[0] ?? DISABLED;
  const refresh = useCallback(
    () => (enabled ? poll(getStore(sessionId), true) : Promise.resolve()),
    [sessionId, enabled],
  );
  return { ...snapshot, refresh };
}

export function useSpeedStats(
  sessionId?: string,
  sessionStatus?: string,
  enabled = true,
): SpeedMonitorState {
  const snapshot = useSessionStats(sessionId, sessionStatus, enabled);
  const active = snapshot.stats?.active;
  const activeStart = active?.startTime;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (activeStart === undefined) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [activeStart, snapshot.receivedAt]);
  const elapsed = active
    ? Number(
        (
          Math.max(0, active.elapsedSeconds) +
          Math.max(0, now - snapshot.receivedAt) / 1000
        ).toFixed(1),
      )
    : 0;
  return {
    stats: snapshot.stats,
    loading: snapshot.loading,
    elapsed,
    isStreaming: !!active,
    refresh: snapshot.refresh,
  };
}
