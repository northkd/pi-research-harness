import {
  mdiAlertCircleOutline,
  mdiCheckCircleOutline,
  mdiChevronDown,
  mdiChevronRight,
  mdiClockOutline,
  mdiClose,
  mdiFormatListChecks,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiOpenInNew,
  mdiProgressClock,
} from "@mdi/js";
import { Icon } from "@mdi/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  humanPlanTitle,
  planTaskStatusMeta,
  summarizePlan,
  triStateLabel,
  type PlanTaskStatusTone,
} from "./research-plan-topology.js";
import type {
  CollaborationPlan,
  CollaborationPlanTask,
  CollaborationSnapshot,
  useResearchCollaboration,
} from "./use-research-collaboration.js";

type Controller = ReturnType<typeof useResearchCollaboration>;
type TodoFilterTab = "all" | "unfinished" | "queued" | "completed";

const STORAGE_WIDTH_KEY = "research-plan-todo-panel-width";
const STORAGE_HEIGHT_KEY = "research-plan-todo-panel-height";

const WAIT_REASON_LABELS: Record<string, string> = {
  capacity: "等待并发槽位",
  dependencies: "等待前置任务",
  "main-agent-not-selected": "待选主会话",
  "research-session-concurrency-limit": "等待并发槽位",
  "research-session-capacity-limit": "等待会话槽位",
  "research-session-resident-limit": "等待常驻名额",
  "research-session-memory-limit": "等待宿主机内存",
  "research-session-resource-budget-unavailable": "等待主机资源",
  "research-collaboration-multi-capacity": "等待 Multi-Agent 槽位",
};

function clampSize(value: number, minimum: number, available: number): number {
  const maximum = Math.max(1, Math.min(860, available));
  return Math.min(maximum, Math.max(Math.min(minimum, maximum), value));
}

function panelSpace(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 520, height: 620 };
  const compact = window.innerWidth <= 640;
  return {
    width: window.innerWidth - (compact ? 16 : 24),
    height: window.innerHeight - (compact ? 16 : 76),
  };
}

function savedSize(key: string, fallback: number, minimum: number, available: number): number {
  try {
    const raw = Number(window.localStorage.getItem(key));
    return clampSize(Number.isFinite(raw) && raw > 0 ? raw : fallback, minimum, available);
  } catch {
    return clampSize(fallback, minimum, available);
  }
}

function sortQueuedTasks(plan: CollaborationPlan): CollaborationPlanTask[] {
  return plan.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === "queued")
    .sort((a, b) => {
      const ar = a.task.queueRank ?? a.task.rank ?? a.index;
      const br = b.task.queueRank ?? b.task.rank ?? b.index;
      return ar !== br ? ar - br : a.index - b.index;
    })
    .map(({ task }) => task);
}

function reorderIds(ids: string[], fromIdx: number, toIdx: number): string[] {
  const next = [...ids];
  const [item] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, item!);
  return next;
}

function hasPendingDeps(plan: CollaborationPlan, task: CollaborationPlanTask): boolean {
  if (!task.dependsOn?.length) return false;
  return task.dependsOn.some(depId => plan.tasks.find(row => row.id === depId)?.status !== "completed");
}

/** Extract a concise human-readable one-line step title (Claude Code / Codex style). */
function oneLineStepTitle(task: CollaborationPlanTask, linkedTitle: string | null): string {
  if (linkedTitle && linkedTitle.trim()) return linkedTitle.trim();
  const normalized = (task.task || "").replace(/\s+/g, " ").trim();
  if (!normalized) return task.role || task.id;
  const firstSentence = normalized.split(/(?:[。！？\n]|(?:\.\s+))/)[0]?.trim() || normalized;
  return firstSentence.length > 64 ? `${firstSentence.slice(0, 61)}…` : firstSentence;
}

