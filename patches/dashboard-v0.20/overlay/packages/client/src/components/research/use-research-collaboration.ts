import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginSocket, useShellConnectionStatus } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import { useApiBase } from "../../lib/api/api-context.js";

export interface CollaborationLimits { maxMultiAgents: number; maxSubagents: number }
export interface CollaborationMember { title?: string; role?: string; model?: string; status?: string; parentSessionId?: string }
export interface CollaborationTenure {
  id: string; ordinal: number; mainSessionId: string; status: "current" | "historical" | "removed";
  startedAt: string; endedAt?: string;
  sessionIds: string[]; snapshots: Record<string, CollaborationMember>; detachedSessionIds?: string[];
}
export interface CollaborationPlanTask {
  id: string;
  role: string;
  task: string;
  status: string;
  waitingReason?: string;
  queueReason?: string;
  queueRank?: number;
  rank?: number;
  dependsOn?: string[];
  error?: string;
}
export interface CollaborationPlan {
  id: string;
  tenureId?: string;
  parentSessionId: string;
  revision?: number;
  status?: string;
  concurrency?: number;
  effectiveConcurrency?: number;
  suspendedReason?: string;
  schedulingPaused?: boolean;
  tasks: CollaborationPlanTask[];
}
export interface CollaborationNativeQueueItem {
  id?: string;
  requestId?: string;
  parentSessionId?: string;
  tenureId?: string;
  role?: string;
  model?: string;
  task?: string;
  status: string;
  rank?: number;
  queueReason?: string;
  createdAt?: string;
}
export interface CollaborationSnapshot {
  schema: "pi-research-collaboration.v1"; cwd: string; adopted: boolean; revision: number;
  currentTenureId: string | null; currentMainSessionId: string | null;
  limits: CollaborationLimits; limitMaximums: CollaborationLimits;
  tenures: CollaborationTenure[]; plans: CollaborationPlan[];
  nativeQueue: CollaborationNativeQueueItem[];
}
type Change = { action: "select-main"; sessionId: string }
  | { action: "detach"; sessionId: string; tenureId: string }
  | ({ action: "limits" } & CollaborationLimits)
  | { action: "start"; sessionId: string; planId: string; taskId: string; queueRevision: number }
  | { action: "reorder"; sessionId: string; planId: string; taskIds: string[]; queueRevision: number }
  | { action: "native-reorder"; sessionId: string; taskIds: string[] };
const collaborationChanged = "res-workflow-collaboration-changed";

function errorMessageForCode(code: string): string {
  switch (code) {
    case "research-collaboration-revision-conflict":
    case "research-queue-revision-conflict":
    case "research-native-queue-changed":
      return "队列状态刚刚发生变化，已为您刷新最新队列，请重试。";
    case "research-queue-dependencies-pending":
      return "前置依赖任务尚未完成，暂不可提前启动。";
    case "research-dispatch-scheduling-paused":
      return "当前计划调度已暂停，暂不可启动排队任务。";
    case "research-queue-task-not-queued":
      return "该任务已不在排队状态。";
    default:
      return code;
  }
}

function snapshotOf(value: unknown): CollaborationSnapshot {
  const row = value as CollaborationSnapshot | null;
  if (!row || row.schema !== "pi-research-collaboration.v1" || typeof row.cwd !== "string"
      || typeof row.adopted !== "boolean" || !Number.isSafeInteger(row.revision)
      || !row.limits || !row.limitMaximums || !Array.isArray(row.tenures) || !Array.isArray(row.plans) || !Array.isArray(row.nativeQueue)) {
    throw new Error("协作响应无效");
  }
  return row;
}

class CollaborationRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(errorMessageForCode(code));
    this.status = status;
    this.code = code;
  }
}

async function request(url: string, options: RequestInit) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CollaborationRequestError(response.status, typeof body?.code === "string" ? body.code : `HTTP ${response.status}`);
  }
  return snapshotOf(body);
}

