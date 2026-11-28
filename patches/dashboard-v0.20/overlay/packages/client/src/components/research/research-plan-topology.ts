import type { ResearchWorkbenchRelation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import type { ConfiguredRole, ResearchExecution, ResearchExecutionOriginKind } from "./research-projection.js";
import type { CollaborationPlan, CollaborationPlanTask } from "./use-research-collaboration.js";
import { resolveSessionParents, type CanvasNode, type CanvasSize } from "./research-agent-canvas-layout.js";

export type WorkTriState = "in_progress" | "queued" | "ended";

export interface PlanTaskProgressSummary {
  id: string;
  role: string;
  task: string;
  state: WorkTriState;
  rawStatus: string;
  sessionId?: string;
  stage?: string;
  waitingReason?: string;
  queueRank?: number;
  dependsOn?: string[];
  error?: string;
  summary?: string;
}

export interface PlanSummary {
  id: string;
  label: string;
  parentSessionId: string;
  state: WorkTriState;
  rawStatus?: string;
  total: number;
  ended: number;
  completed: number;
  blocked: number;
  failed: number;
  inProgress: number;
  queued: number;
  progressPercent: number;
  tasks: PlanTaskProgressSummary[];
}

export interface PlansAggregateSummary {
  phase: "awaiting-plan" | "working" | "completed";
  totalPlans: number;
  endedPlans: number;
  inProgressPlans: number;
  queuedPlans: number;
  totalTasks: number;
  endedTasks: number;
  completedTasks: number;
  blockedTasks: number;
  failedTasks: number;
  inProgressTasks: number;
  queuedTasks: number;
  progressPercent: number;
  plans: PlanSummary[];
}

export interface TopologyRoleGroup {
  roleName: string;
  roleObj: ConfiguredRole;
  executions: ResearchExecution[];
  latest: ResearchExecution;
}

export interface TopologySessionCluster {
  sessionExec: ResearchExecution;
  title: string;
  roleObj: ConfiguredRole;
  isCaptain: boolean;
  childSubs: ResearchExecution[];
  childRoleGroups: TopologyRoleGroup[];
  isUserCreated?: boolean;
  origin?: ResearchExecutionOriginKind;
  originLabel?: string;
  creatorSessionId?: string;
  creatorLabel?: string;
  assignedRole?: string;
  workflowDuty?: string;
  planId?: string;
  planTaskId?: string;
  dependsOn?: string[];
}

export type TopologyItem =
  | {
      kind: "session";
      id: string;
      parentId: string | null;
      cluster: TopologySessionCluster;
      planTask?: PlanTaskProgressSummary;
    }
  | {
      kind: "plan";
      id: string;
      parentId: string;
      plan: PlanSummary;
      rawPlan: CollaborationPlan;
      multiAgentCount: number;
    }
  | {
      kind: "plan-awaiting";
      id: string;
      parentId: string;
    }
  | {
      kind: "plan-task";
      id: string;
      parentId: string;
      planId: string;
      task: PlanTaskProgressSummary;
      rawTask: CollaborationPlanTask;
    }
  | {
      kind: "subagent-role";
      id: string;
      parentId: string;
      sessionId: string;
      group: TopologyRoleGroup;
      expandKey: string;
    }
  | {
      kind: "subagent-empty";
      id: string;
      parentId: string;
      cluster: TopologySessionCluster;
    }
  | {
      kind: "subagent-run";
      id: string;
      parentId: string;
      sessionId: string;
      group: TopologyRoleGroup;
      execution: ResearchExecution;
      roundIndex: number;
    };

export interface PositionedTopologyNode extends CanvasNode {
  parentId: string | null;
  depth: number;
  item: TopologyItem;
}

export interface TopologyDependencyEdge {
  id: string;
  fromId: string;
  toId: string;
}

export interface TopologyScene {
  width: number;
  height: number;
  nodes: PositionedTopologyNode[];
  edges: TopologyDependencyEdge[];
}

const ENDED_STATUSES = new Set([
  "ended", "completed", "complete", "failed", "error", "cancelled", "canceled", "stopped", "skipped", "released", "blocked",
]);
const QUEUED_STATUSES = new Set(["queued", "pending", "waiting"]);
const BLOCKED_STATUSES = new Set(["blocked"]);
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "stopped"]);