/** Extract a concise one-line excerpt for blocked/failed reason preview. */
function oneLineNote(text?: string | null): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/(?:[。！？\n]|(?:\.\s+))/)[0]?.trim() || cleaned;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 69)}…` : firstSentence;
}

function toneVisual(tone: PlanTaskStatusTone): { icon: string; iconClass: string; badgeClass: string; short: string } {
  switch (tone) {
    case "completed":
      return {
        icon: mdiCheckCircleOutline,
        iconClass: "text-[var(--accent-green)]",
        badgeClass: "text-[var(--accent-green)]",
        short: "已完成",
      };
    case "blocked":
      return {
        icon: mdiAlertCircleOutline,
        iconClass: "text-[var(--accent-red)]",
        badgeClass: "rounded border border-red-500/35 bg-red-500/12 px-1.5 py-0 font-medium text-[var(--accent-red)]",
        short: "受阻",
      };
    case "failed":
      return {
        icon: mdiAlertCircleOutline,
        iconClass: "text-[var(--accent-red)]",
        badgeClass: "rounded border border-red-500/35 bg-red-500/12 px-1.5 py-0 font-medium text-[var(--accent-red)]",
        short: "失败",
      };
    case "queued":
      return {
        icon: mdiClockOutline,
        iconClass: "text-[var(--accent-orange)]",
        badgeClass: "rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0 font-medium text-[var(--accent-orange)]",
        short: "排队中",
      };
    case "in_progress":
      return {
        icon: mdiProgressClock,
        iconClass: "text-[var(--accent-blue)]",
        badgeClass: "rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0 font-medium text-[var(--accent-blue)]",
        short: "进行中",
      };
  }
}

/**
 * Floating resizable Plan Todolist inspector panel, patterned after the Speed & Billing popover.
 * Defaults to a clean one-line-per-task checklist (Claude Code / Codex style);
 * click any item to expand its full dispatch instruction, dependencies and result summary.
 */
export function ResearchPlanTodoPanel({
  planId,
  snapshot,
  controller,
  onSelectPlan,
  onClose,
  onInspectSession,
}: {
  planId: string | null;
  snapshot: CollaborationSnapshot | null;
  controller: Controller;
  onSelectPlan?: (planId: string) => void;
  onClose: () => void;
  onInspectSession?: (sessionId: string) => void;
}) {
  const open = Boolean(planId && snapshot);
  const plan = useMemo(
    () => (planId && snapshot ? snapshot.plans.find(item => item.id === planId) ?? null : null),
    [planId, snapshot],
  );
  const sessionTitleMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const tenure of snapshot?.tenures ?? []) {
      for (const [sid, snap] of Object.entries(tenure.snapshots ?? {})) {
        if (snap?.title) map[sid] = snap.title;
      }
    }
    return map;
  }, [snapshot]);
  const summary = useMemo(() => (plan ? summarizePlan(plan, "", sessionTitleMap) : null), [plan, sessionTitleMap]);
  const [activeTab, setActiveTab] = useState<TodoFilterTab>("all");
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const [maximized, setMaximized] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => savedSize(STORAGE_WIDTH_KEY, 480, 340, panelSpace().width));
  const [panelHeight, setPanelHeight] = useState(() => savedSize(STORAGE_HEIGHT_KEY, 580, 300, panelSpace().height));
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isResizingRef = useRef<"width" | "bottom" | "corner" | null>(null);
  const startPosRef = useRef({ x: 0, y: 0, startW: 480, startH: 580 });
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => {
    setActiveTab("all");
    setExpandedTaskIds(new Set());
  }, [planId]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    if (!open) resizeCleanupRef.current?.();
    const fit = () => {
      const { width, height } = panelSpace();
      setPanelWidth(w => clampSize(w, 340, width));
      setPanelHeight(h => clampSize(h, 300, height));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open, planId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_WIDTH_KEY, String(panelWidth));
      window.localStorage.setItem(STORAGE_HEIGHT_KEY, String(panelHeight));
    } catch {
      /* Storage may be unavailable. */
    }
  }, [panelWidth, panelHeight]);

  const handleClose = useCallback(() => {
    resizeCleanupRef.current?.();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (isResizingRef.current) return;
      const target = event.target as Element | null;
      if (panelRef.current?.contains(target)) return;
      if (target?.closest('[data-testid="plan-progress-open-todo"]')) return;
      handleClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, handleClose]);

  const startResize = (mode: "width" | "bottom" | "corner", event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    isResizingRef.current = mode;
    startPosRef.current = {
      x: event.clientX,
      y: event.clientY,
      startW: panelWidth,
      startH: panelHeight,
    };
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const dx = moveEvent.clientX - startPosRef.current.x;
      const dy = moveEvent.clientY - startPosRef.current.y;
      if (isResizingRef.current === "width" || isResizingRef.current === "corner") {
        setPanelWidth(clampSize(startPosRef.current.startW - dx, 340, panelSpace().width));
      }
      if (isResizingRef.current === "bottom" || isResizingRef.current === "corner") {
        setPanelHeight(clampSize(startPosRef.current.startH + dy, 300, panelSpace().height));
      }
    };

    const onMouseUp = () => {
      isResizingRef.current = null;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
      resizeCleanupRef.current = null;
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
    resizeCleanupRef.current = onMouseUp;
  };

  if (!open || !plan || !summary || !snapshot) return null;

  const { pending, queueFeedback, clearQueueFeedback } = controller;
  const incompleteEnded = summary.blocked + summary.failed;
  const unfinishedCount = summary.total - summary.completed;
  const incompletePercent =
    summary.total > 0 ? Math.min(100 - summary.progressPercent, Math.round((incompleteEnded / summary.total) * 100)) : 0;
  const isCurrentTenure = !plan.tenureId || plan.tenureId === snapshot.currentTenureId;
  const ownerTenure = snapshot.tenures.find(t => t.id === plan.tenureId)
    ?? snapshot.tenures.find(t => t.sessionIds.includes(plan.parentSessionId));
  const siblingPlans = snapshot.plans.filter(
    candidate => (plan.tenureId ? candidate.tenureId === plan.tenureId : candidate.parentSessionId === plan.parentSessionId),
  );
  const queuedTasks = sortQueuedTasks(plan);
  const queuedIds = queuedTasks.map(t => t.id);
  const queueRevision = plan.revision ?? 1;

  const sessionTitle = (sessionId?: string) => {
    if (!sessionId) return null;
    for (let i = snapshot.tenures.length - 1; i >= 0; i--) {
      const title = snapshot.tenures[i]!.snapshots[sessionId]?.title;
      if (title) return title;
    }
    return null;
  };

  const toggleExpand = (taskId: string) => {
    setExpandedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const orderedTasks = plan.tasks.map(task => {
    const meta = planTaskStatusMeta(task.status);
    const queueIndex = task.status === "queued" ? queuedIds.indexOf(task.id) : -1;
    return { task, meta, queueIndex };
  });

  const filteredTasks = orderedTasks.filter(({ meta }) => {
    if (activeTab === "completed") return !meta.incomplete;
    if (activeTab === "unfinished") return meta.incomplete;
    if (activeTab === "queued") return meta.tone === "queued";
    return true;
  });

  const tabs: Array<{ key: TodoFilterTab; label: string; count: number }> = [
    { key: "all", label: "全部", count: summary.total },
    ...(unfinishedCount > 0 ? [{ key: "unfinished" as const, label: "未完成", count: unfinishedCount }] : []),
    ...(summary.queued > 0 ? [{ key: "queued" as const, label: "排队中", count: summary.queued }] : []),
    ...(summary.completed > 0 && unfinishedCount > 0 ? [{ key: "completed" as const, label: "已完成", count: summary.completed }] : []),
  ];

  return createPortal(
    <div
      ref={panelRef}
      id={panelId}
      data-testid="research-plan-todo-panel"
      data-maximized={maximized}
      role="dialog"
      aria-labelledby={titleId}
      aria-modal="false"
      style={{
        width: maximized ? undefined : `${panelWidth}px`,
        height: maximized ? undefined : `${panelHeight}px`,
      }}
      className="research-plan-todo-panel z-dialog flex flex-col text-[var(--text-primary)] select-text"
      onClick={event => event.stopPropagation()}
    >
      {!maximized && (
        <>
          <div
            role="separator"
            tabIndex={0}
            aria-label="调整 Plan Todolist 宽度"
            aria-orientation="vertical"
            aria-valuenow={Math.round(panelWidth)}
            aria-valuemin={Math.min(340, panelSpace().width)}
            aria-valuemax={Math.min(860, panelSpace().width)}
            onKeyDown={event => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setPanelWidth(w => clampSize(w + (event.key === "ArrowLeft" ? 24 : -24), 340, panelSpace().width));
            }}
            onMouseDown={event => startResize("width", event)}
            className="research-todo-resize research-todo-resize-width"
            title="左右拖拽调节窗口宽度"
          >
            <span />
          </div>
          <div
            role="separator"
            tabIndex={0}
            aria-label="调整 Plan Todolist 高度"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(panelHeight)}
            aria-valuemin={Math.min(300, panelSpace().height)}
            aria-valuemax={Math.min(860, panelSpace().height)}
            onKeyDown={event => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              setPanelHeight(h => clampSize(h + (event.key === "ArrowDown" ? 24 : -24), 300, panelSpace().height));
            }}
            onMouseDown={event => startResize("bottom", event)}
            className="research-todo-resize research-todo-resize-height"
            title="上下拖拽调节窗口高度"
          >
            <span />
          </div>
          <div
            onMouseDown={event => startResize("corner", event)}
            className="research-todo-resize research-todo-resize-corner"
            title="对角拖拽同时调节宽高"
          >
            <span />
          </div>
        </>
      )}

      <header className="research-plan-todo-header">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
            <Icon path={mdiFormatListChecks} size={0.55} className="text-[var(--accent-primary)]" />
            <span>任务清单</span>
            {ownerTenure && <span>· 批次 #{ownerTenure.ordinal}</span>}
          </div>
          <h2 id={titleId} className="mt-0.5 truncate text-[15px] font-semibold leading-snug text-[var(--text-primary)]" title={plan.clientPlanId || plan.id}>
            {humanPlanTitle(plan, sessionTitleMap)}
          </h2>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <span className="font-mono font-medium text-[var(--text-primary)]">
              {summary.completed}/{summary.total}
            </span>
            <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              <div className="h-full bg-[var(--accent-green)] transition-all duration-300" style={{ width: `${summary.progressPercent}%` }} />
              {incompletePercent > 0 && (
                <div className="h-full bg-[var(--accent-red)] transition-all duration-300" style={{ width: `${incompletePercent}%` }} />
              )}
            </div>
            <span className={incompleteEnded > 0 && summary.state === "ended" ? "shrink-0 font-medium text-[var(--accent-red)]" : "shrink-0 text-[var(--text-tertiary)]"}>
              {incompleteEnded > 0 && summary.state === "ended"
                ? `${incompleteEnded} 项受阻`
                : summary.completed === summary.total && summary.total > 0
                ? "全部完成"
                : triStateLabel(summary.state)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              resizeCleanupRef.current?.();
              setMaximized(value => !value);
            }}
            className="research-plan-todo-icon-btn"
            aria-label={maximized ? "还原 Plan Todolist 大小" : "最大化 Plan Todolist"}
            title={maximized ? "还原面板大小" : "最大化面板"}
          >
            <Icon path={maximized ? mdiFullscreenExit : mdiFullscreen} size={0.72} />
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={handleClose}
            className="research-plan-todo-icon-btn"
            aria-label="关闭 Plan Todolist"
            title="关闭 (Esc)"
          >
            <Icon path={mdiClose} size={0.76} />
          </button>
        </div>
      </header>

      {siblingPlans.length > 1 && onSelectPlan && (
        <div className="mx-5 mb-2 flex flex-wrap items-center gap-1.5">
          {siblingPlans.map(candidate => {
            const candidateSummary = summarizePlan(candidate, "", sessionTitleMap);
            const active = candidate.id === plan.id;
            const hasIncomplete = candidateSummary.blocked + candidateSummary.failed > 0;
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => onSelectPlan(candidate.id)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] font-semibold text-[var(--accent-text)]"
                    : "border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <span className="max-w-[180px] truncate">{candidateSummary.label}</span>
                <span className={`font-mono text-[10px] ${hasIncomplete ? "text-[var(--accent-red)]" : "opacity-75"}`}>
                  {candidateSummary.completed}/{candidateSummary.total}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {tabs.length > 1 && (
        <div className="research-plan-todo-tabs" role="tablist" aria-label="Todolist 状态筛选">
          {tabs.map(tab => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.key)}
                className={`research-plan-todo-tab ${active ? "is-active" : ""}`}
              >
                <span>{tab.label}</span>
                <span className="font-mono text-[10.5px] opacity-80">{tab.count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="research-plan-todo-content flex-1 min-h-0 overflow-y-auto">
        {queueFeedback && (
          <div
            role="status"
            className="mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--accent-primary)]/40 bg-[var(--accent-soft)] px-2.5 py-1.5 text-[11px] text-[var(--accent-text)]"
          >
            <span>{queueFeedback}</span>
            <button type="button" className="underline hover:opacity-80" onClick={clearQueueFeedback}>
              关闭
            </button>
          </div>
        )}

        {filteredTasks.length === 0 ? (
          <p className="py-8 text-center text-xs text-[var(--text-tertiary)]">该筛选下暂无任务项。</p>
        ) : (
          <ol className="divide-y divide-[var(--border-subtle)]" data-testid="research-plan-todo-list">
            {filteredTasks.map(({ task, meta, queueIndex }) => {
              const visual = toneVisual(meta.tone);
              const linkedTitle = sessionTitle(task.sessionId);
              const headline = oneLineStepTitle(task, linkedTitle);
              const isExpanded = expandedTaskIds.has(task.id);
              const isQueued = meta.tone === "queued" && queueIndex >= 0;
              const isIncompleteEnded = meta.tone === "blocked" || meta.tone === "failed";
              const shortReason = isIncompleteEnded ? oneLineNote(task.error || task.summary) : null;
              const depsPending = isQueued && hasPendingDeps(plan, task);
              const paused = plan.schedulingPaused === true;
              const waitText = paused
                ? "调度已暂停"
                : depsPending
                ? "等待前置任务"
                : WAIT_REASON_LABELS[task.waitingReason ?? task.queueReason ?? ""] ?? "等待调度";
              const canStart = isQueued && isCurrentTenure && snapshot.adopted && !pending && !paused && !depsPending;

              return (
                <li
                  key={task.id}
                  data-testid="research-plan-todo-item"
                  data-task-status={task.status}
                  className={`py-2 first:pt-0.5 ${isIncompleteEnded ? "pl-2 border-l-2 border-l-[var(--accent-red)]" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpand(task.id)}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <Icon path={visual.icon} size={0.68} className={`mt-0.5 shrink-0 ${visual.iconClass}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`min-w-0 flex-1 truncate text-[12.5px] leading-snug ${
                              meta.tone === "completed"
                                ? "text-[var(--text-secondary)]"
                                : "font-medium text-[var(--text-primary)]"
                            }`}
                            title={headline}
                          >
                            {headline}
                          </span>
                          <span className={`shrink-0 text-[10px] ${visual.badgeClass}`}>
                            {isQueued ? `排队 #${queueIndex + 1}` : visual.short}
                          </span>
                          <Icon
                            path={isExpanded ? mdiChevronDown : mdiChevronRight}
                            size={0.54}
                            className="shrink-0 text-[var(--text-tertiary)]"
                          />
                        </div>
                        {!isExpanded && shortReason && (
                          <p className="mt-0.5 truncate text-[11px] text-[var(--accent-red)]" title={task.error || task.summary}>
                            {shortReason}
                          </p>
                        )}
                        {!isExpanded && isQueued && (
                          <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{waitText}</p>
                        )}
                      </div>
                    </button>

                    {!isExpanded && task.sessionId && onInspectSession && !isQueued && (
                      <button
                        type="button"
                        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--accent-text)] hover:bg-[var(--bg-hover)]"
                        aria-label="查看会话详情"
                        title="查看会话详情"
                        onClick={() => onInspectSession(task.sessionId!)}
                      >
                        详情
                      </button>
                    )}
                  </div>

                  {isQueued && isCurrentTenure && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-7">
                      <button
                        type="button"
                        className="research-workspace-action primary !min-h-[22px] !px-2 !py-0 text-[10.5px]"
                        aria-label={`插队启动 ${task.role}`}
                        disabled={!canStart}
                        onClick={() => {
                          void controller.change({
                            action: "start",
                            sessionId: plan.parentSessionId,
                            planId: plan.id,
                            taskId: task.id,
                            queueRevision,
                          });
                        }}
                      >
                        优先启动
                      </button>
                      {queuedTasks.length > 1 && (
                        <>
                          <button
                            type="button"
                            className="research-workspace-action !min-h-[22px] !px-1.5 !py-0 text-[10.5px]"
                            aria-label={`置顶 ${task.role}`}
                            disabled={queueIndex === 0 || pending || !snapshot.adopted}
                            onClick={() => {
                              void controller.change({
                                action: "reorder",
                                sessionId: plan.parentSessionId,
                                planId: plan.id,
                                taskIds: reorderIds(queuedIds, queueIndex, 0),
                                queueRevision,
                              });
                            }}
                          >
                            置顶
                          </button>
                          <button
                            type="button"
                            className="research-workspace-action !min-h-[22px] !px-1.5 !py-0 text-[10.5px]"
                            aria-label={`上移 ${task.role}`}
                            disabled={queueIndex === 0 || pending || !snapshot.adopted}
                            onClick={() => {
                              void controller.change({
                                action: "reorder",
                                sessionId: plan.parentSessionId,
                                planId: plan.id,
                                taskIds: reorderIds(queuedIds, queueIndex, queueIndex - 1),
                                queueRevision,
                              });
                            }}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="research-workspace-action !min-h-[22px] !px-1.5 !py-0 text-[10.5px]"
                            aria-label={`下移 ${task.role}`}
                            disabled={queueIndex === queuedTasks.length - 1 || pending || !snapshot.adopted}
                            onClick={() => {
                              void controller.change({
                                action: "reorder",
                                sessionId: plan.parentSessionId,
                                planId: plan.id,
                                taskIds: reorderIds(queuedIds, queueIndex, queueIndex + 1),
                                queueRevision,
                              });
                            }}
                          >
                            ↓
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {isExpanded && (
                    <div
                      data-testid="research-plan-todo-detail"
                      className="mt-2 ml-7 space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2.5 text-[11.5px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-[var(--text-tertiary)]">
                        <span>
                          角色：<strong className="font-mono text-[var(--text-secondary)]">{task.role}</strong>
                          {task.dependsOn && task.dependsOn.length > 0 && (
                            <> · 依赖：<span className="font-mono">{task.dependsOn.join(", ")}</span></>
                          )}
                        </span>
                        {task.sessionId && onInspectSession && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline"
                            onClick={() => onInspectSession(task.sessionId!)}
                          >
                            <Icon path={mdiOpenInNew} size={0.46} />
                            <span>查看会话详情</span>
                          </button>
                        )}
                      </div>

                      {task.task && (
                        <div>
                          <p className="text-[10.5px] font-medium text-[var(--text-tertiary)]">任务说明</p>
                          <p className="mt-0.5 whitespace-pre-wrap break-words leading-relaxed text-[var(--text-secondary)]">
                            {task.task}
                          </p>
                        </div>
                      )}

                      {(task.error || task.summary) && (
                        <div>
                          <p className={`text-[10.5px] font-medium ${isIncompleteEnded ? "text-[var(--accent-red)]" : "text-[var(--text-tertiary)]"}`}>
                            {task.error ? "阻断 / 报错" : "执行回执"}
                          </p>
                          <p
                            className={`mt-0.5 whitespace-pre-wrap break-words leading-relaxed ${
                              isIncompleteEnded ? "text-[var(--accent-red)]" : "text-[var(--text-secondary)]"
                            }`}
                          >
                            {task.error || task.summary}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <footer className="research-plan-todo-footer flex items-center justify-between gap-2">
        <span>点击任意条目展开指令与回执</span>
        <span>拖拽边缘可调大小 · Esc 关闭</span>
      </footer>
    </div>,
    document.body,
  );
}
