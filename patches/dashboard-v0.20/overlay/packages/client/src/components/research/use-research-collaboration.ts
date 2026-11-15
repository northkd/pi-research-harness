import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchCollaborationSnapshot } from "@blackbelt-technology/pi-dashboard-shared/research-collaboration.js";
import { inferPlatform, pathKey } from "@blackbelt-technology/pi-dashboard-shared/session-group-path.js";
import { useApiBase } from "../../lib/api/api-context.js";

const changedEvent = "research-collaboration-updated";
const invalidationKey = "research_collaboration_revision";
type Mutation = "select-main" | "detach" | "limits" | "reorder" | "native-reorder" | "start" | "send-main-task";
type Cache = { scope: string; value: ResearchCollaborationSnapshot | null; loaded: boolean; stale: boolean; error: string | null };

export class CollaborationRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

function failureMessage(status: number, code: string): string {
  if (/revision|conflict/.test(code)) return "协作状态已被更新，请核对最新状态后重试；此次操作没有覆盖其他修改。";
  if (/dependenc/.test(code)) return "前置任务尚未完成，不能提前运行。";
  if (/capacity|limit|memory/.test(code)) return "当前执行容量不足；任务仍在队列中，现有任务不会被中断。";
  if (/historical|tenure|not-current/.test(code)) return "该任务不属于当前主 Agent 任期，不能继续派发。";
  if (/detach|removed/.test(code)) return "该会话已移出工作流，请先核对当前关联。";
  if (status === 403) return "当前账号或项目范围不允许此次操作。";
  if (status === 404) return "协作记录不可用，请确认服务端已更新并且项目已接入。";
  if (status === 409) return "协作状态或任务状态已变化，请核对后重试。";
  return status ? `协作服务暂未确认此次操作（HTTP ${status}）。` : "无法连接协作服务，请稍后重试。";
}

function isSnapshot(value: unknown): value is ResearchCollaborationSnapshot {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, any>;
  return row.schema === "pi-research-collaboration.v1" && typeof row.cwd === "string"
    && Number.isSafeInteger(row.revision) && row.revision >= 0
    && (row.currentMainSessionId === null || typeof row.currentMainSessionId === "string")
    && (row.currentTenureId === null || typeof row.currentTenureId === "string")
    && Array.isArray(row.tenures) && row.tenures.every((t: any) => t && typeof t.id === "string" && typeof t.mainSessionId === "string" && Array.isArray(t.sessionIds))
    && Number.isSafeInteger(row.limits?.maxMultiAgents) && row.limits.maxMultiAgents >= 1
    && Number.isSafeInteger(row.limits?.maxSubagents) && row.limits.maxSubagents >= 1
    && Number.isSafeInteger(row.limitMaximums?.maxMultiAgents) && row.limitMaximums.maxMultiAgents >= row.limits.maxMultiAgents
    && Number.isSafeInteger(row.limitMaximums?.maxSubagents) && row.limitMaximums.maxSubagents >= row.limits.maxSubagents
    && Array.isArray(row.plans) && Array.isArray(row.nativeQueue) && Array.isArray(row.detachedSessionIds);
}

/** The server owns the current lead, tenure history, limits and queue order.
 * localStorage is only a cross-tab invalidation ping, never scheduling authority. */
