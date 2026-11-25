import { useEffect, useRef, useState } from "react";
import { ResearchAgentCanvas, type CanvasSessionCluster } from "./ResearchAgentCanvas.js";
import type { ConfiguredRole, ResearchExecution, ResearchProjection } from "./research-projection.js";
import { researchStatusLabel } from "./ResearchAgentDetail.js";
import type {
  CollaborationNativeQueueItem,
  CollaborationPlan,
  CollaborationPlanTask,
  CollaborationSnapshot,
  CollaborationTenure,
  useResearchCollaboration,
} from "./use-research-collaboration.js";

type Controller = ReturnType<typeof useResearchCollaboration>;
const title = (tenure: CollaborationTenure, id: string) => tenure.snapshots[id]?.title || id;

function tenureClusters(tenure: CollaborationTenure, projection: ResearchProjection): CanvasSessionCluster[] {
  const members = new Set(tenure.sessionIds.filter(id => !tenure.detachedSessionIds?.includes(id)));
  const observed = new Map(projection.executions.filter(row => row.kind === "pi-session" && row.sessionId).map(row => [row.sessionId, row]));
  const groups = new Map<string, ResearchExecution[]>();
  for (const row of projection.executions) {
    if (row.kind !== "native-subagent" || !row.parentExecutionId || !row.startedAt
        || row.startedAt < tenure.startedAt || tenure.endedAt && row.startedAt >= tenure.endedAt) continue;
    const entries = groups.get(row.parentExecutionId) ?? [];
    entries.push(row);
    groups.set(row.parentExecutionId, entries);
  }
  return [...members].map(id => {
    const metadata = tenure.snapshots[id] ?? {};
    const observation = observed.get(id);
    const live = tenure.status === "current" ? observation : undefined;
    const executionId = observation?.id ?? `session-${id}`;
    const parentId = id !== tenure.mainSessionId && metadata.parentSessionId && members.has(metadata.parentSessionId) ? metadata.parentSessionId : undefined;
    const roleObj = { name: metadata.role || (id === tenure.mainSessionId ? "主 Agent" : "Multi-Agent"), skills: [] };
    const sessionExec: ResearchExecution = {
      ...live, id: executionId, sessionId: id, kind: "pi-session", source: live?.source ?? "workflow-record", evidence: live?.evidence ?? [],
      status: metadata.status ?? live?.status ?? "unknown",
      role: metadata.role ?? live?.role, observedModel: metadata.model ?? live?.observedModel,
      parentExecutionId: parentId ? observed.get(parentId)?.id ?? `session-${parentId}` : undefined,
    };
    const childSubs = groups.get(executionId) ?? [];
    const byRole = new Map<string, ResearchExecution[]>();
    for (const row of childSubs) {
      const role = row.role ?? "Subagent";
      const entries = byRole.get(role) ?? [];
      entries.push(row);
      byRole.set(role, entries);
    }
    return { sessionExec, title: title(tenure, id), roleObj, isCaptain: id === tenure.mainSessionId,
      origin: parentId ? "lead-agent-created" : id === tenure.mainSessionId ? "user-created" : "unknown",
      creatorSessionId: parentId, creatorLabel: parentId ? title(tenure, parentId) : undefined,
      assignedRole: metadata.role, childSubs, childRoleGroups: [...byRole].map(([roleName, executions]) => ({
        roleName, executions, roleObj: { name: roleName, skills: [] }, latest: executions[0]!,
      })),
    };
  });
}

const waitReasons: Record<string, string> = {
  capacity: "等待并发槽位",
  dependencies: "等待前置任务",
  "main-agent-not-selected": "待选主会话",
  "research-session-concurrency-limit": "等待并发槽位",
  "research-session-capacity-limit": "等待会话槽位",
  "research-session-resident-limit": "等待常驻名额",
  "research-session-memory-limit": "等待宿主机内存",
  "research-session-resource-budget-unavailable": "等待主机资源",
  "research-collaboration-multi-capacity": "等待 Multi-Agent 槽位",
  "research-collaboration-subagent-capacity": "等待 Subagent 槽位",
  "subagent-capacity": "等待 Subagent 槽位",
};

