import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiAccountGroup, mdiArrowLeft, mdiArrowExpandAll, mdiFitToPageOutline, mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew } from "@mdi/js";
import { useSpeedStats } from "@blackbelt-technology/pi-dashboard-speed-plugin";
import type { ResearchWorkbenchRelation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import type { ConfiguredRole, ResearchExecution, ResearchExecutionOriginKind } from "./research-projection.js";
import { MIN_CANVAS_SCALE, fitGraph, layoutFocusedSession, layoutSessionHierarchy, layoutSessionTree, resolveSessionParents, zoomGraphAt, type CanvasNode, type CanvasSessionNode, type CanvasView } from "./research-agent-canvas-layout.js";

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
}
interface Props {
  clusters: CanvasSessionCluster[];
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
}

const originTint = (origin?: ResearchExecutionOriginKind) =>
  origin === "lead-agent-created"
    ? "border-purple-500/20 bg-purple-500/10 text-[var(--text-secondary)]"
    : origin === "workflow-created"
    ? "border-amber-500/20 bg-amber-500/10 text-[var(--text-secondary)]"
    : origin === "user-created"
    ? "border-sky-500/20 bg-sky-500/10 text-[var(--text-secondary)]"
    : "border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]";
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

function busBranchPath(parent: CanvasNode, node: CanvasSessionNode): string {
  const startX = parent.x + parent.width;
  const startY = parent.y + parent.height / 2;
  const endX = node.x - 3;
  const endY = node.y + node.height / 2;
  const trunkX = parent.x + parent.width + 20;
  if ((node.gridCol ?? 0) === 0) {
    const dy = endY - startY;
    if (Math.abs(dy) < 2) return `M ${startX} ${startY} L ${endX} ${endY}`;
    const r = Math.min(8, Math.abs(dy) / 2);
    const dirY = dy > 0 ? 1 : -1;
    return [
      `M ${startX} ${startY}`,
      `H ${trunkX - r}`,
      `Q ${trunkX} ${startY} ${trunkX} ${startY + dirY * r}`,
      `V ${endY - dirY * r}`,
      `Q ${trunkX} ${endY} ${trunkX + r} ${endY}`,
      `H ${endX}`,
    ].join(" ");
  }
  // Route wrapped grid columns along the inter-row gap lane directly above the row so edges never cut cards.
  const laneY = node.y - 9;
  const entryX = node.x - 10;
  const dy1 = laneY - startY;
  const dy2 = endY - laneY;
  const r1 = Math.min(6, Math.abs(dy1) / 2);
  const r2 = Math.min(6, Math.abs(dy2) / 2);
  const segments = [`M ${startX} ${startY}`];
  if (Math.abs(dy1) < 2) {
    segments.push(`H ${entryX - r2}`);
  } else {
    const d1 = dy1 > 0 ? 1 : -1;
    segments.push(
      `H ${trunkX - r1}`,
      `Q ${trunkX} ${startY} ${trunkX} ${startY + d1 * r1}`,
      `V ${laneY - d1 * r1}`,
      `Q ${trunkX} ${laneY} ${trunkX + r1} ${laneY}`,
      `H ${entryX - r2}`,
    );
  }
  const d2 = dy2 >= 0 ? 1 : -1;
  segments.push(
    `Q ${entryX} ${laneY} ${entryX} ${laneY + d2 * r2}`,
    `V ${endY - d2 * r2}`,
    `Q ${entryX} ${endY} ${entryX + r2} ${endY}`,
    `H ${endX}`,
  );
  return segments.join(" ");
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
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function SessionFleetStats({ sessionId, status, visible }: { sessionId?: string; status: string; visible: boolean }) {
  const { stats } = useSpeedStats(sessionId, status, visible && Boolean(sessionId));
  const billing = stats?.billing;
  if (!billing) {
    return (
      <span className="research-fleet-stats text-[var(--text-tertiary)]">
        <span className="text-left whitespace-nowrap">— calls</span>
        <span className="text-center whitespace-nowrap">· — tok</span>
        <span className="text-right whitespace-nowrap">¥—</span>
      </span>
    );
  }
  const calls = billing.modelBreakdown.reduce((sum, entry) => sum + entry.callCount, 0);
  return (
    <span data-testid="canvas-session-stats" className="research-fleet-stats text-[var(--text-secondary)]">
      <span className="text-left whitespace-nowrap">{calls} calls</span>
      <span className="text-center whitespace-nowrap">· {formatCompactTokens(billing.totalTokens)} tok</span>
      <span className="text-right whitespace-nowrap font-semibold text-[var(--text-primary)]">{!billing.complete ? "≥" : ""}¥{billing.sessionTotalCost.toFixed(2)}</span>
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
export function ResearchAgentCanvas({ clusters, stale, relations = [], onAgent, statusLabel, roleLabel, visible = true, overviewTitle = "调度拓扑", tenureTitle, tenureBadge, layout = "forest", onRemoveSession, removalPending }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const roleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const canvasId = useId().replaceAll(":", "");
  const executionGroupId = (roleName: string) => `${canvasId}-rounds-${encodeURIComponent(roleName)}`;
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState<{ sessionId: string; roleName: string } | null>(null);
  const [query, setQuery] = useState("");
  const [hideEnded, setHideEnded] = useState(false);
  const [rolePage, setRolePage] = useState(0);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 });
  const previousSceneMode = useRef<"overview" | "detail" | null>(null);
  const endedCount = useMemo(
    () => clusters.filter(cluster => ENDED_STATUSES.has(cluster.sessionExec.status)).length,
    [clusters],
  );
  const filteredClusters = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? clusters.filter(cluster => [cluster.title, cluster.sessionExec.id, cluster.sessionExec.prompt, cluster.sessionExec.summary]
      .some(value => value?.toLocaleLowerCase().includes(term))) : clusters;
  }, [clusters, query]);
  const focused = filteredClusters.find(cluster => cluster.sessionExec.id === focusedId);
  const hideEndedActive = !focused && hideEnded && endedCount > 0 && endedCount < clusters.length;
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
        : (originalIndex.get(a.sessionExec.id)! - originalIndex.get(b.sessionExec.id)!);
    });
  }, [filteredClusters, hideEndedActive, stale]);
  const pageSize = 4;
  const pageCount = Math.max(1, Math.ceil((focused?.childRoleGroups.length ?? 0) / pageSize));
  const page = Math.min(rolePage, pageCount - 1);
  const visibleRoles = focused?.childRoleGroups.slice(page * pageSize, (page + 1) * pageSize) ?? [];
  const expandedRoleGroup = focused?.sessionExec.id === expandedGroupKey?.sessionId
    ? visibleRoles.find(group => group.roleName === expandedGroupKey?.roleName) : undefined;
  const sessionParents = useMemo(() => {
    const conflicts = new Set(clusters.filter(cluster => cluster.creatorLabel === "父关系冲突").map(cluster => cluster.sessionExec.id));
    return resolveSessionParents(clusters.map(cluster => cluster.sessionExec.id), [
      ...relations,
      ...clusters.flatMap(cluster => cluster.sessionExec.parentExecutionId
        ? [{ fromExecutionId: cluster.sessionExec.parentExecutionId, toExecutionId: cluster.sessionExec.id, kind: "dispatch" }] : []),
    ].filter(relation => !conflicts.has(relation.toExecutionId)));
  }, [clusters, relations]);
  const delegatedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const parentId of sessionParents.values()) counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    return counts;
  }, [sessionParents]);
  const clusterById = useMemo(() => new Map(clusters.map(cluster => [cluster.sessionExec.id, cluster])), [clusters]);
  const totalSubagents = useMemo(() => clusters.reduce((sum, cluster) => sum + cluster.childSubs.length, 0), [clusters]);
  const horizontalTree = layout === "tree" && size.width >= 620;
  // World-space width the viewport can show at the current zoom. Zooming out
  // widens it, so the tree packs more siblings per row instead of a long
  // vertical column. Quantized to avoid relayout churn during smooth zoom.
  // See change: canvas-topology-zoom-aware-columns.
  const worldWidth = useMemo(() => {
    const raw = size.width / Math.max(view.scale, MIN_CANVAS_SCALE);
    return Math.max(size.width, Math.round(raw / 80) * 80);
  }, [size.width, view.scale]);
  const overview = useMemo(() => {
    const ids = orderedClusters.map(cluster => cluster.sessionExec.id);
    return layout === "tree"
      ? layoutSessionTree(ids, sessionParents, horizontalTree, size.width, worldWidth)
      : layoutSessionHierarchy(ids, sessionParents, size.width);
  }, [horizontalTree, layout, orderedClusters, sessionParents, size.width, worldWidth]);
  const hub = overview.hub;
  const overviewById = new Map(overview.nodes.map(node => [node.id, node]));
  const detail = useMemo(() => focused ? layoutFocusedSession(focused.sessionExec.id, visibleRoles.map(group => group.roleName), size.width,
    expandedRoleGroup ? { roleId: expandedRoleGroup.roleName, executionIds: expandedRoleGroup.executions.map(execution => execution.id) } : undefined)
    : null, [focused, page, size.width, expandedRoleGroup]);
  const scene = detail ?? overview;
  // `worldWidth` is part of the key: a zoom-driven reflow changes the scene
  // geometry, and the viewport effect must re-center on it.
  const sceneKey = JSON.stringify([focused?.sessionExec.id ?? null, hideEndedActive, orderedClusters.map(c => c.sessionExec.id), [...sessionParents], visibleRoles.map(g => g.roleName), expandedRoleGroup?.executions.map(execution => execution.id), worldWidth]);
  const creator = focused && clusterById.get(sessionParents.get(focused.sessionExec.id) ?? "");
  const delegatedSessions = focused ? clusters.filter(cluster => sessionParents.get(cluster.sessionExec.id) === focused.sessionExec.id) : [];
  const focusSession = (id: string | null) => { setFocusedId(id); setRolePage(0); setExpandedGroupKey(null); };
  const collapseExpansion = () => {
    if (expandedGroupKey) roleButtonRefs.current.get(expandedGroupKey.roleName)?.focus({ preventScroll: true });
    setExpandedGroupKey(null);
  };
  const revealNode = (node: CanvasNode) => setView(previous => {
    const left = previous.x + node.x * previous.scale, top = previous.y + node.y * previous.scale;
    const right = left + node.width * previous.scale, bottom = top + node.height * previous.scale;
    const dx = left < 16 ? 16 - left : right > size.width - 16 ? size.width - 16 - right : 0;
    const dy = top < 16 ? 16 - top : bottom > size.height - 16 ? size.height - 16 - bottom : 0;
    return dx || dy ? { ...previous, x: previous.x + dx, y: previous.y + dy } : previous;
  });

  useEffect(() => {
    if (focusedId && !clusters.some(cluster => cluster.sessionExec.id === focusedId)) setFocusedId(null);
  }, [clusters, focusedId]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      if (!visible || element.clientWidth === 0) return;
      const width = element.clientWidth, height = element.clientHeight || 520;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [visible]);

  useLayoutEffect(() => {
    const enteringOverview = previousSceneMode.current !== "overview";
    previousSceneMode.current = detail ? "detail" : "overview";
    if (!detail) {
      setView(previous => {
        const scale = enteringOverview ? 1 : previous.scale;
        const scaledW = scene.width * scale;
        // The overview reflows with zoom (column packing), so on a layout
        // change keep the scene horizontally centered when it fits and only
        // clamp when it overflows. `x: 16` alone let the reflowed row spill off
        // the right edge. See change: canvas-topology-zoom-aware-columns.
        const x = scaledW <= size.width - 32
          ? Math.round((size.width - scaledW) / 2)
          : 16;
        return { scale, x, y: 12 };
      });
      return;
    }
    const fitted = fitGraph(scene, size);
    const readableScale = 0.7;
    setView(fitted.scale < readableScale
      ? { scale: readableScale, x: Math.max(12, (size.width - scene.width * readableScale) / 2), y: 12 } : fitted);
    // sceneKey describes the geometry; status and text updates do not reset the viewport.
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
  // "Fit all": reflow at the zoom that would fit everything, then fit. Because
  // the layout's column count follows world width, this lands on the packing
  // that shows the most agents with no empty gutters. See change:
  // canvas-topology-zoom-aware-columns.
  const fitContent = () => setView(fitGraph(overview, size));
  const onCanvasKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && expandedRoleGroup) { event.preventDefault(); event.stopPropagation(); collapseExpansion(); return; }
    if (event.target !== event.currentTarget) return;
    const delta: Record<string, [number, number]> = { ArrowLeft: [70, 0], ArrowRight: [-70, 0], ArrowUp: [0, 70], ArrowDown: [0, -70] };
    if (delta[event.key]) {
      event.preventDefault();
      const [dx, dy] = delta[event.key];
      setView(previous => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.25); }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.25); }
    else if (event.key === "Home") { event.preventDefault(); fit(); }
  };
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, details")) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragRef.current.x, dy = event.clientY - dragRef.current.y;
    setView(previous => ({ ...previous, x: dragRef.current!.startX + dx, y: dragRef.current!.startY + dy }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  };

  const parentNode = (node: CanvasNode, cluster: CanvasSessionCluster, inFocus: boolean) => {
    const row = cluster.sessionExec;
    const liveNode = !(stale && row.source === "observation") && isLive(row.status);
    const parentId = sessionParents.get(row.id);
    const parent = parentId && clusterById.get(parentId);
    const directParent = row.parentExecutionId !== row.id ? row.parentExecutionId : undefined;
    const recordedParents = relations.filter(relation => relation.kind === "dispatch" && relation.toExecutionId === row.id && relation.fromExecutionId !== row.id);
    const recordedCreator = !!directParent || recordedParents.length > 0;
    const isAgentCreated = !!parentId || recordedCreator || cluster.origin === "lead-agent-created";
    const origin = isAgentCreated ? "lead-agent-created" : cluster.origin ?? "unknown";
    const recordedParentIds = new Set([directParent, ...recordedParents.map(relation => relation.fromExecutionId)].filter((id): id is string => !!id));
    const parentConflict = recordedParentIds.size > 1 || cluster.creatorLabel === "父关系冲突";
    const creatorId = cluster.creatorSessionId ?? directParent?.replace(/^session-/, "")
      ?? (recordedParents.length === 1 ? recordedParents[0].fromExecutionId.replace(/^session-/, "") : undefined);
    const creatorLabel = parentConflict ? "父关系冲突" : parent ? parent.title : isAgentCreated
      ? (cluster.creatorLabel && !["用户", "父会话", "主agent"].includes(cluster.creatorLabel)
        ? `${cluster.creatorLabel}（未载入）` : creatorId ? `${creatorId}（未载入）` : "父会话未载入")
      : cluster.creatorLabel;
    let depth = 0, ancestor = parentId;
    while (ancestor) { depth += 1; ancestor = sessionParents.get(ancestor); }
    const delegatedCount = delegatedCounts.get(row.id) ?? 0;
    const liveSubCount = cluster.childSubs.filter(sub => !(stale && sub.source === "observation") && isLive(sub.status)).length;
    const shortModel = shortModelName(row.observedModel);
    const staleObservation = stale && row.source === "observation";
    const statusText = canvasStatusLabel(row.status, liveNode, staleObservation, statusLabel);
    const tone = canvasStatusTone(row.status, liveNode, cluster.isCaptain);
    const showUnlinkedCreator = parentConflict || (isAgentCreated && !parent);

    return (
      <div key={node.id} style={nodeStyle(node)} className="research-canvas-position research-fleet-node-wrap flex items-center">
      <div className="relative w-full">
      <button
        type="button" data-testid="canvas-session-node" data-origin={origin} data-parent-id={parentId ?? undefined} data-depth={depth}
        aria-label={inFocus ? `查看 ${cluster.title} 会话详情` : `聚焦${cluster.title}`}
        onClick={() => { if (inFocus) onAgent(cluster.roleObj, row); else focusSession(row.id); }}
        onFocus={() => revealNode(node)}
        className={`research-fleet-card research-fleet-card--session focus-ring w-full cursor-pointer ${
          liveNode
            ? "border-l-[var(--accent-green)]"
            : ["queued", "pending"].includes(row.status)
            ? "border-l-[var(--accent-orange)]"
            : ["failed", "blocked"].includes(row.status)
            ? "border-l-[var(--accent-red)]"
            : cluster.isCaptain
            ? "border-l-[var(--accent-orange)]"
            : "border-l-[var(--accent-blue)]"
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text-primary)]" title={cluster.title}>
            {cluster.title}
          </span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${
            cluster.isCaptain
              ? "bg-amber-500/15 text-[var(--accent-orange)]"
              : "bg-sky-500/15 text-[var(--accent-blue)]"
          }`}>
            {cluster.isCaptain ? (depth ? `主会话·L${depth}` : "主会话") : "Multi-Agent"}
          </span>
        </span>

        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
          <span className={tone.text}>{statusText}</span>
          {shortModel && (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate font-mono text-[var(--text-tertiary)]" title={row.observedModel}>{shortModel}</span>
            </>
          )}
          {cluster.assignedRole && (
            <span className="ml-auto max-w-[88px] shrink-0 truncate rounded border border-[color-mix(in_srgb,var(--border-subtle)_70%,transparent)] bg-[var(--bg-primary)] px-1 py-0 text-[9.5px] text-[var(--text-secondary)]" title={`角色：${roleLabel(cluster.assignedRole)}`}>
              {roleLabel(cluster.assignedRole)}
            </span>
          )}
        </span>

        {showUnlinkedCreator && creatorLabel && (
          <span
            data-testid="canvas-session-creator"
            className={`truncate text-[10px] font-medium ${parentConflict ? "text-[var(--accent-red)]" : "text-[var(--accent-orange)]"}`}
          >
            {creatorLabel}
          </span>
        )}

        <SessionFleetStats sessionId={row.sessionId} status={row.status} visible={visible} />

        {cluster.workflowDuty && (
          <div className="research-fleet-box truncate text-[10px] text-[var(--text-secondary)]" title={cluster.workflowDuty}>
            {cluster.workflowDuty}
          </div>
        )}

        <div className={`research-fleet-footer text-[9.5px] ${onRemoveSession && row.sessionId ? "pr-12" : ""}`}>
          <span data-testid="canvas-session-origin" className={`shrink-0 rounded border px-1 py-0 text-[9px] font-medium ${originTint(origin)}`}>
            {originGlyph(origin)}
          </span>
          {delegatedCount > 0 && (
            <span className="rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0 font-medium text-[var(--accent-blue)]">
              Multi-Agent ×{delegatedCount}
            </span>
          )}
          <span className="rounded border border-purple-500/20 bg-purple-500/10 px-1.5 py-0 font-medium text-[var(--accent-purple-text)]">
            Subagent ×{cluster.childSubs.length}{liveSubCount > 0 ? ` (${liveSubCount} running)` : ""}
          </span>
        </div>
      </button>
      {onRemoveSession && row.sessionId && <button type="button" className="research-fleet-remove win11-btn absolute right-2 bottom-1.5 z-10 px-1.5 py-0.5 text-[10px]"
        disabled={removalPending}
        aria-label={`从当前批次移除 ${cluster.title}`} onClick={() => onRemoveSession(row.sessionId!, cluster.title)}>移除</button>}
      </div>
      </div>
    );
  };

  const minimapNodes = useMemo(() => {
    if (detail) return [detail.parent, ...detail.children, ...(expandedRoleGroup ? detail.executions : [])];
    return overview.nodes;
  }, [detail, expandedRoleGroup, overview.nodes]);

  const miniW = 136, miniH = 82;
  const miniScale = Math.min((miniW - 8) / Math.max(1, scene.width), (miniH - 8) / Math.max(1, scene.height));

  return (
    <section className="research-agent-canvas overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]" aria-label="Agent 协作拓扑画布">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
          <Icon path={mdiAccountGroup} size={0.6} className="shrink-0 text-[var(--accent-text)]" />
          {tenureTitle && (
            <>
              <span className="truncate">{tenureTitle}</span>
              <span aria-hidden="true" className="text-[var(--text-tertiary)]">/</span>
            </>
          )}
          <span className="shrink-0">{focused ? `${focused.title} · Subagent` : overviewTitle}</span>
          {tenureBadge && (
            <span className={`shrink-0 rounded-full border px-2 py-0 text-[10.5px] font-medium ${
              tenureBadge === "当前"
                ? "border-[var(--accent-primary)]/40 bg-[var(--accent-soft)] text-[var(--accent-text)]"
                : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            }`}>
              {tenureBadge}
            </span>
          )}
          <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-normal text-[var(--text-secondary)]">
            {focused
              ? `Subagent ${focused.childRoleGroups.length} 类 · ${focused.childSubs.length} 次`
              : `Multi-Agent ${query.trim() || hideEndedActive ? `${orderedClusters.length}/${clusters.length}` : clusters.length} · Subagent ${totalSubagents}`}
          </span>
        </div>
        {!focused && <input type="search" aria-label="搜索会话" placeholder="过滤节点或任务…" value={query}
          onChange={event => { setQuery(event.target.value); focusSession(null); }}
          className="min-w-[120px] flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] sm:max-w-[170px]" />}
        <div className="flex flex-wrap items-center gap-1">
          {!focused && endedCount > 0 && endedCount < clusters.length && (
            <button
              type="button"
              aria-pressed={hideEnded}
              onClick={() => setHideEnded(value => !value)}
              className={`win11-btn px-2 py-1 text-[11px] ${hideEnded ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-text)]" : ""}`}
            >
              隐藏已结束 ({endedCount})
            </button>
          )}
          {focused && <button type="button" onClick={() => { focusSession(null); setQuery(""); }} className="win11-btn px-2 py-1 text-[11px]" aria-label="返回全部会话"><Icon path={mdiArrowLeft} size={0.55} /><span>全部会话</span></button>}
          {creator && <button type="button" onClick={() => { setQuery(""); focusSession(creator.sessionExec.id); }} className="win11-btn max-w-[220px] px-2 py-1 text-[11px]" aria-label={`返回创建者 ${creator.title}`}><Icon path={mdiArrowLeft} size={0.55} /><span className="truncate">创建者：{creator.title}</span></button>}
          {expandedRoleGroup && <button type="button" onClick={collapseExpansion} className="win11-btn px-2 py-1 text-[11px]" aria-label="收起执行卡片">收起展开</button>}
          {focused && pageCount > 1 && <div className="inline-flex items-center gap-1 rounded-md border border-[var(--border-primary)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">
            <button type="button" aria-label="上一组角色" disabled={page === 0} onClick={() => { setExpandedGroupKey(null); setRolePage(page - 1); }} className="rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] disabled:opacity-40">‹</button>
            <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, focused.childRoleGroups.length)} / {focused.childRoleGroups.length}</span>
            <button type="button" aria-label="下一组角色" disabled={page >= pageCount - 1} onClick={() => { setExpandedGroupKey(null); setRolePage(page + 1); }} className="rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] disabled:opacity-40">›</button>
          </div>}
          {!focused ? (
            <details className="relative">
              <summary className="win11-btn list-none cursor-pointer px-2 py-1 text-[11px]" aria-label="连线图例">图例</summary>
              <div className="absolute right-0 top-[calc(100%+4px)] z-20 flex w-56 flex-col gap-1.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2.5 text-[11px] text-[var(--text-secondary)] shadow-md">
                <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="w-4 border-t-2 border-[var(--accent-blue)]" />Multi-Agent 派发关系</span>
                <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="w-4 border-t-2 border-dashed border-[var(--accent-green)]" />节点运行中</span>
                <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="w-4 border-t-2 border-dashed border-[var(--accent-purple)]" />Subagent 子代理执行</span>
                {relations.some(relation => relation.kind === "handoff") && (
                  <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="w-4 border-t border-dashed border-[var(--accent-orange)]" />任务交接</span>
                )}
              </div>
            </details>
          ) : (
            <button type="button" onClick={() => onAgent(focused.roleObj, focused.sessionExec)} className="win11-btn px-2 py-1 text-[11px] text-[var(--accent-text)]">
              <Icon path={mdiOpenInNew} size={0.5} /><span>详情与纠偏</span>
            </button>
          )}
        </div>
      </div>

      <div
        ref={viewportRef} data-testid="research-canvas-viewport" data-scale={view.scale.toFixed(3)}
        role="region" aria-label="Agent 调度拓扑画布" tabIndex={0}
        onKeyDown={onCanvasKey} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        className={`relative h-[min(64vh,640px)] min-h-[440px] overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ touchAction: "none", backgroundColor: "var(--bg-primary)", backgroundImage: "radial-gradient(color-mix(in srgb, var(--border-secondary) 42%, transparent) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
      >
        <div className="research-canvas-scene" style={{ transition: dragging ? "none" : undefined, position: "absolute", left: 0, top: 0, width: scene.width, height: scene.height, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
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
            </defs>
            {detail && focused ? detail.children.map((child, idx) => {
              const roleGroup = visibleRoles[idx];
              const live = roleGroup?.executions.some(ex => !(stale && ex.source === "observation") && isLive(ex.status));
              return (
                <path
                  key={child.id}
                  d={detail.direction === "vertical"
                    ? verticalBranch(detail.parent, child)
                    : smoothStepPath(detail.parent.x + detail.parent.width, detail.parent.y + detail.parent.height / 2, child.x - 3, child.y + child.height / 2)}
                  fill="none"
                  stroke="var(--accent-purple)"
                  strokeWidth="2"
                  strokeDasharray="6 4"
                  strokeLinejoin="round"
                  markerEnd={`url(#${canvasId}-arrow-purple)`}
                  className={live ? "research-fleet-edge-animated" : undefined}
                  opacity={live ? 0.95 : 0.7}
                />
              );
            }) : hub && overview.nodes.filter(node => !node.parentId).map(node => (
              <path key={node.id} d={smoothStepPath(hub.x + hub.width / 2, hub.y + hub.height, node.x + node.width / 2, node.y)} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeDasharray="5 6" opacity="0.32" />
            ))}
            {!detail && overview.nodes.filter(node => node.parentId).map(node => {
              const parent = overviewById.get(node.parentId!)!;
              const childCluster = clusterById.get(node.id);
              const liveChild = childCluster && !(stale && childCluster.sessionExec.source === "observation") && isLive(childCluster.sessionExec.status);
              const branch = horizontalTree
                ? busBranchPath(parent, node)
                : `M ${parent.x + 12} ${parent.y + parent.height} V ${node.y + node.height / 2} H ${node.x - 3}`;
              return <g key={`parent-${node.id}`} data-testid="canvas-parent-edge">
                <path data-testid="canvas-relation-edge" d={branch}
                  fill="none" stroke={liveChild ? "var(--accent-green)" : "var(--accent-blue)"} strokeWidth="2" strokeLinejoin="round"
                  className={liveChild ? "research-fleet-edge-animated" : undefined}
                  markerEnd={`url(#${canvasId}-${liveChild ? "arrow-green" : "arrow-blue"})`} opacity={liveChild ? 0.95 : 0.8} />
              </g>;
            })}
            {!detail && relations.filter(relation => relation.kind === "handoff" || sessionParents.get(relation.toExecutionId) !== relation.fromExecutionId).map(relation => {
              const from = overviewById.get(relation.fromExecutionId);
              const to = overviewById.get(relation.toExecutionId);
              if (!from || !to) return null;
              return <path key={relation.id} data-testid="canvas-relation-edge"
                d={smoothStepPath(from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2)}
                fill="none" stroke="var(--accent-orange)" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.65" />;
            })}
            {detail && expandedRoleGroup && detail.executions.map(node => {
              const source = detail.children.find(child => child.id === expandedRoleGroup.roleName)!;
              return <path key={`run-${node.id}`} d={detail.direction === "vertical" ? verticalBranch(source, node)
                : smoothStepPath(source.x + source.width, source.y + source.height / 2, node.x, node.y + node.height / 2)}
                fill="none" stroke="var(--accent-purple)" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />;
            })}
          </svg>
          {!detail && hub && (
            <div style={nodeStyle(hub)} className="win11-card-subtle flex flex-col items-center justify-center rounded-xl border border-[var(--border-secondary)] text-center shadow-sm">
              <span className="text-xs font-semibold text-[var(--text-primary)]">协作工作区</span>
              <span className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">{filteredClusters.length} 个会话</span>
            </div>
          )}
          {detail && focused ? parentNode(detail.parent, focused, true) : overview.nodes.map(node => parentNode(node, clusterById.get(node.id)!, false))}
          {detail && focused && detail.children.map((node, index) => {
            const group = visibleRoles[index];
            const current = group.latest;
            const summary = (current.prompt ?? current.summary ?? "").replace(/^Task:\s*/i, "").replace(/\s+/g, " ").trim();
            const hasMultiple = group.executions.length > 1;
            const isExpanded = expandedRoleGroup?.roleName === group.roleName;
            const roleLive = group.executions.some(ex => !(stale && ex.source === "observation") && isLive(ex.status));
            const shortModel = shortModelName(current.observedModel);

            return (
              <div key={node.id} style={nodeStyle(node)} className="research-canvas-position relative group">
                {hasMultiple && !isExpanded && (
                  <>
                    {group.executions.length > 2 && (
                      <div
                        className="absolute inset-0 translate-x-2 translate-y-2 rounded-[10px] border border-dashed border-[var(--accent-purple)]/40 bg-[var(--bg-secondary)] pointer-events-none"
                        style={{ zIndex: 0, opacity: 0.55 }}
                      />
                    )}
                    <div
                      className="absolute inset-0 translate-x-1 translate-y-1 rounded-[10px] border border-dashed border-[var(--accent-purple)]/60 bg-[var(--bg-secondary)] pointer-events-none"
                      style={{ zIndex: 1, opacity: 0.8 }}
                    />
                  </>
                )}

                <button
                  type="button"
                  data-testid="canvas-role-node"
                  ref={element => { if (element) roleButtonRefs.current.set(group.roleName, element); else roleButtonRefs.current.delete(group.roleName); }}
                  aria-label={hasMultiple ? `${isExpanded ? "收起" : "展开"} ${roleLabel(group.roleName)} 的 ${group.executions.length} 次 Subagent 执行` : `查看 ${roleLabel(group.roleName)} 详情`}
                  aria-expanded={hasMultiple ? isExpanded : undefined}
                  aria-controls={hasMultiple ? executionGroupId(group.roleName) : undefined}
                  onFocus={() => revealNode(node)}
                  onClick={() => {
                    if (hasMultiple) {
                      setExpandedGroupKey(isExpanded ? null : { sessionId: focused.sessionExec.id, roleName: group.roleName });
                    } else {
                      onAgent(group.roleObj, current);
                    }
                  }}
                  className={`relative z-10 h-full w-full research-fleet-card research-fleet-card--subagent focus-ring cursor-pointer ${
                    roleLive
                      ? "border-l-[var(--accent-green)]"
                      : "border-l-[var(--accent-purple)]"
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
                        <span className="min-w-0 truncate font-mono text-[var(--text-tertiary)]" title={current.observedModel}>{shortModel}</span>
                      </>
                    )}
                  </span>

                  <SubagentRoleFleetStats
                    parentSessionId={focused.sessionExec.sessionId}
                    parentStatus={focused.sessionExec.status}
                    roleName={group.roleName}
                    fallbackCount={group.executions.length}
                    visible={visible}
                  />

                  <div className="research-fleet-box flex items-center justify-between gap-2 text-[10px]">
                    <span className="min-w-0 truncate text-[var(--text-secondary)]" title={summary}>
                      {summary || "无任务摘要"}
                    </span>
                    {hasMultiple && (
                      <span className="shrink-0 font-medium text-[var(--accent-purple)]">
                        {isExpanded ? "收起 ▴" : "展开 ▾"}
                      </span>
                    )}
                  </div>
                </button>
              </div>
            );
          })}
          {detail && focused && visibleRoles.filter(group => group.executions.length > 1).map(group => {
            const isExpanded = expandedRoleGroup?.roleName === group.roleName;
            const source = detail.children.find(node => node.id === group.roleName)!;
            return <div key={`rounds-${group.roleName}`} id={executionGroupId(group.roleName)} aria-hidden={!isExpanded}>
              {group.executions.map((execution, roundIndex) => {
                const destination = isExpanded ? detail.executions.find(node => node.id === execution.id) : undefined;
                const node = destination ?? { ...source, id: execution.id, height: 154 };
                const round = group.executions.length - roundIndex;
                const live = !(stale && execution.source === "observation") && isLive(execution.status);
                const task = (execution.prompt ?? execution.summary ?? execution.output ?? "").replace(/^Task:\s*/i, "").replace(/\s+/g, " ").trim();
                const shortModel = shortModelName(execution.observedModel);
                return <button key={execution.id} type="button" data-testid="canvas-execution-node" data-expanded={isExpanded}
                  aria-label={`查看 ${roleLabel(group.roleName)} 第 ${round} 次详情`} tabIndex={isExpanded ? 0 : -1}
                  style={nodeStyle(node)} onFocus={() => revealNode(node)} onClick={() => onAgent(group.roleObj, execution)}
                  className={`research-canvas-execution research-fleet-card research-fleet-card--subagent focus-ring ${live ? "border-l-[var(--accent-green)]" : "border-l-[var(--accent-purple)]"}`}>
                  <span className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-semibold text-[var(--text-primary)]">#{round}{roundIndex === 0 ? " 最新" : ""}</span>
                    <span className={`truncate text-[10px] ${canvasStatusTone(execution.status, live, false).text}`}>{canvasStatusLabel(execution.status, live, stale && execution.source === "observation", statusLabel)}</span>
                  </span>
                  {shortModel && <span className="truncate font-mono text-[9.5px] text-[var(--text-tertiary)]" title={execution.observedModel}>{shortModel}</span>}
                  <div className="research-fleet-box">
                    <span className="line-clamp-2 text-[10.5px] leading-snug text-[var(--text-secondary)]" title={task}>{task || "点击查看详细输出"}</span>
                  </div>
                  <span className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="text-[var(--text-tertiary)]">{execution.startedAt ? new Date(execution.startedAt).toLocaleTimeString() : "时间未记录"}</span>
                    <span className="font-medium text-[var(--accent-text)]">详情 →</span>
                  </span>
                </button>;
              })}
            </div>;
          })}
        </div>

        {/* Bottom-left floating Fleet zoom controls */}
        <div className="research-fleet-controls" role="group" aria-label="画布缩放控制">
          <button type="button" onClick={() => zoom(1 / 1.25)} aria-label="缩小画布" title="缩小"><Icon path={mdiMagnifyMinusOutline} size={0.62} /></button>
          <span data-testid="research-canvas-zoom" className="w-10 text-center font-mono text-[10px] text-[var(--text-secondary)]" aria-label={`缩放 ${Math.round(view.scale * 100)}%`}>{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoom(1.25)} aria-label="放大画布" title="放大"><Icon path={mdiMagnifyPlusOutline} size={0.62} /></button>
          <button type="button" onClick={fit} aria-label="适应画布" title="适应画布"><Icon path={mdiArrowExpandAll} size={0.62} /></button>
          <button type="button" onClick={fitContent} aria-label="适应全部节点" title="缩放并居中显示全部 agent"><Icon path={mdiFitToPageOutline} size={0.62} /></button>
        </div>

        {/* Bottom-right compact SVG minimap */}
        {minimapNodes.length > 0 && (
          <svg className="research-fleet-minimap hidden sm:block" width={miniW} height={miniH} aria-hidden="true">
            {minimapNodes.map(node => {
              const cluster = clusterById.get(node.id);
              const live = cluster && !(stale && cluster.sessionExec.source === "observation") && isLive(cluster.sessionExec.status);
              const fill = cluster
                ? (live ? "var(--accent-green)" : cluster.isCaptain ? "var(--accent-orange)" : "var(--accent-blue)")
                : "var(--accent-purple)";
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

        {!focused && filteredClusters.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-tertiary)]">没有匹配的节点</div>}
        {focused && focused.childRoleGroups.length === 0 && (
          <div className="absolute right-3 top-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">该会话暂无 Subagent 执行记录</div>
        )}
      </div>

      {focused && delegatedSessions.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-primary)] px-3 py-2 text-[10px] text-[var(--text-secondary)]">
        <span>派发的 Multi-Agent：</span>{delegatedSessions.map(child => <button type="button" key={child.sessionExec.id}
          className="max-w-[220px] truncate rounded-md border border-[var(--border-primary)] px-2 py-0.5 text-[var(--accent-text)] hover:bg-[var(--bg-hover)] focus-ring"
          onClick={() => { setQuery(""); focusSession(child.sessionExec.id); }}>{child.title}</button>)}
      </div>}
      <span className="sr-only" aria-live="polite">{expandedRoleGroup ? `${roleLabel(expandedRoleGroup.roleName)} 的 ${expandedRoleGroup.executions.length} 次 Subagent 执行已在画布展开。按 Escape 收起。` : ""}</span>
    </section>
  );
}