export type PlanTaskStatusTone = "completed" | "blocked" | "failed" | "queued" | "in_progress";

export interface PlanTaskStatusMeta {
  tone: PlanTaskStatusTone;
  label: string;
  shortLabel: string;
  incomplete: boolean;
}

export function planTaskStatusMeta(rawStatus?: string): PlanTaskStatusMeta {
  const normalized = (rawStatus ?? "").toLowerCase();
  if (normalized === "completed" || normalized === "complete") {
    return { tone: "completed", label: "已完成", shortLabel: "完成", incomplete: false };
  }
  if (BLOCKED_STATUSES.has(normalized)) {
    return { tone: "blocked", label: "受阻 · 未完成", shortLabel: "受阻", incomplete: true };
  }
  if (FAILED_STATUSES.has(normalized)) {
    return { tone: "failed", label: "失败 · 未完成", shortLabel: "失败", incomplete: true };
  }
  if (QUEUED_STATUSES.has(normalized)) {
    return { tone: "queued", label: "排队中", shortLabel: "排队", incomplete: true };
  }
  if (normalized === "recovery-required") {
    return { tone: "in_progress", label: "待恢复", shortLabel: "待恢复", incomplete: true };
  }
  if (ENDED_STATUSES.has(normalized)) {
    return { tone: "completed", label: "已结束", shortLabel: "结束", incomplete: false };
  }
  return { tone: "in_progress", label: "执行中", shortLabel: "进行中", incomplete: true };
}

export function normalizeWorkState(status?: string): WorkTriState {
  const normalized = (status ?? "").toLowerCase();
  if (ENDED_STATUSES.has(normalized)) return "ended";
  if (QUEUED_STATUSES.has(normalized)) return "queued";
  return "in_progress";
}

export function triStateLabel(state: WorkTriState): string {
  if (state === "ended") return "已结束";
  if (state === "queued") return "排队中";
  return "进行中";
}

export function shortPlanLabel(plan: Pick<CollaborationPlan, "id" | "clientPlanId">): string {
  const raw = (plan.clientPlanId || plan.id || "").trim();
  if (!raw) return "执行计划";
  const stripped = raw.startsWith("dispatch-") ? raw.slice(9, 17) : raw;
  return stripped.length > 22 ? `${stripped.slice(0, 19)}…` : stripped;
}

function cleanTaskHeadline(task: CollaborationPlanTask, sessionTitles?: Readonly<Record<string, string>>): string {
  const linked = task.sessionId ? sessionTitles?.[task.sessionId]?.trim() : "";
  if (linked) return linked;
  let text = (task.task || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:任务名|会话名建议|目标|科研补缺|科研首次全程分析)\s*[：:]\s*/, "");
  const first = text.split(/(?:[。！？\n]|(?:\.\s+))/)[0]?.trim() || text;
  return first.replace(/[（(]mp-\d+[）)]/gi, "").trim();
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Derive a human-readable Plan title from its task headlines / linked session titles
 * instead of exposing internal kebab-case `clientPlanId` slugs.
 */
export function humanPlanTitle(
  plan: Pick<CollaborationPlan, "id" | "clientPlanId" | "tasks">,
  sessionTitles?: Readonly<Record<string, string>>,
): string {
  const tasks = plan.tasks ?? [];
  if (tasks.length === 0) return shortPlanLabel(plan);
  const headlines = tasks.map(task => cleanTaskHeadline(task, sessionTitles)).filter(Boolean);
  if (headlines.length === 0) return shortPlanLabel(plan);
  if (headlines.length === 1) return clipText(headlines[0]!, 26);

  const split = headlines.map(head => {
    const sepIndex = head.search(/[｜|]/);
    return sepIndex > 0
      ? [head.slice(0, sepIndex).trim(), head.slice(sepIndex + 1).trim()] as const
      : null;
  });
  if (split.every((pair): pair is readonly [string, string] => Boolean(pair && pair[0] && pair[1]))) {
    const lefts = split.map(pair => pair[0]);
    const rights = split.map(pair => pair[1]);
    if (new Set(rights).size === 1) {
      return clipText(`${rights[0]}（${lefts[0]} 等）`, 28);
    }
    if (new Set(lefts).size === 1) {
      return clipText(`${lefts[0]}｜${rights[0]} 等`, 28);
    }
    const joined = lefts.slice(0, 3).join("/");
    if (joined.length <= 20) {
      return clipText(`${joined} 等分析`, 26);
    }
  }
  return clipText(`${headlines[0]} 等`, 26);
}