function sortPlanQueuedTasks(plan: CollaborationPlan): CollaborationPlanTask[] {
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

function hasPendingDependencies(plan: CollaborationPlan, task: CollaborationPlanTask): boolean {
  if (!task.dependsOn?.length) return false;
  return task.dependsOn.some(depId => plan.tasks.find(row => row.id === depId)?.status !== "completed");
}

function reorderIds(ids: string[], fromIdx: number, toIdx: number): string[] {
  const next = [...ids];
  const [item] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, item!);
  return next;
}

function DispatchQueueSummary({
  multiCount,
  nativeCount,
  open,
  onToggle,
}: {
  multiCount: number;
  nativeCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  const total = multiCount + nativeCount;
  return (
    <div className="research-inline-bar min-w-0" aria-label="调度队列">
      <span className="text-[11px] font-medium text-[var(--text-secondary)] whitespace-nowrap">调度队列</span>
      <span className="research-queue-pill">Multi-Agent {multiCount}</span>
      {nativeCount > 0 && <span className="research-queue-pill">Subagent {nativeCount}</span>}
      {total === 0 ? (
        <span className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap">空闲</span>
      ) : (
        <button
          type="button"
          className="research-workspace-action !min-h-[24px] !px-2 !py-0 text-[11px]"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? "收起队列 ▴" : "排队详情 ▾"}
        </button>
      )}
    </div>
  );
}

