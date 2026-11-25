/**
 * Read-only research file sync: watch/reconnect hints plus a visible 5 s fallback.
 * Scope fencing and retained snapshots keep background refreshes non-disruptive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResWorkflowAdoption, ResWorkflowSnapshot } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { getResWorkflow, ResWorkflowApiError } from "../../lib/api/res-workflow-api.js";
import { ApiHttpError, fetchJsonResponse } from "../../lib/api/fetch-json.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { useResearchWorkbenchLive, type ObservationStatus } from "./use-research-workbench-live.js";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { usePluginSocket, useShellConnectionStatus } from "@blackbelt-technology/dashboard-plugin-runtime";
import {
  type ResearchFileSet,
  type ResearchSnapshot,
  parseResearchSnapshot,
} from "./research-projection.js";

const RESEARCH_FILES = [
  "state.json",
  "ledger.jsonl",
  "events.jsonl",
  "auto-run.json",
] as const;

/** Fallback sync cadence while the document is visible. */
const FALLBACK_MS = 5_000;
/** Coalesce a burst of watch candidates into one read. */
const CHANGE_DEBOUNCE_MS = 200;

type LoadMode = "initial" | "manual" | "silent";

interface InFlight {
  controller: AbortController;
  seq: number;
}

/** A read failure with a user-facing message (never raw JSON noise). */
class ResearchLiveError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow directory API works even when no session has ever been started. */
async function readAll(cwd: string, signal: AbortSignal, apiBase: string): Promise<ResWorkflowSnapshot> {
  let body: ResWorkflowSnapshot;
  try {
    body = await getResWorkflow(cwd, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    const status = err instanceof ResWorkflowApiError || err instanceof ApiHttpError ? err.status : undefined;
    if (status !== undefined && [401, 403, 404].includes(status)) throw new ResearchLiveError(`无权读取科研记录（${status}）；已清除本页缓存。`, status);
    const message = messageOf(err);
    if (/403/.test(message)) throw new ResearchLiveError(`无权读取研究状态（403）：${message}`);
    if (/413|too large/i.test(message)) throw new ResearchLiveError(`研究状态文件过大：${message}`);
    throw new ResearchLiveError(`无法连接研究状态服务：${message}`);
  }
  if (!body || typeof body.cwd !== "string" || !body.cwd || typeof body.adopted !== "boolean" || !body.research || !("adoption" in body)
    || body.adoption !== null && (!body.adoption || body.adoption.cwd !== body.cwd || typeof body.adoption.id !== "string")) {
    throw new ResearchLiveError("研究状态响应损坏：不是合法的目录快照");
  }
  if (body.cwd !== cwd) {
    // An alias is valid only when the exact requested directory independently
    // resolves to this canonical binding through the narrow admission route.
    if (signal.aborted || getApiBase() !== apiBase) throw new DOMException("Aborted", "AbortError");
    const { res, json } = await fetchJsonResponse<{ cwd?: string; adopted?: boolean }>(`${apiBase}/api/res-workflow/connection?cwd=${encodeURIComponent(cwd)}`, { signal });
    if ([401, 403, 404].includes(res.status)) throw new ResearchLiveError(`无权读取科研记录（${res.status}）；已清除本页缓存。`, res.status);
    if (!res.ok || json?.cwd !== body.cwd || json.adopted !== body.adopted) throw new ResearchLiveError("研究状态响应目录不一致，未采用这份记录。");
  }
  for (const name of RESEARCH_FILES) {
    if (body.research[name] !== null && typeof body.research[name] !== "string") {
      throw new ResearchLiveError(`研究状态路径不是普通文件：${name}`);
    }
  }
  return body;
}

/** Existence bitmap: a change means a watcher must be declared again. */
function existenceKey(files: ResearchFileSet): string {
  return RESEARCH_FILES.map((name) => (files[name] === null ? "0" : "1")).join("");
}

function contentKey(files: ResearchFileSet): string {
  return JSON.stringify(RESEARCH_FILES.map((name) => files[name]));
}

function parseSnapshot(files: ResearchFileSet): ResearchSnapshot {
  let snapshot: ResearchSnapshot;
  try {
    snapshot = parseResearchSnapshot(files);
  } catch (err) {
    // The projection already produces a user-facing "…损坏…" sentence.
    const message = messageOf(err);
    throw new ResearchLiveError(message.startsWith("研究") ? message : `研究状态文件损坏：${message}`);
  }
  // A present-but-unparseable state.json must not be mistaken for "no study yet".
  if (files["state.json"] !== null && snapshot.state === null) {
    throw new ResearchLiveError("研究状态文件损坏：state.json 无法解析");
  }
  return snapshot;
}

/** Normalize errors for display; abort/scope staleness is filtered by the caller. */
function describeError(err: unknown): string {
  if (err instanceof ResearchLiveError) return err.message;
  return `读取研究状态失败：${messageOf(err)}`;
}

export interface UseResearchLoopLiveOptions {
  cwd: string;
  /** Raw watch-candidate generation string (research paths only). */
  refreshSignal?: string;
  /** WS connection generation; a bump resyncs the watch and reloads. */
  connectionGeneration?: number;
  /** Re-declare the server watch (used on reconnect + first appearance). */
  resyncWatch?: () => void;
}

export interface ResearchLoopLive {
  snapshot: ResearchSnapshot | null;
  adopted: boolean;
  adoption: ResWorkflowAdoption | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  checkedAt: string | null;
  refresh: () => void;
  workbench: ResearchWorkbenchObservation | null;
  observationStatus: ObservationStatus;
  observationError: string | null;
}

export function useResearchLoopLive({
  cwd,
  refreshSignal,
  connectionGeneration,
  resyncWatch,
}: UseResearchLoopLiveOptions): ResearchLoopLive {
  const apiBase = useApiBase();
  const socket = usePluginSocket(), authRequired = useShellConnectionStatus() === "auth_required";
  const scopeKey = JSON.stringify([apiBase, cwd, connectionGeneration, authRequired]);
  const scopeRef = useRef({ key: scopeKey, socket, token: Symbol() });
  if (scopeRef.current.key !== scopeKey || socket !== null && scopeRef.current.socket !== socket) scopeRef.current = { key: scopeKey, socket, token: Symbol() };
  const scope = scopeRef.current.token;
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null);
  const [adopted, setAdopted] = useState(false);
  const [adoption, setAdoption] = useState<ResWorkflowAdoption | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const stateScopeRef = useRef(scope);
  const resyncRef = useRef(resyncWatch);
  resyncRef.current = resyncWatch;

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const inFlightRef = useRef<InFlight | null>(null);
  const dirtyModeRef = useRef<LoadMode | null>(null);
  const lastContentRef = useRef<string | null>(null);
  const lastExistenceRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCurrent = useCallback((seq: number, controller: AbortController, requestCwd: string): boolean => {
    return (
      mountedRef.current &&
      seq === seqRef.current &&
      cwdRef.current === requestCwd &&
      scopeRef.current.token === scope && getApiBase() === apiBase &&
      !controller.signal.aborted
    );
  }, [scope, apiBase]);

  const runLoad = useCallback(
    async (mode: LoadMode): Promise<void> => {
      const requestCwd = cwdRef.current;
      if (!requestCwd || authRequired || getApiBase() !== apiBase) return;
      const seq = ++seqRef.current;
      const controller = new AbortController();
      inFlightRef.current = { controller, seq };
      if (mode === "initial") setLoading(true);
      if (mode === "manual") setRefreshing(true);

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new ResearchLiveError("研究状态读取超时，稍后自动重试。")), 9_000); });
        const result = await Promise.race([readAll(requestCwd, controller.signal, apiBase), deadline]);
        if (!isCurrent(seq, controller, requestCwd)) return;
        const files = result.research;
        const parsed = parseSnapshot(files);
        if (!isCurrent(seq, controller, requestCwd)) return;

        const content = contentKey(files);
        if (content !== lastContentRef.current) {
          lastContentRef.current = content;
          setSnapshot(parsed);
        }

        setAdopted(result.adopted);
        setAdoption(previous => JSON.stringify(previous) === JSON.stringify(result.adoption) ? previous : result.adoption);

        const existence = existenceKey(files);
        // Only a CHANGE after the first successful load needs a re-declare:
        // a file that appeared late could not have been watched yet.
        if (lastExistenceRef.current !== null && existence !== lastExistenceRef.current) {
          resyncRef.current?.();
        }
        lastExistenceRef.current = existence;

        setCheckedAt(new Date().toISOString());
        setError(null);
      } catch (err) {
        if (!isCurrent(seq, controller, requestCwd)) return;
        controller.abort();
        const status = err instanceof ResearchLiveError || err instanceof ResWorkflowApiError || err instanceof ApiHttpError ? err.status : undefined;
        if (status !== undefined && [401, 403, 404].includes(status)) {
          setSnapshot(null); setAdoption(null); setAdopted(false); setCheckedAt(null);
          lastContentRef.current = null; lastExistenceRef.current = null; dirtyModeRef.current = null;
        }
        setError(describeError(err));
      } finally {
        clearTimeout(timeout);
        if (inFlightRef.current?.seq === seq) inFlightRef.current = null;
        if (seqRef.current === seq) {
          if (mode === "initial") setLoading(false);
          if (mode === "manual") setRefreshing(false);

          const next = dirtyModeRef.current;
          dirtyModeRef.current = null;
          if (next && mountedRef.current && cwdRef.current === requestCwd
            && (next === "manual" || typeof document === "undefined" || !document.hidden)) {
            void runLoad(next);
          }
        }
      }
    },
    [isCurrent, apiBase, authRequired],
  );

  /** Single-flight: a trigger during a load becomes exactly one follow-up. */
  const requestLoad = useCallback(
    (mode: LoadMode) => {
      if (inFlightRef.current) {
        // Never downgrade a queued manual refresh to silent.
        const queued = dirtyModeRef.current;
        dirtyModeRef.current = mode === "manual" || queued === "manual" ? "manual" : "silent";
        return;
      }
      void runLoad(mode);
    },
    [runLoad],
  );

  // cwd scope: abort the outgoing read and reset every committed value. The
  // cleanup also runs for StrictMode's discarded mount, so setup B always
  // starts a fresh read instead of trusting a scope marker from the aborted run.
  useEffect(() => {
    stateScopeRef.current = scope;
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
    dirtyModeRef.current = null;
    seqRef.current += 1;
    lastContentRef.current = null;
    lastExistenceRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSnapshot(null);
    setAdoption(null);
    setAdopted(false);
    setError(null);
    setCheckedAt(null);
    setRefreshing(false);
    if (!cwd || authRequired) {
      setLoading(false);
      if (authRequired) setError("身份验证已失效，科研记录待重新授权读取。");
    } else {
      setLoading(true);
      void runLoad("initial");
    }
    return () => {
      seqRef.current += 1;
      inFlightRef.current?.controller.abort();
      inFlightRef.current = null;
      dirtyModeRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
    };
  }, [cwd, scope, runLoad]);

  // Mounted latch + final safety net for the debounce timer.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Watch candidates (research paths only): debounce into one silent read.
  const prevSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === prevSignalRef.current) return;
    prevSignalRef.current = refreshSignal;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      if (typeof document !== "undefined" && document.hidden) return;
      requestLoad("silent");
    }, CHANGE_DEBOUNCE_MS);
  }, [refreshSignal, requestLoad]);

  // WS reconnect: the server forgot every watcher — re-declare, then reload.
  const prevConnRef = useRef(connectionGeneration);
  useEffect(() => {
    if (connectionGeneration === undefined || connectionGeneration === prevConnRef.current) return;
    prevConnRef.current = connectionGeneration;
    resyncRef.current?.();
    // The connection-scoped effect already starts a fresh initial read.
  }, [connectionGeneration]);

  // Visibility: hidden pauses the fallback; visible reloads immediately.
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      const next = !document.hidden;
      setVisible(next);
      if (next) requestLoad("silent");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [requestLoad]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => requestLoad("silent"), FALLBACK_MS);
    return () => clearInterval(timer);
  }, [visible, requestLoad]);

  const inScope = stateScopeRef.current === scope;
  const observation = useResearchWorkbenchLive({ cwd, adoption: inScope ? adoption : null, adopted: inScope && adopted, charter: inScope ? snapshot?.state?.charter : undefined, connectionGeneration, refreshSignal });
  const refresh = useCallback(() => { requestLoad("manual"); observation.refreshObservation(); }, [requestLoad, observation.refreshObservation]);

  // Effects run after render: never expose the outgoing cwd's data in that gap.
  return {
    snapshot: inScope ? snapshot : null,
    adopted: inScope && adopted,
    adoption: inScope ? adoption : null,
    loading: inScope ? loading : Boolean(cwd),
    refreshing: inScope && refreshing,
    error: inScope ? error : null,
    checkedAt: inScope ? checkedAt : null,
    refresh,
    workbench: observation.workbench,
    observationStatus: observation.observationStatus,
    observationError: observation.observationError,
  };
}