export function summarizePlan(
  plan: CollaborationPlan,
  defaultParentSessionId = "",
  sessionTitles?: Readonly<Record<string, string>>,
): PlanSummary {
  const tasks: PlanTaskProgressSummary[] = (plan.tasks ?? []).map(task => ({
    id: task.id,
    role: task.role,
    task: task.task,
    state: normalizeWorkState(task.status),
    rawStatus: task.status,
    sessionId: task.sessionId,
    stage: task.stage,
    waitingReason: task.waitingReason,
    queueRank: task.queueRank ?? task.rank,
    dependsOn: task.dependsOn,
    error: task.error,
    summary: task.summary,
  }));
  const blocked = tasks.filter(task => BLOCKED_STATUSES.has((task.rawStatus ?? "").toLowerCase())).length;
  const failed = tasks.filter(task => FAILED_STATUSES.has((task.rawStatus ?? "").toLowerCase())).length;
  const completed = tasks.filter(task => task.state === "ended" && !BLOCKED_STATUSES.has((task.rawStatus ?? "").toLowerCase()) && !FAILED_STATUSES.has((task.rawStatus ?? "").toLowerCase())).length;
  const ended = completed + blocked + failed;
  const inProgress = tasks.filter(task => task.state === "in_progress").length;
  const queued = tasks.filter(task => task.state === "queued").length;
  const total = tasks.length;

  let state: WorkTriState = "in_progress";
  if (total === 0) {
    state = normalizeWorkState(plan.status);
  } else if (ended === total || ENDED_STATUSES.has((plan.status ?? "").toLowerCase())) {
    state = "ended";
  } else if (inProgress === 0 && ended === 0 && queued > 0) {
    state = "queued";
  }

  return {
    id: plan.id,
    label: humanPlanTitle(plan, sessionTitles),
    parentSessionId: plan.parentSessionId || defaultParentSessionId,
    state,
    rawStatus: plan.status,
    total,
    ended,
    completed,
    blocked,
    failed,
    inProgress,
    queued,
    progressPercent: total > 0 ? Math.round((completed / total) * 100) : state === "ended" ? 100 : 0,
    tasks,
  };
}

export function summarizePlansForScope(
  plans: ReadonlyArray<CollaborationPlan> | undefined,
  options: {
    tenureId?: string | null;
    mainSessionId?: string | null;
    sessionIds?: ReadonlyArray<string>;
    sessionTitles?: Readonly<Record<string, string>>;
  } = {},
): PlansAggregateSummary {
  const allowedSessions = new Set(options.sessionIds ?? []);
  if (options.mainSessionId) allowedSessions.add(options.mainSessionId);
  const relevant = (plans ?? []).filter(plan => {
    if (options.tenureId && plan.tenureId) return plan.tenureId === options.tenureId;
    if (allowedSessions.size > 0 && plan.parentSessionId) return allowedSessions.has(plan.parentSessionId);
    return !options.tenureId;
  });

  const summaries = relevant.map(plan => summarizePlan(plan, options.mainSessionId ?? "", options.sessionTitles));
  const totalPlans = summaries.length;
  const endedPlans = summaries.filter(plan => plan.state === "ended").length;
  const inProgressPlans = summaries.filter(plan => plan.state === "in_progress").length;
  const queuedPlans = summaries.filter(plan => plan.state === "queued").length;
  const totalTasks = summaries.reduce((sum, plan) => sum + plan.total, 0);
  const endedTasks = summaries.reduce((sum, plan) => sum + plan.ended, 0);
  const completedTasks = summaries.reduce((sum, plan) => sum + plan.completed, 0);
  const blockedTasks = summaries.reduce((sum, plan) => sum + plan.blocked, 0);
  const failedTasks = summaries.reduce((sum, plan) => sum + plan.failed, 0);
  const inProgressTasks = summaries.reduce((sum, plan) => sum + plan.inProgress, 0);
  const queuedTasks = summaries.reduce((sum, plan) => sum + plan.queued, 0);
  const phase = totalPlans === 0 ? "awaiting-plan" : endedPlans === totalPlans ? "completed" : "working";

  return {
    phase,
    totalPlans,
    endedPlans,
    inProgressPlans,
    queuedPlans,
    totalTasks,
    endedTasks,
    completedTasks,
    blockedTasks,
    failedTasks,
    inProgressTasks,
    queuedTasks,
    progressPercent: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : phase === "completed" ? 100 : 0,
    plans: summaries,
  };
}