export function useResearchCollaboration(cwd: string, visible: boolean, connectionGeneration?: number) {
  const apiBase = useApiBase();
  const socket = usePluginSocket();
  const authorized = useShellConnectionStatus() !== "auth_required";
  const scope = JSON.stringify([apiBase, cwd, connectionGeneration, authorized]);
  const endpoint = `${apiBase}/api/res-workflow/collaboration`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [record, setRecord] = useState<{ scope: string; snapshot: CollaborationSnapshot | null; error: string | null }>();
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const [queueFeedback, setQueueFeedback] = useState<string | null>(null);
  const mutation = useRef<symbol | null>(null);
  const reading = useRef<AbortController | null>(null);
  const visibleRecord = record?.scope === scope ? record : undefined;
  const snapshot = visibleRecord?.snapshot ?? null;
  const canonicalCwd = snapshot?.cwd ?? cwd;

  useEffect(() => {
    setQueueFeedback(null);
  }, [scope]);

  const clearQueueFeedback = useCallback(() => setQueueFeedback(null), []);

  const refresh = useCallback(async () => {
    if (!visible || !authorized || document.hidden || mutation.current || reading.current || currentScope.current !== scope) return;
    const controller = new AbortController();
    reading.current = controller;
    try {
      const next = await request(`${endpoint}?${new URLSearchParams({ cwd })}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      if (currentScope.current === scope && !controller.signal.aborted) setRecord({ scope, snapshot: next, error: null });
    } catch (error) {
      if (currentScope.current === scope && !controller.signal.aborted) {
        const refused = error instanceof CollaborationRequestError && [401, 403, 404].includes(error.status);
        setRecord(previous => ({ scope, snapshot: !refused && previous?.scope === scope ? previous.snapshot : null,
          error: error instanceof Error ? error.message : "读取协作状态失败" }));
      }
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  }, [authorized, cwd, endpoint, scope, visible]);

  useEffect(() => {
    if (!visible || !authorized) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    const onVisible = () => void refresh();
    const onChanged = (event: Event) => {
      const update = (event as CustomEvent<{ cwd: string; endpoint: string }>).detail;
      if (update?.cwd === canonicalCwd && update.endpoint === endpoint) void refresh();
    };
    let registryTimer: number | undefined;
    const onRegistry = (event: MessageEvent) => {
      if (registryTimer !== undefined || typeof event.data !== "string" || !/"session_(added|updated)"/.test(event.data)) return;
      let message: ServerToBrowserMessage;
      try { message = JSON.parse(event.data); } catch { return; }
      const relevant = message.type === "session_added"
        ? message.session.cwd === canonicalCwd || message.session.resWorkflow?.canonicalCwd === canonicalCwd
        : message.type === "session_updated" && (message.updates.resWorkflow?.canonicalCwd === canonicalCwd
          || message.updates.researchSession?.workflowCwd === canonicalCwd);
      if (relevant) registryTimer = window.setTimeout(() => { registryTimer = undefined; void refresh(); }, 150);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(collaborationChanged, onChanged);
    socket?.addEventListener("message", onRegistry);
    return () => {
      reading.current?.abort();
      reading.current = null;
      window.clearInterval(timer);
      window.clearTimeout(registryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(collaborationChanged, onChanged);
      socket?.removeEventListener("message", onRegistry);
    };
  }, [authorized, canonicalCwd, endpoint, refresh, socket, visible]);

  async function change(input: Change) {
    if (!snapshot || !authorized || mutation.current || currentScope.current !== scope) return false;
    const token = Symbol();
    mutation.current = token;
    reading.current?.abort();
    reading.current = null;
    setPendingScope(scope);
    try {
      const next = await request(endpoint, {
        method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, cwd: snapshot.cwd, expectedRevision: snapshot.revision }),
      });
      if (currentScope.current !== scope) return false;
      setRecord({ scope, snapshot: next, error: null });
      const queueAction = (next as CollaborationSnapshot & {
        queueAction?: { startResult?: { status?: string; waitingReason?: string } };
      }).queueAction;
      if (input.action === "start") {
        const resultStatus = queueAction?.startResult?.status;
        if (resultStatus === "running" || resultStatus === "launching") {
          setQueueFeedback("已插队并立即启动");
        } else {
          const reason = queueAction?.startResult?.waitingReason === "capacity"
            ? "当前并发已满，空出槽位后将最先启动"
            : "已移至队首，等待调度启动";
          setQueueFeedback(`已插队至队首（${reason}）`);
        }
      } else if (input.action === "reorder" || input.action === "native-reorder") {
        setQueueFeedback("调度顺序已更新");
      }
      window.dispatchEvent(new CustomEvent(collaborationChanged, { detail: { cwd: next.cwd, endpoint } }));
      return true;
    } catch (error) {
      if (currentScope.current === scope) {
        setRecord({ scope, snapshot, error: error instanceof Error ? error.message : "保存协作设置失败" });
        if (
          error instanceof CollaborationRequestError
          && ["research-collaboration-revision-conflict", "research-queue-revision-conflict", "research-native-queue-changed"].includes(error.code)
        ) {
          window.setTimeout(() => { void refresh(); }, 0);
        }
      }
      return false;
    } finally {
      if (mutation.current === token) { mutation.current = null; setPendingScope(null); }
    }
  }

  return {
    scope,
    snapshot,
    error: visibleRecord?.error ?? null,
    pending: pendingScope === scope,
    queueFeedback,
    clearQueueFeedback,
    change,
    refresh,
  };
}