export function useResearchCollaboration({ cwd, visible = true, connectionGeneration = 0, refreshSignal, onChanged }: {
  cwd: string; visible?: boolean; connectionGeneration?: number; refreshSignal?: string; onChanged?: () => void;
}) {
  const apiBase = useApiBase();
  const scope = JSON.stringify([apiBase, cwd, connectionGeneration]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(true);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writing = useRef<{ scope: string; controller: AbortController } | null>(null);
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const [cache, setCache] = useState<Cache>({ scope, value: null, loaded: false, stale: true, error: null });
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const current = cache.scope === scope ? cache : { scope, value: null, loaded: false, stale: true, error: null };
  const latest = useRef(current); latest.current = current;
  const sameCwd = (left: string, right: string) => {
    const platform = inferPlatform([left, right]);
    return pathKey(left, platform) === pathKey(right, platform);
  };

  const request = useCallback(async (suffix: string, init?: RequestInit): Promise<ResearchCollaborationSnapshot> => {
    let response: Response;
    try { response = await fetch(`${apiBase}/api/res-workflow/collaboration${suffix}`, init); }
    catch (error) { if (init?.signal?.aborted) throw error; throw new CollaborationRequestError(0, "network", failureMessage(0, "network")); }
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof json?.code === "string" ? json.code : typeof json?.error === "string" ? json.error : "unavailable";
      throw new CollaborationRequestError(response.status, code, failureMessage(response.status, code));
    }
    if (!isSnapshot(json)) throw new CollaborationRequestError(response.status, "invalid-response", "协作服务返回的状态不完整，操作入口已暂时停用。");
    return json;
  }, [apiBase]);

  const refresh = useCallback(async () => {
    if (writing.current?.scope === scope) return latest.current.scope === scope ? latest.current.value : null;
    const sequence = ++readSequence.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    try {
      const value = await request(`?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
      if (mounted.current && scopeRef.current === scope && sequence === readSequence.current && !controller.signal.aborted) {
        const next = { scope, value, loaded: true, stale: false, error: null };
        latest.current = next; setCache(next);
      }
      return value;
    } catch (error) {
      if (mounted.current && scopeRef.current === scope && sequence === readSequence.current && !controller.signal.aborted) {
        setCache(previous => ({ scope, value: previous.scope === scope ? previous.value : null, loaded: true, stale: true, error: error instanceof Error ? error.message : "协作状态待同步。" }));
      }
      return null;
    }
  }, [cwd, scope, request]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++readSequence.current; readController.current?.abort(); writing.current?.controller.abort(); writing.current = null; };
  }, [scope]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 2500);
    const onFocus = () => { void refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === invalidationKey) void refresh(); };
    const onBroadcast = (event: Event) => {
      const detail = (event as CustomEvent<{ apiBase: string; value: ResearchCollaborationSnapshot }>).detail;
      if (!detail || detail.apiBase !== apiBase || !isSnapshot(detail.value)) return;
      const previous = latest.current;
      if (!sameCwd(detail.value.cwd, previous.value?.cwd ?? cwd) || writing.current) return;
      if (previous.value && detail.value.revision < previous.value.revision) return;
      ++readSequence.current; readController.current?.abort();
      const next = { scope, value: detail.value, loaded: true, stale: false, error: null };
      latest.current = next; setCache(next);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    window.addEventListener(changedEvent, onBroadcast);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("storage", onStorage); window.removeEventListener(changedEvent, onBroadcast); };
  }, [visible, refresh, refreshSignal, apiBase, cwd, scope]);

  const mutate = useCallback(async (action: Mutation, fields: Record<string, unknown> = {}) => {
    const admitted = latest.current;
    if (writing.current || admitted.scope !== scope || !admitted.value || admitted.stale) throw new Error("请先同步协作状态，再执行操作。");
    const pending = { scope, controller: new AbortController() };
    writing.current = pending; setBusyScope(scope);
    ++readSequence.current; readController.current?.abort();
    try {
      const value = await request("", { method: "POST", headers: { "content-type": "application/json" }, signal: pending.controller.signal,
        body: JSON.stringify({ ...fields, cwd: admitted.value.cwd, action,
          expectedRevision: Number.isSafeInteger(fields.expectedRevision) && Number(fields.expectedRevision) >= 0 ? fields.expectedRevision : admitted.value.revision }) });
      if (scopeRef.current !== scope || !mounted.current || pending.controller.signal.aborted) return null;
      if (!sameCwd(value.cwd, admitted.value.cwd) || value.revision < admitted.value.revision) throw new Error("协作更新回执与当前工作区不匹配，请刷新核对。");
      const next = { scope, value, loaded: true, stale: false, error: null };
      latest.current = next; setCache(next);
      window.dispatchEvent(new CustomEvent(changedEvent, { detail: { apiBase, value } }));
      try { window.localStorage.setItem(invalidationKey, JSON.stringify([apiBase, value.cwd, value.revision, Date.now()])); } catch { /* Polling remains authoritative when storage is disabled. */ }
      changedRef.current?.();
      return value;
    } catch (error) {
      if (scopeRef.current === scope && mounted.current && !pending.controller.signal.aborted) {
        setCache(previous => ({ ...previous, stale: true, error: error instanceof Error ? error.message : "操作尚未确认，请刷新核对。" }));
      }
      throw error;
    } finally {
      if (writing.current === pending) writing.current = null;
      if (scopeRef.current === scope && mounted.current) { setBusyScope(null); void refresh(); }
    }
  }, [apiBase, scope, request, refresh]);

  return { scope, snapshot: current.value, loading: !current.loaded, stale: current.stale, error: current.error,
    busy: busyScope === scope, refresh, mutate };
}

export type ResearchCollaborationController = ReturnType<typeof useResearchCollaboration>;