function resolveSessionNodeId(clusterById: ReadonlyMap<string, TopologySessionCluster>, sessionId?: string | null): string | null {
  if (!sessionId) return null;
  if (clusterById.has(sessionId)) return sessionId;
  if (clusterById.has(`session-${sessionId}`)) return `session-${sessionId}`;
  for (const [execId, cluster] of clusterById) {
    if (cluster.sessionExec.sessionId === sessionId) return execId;
  }
  return null;
}

export function buildTopologyGraph(params: {
  clusters: ReadonlyArray<TopologySessionCluster>;
  relations: ReadonlyArray<ResearchWorkbenchRelation>;
  plans?: ReadonlyArray<CollaborationPlan>;
  mainSessionId?: string | null;
  showPlanGate?: boolean;
  collapsedPlanIds: ReadonlySet<string>;
  expandedSessionIds: ReadonlySet<string>;
  expandedRoleKeys: ReadonlySet<string>;
}): { items: TopologyItem[]; dependencyEdges: TopologyDependencyEdge[] } {
  const {
    clusters,
    relations,
    plans = [],
    mainSessionId,
    showPlanGate = false,
    collapsedPlanIds,
    expandedSessionIds,
    expandedRoleKeys,
  } = params;

  const clusterIds = clusters.map(cluster => cluster.sessionExec.id);
  const clusterById = new Map(clusters.map(cluster => [cluster.sessionExec.id, cluster]));
  const conflicts = new Set(clusters.filter(cluster => cluster.creatorLabel === "父关系冲突").map(cluster => cluster.sessionExec.id));
  const syntheticRelations: Array<{ fromExecutionId: string; toExecutionId: string; kind: string }> = [
    ...relations,
    ...clusters.flatMap(cluster => {
      if (conflicts.has(cluster.sessionExec.id)) return [];
      const parentExecId = resolveSessionNodeId(clusterById, cluster.sessionExec.parentExecutionId ?? cluster.creatorSessionId);
      return parentExecId ? [{ fromExecutionId: parentExecId, toExecutionId: cluster.sessionExec.id, kind: "dispatch" }] : [];
    }),
  ];
  const sessionParents = resolveSessionParents(clusterIds, syntheticRelations);

  const captainId = resolveSessionNodeId(clusterById, mainSessionId) ?? clusters.find(cluster => cluster.isCaptain)?.sessionExec.id ?? null;

  // Match plan tasks to loaded session clusters (1 Plan -> N Multi-Agents).
  const sessionToPlanNodeId = new Map<string, string>();
  const sessionToTaskSummary = new Map<string, PlanTaskProgressSummary>();
  const taskNodeIdByPlanAndTask = new Map<string, string>();

  const sessionTitles: Record<string, string> = {};
  for (const cluster of clusters) {
    if (cluster.sessionExec.sessionId && cluster.title) {
      sessionTitles[cluster.sessionExec.sessionId] = cluster.title;
    }
  }
  const normalizedPlans = plans.map(plan => ({ rawPlan: plan, summary: summarizePlan(plan, mainSessionId ?? "", sessionTitles) }));
  for (const { rawPlan, summary } of normalizedPlans) {
    const planNodeId = `plan:${rawPlan.id}`;
    for (const task of summary.tasks) {
      const targetClusterId = resolveSessionNodeId(clusterById, task.sessionId)
        ?? clusters.find(cluster => cluster.planId === rawPlan.id && cluster.planTaskId === task.id)?.sessionExec.id
        ?? null;
      if (targetClusterId && !sessionToPlanNodeId.has(targetClusterId)) {
        sessionToPlanNodeId.set(targetClusterId, planNodeId);
        sessionToTaskSummary.set(targetClusterId, task);
        taskNodeIdByPlanAndTask.set(`${rawPlan.id}\0${task.id}`, targetClusterId);
      } else {
        taskNodeIdByPlanAndTask.set(`${rawPlan.id}\0${task.id}`, `plan-task:${rawPlan.id}:${task.id}`);
      }
    }
  }

  // Filter out sessions whose parent Plan is currently collapsed.
  const isAncestorCollapsed = (execId: string): boolean => {
    const seen = new Set<string>();
    let cur: string | undefined = execId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const planNodeId = sessionToPlanNodeId.get(cur);
      if (planNodeId && collapsedPlanIds.has(planNodeId.slice(5))) return true;
      cur = sessionParents.get(cur);
    }
    return false;
  };

  const items: TopologyItem[] = [];
  const emittedNodeIds = new Set<string>();

  for (const cluster of clusters) {
    const execId = cluster.sessionExec.id;
    if (isAncestorCollapsed(execId)) continue;
    const planParentNode = sessionToPlanNodeId.get(execId);
    const parentId = planParentNode ?? sessionParents.get(execId) ?? null;
    items.push({
      kind: "session",
      id: execId,
      parentId,
      cluster,
      planTask: sessionToTaskSummary.get(execId),
    });
    emittedNodeIds.add(execId);
  }

  // Emit L1 Plan nodes attached to their parent session (typically Main Agent / L0).
  const emittedPlans: Array<{ rawPlan: CollaborationPlan; summary: PlanSummary; planNodeId: string }> = [];
  for (const { rawPlan, summary } of normalizedPlans) {
    const ownerSessionExecId = resolveSessionNodeId(clusterById, rawPlan.parentSessionId) ?? captainId;
    if (!ownerSessionExecId || !emittedNodeIds.has(ownerSessionExecId)) continue;
    const planNodeId = `plan:${rawPlan.id}`;
    items.push({
      kind: "plan",
      id: planNodeId,
      parentId: ownerSessionExecId,
      plan: summary,
      rawPlan,
      multiAgentCount: summary.total,
    });
    emittedNodeIds.add(planNodeId);
    emittedPlans.push({ rawPlan, summary, planNodeId });
  }

  // If res-workflow tenure is active with 0 Plans and no child dispatches yet, surface explicit "Plan first, then Work" placeholder.
  if (showPlanGate && normalizedPlans.length === 0 && clusters.length <= 1 && captainId && emittedNodeIds.has(captainId)) {
    const awaitingId = `plan-awaiting:${captainId}`;
    items.push({ kind: "plan-awaiting", id: awaitingId, parentId: captainId });
    emittedNodeIds.add(awaitingId);
  }

  // Emit L2 synthetic Multi-Agent nodes for plan tasks without loaded session clusters when the Plan is expanded.
  const dependencyEdges: TopologyDependencyEdge[] = [];
  for (const { rawPlan, summary, planNodeId } of emittedPlans) {
    if (collapsedPlanIds.has(rawPlan.id)) continue;
    rawPlan.tasks.forEach((rawTask, index) => {
      const taskSummary = summary.tasks[index]!;
      const mappedId = taskNodeIdByPlanAndTask.get(`${rawPlan.id}\0${rawTask.id}`);
      if (!mappedId) return;
      if (!emittedNodeIds.has(mappedId) && mappedId.startsWith("plan-task:")) {
        items.push({
          kind: "plan-task",
          id: mappedId,
          parentId: planNodeId,
          planId: rawPlan.id,
          task: taskSummary,
          rawTask,
        });
        emittedNodeIds.add(mappedId);
      }
      for (const depTaskId of rawTask.dependsOn ?? []) {
        const depNodeId = taskNodeIdByPlanAndTask.get(`${rawPlan.id}\0${depTaskId}`);
        if (depNodeId && emittedNodeIds.has(depNodeId) && emittedNodeIds.has(mappedId) && depNodeId !== mappedId) {
          dependencyEdges.push({ id: `dep:${rawPlan.id}:${depTaskId}->${rawTask.id}`, fromId: depNodeId, toId: mappedId });
        }
      }
    });
  }

  // Inline L3 Subagent Roles and L4 Repeated Runs inside the main topology tree (never replaces canvas!).
  for (const cluster of clusters) {
    const sessionExecId = cluster.sessionExec.id;
    if (!emittedNodeIds.has(sessionExecId) || !expandedSessionIds.has(sessionExecId)) continue;
    if (cluster.childRoleGroups.length === 0) {
      const emptyId = `subagent-empty:${sessionExecId}`;
      items.push({ kind: "subagent-empty", id: emptyId, parentId: sessionExecId, cluster });
      emittedNodeIds.add(emptyId);
      continue;
    }
    for (const group of cluster.childRoleGroups) {
      const roleNodeId = `subagent:${sessionExecId}:${group.roleName}`;
      const expandKey = `${sessionExecId}\0${group.roleName}`;
      items.push({
        kind: "subagent-role",
        id: roleNodeId,
        parentId: sessionExecId,
        sessionId: sessionExecId,
        group,
        expandKey,
      });
      emittedNodeIds.add(roleNodeId);

      if (group.executions.length > 1 && expandedRoleKeys.has(expandKey)) {
        group.executions.forEach((execution, index) => {
          const runId = `subagent-run:${sessionExecId}:${group.roleName}:${execution.id}`;
          items.push({
            kind: "subagent-run",
            id: runId,
            parentId: roleNodeId,
            sessionId: sessionExecId,
            group,
            execution,
            roundIndex: group.executions.length - index,
          });
          emittedNodeIds.add(runId);
        });
      }
    }
  }

  return { items, dependencyEdges };
}