function DispatchQueuePanel({
  controller,
  snapshot,
  multiPlans,
  nativeQueued,
}: {
  controller: Controller;
  snapshot: CollaborationSnapshot;
  multiPlans: Array<{ plan: CollaborationPlan; queued: CollaborationPlanTask[] }>;
  nativeQueued: CollaborationNativeQueueItem[];
}) {
  const { pending, queueFeedback, clearQueueFeedback } = controller;
  const sessionTitle = (sessionId?: string) => {
    if (!sessionId) return "未知会话";
    for (let i = snapshot.tenures.length - 1; i >= 0; i--) {
      const tenure = snapshot.tenures[i]!;
      const snap = tenure.snapshots[sessionId];
      if (snap?.title) return snap.title;
    }
    return sessionId;
  };

  // Group queued native subagents by parentSessionId so native-reorder operates per parent scope.
  const nativeGroups = new Map<string, CollaborationNativeQueueItem[]>();
  for (const row of nativeQueued) {
    const key = row.parentSessionId ?? "__unknown__";
    const list = nativeGroups.get(key) ?? [];
    list.push(row);
    nativeGroups.set(key, list);
  }
  for (const [key, list] of nativeGroups) {
    nativeGroups.set(
      key,
      [...list].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)),
    );
  }

  return (
    <section className="research-collab-queue-panel p-2.5 space-y-2.5" aria-label="调度排队详情">
      {queueFeedback && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--accent-primary)]/40 bg-[var(--accent-soft)] px-2.5 py-1.5 text-[11px] text-[var(--accent-text)]"
        >
          <span>{queueFeedback}</span>
          <button
            type="button"
            className="text-[11px] underline hover:opacity-80"
            onClick={clearQueueFeedback}
          >
            关闭
          </button>
        </div>
      )}

      {multiPlans.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--text-secondary)]">
            <span>Multi-Agent 排队队列</span>
            <span className="text-[10.5px] text-[var(--text-tertiary)]">受并发配额与前置依赖约束；插队将在空出槽位时最先启动</span>
          </div>
          <ol className="space-y-1.5" data-testid="research-multi-agent-queue">
            {multiPlans.flatMap(({ plan, queued }) => {
              const owner = snapshot.tenures.find(tenure => tenure.id === plan.tenureId);
              const isCurrentTenure = !plan.tenureId || plan.tenureId === snapshot.currentTenureId;
              const queuedIds = queued.map(item => item.id);
              const queueRevision = plan.revision ?? 1;
              return queued.map((task, idx) => {
                const depsPending = hasPendingDependencies(plan, task);
                const paused = plan.schedulingPaused === true;
                const reasonKey = task.waitingReason ?? task.queueReason ?? "";
                const reasonText = paused
                  ? "已暂停"
                  : depsPending
                    ? "等待前置任务"
                    : waitReasons[reasonKey] ?? "等待调度";
                const canStart = isCurrentTenure && snapshot.adopted && !pending && !paused && !depsPending;
                const startTitle = !isCurrentTenure
                  ? "历史批次不可操作"
                  : paused
                    ? "当前计划调度已暂停"
                    : depsPending
                      ? "存在未完成的前置依赖任务"
                      : "优先插队启动（并发满时排至队首）";
                return (
                  <li key={`${plan.id}:${task.id}`} className="win11-card-subtle flex flex-wrap items-start justify-between gap-2 p-2 text-xs">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">#{idx + 1}</span>
                        <strong>{task.role}</strong>
                        <span className="rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-[var(--accent-orange)]">
                          Queued
                        </span>
                        <span className="text-[11px] text-[var(--text-secondary)]">{reasonText}</span>
                      </div>
                      <p className="break-words text-[var(--text-primary)]">{task.task}</p>
                      <p className="text-[11px] text-[var(--text-tertiary)]">
                        {owner ? `批次 #${owner.ordinal} · ${title(owner, plan.parentSessionId)}` : plan.parentSessionId}
                      </p>
                    </div>
                    {isCurrentTenure && (
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        <button
                          type="button"
                          className="research-workspace-action primary !min-h-[24px] !px-2 !py-0 text-[11px]"
                          aria-label={`插队启动 ${task.role}`}
                          title={startTitle}
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
                        {queued.length > 1 && (
                          <>
                            <button
                              type="button"
                              className="research-workspace-action !min-h-[24px] !px-1.5 !py-0 text-[11px]"
                              aria-label={`置顶 ${task.role}`}
                              disabled={idx === 0 || pending || !snapshot.adopted}
                              onClick={() => {
                                void controller.change({
                                  action: "reorder",
                                  sessionId: plan.parentSessionId,
                                  planId: plan.id,
                                  taskIds: reorderIds(queuedIds, idx, 0),
                                  queueRevision,
                                });
                              }}
                            >
                              置顶
                            </button>
                            <button
                              type="button"
                              className="research-workspace-action !min-h-[24px] !px-1.5 !py-0 text-[11px]"
                              aria-label={`上移 ${task.role}`}
                              disabled={idx === 0 || pending || !snapshot.adopted}
                              onClick={() => {
                                void controller.change({
                                  action: "reorder",
                                  sessionId: plan.parentSessionId,
                                  planId: plan.id,
                                  taskIds: reorderIds(queuedIds, idx, idx - 1),
                                  queueRevision,
                                });
                              }}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="research-workspace-action !min-h-[24px] !px-1.5 !py-0 text-[11px]"
                              aria-label={`下移 ${task.role}`}
                              disabled={idx === queued.length - 1 || pending || !snapshot.adopted}
                              onClick={() => {
                                void controller.change({
                                  action: "reorder",
                                  sessionId: plan.parentSessionId,
                                  planId: plan.id,
                                  taskIds: reorderIds(queuedIds, idx, idx + 1),
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
                  </li>
                );
              });
            })}
          </ol>
        </div>
      )}

      {nativeQueued.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">Subagent 排队队列</div>
          <ol className="space-y-1.5" data-testid="research-subagent-queue">
            {[...nativeGroups.entries()].flatMap(([parentKey, group]) => {
              const reorderableIds = group.map(item => item.id).filter((id): id is string => Boolean(id));
              const canReorderGroup = parentKey !== "__unknown__"
                && reorderableIds.length === group.length
                && group.length > 1
                && (!group[0]?.tenureId || group[0].tenureId === snapshot.currentTenureId)
                && snapshot.adopted;
              return group.map((row, idx) => {
                const roleName = row.role ?? "Subagent";
                const reasonText = waitReasons[row.queueReason ?? ""] ?? "等待 Subagent 槽位";
                return (
                  <li key={row.id ?? row.requestId ?? `${parentKey}-${idx}`} className="win11-card-subtle flex flex-wrap items-start justify-between gap-2 p-2 text-xs">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">#{idx + 1}</span>
                        <strong>{roleName}</strong>
                        <span className="rounded border border-purple-500/35 bg-purple-500/10 px-1.5 py-0 text-[10px] font-medium text-[var(--accent-purple-text)]">
                          Queued
                        </span>
                        <span className="text-[11px] text-[var(--text-secondary)]">{reasonText}</span>
                        {row.model && <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">{row.model}</span>}
                      </div>
                      {row.task && <p className="break-words text-[var(--text-primary)]">{row.task}</p>}
                      {row.parentSessionId && (
                        <p className="text-[11px] text-[var(--text-tertiary)]">父会话：{sessionTitle(row.parentSessionId)}</p>
                      )}
                    </div>
                    {canReorderGroup && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className="research-workspace-action !min-h-[24px] !px-1.5 !py-0 text-[11px]"
                          aria-label={`置顶 Subagent ${roleName}`}
                          disabled={idx === 0 || pending}
                          onClick={() => {
                            void controller.change({
                              action: "native-reorder",
                              sessionId: parentKey,
                              taskIds: reorderIds(reorderableIds, idx, 0),
                            });
                          }}
                        >
                          置顶
                        </button>
                        <button
                          type="button"
                          className="research-workspace-action !min-h-[24px] !px-1.5 !py-0 text-[11px]"
                          aria-label={`上移 Subagent ${roleName}`}
                          disabled={idx === 0 || pending}
                          onClick={() => {
                            void controller.change({
                              action: "native-reorder",
                              sessionId: parentKey,
                              taskIds: reorderIds(reorderableIds, idx, idx - 1),
                            });
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="research-workspace-action !min-h-[24px] !px-1.5 !py-0 text-[11px]"
                          aria-label={`下移 Subagent ${roleName}`}
                          disabled={idx === group.length - 1 || pending}
                          onClick={() => {
                            void controller.change({
                              action: "native-reorder",
                              sessionId: parentKey,
                              taskIds: reorderIds(reorderableIds, idx, idx + 1),
                            });
                          }}
                        >
                          ↓
                        </button>
                      </div>
                    )}
                  </li>
                );
              });
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

function Limits({ controller, snapshot }: { controller: Controller; snapshot: CollaborationSnapshot }) {
  const [multi, setMulti] = useState(String(snapshot.limits.maxMultiAgents));
  const [subs, setSubs] = useState(String(snapshot.limits.maxSubagents));
  const [rangeNotice, setRangeNotice] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const draftRef = useRef({ multi, subs });
  draftRef.current = { multi, subs };
  const lastServerRef = useRef(snapshot.limits);
  const debounceRef = useRef<number | undefined>(undefined);
  const savedTimerRef = useRef<number | undefined>(undefined);
  const queuedCommitRef = useRef<{ maxMultiAgents: number; maxSubagents: number } | null>(null);

  useEffect(() => {
    if (
      snapshot.limits.maxMultiAgents !== lastServerRef.current.maxMultiAgents
      || snapshot.limits.maxSubagents !== lastServerRef.current.maxSubagents
    ) {
      lastServerRef.current = snapshot.limits;
      setMulti(String(snapshot.limits.maxMultiAgents));
      setSubs(String(snapshot.limits.maxSubagents));
      setRangeNotice(null);
    }
  }, [snapshot.limits]);

  useEffect(() => () => {
    window.clearTimeout(debounceRef.current);
    window.clearTimeout(savedTimerRef.current);
  }, []);

  type ParsedLimits =
    | { ok: false; error: string }
    | { ok: true; maxMultiAgents: number; maxSubagents: number };

  const parseLimits = (rawMulti: string, rawSubs: string): ParsedLimits | null => {
    if (!rawMulti || !rawSubs) return null;
    const m = Number.parseInt(rawMulti, 10);
    const s = Number.parseInt(rawSubs, 10);
    if (!Number.isSafeInteger(m) || m < 1 || m > snapshot.limitMaximums.maxMultiAgents) {
      return { ok: false, error: `Multi-Agent 范围 1–${snapshot.limitMaximums.maxMultiAgents}` };
    }
    if (!Number.isSafeInteger(s) || s < 1 || s > snapshot.limitMaximums.maxSubagents) {
      return { ok: false, error: `Subagent 范围 1–${snapshot.limitMaximums.maxSubagents}` };
    }
    return { ok: true, maxMultiAgents: m, maxSubagents: s };
  };

  const commitValues = (rawMulti: string, rawSubs: string) => {
    if (!snapshot.adopted) return;
    const parsed = parseLimits(rawMulti, rawSubs);
    if (!parsed) return;
    if (!parsed.ok) {
      setRangeNotice(parsed.error);
      return;
    }
    setRangeNotice(null);
    const nextLimits = { maxMultiAgents: parsed.maxMultiAgents, maxSubagents: parsed.maxSubagents };
    if (
      nextLimits.maxMultiAgents === snapshot.limits.maxMultiAgents
      && nextLimits.maxSubagents === snapshot.limits.maxSubagents
    ) {
      return;
    }
    if (controller.pending) {
      queuedCommitRef.current = nextLimits;
      return;
    }
    queuedCommitRef.current = null;
    void controller.change({ action: "limits", ...nextLimits }).then(ok => {
      if (!ok) return;
      setSavedNotice(true);
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedNotice(false), 1800);
    });
  };

  // Flush any edit that arrived while a previous mutation was in flight.
  useEffect(() => {
    if (!controller.pending && queuedCommitRef.current && snapshot.adopted) {
      const next = queuedCommitRef.current;
      queuedCommitRef.current = null;
      if (
        next.maxMultiAgents !== snapshot.limits.maxMultiAgents
        || next.maxSubagents !== snapshot.limits.maxSubagents
      ) {
        void controller.change({ action: "limits", ...next }).then(ok => {
          if (!ok) return;
          setSavedNotice(true);
          window.clearTimeout(savedTimerRef.current);
          savedTimerRef.current = window.setTimeout(() => setSavedNotice(false), 1800);
        });
      }
    }
  }, [controller, snapshot.adopted, snapshot.limits.maxMultiAgents, snapshot.limits.maxSubagents]);

  const scheduleCommit = (nextMulti: string, nextSubs: string) => {
    draftRef.current = { multi: nextMulti, subs: nextSubs };
    const parsed = parseLimits(nextMulti, nextSubs);
    setRangeNotice(parsed && !parsed.ok ? parsed.error : null);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      commitValues(draftRef.current.multi, draftRef.current.subs);
    }, 300);
  };

  const flushOrRestore = () => {
    window.clearTimeout(debounceRef.current);
    const current = draftRef.current;
    const parsed = parseLimits(current.multi, current.subs);
    if (!parsed || !parsed.ok) {
      setMulti(String(snapshot.limits.maxMultiAgents));
      setSubs(String(snapshot.limits.maxSubagents));
      setRangeNotice(null);
      return;
    }
    commitValues(current.multi, current.subs);
  };

  return (
    <form
      className="research-inline-bar"
      aria-label="并发配额"
      onSubmit={event => {
        event.preventDefault();
        flushOrRestore();
      }}
    >
      <span className="text-[11px] font-medium text-[var(--text-secondary)] whitespace-nowrap">并发配额</span>
      <label className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap" title="单个主会话可同时开启的 Multi-Agent 数量">
        <span className="text-[var(--text-tertiary)]">Multi-Agent</span>
        <input
          className="research-quota-input"
          aria-label="Multi-Agent 并发数"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={!snapshot.adopted}
          value={multi}
          onChange={event => {
            const cleaned = event.target.value.replace(/\D/g, "");
            setMulti(cleaned);
            scheduleCommit(cleaned, draftRef.current.subs);
          }}
          onBlur={flushOrRestore}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              flushOrRestore();
            }
          }}
        />
      </label>
      <label className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap" title="每个协作节点可同时启动的 Subagent 数量">
        <span className="text-[var(--text-tertiary)]">Subagent</span>
        <input
          className="research-quota-input"
          aria-label="Subagent 并发数"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          disabled={!snapshot.adopted}
          value={subs}
          onChange={event => {
            const cleaned = event.target.value.replace(/\D/g, "");
            setSubs(cleaned);
            scheduleCommit(draftRef.current.multi, cleaned);
          }}
          onBlur={flushOrRestore}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              flushOrRestore();
            }
          }}
        />
      </label>
      {controller.pending && (
        <span className="text-[10.5px] text-[var(--text-secondary)] whitespace-nowrap">同步中…</span>
      )}
      {!controller.pending && rangeNotice && (
        <span className="text-[10.5px] text-[var(--severity-warning-fg)] whitespace-nowrap">{rangeNotice}</span>
      )}
      {!controller.pending && !rangeNotice && savedNotice && (
        <span className="text-[10.5px] text-[var(--accent-green-text)] whitespace-nowrap">已生效</span>
      )}
    </form>
  );
}

export function getCollaborationQueueData(snapshot: CollaborationSnapshot | null) {
  if (!snapshot) {
    return {
      multiPlans: [] as Array<{ plan: CollaborationPlan; queued: CollaborationPlanTask[] }>,
      multiQueuedCount: 0,
      nativeQueued: [] as CollaborationNativeQueueItem[],
      totalQueued: 0,
    };
  }
  const multiPlans = snapshot.plans
    .map(plan => ({ plan, queued: sortPlanQueuedTasks(plan) }))
    .filter(({ queued }) => queued.length > 0);
  const multiQueuedCount = multiPlans.reduce((sum, entry) => sum + entry.queued.length, 0);
  const nativeQueued = snapshot.nativeQueue.filter(row => row.status === "queued");
  return {
    multiPlans,
    multiQueuedCount,
    nativeQueued,
    totalQueued: multiQueuedCount + nativeQueued.length,
  };
}

export function ResearchCollaborationMetaControls({
  controller,
  queueOpen,
  onToggleQueue,
}: {
  controller: Controller;
  queueOpen: boolean;
  onToggleQueue: () => void;
}) {
  const { snapshot } = controller;
  if (!snapshot) return null;
  const { multiQueuedCount, nativeQueued } = getCollaborationQueueData(snapshot);
  return (
    <>
      <Limits key={controller.scope} controller={controller} snapshot={snapshot} />
      <span aria-hidden="true" className="hidden sm:inline-block h-3.5 w-px bg-[var(--border-subtle)] shrink-0" />
      <DispatchQueueSummary
        multiCount={multiQueuedCount}
        nativeCount={nativeQueued.length}
        open={queueOpen}
        onToggle={onToggleQueue}
      />
    </>
  );
}

export function ResearchDispatchQueueDrawer({
  controller,
  queueOpen,
}: {
  controller: Controller;
  queueOpen: boolean;
}) {
  const { snapshot } = controller;
  if (!snapshot) return null;
  const { multiPlans, nativeQueued, totalQueued } = getCollaborationQueueData(snapshot);
  if (!((totalQueued > 0 && queueOpen) || Boolean(controller.queueFeedback))) return null;
  return (
    <DispatchQueuePanel
      controller={controller}
      snapshot={snapshot}
      multiPlans={multiPlans}
      nativeQueued={nativeQueued}
    />
  );
}

export function ResearchCollaborationPanel({ controller, projection, stale, visible, hideInlineToolbar = false, onAgent }: {
  controller: Controller; projection: ResearchProjection; stale: boolean; visible: boolean; hideInlineToolbar?: boolean;
  onAgent(role: ConfiguredRole, execution?: ResearchExecution): void;
}) {
  const { snapshot, pending, error } = controller;
  const [removing, setRemoving] = useState<{ tenureId: string; sessionId: string; name: string } | null>(null);
  const { multiPlans, multiQueuedCount, nativeQueued, totalQueued } = getCollaborationQueueData(snapshot);

  const [queueOpen, setQueueOpen] = useState(totalQueued > 0);
  const prevTotalQueuedRef = useRef(totalQueued);
  useEffect(() => {
    if (prevTotalQueuedRef.current === 0 && totalQueued > 0) setQueueOpen(true);
    prevTotalQueuedRef.current = totalQueued;
  }, [totalQueued]);

  useEffect(() => { setRemoving(null); }, [controller.scope]);
  return <section className="space-y-2.5" data-testid="research-agent-topology">
    {error && <p role="alert" className="research-warning text-xs">状态异常 · {error}</p>}
    {!snapshot ? <p className="text-xs text-[var(--text-secondary)]">{error ? "等待同步协作状态。" : "加载协作状态…"}</p> : <>
      {!hideInlineToolbar && (
        <>
          <div className="research-collab-toolbar">
            <Limits key={controller.scope} controller={controller} snapshot={snapshot} />
            <DispatchQueueSummary
              multiCount={multiQueuedCount}
              nativeCount={nativeQueued.length}
              open={queueOpen}
              onToggle={() => setQueueOpen(value => !value)}
            />
          </div>
          {((totalQueued > 0 && queueOpen) || Boolean(controller.queueFeedback)) && (
            <DispatchQueuePanel
              controller={controller}
              snapshot={snapshot}
              multiPlans={multiPlans}
              nativeQueued={nativeQueued}
            />
          )}
        </>
      )}
      {removing && <div role="group" aria-label="确认移除节点" className="win11-card-subtle flex flex-wrap items-center gap-2 p-2.5 text-xs">
        <span>从本批次移除「{removing.name}」及下级节点？（原会话与聊天记录会保留）</span>
        <button type="button" className="research-workspace-action" disabled={pending} onClick={() => {
          void controller.change({ action: "detach", tenureId: removing.tenureId, sessionId: removing.sessionId }).then(ok => { if (ok) setRemoving(null); });
        }}>确认移除</button>
        <button type="button" className="research-workspace-action" disabled={pending} onClick={() => setRemoving(null)}>取消</button>
      </div>}
      {!snapshot.currentTenureId && <p className="text-xs text-[var(--text-secondary)]">请先在上方选定主会话以建立协作拓扑。</p>}
      {[...snapshot.tenures].reverse().filter(tenure => tenure.status !== "removed").map(tenure =>
        <section key={tenure.id} data-testid="research-collaboration-tenure" aria-label={`批次 #${tenure.ordinal}`}>
          <ResearchAgentCanvas
            clusters={tenureClusters(tenure, projection)}
            stale={tenure.status === "current" && stale}
            overviewTitle="调度拓扑"
            tenureTitle={`批次 #${tenure.ordinal} · ${title(tenure, tenure.mainSessionId)}`}
            tenureBadge={tenure.status === "current" ? "当前" : "历史"}
            layout="tree"
            visible={visible}
            onAgent={onAgent}
            statusLabel={researchStatusLabel}
            roleLabel={role => role}
            onRemoveSession={(sessionId, name) => setRemoving({ tenureId: tenure.id, sessionId, name })}
            removalPending={pending}
          />
        </section>)}
    </>}
  </section>;
}
