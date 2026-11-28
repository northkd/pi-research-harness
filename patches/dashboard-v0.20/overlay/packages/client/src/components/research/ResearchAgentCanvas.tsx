import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiAccountGroup, mdiArrowExpandAll, mdiChevronDown, mdiChevronRight, mdiFitToPageOutline, mdiForumOutline, mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew } from "@mdi/js";
import { useSpeedStats } from "@blackbelt-technology/pi-dashboard-speed-plugin";
import type { ResearchWorkbenchRelation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import type { ConfiguredRole, ResearchExecution, ResearchExecutionOriginKind } from "./research-projection.js";
import { MIN_CANVAS_SCALE, fitGraph, resolveSessionParents, zoomGraphAt, type CanvasNode, type CanvasView } from "./research-agent-canvas-layout.js";
import {
  buildTopologyGraph,
  layoutTopologyTree,
  normalizeWorkState,
  planTaskStatusMeta,
  summarizePlansForScope,
  triStateLabel,
  type PlanTaskProgressSummary,
  type PlanTaskStatusTone,
  type TopologyItem,
} from "./research-plan-topology.js";
import { ResearchMainPlanProgress } from "./ResearchPlanProgressBar.js";
import { ResearchCommunicationFeed } from "./ResearchCommunicationFeed.js";
import type { CollaborationCommunicationItem, CollaborationPlan } from "./use-research-collaboration.js";

export interface CanvasRoleGroup {
  roleName: string;
  roleObj: ConfiguredRole;
  executions: ResearchExecution[];
  latest: ResearchExecution;
}
export interface CanvasSessionCluster {
  sessionExec: ResearchExecution;
  title: string;
  roleObj: ConfiguredRole;
  isCaptain: boolean;
  childSubs: ResearchExecution[];
  childRoleGroups: CanvasRoleGroup[];
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
interface Props {
  clusters: CanvasSessionCluster[];
  plans?: CollaborationPlan[];
  communications?: CollaborationCommunicationItem[];
  sessionTitles?: Record<string, string>;
  mainSessionId?: string | null;
  showPlanGate?: boolean;
  highlightedPlanId?: string | null;
  stale: boolean;
  /** Only relations whose actual endpoint executions exist are passed in. */
  relations?: ResearchWorkbenchRelation[];
  onAgent: (role: ConfiguredRole, execution?: ResearchExecution) => void;
  statusLabel: (status: string) => string;
  roleLabel: (role: string) => string;
  visible?: boolean;
  overviewTitle?: string;
  tenureTitle?: string;
  tenureBadge?: string;
  layout?: "forest" | "tree";
  onRemoveSession?: (sessionId: string, title: string) => void;
  removalPending?: boolean;
  onJumpPlanTask?: (planId: string, taskId: string, queueRevision?: number) => void;
  onOpenQueue?: (planId?: string) => void;
  onCollapse?: () => void;
}

const originGlyph = (origin?: ResearchExecutionOriginKind) =>
  origin === "lead-agent-created" ? "Agent 派生" : origin === "workflow-created" ? "工作流创建"
    : origin === "user-created" ? "用户创建" : "来源未记录";

const nodeStyle = (node: CanvasNode) => ({ position: "absolute" as const, left: node.x, top: node.y, width: node.width, height: node.height });
const smoothStepPath = (fromX: number, fromY: number, toX: number, toY: number, radius = 10) => {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.abs(dy) < 2) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  const midX = fromX + dx * 0.5;
  const r = Math.min(radius, Math.abs(dy) / 2, Math.abs(dx) / 4);
  if (r < 1) return `M ${fromX} ${fromY} H ${midX} V ${toY} H ${toX}`;
  const dirY = dy > 0 ? 1 : -1;
  const dirX = dx >= 0 ? 1 : -1;
  return [
    `M ${fromX} ${fromY}`,
    `L ${midX - r * dirX} ${fromY}`,
    `Q ${midX} ${fromY} ${midX} ${fromY + r * dirY}`,
    `L ${midX} ${toY - r * dirY}`,
    `Q ${midX} ${toY} ${midX + r * dirX} ${toY}`,
    `L ${toX} ${toY}`,
  ].join(" ");
};
const verticalBranch = (parent: CanvasNode, child: CanvasNode) =>
  `M ${parent.x} ${parent.y + parent.height / 2} H 12 V ${child.y + child.height / 2} H ${child.x}`;
const isLive = (status: string) => ["streaming", "started", "running"].includes(status);
const ENDED_STATUSES = new Set(["ended", "completed", "complete", "stopped", "cancelled"]);

function statusPriority(status: string, liveNode: boolean): number {
  if (liveNode || isLive(status)) return 0;
  if (["queued", "pending", "waiting"].includes(status)) return 1;
  if (["idle", "active", "registered"].includes(status)) return 2;
  if (["failed", "blocked", "paused"].includes(status)) return 3;
  if (ENDED_STATUSES.has(status)) return 4;
  return 2;
}

function canvasStatusLabel(
  status: string,
  liveNode: boolean,
  staleObservation: boolean,
  fallback: (value: string) => string,
): string {
  if (staleObservation) return "观测已过期";
  if (liveNode) return "Running";
  switch (status) {
    case "ended": return "Ended";
    case "queued":
    case "pending": return "Queued";
    case "running":
    case "streaming":
    case "started": return "Running";
    case "idle": return "Idle";
    case "completed":
    case "complete": return "Completed";
    case "failed": return "Failed";
    case "blocked": return "Blocked";
    case "paused": return "Paused";
    case "stopped":
    case "cancelled": return "Stopped";
    case "stopping": return "Stopping";
    case "waiting": return "Waiting";
    case "active": return "Active";
    case "registered": return "Registered";
    case "unknown": return "Unknown";
    default: return fallback(status);
  }
}

function canvasStatusTone(status: string, liveNode: boolean, isCaptain: boolean): { dot: string; text: string } {
  if (liveNode || isLive(status)) {
    return { dot: "bg-emerald-500", text: "font-semibold text-emerald-600 dark:text-emerald-400" };
  }
  if (["queued", "pending", "waiting", "paused"].includes(status)) {
    return { dot: "bg-[var(--accent-orange)]", text: "font-semibold text-[var(--accent-orange)]" };
  }
  if (["failed", "blocked"].includes(status)) {
    return { dot: "bg-[var(--accent-red)]", text: "font-medium text-[var(--accent-red)]" };
  }
  if (ENDED_STATUSES.has(status)) {
    return { dot: "bg-[var(--text-tertiary)] opacity-60", text: "text-[var(--text-tertiary)]" };
  }
  return {
    dot: isCaptain ? "bg-[var(--accent-orange)]" : "bg-[var(--accent-blue)]",
    text: "text-[var(--text-secondary)]",
  };
}

function planTaskBadgeClass(tone: PlanTaskStatusTone): string {
  switch (tone) {
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-[var(--accent-green)]";
    case "blocked":
    case "failed":
      return "border-red-500/35 bg-red-500/15 text-[var(--accent-red)] font-semibold";
    case "queued":
      return "border-amber-500/35 bg-amber-500/10 text-[var(--accent-orange)] font-medium";
    case "in_progress":
      return "border-sky-500/30 bg-sky-500/10 text-[var(--accent-blue)] font-medium";
  }
}

function formatCompactTokens(tokens?: number): string {
  if (!tokens || tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function shortModelName(model?: string): string | null {
  if (!model) return null;
  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  return base.replace(/\[\d+m\]/gi, "").trim() || base;
}

function SessionFleetStats({ sessionId, status, visible }: { sessionId?: string; status: string; visible: boolean }) {
  const { stats } = useSpeedStats(sessionId, status, visible && Boolean(sessionId));
  const billing = stats?.billing;
  if (!billing) return null;
  const calls = billing.modelBreakdown.reduce((sum, entry) => sum + entry.callCount, 0);
  return (
    <span data-testid="canvas-session-stats" className="research-fleet-stats-inline text-[var(--text-tertiary)]">
      <span className="whitespace-nowrap">{calls}次</span>
      <span aria-hidden="true">·</span>
      <span className="whitespace-nowrap">{formatCompactTokens(billing.totalTokens)}</span>
      <span aria-hidden="true">·</span>
      <span className="whitespace-nowrap font-semibold text-[var(--text-secondary)]">
        {!billing.complete ? "≥" : ""}¥{billing.sessionTotalCost.toFixed(2)}
      </span>
    </span>
  );
}

function SubagentRoleFleetStats({ parentSessionId, parentStatus, roleName, fallbackCount, visible }: {
  parentSessionId?: string; parentStatus: string; roleName: string; fallbackCount: number; visible: boolean;
}) {
  const { stats } = useSpeedStats(parentSessionId, parentStatus, visible && Boolean(parentSessionId));
  const records = stats?.billingSubagentHistory?.filter(record => record.subagentRole === roleName) ?? [];
  if (!stats?.billing || records.length === 0) {
    return (
      <span className="research-fleet-stats text-[var(--text-tertiary)]">
        <span className="text-left whitespace-nowrap">{fallbackCount} runs</span>
        <span className="text-center whitespace-nowrap">· — tok</span>
        <span className="text-right whitespace-nowrap">¥—</span>
      </span>
    );
  }
  const tokens = records.reduce((sum, record) => sum + record.totalTokens, 0);
  const cost = records.reduce((sum, record) => sum + (record.cost?.total ?? 0), 0);
  return (
    <span className="research-fleet-stats text-[var(--text-secondary)]">
      <span className="text-left whitespace-nowrap">{records.length} calls</span>
      <span className="text-center whitespace-nowrap">· {formatCompactTokens(tokens)} tok</span>
      <span className="text-right whitespace-nowrap font-semibold text-[var(--text-primary)]">¥{cost.toFixed(2)}</span>
    </span>
  );
}

/** A read-only Fleet-style map of Multi-Agent sessions and their Subagent executions. */
const TREE_WAIT_TEXT: Record<string, string> = {
  capacity: "并发槽位排队",
  dependencies: "依赖前置任务",
  "research-session-concurrency-limit": "并发槽位排队",
  "research-session-capacity-limit": "会话槽位排队",
  "research-collaboration-multi-capacity": "Multi-Agent 槽位排队",
};

function orthogonalDownPath(parent: CanvasNode, child: CanvasNode): string {
  const fromX = parent.x + parent.width / 2;
  const fromY = parent.y + parent.height;
  const toX = child.x + child.width / 2;
  const toY = child.y - 3;
  const midY = Math.round(fromY + Math.max(8, (toY - fromY) * 0.5));
  if (Math.abs(fromX - toX) < 2) return `M ${fromX} ${fromY} V ${toY}`;
  return `M ${fromX} ${fromY} V ${midY} H ${toX} V ${toY}`;
}

export function ResearchAgentCanvas({
  clusters,
  plans,
  communications = [],
  sessionTitles,
  mainSessionId,
  showPlanGate = false,
  highlightedPlanId = null,
  stale,
  relations = [],
  onAgent,
  statusLabel,
  roleLabel,
  visible = true,
  overviewTitle = "调度拓扑",
  tenureTitle,
  tenureBadge,
  onRemoveSession,
  removalPending,
  onJumpPlanTask,
  onOpenQueue,
  onCollapse,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const roleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const sessionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const canvasId = useId().replaceAll(":", "");
  const executionGroupId = (expandKey: string) => `${canvasId}-rounds-${encodeURIComponent(expandKey)}`;
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [collapsedPlanIds, setCollapsedPlanIds] = useState<Set<string>>(() => new Set());
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set());
  const [expandedRoleKeys, setExpandedRoleKeys] = useState<Set<string>>(() => new Set());
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [hideEnded, setHideEnded] = useState(false);
  const [commOpenOverride, setCommOpenOverride] = useState<boolean | null>(null);
  const [highlightedCommSessions, setHighlightedCommSessions] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 });
  const hasInitializedView = useRef(false);

  // Default behavior: auto-expand the live communication sidebar when this tenure
  // has communications, stay collapsed when empty; manual clicks always win.
  const commOpen = commOpenOverride ?? communications.length > 0;
  const unresolvedCommRequests = useMemo(
    () => communications.filter(item => item.kind === "request" && !item.resolved && !item.peerSettled).length,
    [communications],
  );
  const mergedSessionTitles = useMemo(() => {
    const map: Record<string, string> = { ...(sessionTitles ?? {}) };
    for (const cluster of clusters) {
      const sid = cluster.sessionExec.sessionId ?? cluster.sessionExec.id;
      if (sid && cluster.title) map[sid] = cluster.title;
    }
    return map;
  }, [clusters, sessionTitles]);
  const taskLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const plan of plans ?? []) {
      for (const task of plan.tasks ?? []) {
        const head = (task.task ?? "").split(/[｜|。\n]/)[0]?.trim();
        map[task.id] = head || task.role || task.id;
      }
    }
    return map;
  }, [plans]);

  const endedCount = useMemo(
    () => clusters.filter(cluster => !cluster.isCaptain && ENDED_STATUSES.has(cluster.sessionExec.status)).length,
    [clusters],
  );
  const filteredClusters = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? clusters.filter(cluster =>
          [
            cluster.title,
            cluster.sessionExec.id,
            cluster.sessionExec.prompt,
            cluster.sessionExec.summary,
            cluster.assignedRole,
            cluster.planId,
            cluster.planTaskId,
          ].some(value => value?.toLocaleLowerCase().includes(term)),
        )
      : clusters;
  }, [clusters, query]);

  const filteredPlans = useMemo(() => {
    const raw = plans ?? [];
    const term = query.trim().toLocaleLowerCase();
    if (!term) return raw;
    const matchedClusterSessionIds = new Set(filteredClusters.map(c => c.sessionExec.sessionId).filter(Boolean));
    return raw.filter(
      plan =>
        plan.id.toLocaleLowerCase().includes(term) ||
        plan.clientPlanId?.toLocaleLowerCase().includes(term) ||
        plan.tasks.some(
          t =>
            t.id.toLocaleLowerCase().includes(term) ||
            t.role.toLocaleLowerCase().includes(term) ||
            (t.sessionId && matchedClusterSessionIds.has(t.sessionId)),
        ),
    );
  }, [plans, filteredClusters, query]);

  const hideEndedActive = hideEnded && endedCount > 0 && endedCount < clusters.length;
  const orderedClusters = useMemo(() => {
    const base = hideEndedActive
      ? filteredClusters.filter(cluster => cluster.isCaptain || !ENDED_STATUSES.has(cluster.sessionExec.status))
      : filteredClusters;
    const originalIndex = new Map(base.map((cluster, index) => [cluster.sessionExec.id, index]));
    return [...base].sort((a, b) => {
      if (a.isCaptain !== b.isCaptain) return a.isCaptain ? -1 : 1;
      const aLive = !(stale && a.sessionExec.source === "observation") && isLive(a.sessionExec.status);
      const bLive = !(stale && b.sessionExec.source === "observation") && isLive(b.sessionExec.status);
      const priorityDiff = statusPriority(a.sessionExec.status, aLive) - statusPriority(b.sessionExec.status, bLive);
      return priorityDiff !== 0
        ? priorityDiff
        : originalIndex.get(a.sessionExec.id)! - originalIndex.get(b.sessionExec.id)!;
    });
  }, [filteredClusters, hideEndedActive, stale]);

  const sessionParents = useMemo(() => {
    const conflicts = new Set(clusters.filter(cluster => cluster.creatorLabel === "父关系冲突").map(cluster => cluster.sessionExec.id));
    return resolveSessionParents(
      clusters.map(cluster => cluster.sessionExec.id),
      [
        ...relations,
        ...clusters.flatMap(cluster =>
          cluster.sessionExec.parentExecutionId
            ? [{ fromExecutionId: cluster.sessionExec.parentExecutionId, toExecutionId: cluster.sessionExec.id, kind: "dispatch" }]
            : [],
        ),
      ].filter(relation => !conflicts.has(relation.toExecutionId)),
    );
  }, [clusters, relations]);

  const delegatedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const parentId of sessionParents.values()) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    return counts;
  }, [sessionParents]);
  const clusterById = useMemo(() => new Map(clusters.map(cluster => [cluster.sessionExec.id, cluster])), [clusters]);
  const totalSubagents = useMemo(() => clusters.reduce((sum, cluster) => sum + cluster.childSubs.length, 0), [clusters]);

  const captainPlanSummary = useMemo(
    () =>
      plans !== undefined && (plans.length > 0 || showPlanGate)
        ? summarizePlansForScope(filteredPlans, {
            mainSessionId: mainSessionId ?? clusters.find(c => c.isCaptain)?.sessionExec.sessionId ?? null,
          })
        : null,
    [plans, filteredPlans, showPlanGate, mainSessionId, clusters],
  );

  // World-space width the viewport can show at the current zoom. Zooming out
  // widens it so large fan-outs pack more siblings per row cleanly.
  const worldWidth = useMemo(() => {
    const raw = size.width / Math.max(view.scale, MIN_CANVAS_SCALE);
    return Math.max(size.width, Math.round(raw / 80) * 80);
  }, [size.width, view.scale]);

  const { items, dependencyEdges } = useMemo(
    () =>
      buildTopologyGraph({
        clusters: orderedClusters,
        relations,
        plans: filteredPlans,
        mainSessionId,
        showPlanGate: showPlanGate && !query.trim(),
        collapsedPlanIds,
        expandedSessionIds,
        expandedRoleKeys,
      }),
    [orderedClusters, relations, filteredPlans, mainSessionId, showPlanGate, query, collapsedPlanIds, expandedSessionIds, expandedRoleKeys],
  );

  const scene = useMemo(
    () => layoutTopologyTree(items, dependencyEdges, size.width, worldWidth),
    [items, dependencyEdges, size.width, worldWidth],
  );
  const sceneById = useMemo(() => new Map(scene.nodes.map(node => [node.id, node])), [scene.nodes]);

  const sceneKey = JSON.stringify([
    hideEndedActive,
    orderedClusters.map(c => c.sessionExec.id),
    filteredPlans.map(p => `${p.id}:${p.tasks.map(t => `${t.id}:${t.status}`).join(",")}`),
    [...collapsedPlanIds],
    [...expandedSessionIds],
    [...expandedRoleKeys],
    worldWidth,
  ]);

  const togglePlan = (planId: string) => {
    setCollapsedPlanIds(prev => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  };
  const toggleSession = (sessionExecId: string) => {
    setExpandedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionExecId)) next.delete(sessionExecId);
      else next.add(sessionExecId);
      return next;
    });
  };
  const toggleRoleRuns = (expandKey: string) => {
    setExpandedRoleKeys(prev => {
      const next = new Set(prev);
      if (next.has(expandKey)) next.delete(expandKey);
      else next.add(expandKey);
      return next;
    });
  };
  const toggleTask = (taskKey: string) => {
    setExpandedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskKey)) next.delete(taskKey);
      else next.add(taskKey);
      return next;
    });
  };

  const collapseAllInline = () => {
    const firstRole = [...expandedRoleKeys][0];
    const firstSession = [...expandedSessionIds][0];
    if (firstRole) roleButtonRefs.current.get(firstRole)?.focus({ preventScroll: true });
    else if (firstSession) sessionButtonRefs.current.get(firstSession)?.focus({ preventScroll: true });
    setExpandedRoleKeys(new Set());
    setExpandedSessionIds(new Set());
  };

  const revealNode = (node: CanvasNode) =>
    setView(previous => {
      const left = previous.x + node.x * previous.scale;
      const top = previous.y + node.y * previous.scale;
      const right = left + node.width * previous.scale;
      const bottom = top + node.height * previous.scale;
      const dx = left < 16 ? 16 - left : right > size.width - 16 ? size.width - 16 - right : 0;
      const dy = top < 16 ? 16 - top : bottom > size.height - 16 ? size.height - 16 - bottom : 0;
      return dx || dy ? { ...previous, x: previous.x + dx, y: previous.y + dy } : previous;
    });

  useEffect(() => {
    if (!highlightedPlanId) return;
    setCollapsedPlanIds(prev => {
      if (!prev.has(highlightedPlanId)) return prev;
      const next = new Set(prev);
      next.delete(highlightedPlanId);
      return next;
    });
    const planNode = sceneById.get(`plan:${highlightedPlanId}`);
    if (planNode) revealNode(planNode);
  }, [highlightedPlanId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const valid = new Set(clusters.map(c => c.sessionExec.id));
    setExpandedSessionIds(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [clusters]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      if (!visible || element.clientWidth === 0) return;
      const width = element.clientWidth;
      const height = element.clientHeight || 520;
      setSize(previous => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visible]);

  useLayoutEffect(() => {
    const isInitial = !hasInitializedView.current;
    hasInitializedView.current = true;
    setView(previous => {
      const scale = isInitial ? 1 : previous.scale;
      const scaledW = scene.width * scale;
      const x = scaledW <= size.width - 32 ? Math.round((size.width - scaledW) / 2) : 16;
      return { scale, x, y: 12 };
    });
    // sceneKey tracks geometry & expansion state cleanly without overriding user zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey, size.width, size.height]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      setView(previous => zoomGraphAt(previous, point, Math.exp(-event.deltaY * 0.0015)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const zoom = (factor: number) => setView(previous => zoomGraphAt(previous, { x: size.width / 2, y: size.height / 2 }, factor));
  const fit = () => setView(fitGraph(scene, size));
  const fitContent = () => setView(fitGraph(scene, size));

  const onCanvasKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (expandedRoleKeys.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        const keys = [...expandedRoleKeys];
        const lastKey = keys[keys.length - 1]!;
        setExpandedRoleKeys(prev => {
          const next = new Set(prev);
          next.delete(lastKey);
          return next;
        });
        roleButtonRefs.current.get(lastKey)?.focus({ preventScroll: true });
        return;
      }
      if (expandedSessionIds.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        const ids = [...expandedSessionIds];
        const lastId = ids[ids.length - 1]!;
        setExpandedSessionIds(prev => {
          const next = new Set(prev);
          next.delete(lastId);
          return next;
        });
        sessionButtonRefs.current.get(lastId)?.focus({ preventScroll: true });
        return;
      }
    }
    if (event.target !== event.currentTarget) return;
    const delta: Record<string, [number, number]> = { ArrowLeft: [70, 0], ArrowRight: [-70, 0], ArrowUp: [0, 70], ArrowDown: [0, -70] };
    if (delta[event.key]) {
      event.preventDefault();
      const [dx, dy] = delta[event.key];
      setView(previous => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(1 / 1.25);
    } else if (event.key === "Home") {
      event.preventDefault();
      fit();
    }
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, details")) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    setView(previous => ({ ...previous, x: dragRef.current!.startX + dx, y: dragRef.current!.startY + dy }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  };

  const renderSessionCard = (node: CanvasNode, cluster: CanvasSessionCluster, planTaskSummary?: PlanTaskProgressSummary) => {
    const row = cluster.sessionExec;
    const liveNode = !(stale && row.source === "observation") && isLive(row.status);
    const taskMeta = planTaskSummary ? planTaskStatusMeta(planTaskSummary.rawStatus) : null;
    const isTaskIncompleteEnded = taskMeta?.tone === "blocked" || taskMeta?.tone === "failed";
    const taskReason = planTaskSummary?.error || planTaskSummary?.summary || planTaskSummary?.waitingReason;
    const parentExecId = sessionParents.get(row.id);
    const parentCluster = parentExecId && clusterById.get(parentExecId);
    const directParent = row.parentExecutionId !== row.id ? row.parentExecutionId : undefined;
    const recordedParents = relations.filter(relation => relation.kind === "dispatch" && relation.toExecutionId === row.id && relation.fromExecutionId !== row.id);
    const recordedCreator = !!directParent || recordedParents.length > 0;
    const isAgentCreated = !!parentExecId || recordedCreator || cluster.origin === "lead-agent-created";
    const origin = isAgentCreated ? "lead-agent-created" : cluster.origin ?? "unknown";
    const recordedParentIds = new Set([directParent, ...recordedParents.map(relation => relation.fromExecutionId)].filter((id): id is string => !!id));
    const parentConflict = recordedParentIds.size > 1 || cluster.creatorLabel === "父关系冲突";
    const creatorId =
      cluster.creatorSessionId ??
      directParent?.replace(/^session-/, "") ??
      (recordedParents.length === 1 ? recordedParents[0].fromExecutionId.replace(/^session-/, "") : undefined);
    const creatorLabel = parentConflict
      ? "父关系冲突"
      : parentCluster
      ? parentCluster.title
      : isAgentCreated
      ? cluster.creatorLabel && !["用户", "父会话", "主agent"].includes(cluster.creatorLabel)
        ? `${cluster.creatorLabel}（未载入）`
        : creatorId
        ? `${creatorId}（未载入）`
        : "父会话未载入"
      : cluster.creatorLabel;
    let sessionDepth = 0;
    let ancestor = parentExecId;
    while (ancestor) {
      sessionDepth += 1;
      ancestor = sessionParents.get(ancestor);
    }
    const delegatedCount = delegatedCounts.get(row.id) ?? 0;
    const liveSubCount = cluster.childSubs.filter(sub => !(stale && sub.source === "observation") && isLive(sub.status)).length;
    const shortModel = shortModelName(row.observedModel);
    const staleObservation = stale && row.source === "observation";
    const statusText = canvasStatusLabel(row.status, liveNode, staleObservation, statusLabel);
    const tone = canvasStatusTone(row.status, liveNode, cluster.isCaptain);
    const showUnlinkedCreator = parentConflict || (isAgentCreated && !parentCluster);
    const isExpanded = expandedSessionIds.has(row.id);

    const borderClass = liveNode
      ? "border-l-[var(--accent-green)]"
      : isTaskIncompleteEnded || ["failed", "blocked"].includes(row.status)
      ? "border-l-[var(--accent-red)]"
      : taskMeta?.tone === "queued" || ["queued", "pending"].includes(row.status)
      ? "border-l-[var(--accent-orange)]"
      : cluster.isCaptain
      ? "border-l-[var(--accent-orange)]"
      : "border-l-[var(--accent-blue)]";

    const isCommHighlighted =
      (row.sessionId && highlightedCommSessions.has(row.sessionId)) || highlightedCommSessions.has(row.id);

    return (
      <div key={node.id} style={nodeStyle(node)} className="research-canvas-position research-fleet-node-wrap flex items-center">
        <div
          data-comm-highlighted={isCommHighlighted ? "true" : undefined}
          className={`research-fleet-card research-fleet-card--session h-full w-full ${borderClass} ${
            isCommHighlighted
              ? "ring-2 ring-[var(--accent-primary)] shadow-md"
              : isExpanded
              ? "ring-1 ring-[var(--accent-primary)]/45"
              : isTaskIncompleteEnded
              ? "ring-1 ring-red-500/35"
              : ""
          }`}
        >
          <button
            ref={element => {
              if (element) sessionButtonRefs.current.set(row.id, element);
              else sessionButtonRefs.current.delete(row.id);
            }}
            type="button"
            data-testid="canvas-session-node"
            data-origin={origin}
            data-parent-id={parentExecId ?? cluster.planId ?? undefined}
            data-depth={sessionDepth}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "收起" : "展开"} ${cluster.title} 下属节点`}
            onClick={() => toggleSession(row.id)}
            onFocus={() => revealNode(node)}
            className="research-fleet-card-body focus-ring"
          >
            {/* Row 1: Dot + Readable Title + Single Primary Badge */}
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${isTaskIncompleteEnded ? "bg-[var(--accent-red)]" : tone.dot}`} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--text-primary)]" title={cluster.title}>
                {cluster.title}
              </span>
              {taskMeta && !liveNode ? (
                <span
                  data-testid="canvas-session-plan-task-status"
                  data-task-status={planTaskSummary!.rawStatus}
                  title={taskReason || planTaskSummary?.task}
                  className={`shrink-0 rounded border px-1.5 py-0 text-[9px] leading-tight ${planTaskBadgeClass(taskMeta.tone)}`}
                >
                  {taskMeta.label}
                </span>
              ) : (
                <span
                  className={`shrink-0 rounded px-1.5 py-0 text-[9px] font-semibold leading-tight ${
                    cluster.isCaptain
                      ? "bg-amber-500/15 text-[var(--accent-orange)]"
                      : "bg-sky-500/15 text-[var(--accent-blue)]"
                  }`}
                >
                  {cluster.isCaptain ? (sessionDepth ? `主 Agent·L${sessionDepth}` : "主 Agent") : "Multi-Agent"}
                </span>
              )}
            </span>

            {/* Row 2: Compact Meta Line (no redundant status clash) */}
            <span className="flex min-w-0 items-center gap-1 text-[9.5px] text-[var(--text-secondary)]">
              {(!taskMeta || liveNode) && (
                <>
                  <span className={`shrink-0 ${tone.text}`}>{statusText}</span>
                  {(cluster.assignedRole || shortModel || !cluster.isCaptain) && <span aria-hidden="true" className="text-[var(--text-tertiary)]">·</span>}
                </>
              )}
              {taskMeta && liveNode && (
                <span
                  data-testid="canvas-session-plan-task-status"
                  data-task-status={planTaskSummary!.rawStatus}
                  className={`shrink-0 rounded border px-1 py-0 text-[8.5px] ${planTaskBadgeClass(taskMeta.tone)}`}
                >
                  {taskMeta.shortLabel}
                </span>
              )}
              {cluster.assignedRole ? (
                <span
                  className="max-w-[92px] shrink-0 truncate font-medium text-[var(--text-secondary)]"
                  title={`角色：${roleLabel(cluster.assignedRole)}`}
                >
                  {roleLabel(cluster.assignedRole)}
                </span>
              ) : !cluster.isCaptain ? (
                <span className="shrink-0 text-[var(--accent-blue)]">Multi-Agent</span>
              ) : null}
              {shortModel && (
                <>
                  {(cluster.assignedRole || !cluster.isCaptain) && <span aria-hidden="true" className="text-[var(--text-tertiary)]">·</span>}
                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-tertiary)]" title={row.observedModel}>
                    {shortModel}
                  </span>
                </>
              )}
              {taskMeta && !liveNode && !cluster.isCaptain && <span className="sr-only">Multi-Agent</span>}
            </span>

            {/* Row 3: Conditional High-Value Row (Captain progress / Blocked reason / Unlinked parent / Duty) */}
            {cluster.isCaptain && captainPlanSummary && (
              <ResearchMainPlanProgress summary={captainPlanSummary} compact />
            )}

            {!cluster.isCaptain && isTaskIncompleteEnded && taskReason && (
              <span
                className="block truncate rounded bg-red-500/10 px-1.5 py-0.5 text-[9.5px] text-[var(--accent-red)]"
                title={taskReason}
              >
                {taskReason}
              </span>
            )}

            {showUnlinkedCreator && creatorLabel && (
              <span
                data-testid="canvas-session-creator"
                className={`truncate text-[9.5px] font-medium ${parentConflict ? "text-[var(--accent-red)]" : "text-[var(--accent-orange)]"}`}
              >
                {creatorLabel}
              </span>
            )}

            {!cluster.isCaptain && cluster.workflowDuty && !(isTaskIncompleteEnded && taskReason) && (
              <span className="block truncate text-[9.5px] text-[var(--text-tertiary)]" title={cluster.workflowDuty}>
                {cluster.workflowDuty}
              </span>
            )}

            {/* Row 4: Whisper-quiet metadata line (no noisy box borders for zero/routine fields!) */}
            <div className="research-fleet-footer text-[9px] text-[var(--text-tertiary)]">
              <span data-testid="canvas-session-origin" className="shrink-0">
                {originGlyph(origin)}
              </span>
              {delegatedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0 font-medium text-[var(--accent-blue)]">
                    Multi-Agent ×{delegatedCount}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span
                className={`inline-flex shrink-0 items-center gap-0.5 ${
                  cluster.childSubs.length > 0
                    ? "rounded border border-purple-500/25 bg-purple-500/10 px-1 py-0 font-medium text-[var(--accent-purple-text)]"
                    : "text-[var(--text-tertiary)]"
                }`}
              >
                <span>
                  Subagent ×{cluster.childSubs.length}
                  {liveSubCount > 0 ? ` (${liveSubCount})` : ""}
                </span>
                <Icon path={isExpanded ? mdiChevronDown : mdiChevronRight} size={0.44} />
              </span>
              {planTaskSummary?.dependsOn && planTaskSummary.dependsOn.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">依赖 {planTaskSummary.dependsOn.length}</span>
                </>
              )}
            </div>
          </button>

          {/* Dedicated Bottom Bar: Left=Stats, Right=Actions (zero collision!) */}
          <div className="research-fleet-actionbar">
            <div className="min-w-0 flex-1 truncate">
              <SessionFleetStats sessionId={row.sessionId} status={row.status} visible={visible} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="research-fleet-mini-btn text-[var(--accent-text)]"
                aria-label={`查看 ${cluster.title} 会话详情`}
                title="查看会话详情与纠偏"
                onClick={event => {
                  event.stopPropagation();
                  onAgent(cluster.roleObj, row);
                }}
              >
                详情
              </button>
              {onRemoveSession && row.sessionId && (
                <button
                  type="button"
                  className="research-fleet-remove"
                  disabled={removalPending}
                  aria-label={`从当前批次移除 ${cluster.title}`}
                  onClick={event => {
                    event.stopPropagation();
                    onRemoveSession(row.sessionId!, cluster.title);
                  }}
                >
                  移除
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderPlanNode = (node: CanvasNode, item: Extract<TopologyItem, { kind: "plan" }>) => {
    const { plan, rawPlan, multiAgentCount } = item;
    const isExpanded = !collapsedPlanIds.has(rawPlan.id);
    const isHighlighted = highlightedPlanId === rawPlan.id;
    const incompleteEnded = plan.blocked + plan.failed;
    const incompletePercent = plan.total > 0 ? Math.min(100 - plan.progressPercent, Math.round((incompleteEnded / plan.total) * 100)) : 0;
    const borderClass =
      incompleteEnded > 0 && plan.state === "ended"
        ? "border-l-[var(--accent-red)]"
        : plan.state === "ended"
        ? "border-l-[var(--accent-green)]"
        : plan.state === "queued"
        ? "border-l-[var(--accent-orange)]"
        : "border-l-[var(--accent-primary)]";
    const statusText =
      incompleteEnded > 0 && plan.state === "ended"
        ? `受阻/未完成 ${incompleteEnded}`
        : plan.completed === plan.total && plan.total > 0
        ? "全部完成"
        : plan.queued > 0 && plan.inProgress === 0
        ? `排队 ${plan.queued}`
        : triStateLabel(plan.state);
    const statusClass =
      incompleteEnded > 0 && plan.state === "ended"
        ? "font-semibold text-[var(--accent-red)]"
        : plan.state === "ended"
        ? "font-medium text-[var(--accent-green)]"
        : plan.state === "queued"
        ? "font-medium text-[var(--accent-orange)]"
        : "font-medium text-[var(--accent-blue)]";
    return (
      <div key={node.id} style={nodeStyle(node)} className="research-canvas-position flex items-center">
        <div
          className={`research-fleet-card research-fleet-card--plan h-full w-full ${borderClass} ${
            isHighlighted ? "ring-2 ring-[var(--accent-primary)]" : ""
          }`}
        >
          <button
            type="button"
            data-testid="canvas-plan-node"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "收起" : "展开"} Plan ${plan.label}`}
            onClick={() => togglePlan(rawPlan.id)}
            onFocus={() => revealNode(node)}
            className="research-fleet-card-body focus-ring !justify-between !py-2"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--text-primary)]" title={rawPlan.clientPlanId || rawPlan.id}>
                Plan · {plan.label}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-[var(--text-tertiary)]">
                1:{multiAgentCount} Multi-Agent
              </span>
              <Icon path={isExpanded ? mdiChevronDown : mdiChevronRight} size={0.5} className="shrink-0 text-[var(--text-tertiary)]" />
            </span>

            <div className="space-y-1.5">
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                <div className="h-full bg-[var(--accent-green)] transition-all duration-300" style={{ width: `${plan.progressPercent}%` }} />
                {incompletePercent > 0 && (
                  <div className="h-full bg-[var(--accent-red)] transition-all duration-300" style={{ width: `${incompletePercent}%` }} />
                )}
              </div>
              <div className="flex items-center justify-between gap-1.5 text-[10px]">
                <span className={statusClass}>
                  {statusText}
                  {plan.inProgress > 0 && plan.queued > 0 ? ` · 排队 ${plan.queued}` : ""}
                </span>
                <span className="font-mono text-[var(--text-secondary)]">
                  {plan.completed}/{plan.total} ({plan.progressPercent}%)
                </span>
              </div>
            </div>
          </button>
        </div>
      </div>
    );
  };

  const renderPlanTaskNode = (node: CanvasNode, item: Extract<TopologyItem, { kind: "plan-task" }>) => {
    const { planId, task, rawTask } = item;
    const taskKey = `${planId}:${task.id}`;
    const isExpanded = expandedTaskIds.has(taskKey);
    const parentPlan = filteredPlans.find(plan => plan.id === planId);
    const taskMeta = planTaskStatusMeta(task.rawStatus);
    const isIncompleteEnded = taskMeta.tone === "blocked" || taskMeta.tone === "failed";
    const waitLabel = isIncompleteEnded
      ? task.error || task.summary || taskMeta.label
      : task.state === "ended"
      ? "Ended"
      : TREE_WAIT_TEXT[task.waitingReason ?? ""] ?? "Queued";
    const statusChip =
      taskMeta.tone === "blocked"
        ? "Blocked · 未完成"
        : taskMeta.tone === "failed"
        ? "Failed · 未完成"
        : task.state === "ended"
        ? "Ended"
        : task.state === "queued"
        ? "Queued"
        : "Running";

    return (
      <div key={node.id} style={nodeStyle(node)} className="research-canvas-position flex items-center">
        <div
          className={`research-fleet-card research-fleet-card--queued relative h-full w-full ${
            isIncompleteEnded
              ? "border-l-[var(--accent-red)] ring-1 ring-red-500/30"
              : task.state === "queued"
              ? "border-l-[var(--accent-orange)]"
              : "border-l-[var(--border-primary)]"
          }`}
        >
          <button
            type="button"
            data-testid="canvas-queued-task-node"
            data-work-state={task.state}
            data-task-status={task.rawStatus}
            aria-expanded={isExpanded}
            aria-label={`Plan 任务 ${task.role}（${statusChip}）`}
            title={task.error || task.task}
            onClick={() => toggleTask(taskKey)}
            onFocus={() => revealNode(node)}
            className="research-fleet-card-body focus-ring"
          >
            <span className="flex min-w-0 items-center justify-between gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--text-primary)]">{task.role}</span>
              <span
                className={`shrink-0 text-[9.5px] ${
                  isIncompleteEnded
                    ? "font-semibold text-[var(--accent-red)]"
                    : task.state === "queued"
                    ? "font-medium text-[var(--accent-orange)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                {statusChip}
              </span>
            </span>

            <span className="flex items-center justify-between gap-1.5 text-[9.5px] text-[var(--text-tertiary)]">
              <span className={`min-w-0 truncate ${isIncompleteEnded ? "text-[var(--accent-red)]" : ""}`}>{waitLabel}</span>
              <span className="shrink-0 font-mono">
                {task.queueRank ? `#${task.queueRank}` : task.id}
                {rawTask.dependsOn && rawTask.dependsOn.length > 0 ? ` · 依赖${rawTask.dependsOn.length}` : ""}
              </span>
            </span>
          </button>

          {task.state === "queued" && (onJumpPlanTask || onOpenQueue) && (
            <div className="research-fleet-actionbar">
              <span className="truncate text-[9px] text-[var(--text-tertiary)]">Multi-Agent</span>
              <div className="flex shrink-0 items-center gap-1">
                {onOpenQueue && (
                  <button
                    type="button"
                    className="research-fleet-mini-btn text-[var(--text-secondary)]"
                    aria-label={`打开 ${task.role} 排队管理`}
                    onClick={event => {
                      event.stopPropagation();
                      onOpenQueue(planId);
                    }}
                  >
                    调序
                  </button>
                )}
                {onJumpPlanTask && (
                  <button
                    type="button"
                    className="research-fleet-mini-btn text-[var(--accent-text)]"
                    onClick={event => {
                      event.stopPropagation();
                      onJumpPlanTask(planId, task.id, parentPlan?.revision);
                    }}
                  >
                    优先启动
                  </button>
                )}
              </div>
            </div>
          )}

          {isExpanded && (
            <div className="absolute left-0 top-[calc(100%+4px)] z-popover w-56 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 text-[10.5px] text-[var(--text-secondary)] shadow-md">
              <p className="font-medium text-[var(--text-primary)]">
                {task.role} · {task.id}
              </p>
              {isIncompleteEnded && (
                <p className="mt-1 font-medium text-[var(--accent-red)]">
                  状态：{taskMeta.label}{task.error ? `（${task.error}）` : ""}
                </p>
              )}
              <p className="mt-1 whitespace-pre-wrap break-words">{task.task}</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSubagentRoleNode = (node: CanvasNode, item: Extract<TopologyItem, { kind: "subagent-role" }>) => {
    const { sessionId, group, expandKey } = item;
    const parentCluster = clusterById.get(sessionId);
    const current = group.latest;
    const summary = (current.prompt ?? current.summary ?? "").replace(/^Task:\s*/i, "").replace(/\s+/g, " ").trim();
    const hasMultiple = group.executions.length > 1;
    const isExpanded = expandedRoleKeys.has(expandKey);
    const roleLive = group.executions.some(ex => !(stale && ex.source === "observation") && isLive(ex.status));
    const shortModel = shortModelName(current.observedModel);

    return (
      <div key={node.id} style={nodeStyle(node)} className="research-canvas-position relative group">
        {hasMultiple && !isExpanded && (
          <>
            {group.executions.length > 2 && (
              <div
                className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 rounded-[10px] border border-dashed border-[var(--accent-purple)]/40 bg-[var(--bg-secondary)]"
                style={{ zIndex: 0, opacity: 0.55 }}
              />
            )}
            <div
              className="pointer-events-none absolute inset-0 translate-x-1 translate-y-1 rounded-[10px] border border-dashed border-[var(--accent-purple)]/60 bg-[var(--bg-secondary)]"
              style={{ zIndex: 1, opacity: 0.8 }}
            />
          </>
        )}

        <button
          type="button"
          data-testid="canvas-role-node"
          ref={element => {
            if (element) roleButtonRefs.current.set(expandKey, element);
            else roleButtonRefs.current.delete(expandKey);
          }}
          aria-label={
            hasMultiple
              ? `${isExpanded ? "收起" : "展开"} ${roleLabel(group.roleName)} 的 ${group.executions.length} 次 Subagent 执行`
              : `查看 ${roleLabel(group.roleName)} 详情`
          }
          aria-expanded={hasMultiple ? isExpanded : undefined}
          aria-controls={hasMultiple ? executionGroupId(expandKey) : undefined}
          onFocus={() => revealNode(node)}
          onClick={() => {
            if (hasMultiple) toggleRoleRuns(expandKey);
            else onAgent(group.roleObj, current);
          }}
          className={`relative z-10 h-full w-full research-fleet-card research-fleet-card--subagent focus-ring cursor-pointer ${
            roleLive ? "border-l-[var(--accent-green)]" : "border-l-[var(--accent-purple)]"
          }`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${roleLive ? "bg-emerald-500" : "bg-[var(--accent-purple)]"}`} />
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--text-primary)]" title={roleLabel(group.roleName)}>
              {roleLabel(group.roleName)}
            </span>
            <span className="shrink-0 rounded border border-purple-500/20 bg-purple-500/10 px-1.5 py-0 text-[9.5px] font-medium text-[var(--accent-purple-text)]">
              Subagent ×{group.executions.length}
            </span>
          </span>

          <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
            <span className={canvasStatusTone(current.status, roleLive, false).text}>
              {canvasStatusLabel(current.status, roleLive, stale && current.source === "observation", statusLabel)}
            </span>
            {shortModel && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate font-mono text-[var(--text-tertiary)]" title={current.observedModel}>
                  {shortModel}
                </span>
              </>
            )}
          </span>

          <SubagentRoleFleetStats
            parentSessionId={parentCluster?.sessionExec.sessionId}
            parentStatus={parentCluster?.sessionExec.status ?? "idle"}
            roleName={group.roleName}
            fallbackCount={group.executions.length}
            visible={visible}
          />

          <div className="research-fleet-box flex items-center justify-between gap-2 text-[10px]">
            <span className="min-w-0 truncate text-[var(--text-secondary)]" title={summary}>
              {summary || "无任务摘要"}
            </span>
            {hasMultiple && (
              <span className="shrink-0 font-medium text-[var(--accent-purple)]">{isExpanded ? "收起 ▴" : "展开 ▾"}</span>
            )}
          </div>
        </button>
      </div>
    );
  };

  const renderSubagentRunNode = (node: CanvasNode, item: Extract<TopologyItem, { kind: "subagent-run" }>) => {
    const { group, execution, roundIndex } = item;
    const live = !(stale && execution.source === "observation") && isLive(execution.status);
    const task = (execution.prompt ?? execution.summary ?? execution.output ?? "").replace(/^Task:\s*/i, "").replace(/\s+/g, " ").trim();
    const shortModel = shortModelName(execution.observedModel);

    return (
      <button
        key={node.id}
        type="button"
        data-testid="canvas-execution-node"
        data-expanded="true"
        aria-label={`查看 ${roleLabel(group.roleName)} 第 ${roundIndex} 次详情`}
        style={nodeStyle(node)}
        onFocus={() => revealNode(node)}
        onClick={() => onAgent(group.roleObj, execution)}
        className={`research-canvas-execution research-fleet-card research-fleet-card--subagent focus-ring ${
          live ? "border-l-[var(--accent-green)]" : "border-l-[var(--accent-purple)]"
        }`}
      >
        <span className="flex items-center justify-between gap-1">
          <span className="text-[11px] font-semibold text-[var(--text-primary)]">
            #{roundIndex}
            {roundIndex === group.executions.length ? " 最新" : ""}
          </span>
          <span className={`truncate text-[10px] ${canvasStatusTone(execution.status, live, false).text}`}>
            {canvasStatusLabel(execution.status, live, stale && execution.source === "observation", statusLabel)}
          </span>
        </span>
        {shortModel && (
          <span className="truncate font-mono text-[9.5px] text-[var(--text-tertiary)]" title={execution.observedModel}>
            {shortModel}
          </span>
        )}
        <div className="research-fleet-box">
          <span className="line-clamp-2 text-[10.5px] leading-snug text-[var(--text-secondary)]" title={task}>
            {task || "点击查看详细输出"}
          </span>
        </div>
        <span className="flex items-center justify-between gap-2 text-[10px]">
          <span className="text-[var(--text-tertiary)]">{execution.startedAt ? new Date(execution.startedAt).toLocaleTimeString() : "时间未记录"}</span>
          <span className="font-medium text-[var(--accent-text)]">详情 →</span>
        </span>
      </button>
    );
  };

  const miniW = 136;
  const miniH = 82;
  const miniScale = Math.min((miniW - 8) / Math.max(1, scene.width), (miniH - 8) / Math.max(1, scene.height));
  const totalPlansCount = filteredPlans.length;
  const hasInlineExpansions = expandedSessionIds.size > 0 || expandedRoleKeys.size > 0;

  return (
    <section className="research-agent-canvas overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]" aria-label="Agent 协作拓扑画布">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
          <Icon path={mdiAccountGroup} size={0.6} className="shrink-0 text-[var(--accent-text)]" />
          {tenureTitle && (
            <>
              <span className="truncate">{tenureTitle}</span>
              <span aria-hidden="true" className="text-[var(--text-tertiary)]">·</span>
            </>
          )}
          <span className={`shrink-0 ${tenureTitle ? "font-normal text-[var(--text-tertiary)]" : ""}`}>{overviewTitle}</span>
          {tenureBadge && (
            <span
              className={`shrink-0 rounded-full border px-2 py-0 text-[10.5px] font-medium ${
                tenureBadge === "当前"
                  ? "border-[var(--accent-primary)]/40 bg-[var(--accent-soft)] text-[var(--accent-text)]"
                  : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              }`}
            >
              {tenureBadge}
            </span>
          )}
          <span className="text-[10.5px] font-normal text-[var(--text-tertiary)]">
            {totalPlansCount > 0 ? `Plan ${totalPlansCount} · ` : ""}
            Multi-Agent {query.trim() || hideEndedActive ? `${orderedClusters.length}/${clusters.length}` : clusters.length}
            {totalSubagents > 0 ? ` · Subagent ${totalSubagents}` : ""}
          </span>
        </div>

        <input
          type="search"
          aria-label="搜索会话"
          placeholder="过滤 Plan 或节点…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="min-w-[120px] flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] sm:max-w-[170px]"
        />

        <div className="flex flex-wrap items-center gap-1">
          {endedCount > 0 && endedCount < clusters.length && (
            <button
              type="button"
              aria-pressed={hideEnded}
              onClick={() => setHideEnded(value => !value)}
              className={`win11-btn px-2 py-1 text-[11px] ${hideEnded ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-text)]" : ""}`}
            >
              隐藏已结束 ({endedCount})
            </button>
          )}
          {hasInlineExpansions && (
            <button type="button" onClick={collapseAllInline} className="win11-btn px-2 py-1 text-[11px]" aria-label="收起执行卡片">
              收起展开
            </button>
          )}
          {collapsedPlanIds.size > 0 && (
            <button type="button" onClick={() => setCollapsedPlanIds(new Set())} className="win11-btn px-2 py-1 text-[11px]">
              展开全部 Plan
            </button>
          )}
          <button
            type="button"
            data-testid="research-toggle-comm-feed"
            aria-pressed={commOpen}
            onClick={() => setCommOpenOverride(!commOpen)}
            className={`win11-btn inline-flex items-center gap-1 px-2 py-1 text-[11px] ${
              commOpen ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-text)]" : ""
            }`}
            title={commOpen ? "收起 Agent 通信动态" : "展开 Agent 通信动态"}
          >
            <Icon path={mdiForumOutline} size={0.54} />
            <span>通信动态{communications.length > 0 ? ` (${communications.length})` : ""}</span>
            {unresolvedCommRequests > 0 && (
              <span
                aria-label={`${unresolvedCommRequests} 条待回复求助`}
                className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent-orange)]"
              />
            )}
          </button>
          <details className="relative">
            <summary className="win11-btn list-none cursor-pointer px-2 py-1 text-[11px]" aria-label="连线图例">
              图例
            </summary>
            <div className="absolute right-0 top-[calc(100%+4px)] z-20 flex w-60 flex-col gap-1.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2.5 text-[11px] text-[var(--text-secondary)] shadow-md">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t-2 border-[var(--accent-primary)]" />主 Agent → Plan（1:N 分派）
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t-2 border-[var(--accent-blue)]" />Plan → Multi-Agent 派发关系
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t-2 border-dashed border-[var(--accent-green)]" />节点进行中（Running）
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t-2 border-[var(--accent-red)]" />任务受阻 / 失败未完成
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t-2 border-dashed border-[var(--accent-purple)]" />Subagent 子代理与多轮展开
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="w-4 border-t border-dashed border-[var(--accent-orange)]" />任务依赖 / 排队 / 交接
              </span>
            </div>
          </details>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="win11-btn px-2 py-1 text-[11px]"
              aria-label="收起历史批次拓扑"
            >
              收起
            </button>
          )}
        </div>
      </div>

      <div className="research-canvas-body">
      <div
        ref={viewportRef}
        data-testid="research-canvas-viewport"
        data-scale={view.scale.toFixed(3)}
        role="region"
        aria-label="Agent 调度拓扑画布"
        tabIndex={0}
        onKeyDown={onCanvasKey}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        className={`relative h-[min(64vh,640px)] min-h-[440px] flex-1 min-w-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)] ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{
          touchAction: "none",
          backgroundColor: "var(--bg-primary)",
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--border-secondary) 42%, transparent) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        <div
          className="research-canvas-scene"
          style={{
            transition: dragging ? "none" : undefined,
            position: "absolute",
            left: 0,
            top: 0,
            width: scene.width,
            height: scene.height,
            transformOrigin: "0 0",
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg aria-hidden="true" width={scene.width} height={scene.height} className="pointer-events-none absolute inset-0 overflow-visible">
            <defs>
              <marker id={`${canvasId}-arrow-blue`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M 0 0.7 L 6.5 3.5 L 0 6.3 Z" fill="var(--accent-blue)" />
              </marker>
              <marker id={`${canvasId}-arrow-green`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M 0 0.7 L 6.5 3.5 L 0 6.3 Z" fill="var(--accent-green)" />
              </marker>
              <marker id={`${canvasId}-arrow-purple`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M 0 0.7 L 6.5 3.5 L 0 6.3 Z" fill="var(--accent-purple)" />
              </marker>
              <marker id={`${canvasId}-arrow-orange`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M 0 0.7 L 6.5 3.5 L 0 6.3 Z" fill="var(--accent-orange)" />
              </marker>
              <marker id={`${canvasId}-arrow-red`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M 0 0.7 L 6.5 3.5 L 0 6.3 Z" fill="var(--accent-red)" />
              </marker>
            </defs>

            {scene.nodes
              .filter(node => node.parentId && sceneById.has(node.parentId))
              .map(node => {
                const parent = sceneById.get(node.parentId!)!;
                const item = node.item;
                const isSubagentEdge = item.kind === "subagent-role" || item.kind === "subagent-run" || item.kind === "subagent-empty";
                const isLiveEdge =
                  (item.kind === "session" && !(stale && item.cluster.sessionExec.source === "observation") && isLive(item.cluster.sessionExec.status)) ||
                  (item.kind === "plan" && item.plan.state === "in_progress") ||
                  (item.kind === "subagent-role" && item.group.executions.some(ex => !(stale && ex.source === "observation") && isLive(ex.status))) ||
                  (item.kind === "subagent-run" && !(stale && item.execution.source === "observation") && isLive(item.execution.status));
                const isIncompleteEdge =
                  (item.kind === "session" && Boolean(item.planTask) && ["blocked", "failed"].includes(planTaskStatusMeta(item.planTask?.rawStatus).tone)) ||
                  (item.kind === "plan-task" && ["blocked", "failed"].includes(planTaskStatusMeta(item.task.rawStatus).tone)) ||
                  (item.kind === "plan" && item.plan.state === "ended" && item.plan.blocked + item.plan.failed > 0);
                const isQueuedEdge =
                  item.kind === "plan-task"
                    ? item.task.state === "queued"
                    : item.kind === "plan-awaiting" || (item.kind === "session" && normalizeWorkState(item.cluster.sessionExec.status) === "queued");

                const stroke = isSubagentEdge
                  ? isLiveEdge
                    ? "var(--accent-green)"
                    : "var(--accent-purple)"
                  : isLiveEdge
                  ? "var(--accent-green)"
                  : isIncompleteEdge
                  ? "var(--accent-red)"
                  : isQueuedEdge
                  ? "var(--accent-orange)"
                  : "var(--accent-blue)";
                const markerName = isSubagentEdge
                  ? isLiveEdge
                    ? "arrow-green"
                    : "arrow-purple"
                  : isLiveEdge
                  ? "arrow-green"
                  : isIncompleteEdge
                  ? "arrow-red"
                  : isQueuedEdge
                  ? "arrow-orange"
                  : "arrow-blue";

                return (
                  <g key={`parent-${node.id}`} data-testid="canvas-parent-edge">
                    <path
                      data-testid="canvas-relation-edge"
                      d={orthogonalDownPath(parent, node)}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={item.kind === "subagent-run" ? 1.5 : 2}
                      strokeDasharray={isSubagentEdge || isLiveEdge || isQueuedEdge ? "6 4" : undefined}
                      strokeLinejoin="round"
                      className={isLiveEdge ? "research-fleet-edge-animated" : undefined}
                      markerEnd={`url(#${canvasId}-${markerName})`}
                      opacity={isLiveEdge ? 0.95 : 0.78}
                    />
                  </g>
                );
              })}

            {scene.edges.map(edge => {
              const from = sceneById.get(edge.fromId);
              const to = sceneById.get(edge.toId);
              if (!from || !to) return null;
              return (
                <path
                  key={edge.id}
                  data-testid="canvas-dependency-edge"
                  d={smoothStepPath(from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2)}
                  fill="none"
                  stroke="var(--accent-orange)"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  opacity="0.7"
                />
              );
            })}

            {relations
              .filter(relation => relation.kind === "handoff" || sessionParents.get(relation.toExecutionId) !== relation.fromExecutionId)
              .map(relation => {
                const from = sceneById.get(relation.fromExecutionId);
                const to = sceneById.get(relation.toExecutionId);
                if (!from || !to) return null;
                return (
                  <path
                    key={relation.id}
                    data-testid="canvas-relation-edge"
                    d={smoothStepPath(from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2)}
                    fill="none"
                    stroke="var(--accent-orange)"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                    opacity="0.65"
                  />
                );
              })}
          </svg>

          {scene.nodes.map(node => {
            const { item } = node;
            switch (item.kind) {
              case "session":
                return renderSessionCard(node, item.cluster, item.planTask);
              case "plan":
                return renderPlanNode(node, item);
              case "plan-awaiting":
                return (
                  <div key={node.id} style={nodeStyle(node)} className="research-canvas-position flex items-center">
                    <div
                      data-testid="canvas-plan-awaiting-node"
                      className="research-fleet-card research-fleet-card--queued h-full w-full justify-center gap-1 px-2.5 py-2 border-l-[var(--accent-orange)] text-left"
                    >
                      <span className="text-[11px] font-semibold text-[var(--text-primary)]">先 Plan 后 Work</span>
                      <span className="text-[10px] text-[var(--text-secondary)]">主 Agent 尚未提交执行 Plan，制定 Plan 后显示与 Multi-Agent 的 1:N 对应关系。</span>
                    </div>
                  </div>
                );
              case "plan-task":
                return renderPlanTaskNode(node, item);
              case "subagent-role":
                return renderSubagentRoleNode(node, item);
              case "subagent-empty":
                return (
                  <div key={node.id} style={nodeStyle(node)} className="research-canvas-position flex items-center">
                    <div className="research-fleet-card research-fleet-card--subagent h-full w-full justify-between border-l-[var(--accent-purple)]">
                      <span className="text-[11px] text-[var(--text-secondary)]">该会话暂无 Subagent 执行记录</span>
                      <button
                        type="button"
                        className="win11-btn self-end px-2 py-0.5 text-[10px] text-[var(--accent-text)]"
                        onClick={() => onAgent(item.cluster.roleObj, item.cluster.sessionExec)}
                      >
                        <Icon path={mdiOpenInNew} size={0.45} />
                        <span>打开会话详情</span>
                      </button>
                    </div>
                  </div>
                );
              case "subagent-run":
                return renderSubagentRunNode(node, item);
            }
          })}
        </div>

        {/* Bottom-left floating zoom controls */}
        <div className="research-fleet-controls" role="group" aria-label="画布缩放控制">
          <button type="button" onClick={() => zoom(1 / 1.25)} aria-label="缩小画布" title="缩小">
            <Icon path={mdiMagnifyMinusOutline} size={0.62} />
          </button>
          <span data-testid="research-canvas-zoom" className="w-10 text-center font-mono text-[10px] text-[var(--text-secondary)]" aria-label={`缩放 ${Math.round(view.scale * 100)}%`}>
            {Math.round(view.scale * 100)}%
          </span>
          <button type="button" onClick={() => zoom(1.25)} aria-label="放大画布" title="放大">
            <Icon path={mdiMagnifyPlusOutline} size={0.62} />
          </button>
          <button type="button" onClick={fit} aria-label="适应画布" title="适应画布">
            <Icon path={mdiArrowExpandAll} size={0.62} />
          </button>
          <button type="button" onClick={fitContent} aria-label="适应全部节点" title="缩放并居中显示全部 agent">
            <Icon path={mdiFitToPageOutline} size={0.62} />
          </button>
        </div>

        {/* Bottom-right compact SVG minimap */}
        {scene.nodes.length > 0 && (
          <svg className="research-fleet-minimap hidden sm:block" width={miniW} height={miniH} aria-hidden="true">
            {scene.nodes.map(node => {
              let fill = "var(--accent-blue)";
              if (node.item.kind === "session") {
                const c = node.item.cluster;
                const live = !(stale && c.sessionExec.source === "observation") && isLive(c.sessionExec.status);
                fill = live ? "var(--accent-green)" : c.isCaptain ? "var(--accent-orange)" : "var(--accent-blue)";
              } else if (node.item.kind === "plan") {
                fill = "var(--accent-primary)";
              } else if (node.item.kind === "plan-task" || node.item.kind === "plan-awaiting") {
                fill = "var(--accent-orange)";
              } else {
                fill = "var(--accent-purple)";
              }
              return (
                <rect
                  key={node.id}
                  x={4 + node.x * miniScale}
                  y={4 + node.y * miniScale}
                  width={Math.max(4, node.width * miniScale)}
                  height={Math.max(3, node.height * miniScale)}
                  rx={2}
                  fill={fill}
                  fillOpacity={0.75}
                  stroke="var(--border-primary)"
                  strokeWidth={0.8}
                />
              );
            })}
            <rect
              x={Math.max(0, 4 - (view.x / Math.max(0.05, view.scale)) * miniScale)}
              y={Math.max(0, 4 - (view.y / Math.max(0.05, view.scale)) * miniScale)}
              width={Math.min(miniW - 2, (size.width / Math.max(0.05, view.scale)) * miniScale)}
              height={Math.min(miniH - 2, (size.height / Math.max(0.05, view.scale)) * miniScale)}
              rx={2}
              fill="none"
              stroke="var(--accent-primary)"
              strokeWidth={1}
              opacity={0.7}
            />
          </svg>
        )}

        {filteredClusters.length === 0 && filteredPlans.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-tertiary)]">没有匹配的节点</div>
        )}
      </div>

      {commOpen && (
        <ResearchCommunicationFeed
          items={communications}
          mainSessionId={mainSessionId}
          sessionTitles={mergedSessionTitles}
          taskLabels={taskLabels}
          onClose={() => {
            setCommOpenOverride(false);
            setHighlightedCommSessions(new Set());
          }}
          onHighlightSessions={ids => setHighlightedCommSessions(new Set(ids))}
          onLocateSession={targetSessionId => {
            setHighlightedCommSessions(new Set([targetSessionId]));
            const match = scene.nodes.find(
              node =>
                node.item.kind === "session" &&
                (node.item.cluster.sessionExec.sessionId === targetSessionId ||
                  node.item.cluster.sessionExec.id === targetSessionId),
            );
            if (match) revealNode(match);
          }}
          onOpenSession={targetSessionId => {
            const cluster = clusters.find(
              item => item.sessionExec.sessionId === targetSessionId || item.sessionExec.id === targetSessionId,
            );
            if (cluster) onAgent(cluster.roleObj, cluster.sessionExec);
          }}
        />
      )}
      </div>

      <span className="sr-only" aria-live="polite">
        {hasInlineExpansions ? "下属节点已在拓扑画布中展开，按 Escape 收起。" : ""}
      </span>
    </section>
  );
}