function nodeDimensions(item: TopologyItem): { width: number; height: number } {
  switch (item.kind) {
    case "session": {
      if (item.cluster.isCaptain) return { width: 264, height: 118 };
      const taskTone = item.planTask ? planTaskStatusMeta(item.planTask.rawStatus).tone : null;
      const hasAlertOrDuty =
        Boolean(item.cluster.workflowDuty) ||
        Boolean(
          (taskTone === "blocked" || taskTone === "failed") &&
            (item.planTask?.error || item.planTask?.summary),
        );
      return hasAlertOrDuty ? { width: 240, height: 122 } : { width: 240, height: 106 };
    }
    case "plan":
      return { width: 256, height: 80 };
    case "plan-awaiting":
      return { width: 228, height: 72 };
    case "plan-task":
      return { width: 234, height: 92 };
    case "subagent-role":
      return { width: 220, height: 92 };
    case "subagent-empty":
      return { width: 210, height: 72 };
    case "subagent-run":
      return { width: 216, height: 80 };
  }
}

export function layoutTopologyTree(
  items: ReadonlyArray<TopologyItem>,
  dependencyEdges: ReadonlyArray<TopologyDependencyEdge>,
  viewportWidth = 960,
  targetWidth = viewportWidth,
): TopologyScene {
  const byId = new Map(items.map(item => [item.id, item]));
  const childrenMap = new Map<string, TopologyItem[]>();
  const roots: TopologyItem[] = [];

  for (const item of items) {
    if (item.parentId && byId.has(item.parentId)) {
      const list = childrenMap.get(item.parentId) ?? [];
      list.push(item);
      childrenMap.set(item.parentId, list);
    } else {
      roots.push(item);
    }
  }

  const margin = 20;
  const colGap = 18;
  const rowGap = 20;
  const maxContentWidth = Number.isFinite(targetWidth) ? Math.max(256, targetWidth - margin * 2) : 960;

  interface PlacedSubtree {
    width: number;
    height: number;
    nodes: PositionedTopologyNode[];
  }

  const layoutSubtree = (item: TopologyItem, depth: number): PlacedSubtree => {
    const dim = nodeDimensions(item);
    const directChildren = childrenMap.get(item.id) ?? [];
    if (directChildren.length === 0) {
      return {
        width: dim.width,
        height: dim.height,
        nodes: [{ id: item.id, parentId: item.parentId, depth, x: 0, y: 0, width: dim.width, height: dim.height, item }],
      };
    }

    const childSubtrees = directChildren.map(child => layoutSubtree(child, depth + 1));
    // Pack subtrees into collision-free rows fitting targetWidth while keeping wide fan-outs readable.
    const rows: Array<{ entries: PlacedSubtree[]; rowHeight: number; rowWidth: number }> = [];
    let currentRow: PlacedSubtree[] = [];
    let currentWidth = 0;
    let currentHeight = 0;

    for (const sub of childSubtrees) {
      const nextWidth = currentRow.length === 0 ? sub.width : currentWidth + colGap + sub.width;
      if (currentRow.length > 0 && nextWidth > maxContentWidth) {
        rows.push({ entries: currentRow, rowWidth: currentWidth, rowHeight: currentHeight });
        currentRow = [sub];
        currentWidth = sub.width;
        currentHeight = sub.height;
      } else {
        currentRow.push(sub);
        currentWidth = nextWidth;
        currentHeight = Math.max(currentHeight, sub.height);
      }
    }
    if (currentRow.length > 0) {
      rows.push({ entries: currentRow, rowWidth: currentWidth, rowHeight: currentHeight });
    }

    const childrenBlockWidth = Math.max(...rows.map(row => row.rowWidth), dim.width);
    const totalWidth = Math.max(dim.width, childrenBlockWidth);
    const rootX = Math.round((totalWidth - dim.width) / 2);

    const nodes: PositionedTopologyNode[] = [
      { id: item.id, parentId: item.parentId, depth, x: rootX, y: 0, width: dim.width, height: dim.height, item },
    ];

    let cursorY = dim.height + rowGap + (directChildren.length > 1 ? 14 : 6);
    for (const row of rows) {
      let cursorX = Math.round((totalWidth - row.rowWidth) / 2);
      for (const sub of row.entries) {
        for (const n of sub.nodes) {
          nodes.push({
            ...n,
            x: n.x + cursorX,
            y: n.y + cursorY,
          });
        }
        cursorX += sub.width + colGap;
      }
      cursorY += row.rowHeight + rowGap;
    }

    const totalHeight = cursorY - rowGap;
    return { width: totalWidth, height: totalHeight, nodes };
  };

  if (roots.length === 0) {
    return { width: Math.max(viewportWidth, 320), height: 220, nodes: [], edges: [] };
  }

  const placedRoots = roots.map(root => layoutSubtree(root, 0));
  const positioned: PositionedTopologyNode[] = [];
  let cursorY = margin;
  let maxRight = 0;

  for (const subtree of placedRoots) {
    const startX = Math.max(margin, Number.isFinite(viewportWidth) ? Math.round((Math.max(viewportWidth, subtree.width + margin * 2) - subtree.width) / 2) : margin);
    for (const n of subtree.nodes) {
      const shiftedX = n.x + startX;
      const shiftedY = n.y + cursorY;
      positioned.push({ ...n, x: shiftedX, y: shiftedY });
      maxRight = Math.max(maxRight, shiftedX + n.width);
    }
    cursorY += subtree.height + rowGap + 12;
  }

  const width = Math.max(Math.ceil(maxRight + margin), Number.isFinite(viewportWidth) ? Math.round(viewportWidth) : 320);
  const height = Math.max(220, Math.ceil(cursorY - rowGap - 12 + margin));
  const nodeIds = new Set(positioned.map(n => n.id));
  const edges = dependencyEdges.filter(edge => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId));
  return { width, height, nodes: positioned, edges };
}

export function topologySceneSize(scene: Pick<TopologyScene, "width" | "height">): CanvasSize {
  return { width: scene.width, height: scene.height };
}
