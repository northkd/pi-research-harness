import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiAccountGroup, mdiArrowLeft, mdiArrowExpandAll, mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew } from "@mdi/js";
import type { ConfiguredRole, ResearchExecution, ResearchExecutionOriginKind } from "./research-projection.js";
import type { ResearchWorkbenchRelation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { getMemberArt, leadArt } from "./agent-teams-artwork.js";
import { fitGraph, layoutFocusedSession, layoutSessionHierarchy, resolveSessionParents, zoomGraphAt, type CanvasNode, type CanvasView } from "./research-agent-canvas-layout.js";

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
}

const originTint = (origin?: ResearchExecutionOriginKind) =>
  origin === "lead-agent-created"
    ? "border-purple-500/40 bg-purple-500/10 text-[var(--text-secondary)]"
    : origin === "workflow-created"
    ? "border-amber-500/40 bg-amber-500/10 text-[var(--text-secondary)]"
    : "border-sky-500/40 bg-sky-500/10 text-[var(--text-secondary)]";
const originGlyph = (origin?: ResearchExecutionOriginKind) =>
  origin === "lead-agent-created" ? "🧭 Agent 创建" : origin === "workflow-created" ? "⚡ 工作流创建" : "👤 我创建的";

const nodeStyle = (node: CanvasNode) => ({ position: "absolute" as const, left: node.x, top: node.y, width: node.width, height: node.height });
const curve = (fromX: number, fromY: number, toX: number, toY: number) => {
  const middle = (fromX + toX) / 2;
  return `M ${fromX} ${fromY} C ${middle} ${fromY}, ${middle} ${toY}, ${toX} ${toY}`;
};
const verticalBranch = (parent: CanvasNode, child: CanvasNode) =>
  `M ${parent.x} ${parent.y + parent.height / 2} H 12 V ${child.y + child.height / 2} H ${child.x}`;
const isLive = (status: string) => ["streaming", "started", "running"].includes(status);

/** A read-only map of recorded sessions and their observed child roles. */
export function ResearchAgentCanvas({ clusters, stale, relations = [], onAgent, statusLabel, roleLabel, visible = true }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const roleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const canvasId = useId().replaceAll(":", "");
  const executionGroupId = (roleName: string) => `${canvasId}-rounds-${encodeURIComponent(roleName)}`;
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState<{ sessionId: string; roleName: string } | null>(null);
  const [query, setQuery] = useState("");
  const [rolePage, setRolePage] = useState(0);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 });
  const filteredClusters = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? clusters.filter(cluster => [cluster.title, cluster.sessionExec.id, cluster.sessionExec.prompt, cluster.sessionExec.summary]
      .some(value => value?.toLocaleLowerCase().includes(term))) : clusters;
  }, [clusters, query]);
  const focused = filteredClusters.find(cluster => cluster.sessionExec.id === focusedId);
  const pageSize = 4;
  const pageCount = Math.max(1, Math.ceil((focused?.childRoleGroups.length ?? 0) / pageSize));
  const page = Math.min(rolePage, pageCount - 1);
  const visibleRoles = focused?.childRoleGroups.slice(page * pageSize, (page + 1) * pageSize) ?? [];
  const expandedRoleGroup = focused?.sessionExec.id === expandedGroupKey?.sessionId
    ? visibleRoles.find(group => group.roleName === expandedGroupKey?.roleName) : undefined;
  const sessionParents = useMemo(() => resolveSessionParents(clusters.map(cluster => cluster.sessionExec.id), [
    ...relations,
    ...clusters.flatMap(cluster => cluster.sessionExec.parentExecutionId
      ? [{ fromExecutionId: cluster.sessionExec.parentExecutionId, toExecutionId: cluster.sessionExec.id, kind: "dispatch" }] : []),
  ]), [clusters, relations]);
  const clusterById = useMemo(() => new Map(clusters.map(cluster => [cluster.sessionExec.id, cluster])), [clusters]);
  const overview = useMemo(() => layoutSessionHierarchy(filteredClusters.map(cluster => cluster.sessionExec.id), sessionParents, size.width), [filteredClusters, sessionParents, size.width]);
  const detail = useMemo(() => focused ? layoutFocusedSession(focused.sessionExec.id, visibleRoles.map(group => group.roleName), size.width,
    expandedRoleGroup ? { roleId: expandedRoleGroup.roleName, executionIds: expandedRoleGroup.executions.map(execution => execution.id) } : undefined)
    : null, [focused, page, size.width, expandedRoleGroup]);
  const scene = detail ?? overview;
  const sceneKey = JSON.stringify([focused?.sessionExec.id ?? null, filteredClusters.map(c => c.sessionExec.id), [...sessionParents], visibleRoles.map(g => g.roleName), expandedRoleGroup?.executions.map(execution => execution.id)]);
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

  // Keep the user's pan/zoom while live status updates arrive; refit only when the topology changes.
  useLayoutEffect(() => {
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
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView(previous => ({ ...previous, x: drag.startX + event.clientX - drag.x, y: drag.startY + event.clientY - drag.y }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const parentNode = (node: CanvasNode, cluster: CanvasSessionCluster, inFocus: boolean) => {
    const row = cluster.sessionExec;
    const liveNode = !(stale && row.source === "observation") && isLive(row.status);
    const parentId = sessionParents.get(row.id);
    const parent = parentId && clusterById.get(parentId);
    const recordedCreator = !!row.parentExecutionId || relations.some(relation => relation.kind === "dispatch" && relation.toExecutionId === row.id);
    const isAgentCreated = !!parentId || recordedCreator || cluster.origin === "lead-agent-created";
    const creatorLabel = parent ? parent.title : isAgentCreated
      ? (cluster.creatorLabel && !["用户", "父会话", "主agent"].includes(cluster.creatorLabel) ? `${cluster.creatorLabel}（未载入）` : "父会话未载入")
      : cluster.creatorLabel;
    let depth = 0, ancestor = parentId;
    while (ancestor) { depth += 1; ancestor = sessionParents.get(ancestor); }
    return (
      <button
        key={node.id} type="button" data-testid="canvas-session-node" data-parent-id={parentId ?? undefined} data-depth={depth}
        aria-label={inFocus ? `查看 ${cluster.title} 会话详情` : `聚焦${cluster.title}`}
        onClick={() => { if (inFocus) onAgent(cluster.roleObj, row); else focusSession(row.id); }}
        onFocus={() => revealNode(node)}
        style={nodeStyle(node)}
        className={`research-canvas-position win11-card-interactive focus-ring flex cursor-pointer flex-col justify-between overflow-hidden border-l-[3px] p-3 text-left shadow-sm transition-all ${
          liveNode
            ? "border-l-[var(--accent-green)]"
            : cluster.isCaptain
            ? "border-l-[var(--accent-orange)]"
            : "border-l-[var(--accent-blue)]"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <div className="relative shrink-0">
            <img src={cluster.isCaptain ? leadArt : getMemberArt(cluster.title, false)} alt="" className="h-8 w-8 shrink-0 object-contain" />
          </div>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-bold text-[var(--text-primary)]" title={cluster.title}>{cluster.title}</span>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className={`font-semibold ${cluster.isCaptain ? "text-[var(--accent-orange)]" : "text-[var(--accent-blue)]"}`}>
                {cluster.isCaptain ? (depth ? `主 Agent · 第 ${depth} 层` : "主 Agent") : parentId ? `第 ${depth} 层协作` : isAgentCreated ? "派生协作会话" : "协作会话"}
              </span>
              <span className={`rounded px-1.5 py-0.2 border text-[9.5px] font-medium ${originTint(isAgentCreated ? "lead-agent-created" : cluster.origin)}`}>
                {originGlyph(isAgentCreated ? "lead-agent-created" : cluster.origin)}
              </span>
              {cluster.assignedRole && (
                <span className="rounded px-1.5 py-0.2 border border-[var(--border-primary)] text-[9.5px] text-[var(--text-secondary)]">
                  角色：{roleLabel(cluster.assignedRole)}
                </span>
              )}
            </div>
          </span>
        </span>
        <span className="block truncate text-[10px] text-[var(--text-secondary)]" title={[creatorLabel && `创建者：${creatorLabel}`, cluster.workflowDuty].filter(Boolean).join(" · ") || cluster.title}>
          {creatorLabel && isAgentCreated ? `创建者：${creatorLabel} · ` : ""}
          {cluster.workflowDuty ?? "暂无已记录的任务职责"}
        </span>
        <span className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-secondary)]">
          {liveNode ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-bold text-emerald-600 dark:text-emerald-400 animate-pulse">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>⚡ 执行中</span>
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-tertiary)]" />
              {stale && row.source === "observation" ? "观测已过期" : row.status === "idle" ? "就绪待命" : statusLabel(row.status)}
            </span>
          )}
          <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 font-semibold text-[var(--accent-text)]">
            {cluster.childSubs.length} 次派发
          </span>
        </span>
      </button>
    );
  };

  return (
    <section className="research-agent-canvas overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]" aria-label="智能体协作画布">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
            <Icon path={mdiAccountGroup} size={0.6} className="text-[var(--accent-text)]" />
            <span>{focused ? "会话与下属角色" : "工作区会话总览"}</span>
            <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-normal text-[var(--text-secondary)]">{focused ? `${focused.childRoleGroups.length} 个角色 · ${focused.childSubs.length} 次派发` : `${query.trim() ? `${filteredClusters.length} / ${clusters.length}` : clusters.length} 个会话`}</span>
          </div>
          <p className="mt-1 text-[10px] text-[var(--text-tertiary)]">拖动空白处平移 · Ctrl / ⌘ + 滚轮缩放 · 点击会话查看下属角色</p>
        </div>
        {!focused && <input type="search" aria-label="搜索会话" placeholder="搜索会话或任务" value={query}
          onChange={event => { setQuery(event.target.value); focusSession(null); }}
          className="min-w-[120px] flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] sm:max-w-[180px]" />}
        <div className="flex flex-wrap items-center gap-1">
          {focused && <button type="button" onClick={() => { focusSession(null); setQuery(""); }} className="win11-btn px-2 py-1 text-[11px]" aria-label="返回全部会话"><Icon path={mdiArrowLeft} size={0.55} /><span>全部会话</span></button>}
          {creator && <button type="button" onClick={() => { setQuery(""); focusSession(creator.sessionExec.id); }} className="win11-btn max-w-[240px] px-2 py-1 text-[11px]" aria-label={`返回创建者 ${creator.title}`}><Icon path={mdiArrowLeft} size={0.55} /><span className="truncate">创建者：{creator.title}</span></button>}
          {expandedRoleGroup && <button type="button" onClick={collapseExpansion} className="win11-btn px-2 py-1 text-[11px]" aria-label="收起执行卡片">收起执行卡片</button>}
          {focused && pageCount > 1 && <div className="inline-flex items-center gap-1 rounded-md border border-[var(--border-primary)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">
            <button type="button" aria-label="上一组角色" disabled={page === 0} onClick={() => { setExpandedGroupKey(null); setRolePage(page - 1); }} className="rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40">‹</button>
            <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, focused.childRoleGroups.length)} / {focused.childRoleGroups.length}</span>
            <button type="button" aria-label="下一组角色" disabled={page >= pageCount - 1} onClick={() => { setExpandedGroupKey(null); setRolePage(page + 1); }} className="rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40">›</button>
          </div>}
          <button type="button" onClick={() => zoom(1 / 1.25)} className="win11-btn p-1.5" aria-label="缩小画布" title="缩小"><Icon path={mdiMagnifyMinusOutline} size={0.65} /></button>
          <span className="w-10 text-center font-mono text-[10px] text-[var(--text-secondary)]" aria-label={`缩放 ${Math.round(view.scale * 100)}%`}>{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoom(1.25)} className="win11-btn p-1.5" aria-label="放大画布" title="放大"><Icon path={mdiMagnifyPlusOutline} size={0.65} /></button>
          <button type="button" onClick={fit} className="win11-btn p-1.5" aria-label="适应画布" title="适应画布"><Icon path={mdiArrowExpandAll} size={0.65} /></button>
        </div>
      </div>
      <div
        ref={viewportRef} data-testid="research-canvas-viewport" data-scale={view.scale.toFixed(3)}
        role="region" aria-label="协作拓扑画布" tabIndex={0}
        onKeyDown={onCanvasKey} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        className={`relative h-[480px] overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)] sm:h-[520px] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ touchAction: "none", backgroundColor: "var(--bg-primary)", backgroundImage: "radial-gradient(var(--border-secondary) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
      >
        <div className="research-canvas-scene" style={{ transition: dragging ? "none" : undefined, position: "absolute", left: 0, top: 0, width: scene.width, height: scene.height, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg aria-hidden="true" width={scene.width} height={scene.height} className="pointer-events-none absolute inset-0 overflow-visible">
            <defs><marker id={`${canvasId}-arrow`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7" fill="none" stroke="var(--accent-purple)" strokeWidth="1.2" /></marker></defs>
            {detail && focused ? detail.children.map(child => (
              <path key={child.id} d={detail.direction === "vertical"
                ? verticalBranch(detail.parent, child)
                : curve(detail.parent.x + detail.parent.width, detail.parent.y + detail.parent.height / 2, child.x, child.y + child.height / 2)} fill="none" stroke="var(--accent-primary)" strokeWidth="2" strokeLinejoin="round" opacity="0.55" />
            )) : overview.nodes.filter(node => !node.parentId).map(node => (
              <path key={node.id} d={curve(overview.hub.x + overview.hub.width / 2, overview.hub.y + overview.hub.height, node.x + node.width / 2, node.y)} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeDasharray="5 6" opacity="0.32" />
            ))}
            {!detail && overview.nodes.filter(node => node.parentId).map(node => {
              const parent = overview.nodes.find(candidate => candidate.id === node.parentId)!;
              return <g key={`parent-${node.id}`} data-testid="canvas-parent-edge">
                <path data-testid="canvas-relation-edge" d={`M ${parent.x + 12} ${parent.y + parent.height} V ${node.y + node.height / 2} H ${node.x - 3}`}
                  fill="none" stroke="var(--accent-purple)" strokeWidth="2" strokeLinejoin="round" markerEnd={`url(#${canvasId}-arrow)`} opacity="0.8" />
              </g>;
            })}
            {!detail && relations.filter(relation => relation.kind === "handoff" || sessionParents.get(relation.toExecutionId) !== relation.fromExecutionId).map(relation => {
              const from = overview.nodes.find(node => node.id === relation.fromExecutionId);
              const to = overview.nodes.find(node => node.id === relation.toExecutionId);
              if (!from || !to) return null;
              return <path key={relation.id} data-testid="canvas-relation-edge"
                d={curve(from.x + from.width, from.y + from.height / 2, to.x + to.width, to.y + to.height / 2)}
                fill="none" stroke="var(--accent-purple)" strokeWidth="1.5" strokeDasharray="4 5" opacity="0.55" />;
            })}
            {detail && expandedRoleGroup && detail.executions.map(node => {
              const source = detail.children.find(child => child.id === expandedRoleGroup.roleName)!;
              return <path key={`run-${node.id}`} d={detail.direction === "vertical" ? verticalBranch(source, node)
                : curve(source.x + source.width, source.y + source.height / 2, node.x, node.y + node.height / 2)}
                fill="none" stroke="var(--accent-purple)" strokeWidth="1.5" opacity="0.5" />;
            })}
          </svg>
          {!detail && (
            <div style={nodeStyle(overview.hub)} className="win11-card-subtle flex flex-col items-center justify-center rounded-xl border border-[var(--border-secondary)] text-center shadow-sm">
              <span className="text-xs font-bold text-[var(--text-primary)]">科研协作工作区</span>
              <span className="mt-1 text-[10px] text-[var(--text-tertiary)]">{filteredClusters.length} 个已记录会话</span>
            </div>
          )}
          {detail && focused ? parentNode(detail.parent, focused, true) : overview.nodes.map(node => parentNode(node, clusterById.get(node.id)!, false))}
          {detail && focused && detail.children.map((node, index) => {
            const group = visibleRoles[index];
            const current = group.latest;
            const summary = (current.prompt ?? current.summary ?? "").replace(/\s+/g, " ").trim();
            const hasMultiple = group.executions.length > 1;
            const isExpanded = expandedRoleGroup?.roleName === group.roleName;
            const roleLive = group.executions.some(ex => !(stale && ex.source === "observation") && isLive(ex.status));

            return (
              <div key={node.id} style={nodeStyle(node)} className="research-canvas-position relative group">
                {/* 3D Overlapping back layers when multiple executions exist */}
                {hasMultiple && !isExpanded && (
                  <>
                    {group.executions.length > 2 && (
                      <div
                        className="absolute inset-0 translate-x-2.5 translate-y-2.5 rounded-xl border border-[var(--accent-purple)]/40 bg-[var(--bg-secondary)] shadow-sm pointer-events-none"
                        style={{ zIndex: 0, opacity: 0.55 }}
                      />
                    )}
                    <div
                      className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-xl border border-[var(--accent-purple)]/60 bg-[var(--bg-secondary)] shadow-sm pointer-events-none"
                      style={{ zIndex: 1, opacity: 0.8 }}
                    />
                  </>
                )}

                {/* Top interactive card */}
                <button
                  type="button"
                  data-testid="canvas-role-node"
                  ref={element => { if (element) roleButtonRefs.current.set(group.roleName, element); else roleButtonRefs.current.delete(group.roleName); }}
                  aria-label={hasMultiple ? `${isExpanded ? "收起" : "展开"} ${roleLabel(group.roleName)} 的 ${group.executions.length} 轮执行` : `查看 ${roleLabel(group.roleName)} 详情`}
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
                  className={`relative z-10 w-full h-full win11-card-interactive focus-ring flex cursor-pointer flex-col justify-between overflow-hidden border-l-[3px] p-3 text-left shadow-sm transition-all ${
                    roleLive
                      ? "border-l-[var(--accent-green)]"
                      : hasMultiple
                      ? "border-l-[var(--accent-purple)] hover:border-l-[var(--accent-primary)] hover:shadow-md"
                      : "border-l-[var(--accent-blue)]"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <img
                      src={getMemberArt(group.roleName, false)}
                      alt=""
                      className="h-7 w-7 shrink-0 object-contain"
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] font-bold text-[var(--text-primary)]"
                      title={roleLabel(group.roleName)}
                    >
                      {roleLabel(group.roleName)}
                    </span>
                    {hasMultiple ? (
                      <span
                        className="shrink-0 rounded-full bg-purple-500/20 border border-purple-500/40 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-purple-text)] shadow-xs"
                        title={`共 ${group.executions.length} 轮执行，${isExpanded ? "点击收起" : "点击在画布中展开"}`}
                      >
                        {isExpanded ? "展开" : "叠"} {group.executions.length} 轮
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--accent-text)]">
                        ×1
                      </span>
                    )}
                  </span>

                  {summary && (
                    <span className="block truncate text-[10px] text-[var(--text-secondary)]" title={summary}>
                      {summary}
                    </span>
                  )}

                  <span className="flex items-center justify-between gap-1 text-[10px] text-[var(--text-secondary)]">
                    {roleLive ? (
                      <span className="inline-flex min-w-0 items-center gap-1 font-bold text-emerald-600 dark:text-emerald-400 animate-pulse">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
                        <span>⚡ 执行中</span>
                      </span>
                    ) : (
                      <span className="truncate text-[10px] text-[var(--text-secondary)]">
                        {stale && current.source === "observation" ? "观测已过期" : statusLabel(current.status)}
                      </span>
                    )}
                    {hasMultiple && (
                      <span className="text-[10px] text-[var(--accent-purple)] font-semibold group-hover:underline flex items-center gap-0.5">
                        {isExpanded ? "点击收起 ▴" : "在画布中展开 ▾"}
                      </span>
                    )}
                  </span>
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
                return <button key={execution.id} type="button" data-testid="canvas-execution-node" data-expanded={isExpanded}
                  aria-label={`查看 ${roleLabel(group.roleName)} 第 ${round} 轮详情`} tabIndex={isExpanded ? 0 : -1}
                  style={nodeStyle(node)} onFocus={() => revealNode(node)} onClick={() => onAgent(group.roleObj, execution)}
                  className={`research-canvas-execution win11-card-interactive focus-ring flex flex-col justify-between overflow-hidden border-l-[3px] p-3 text-left shadow-sm ${live ? "border-l-[var(--accent-green)]" : "border-l-[var(--accent-purple)]"}`}>
                  <span className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-bold text-[var(--text-primary)]">第 {round} 轮{roundIndex === 0 ? " · 最新" : ""}</span>
                    <span className={`truncate text-[10px] ${live ? "font-semibold text-[var(--accent-green-text)]" : "text-[var(--text-secondary)]"}`}>{stale && execution.source === "observation" ? "观测已过期" : statusLabel(execution.status)}</span>
                  </span>
                  {execution.observedModel && <span className="truncate font-mono text-[9px] text-[var(--text-tertiary)]" title={execution.observedModel}>{execution.observedModel}</span>}
                  <span className="line-clamp-3 text-[11px] leading-relaxed text-[var(--text-secondary)]" title={task}>{task || "暂无任务描述，查看详情可访问执行日志与结果"}</span>
                  <span className="flex items-center justify-between gap-2 border-t border-[var(--border-secondary)] pt-1.5 text-[10px]">
                    <span className="text-[var(--text-tertiary)]">{execution.startedAt ? new Date(execution.startedAt).toLocaleTimeString() : "未记录时间"}</span>
                    <span className="font-medium text-[var(--accent-text)]">查看详情 →</span>
                  </span>
                </button>;
              })}
            </div>;
          })}
        </div>
        {!focused && filteredClusters.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-tertiary)]">没有匹配的会话</div>}
        {focused && focused.childRoleGroups.length === 0 && (
          <div className="absolute bottom-3 right-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">该会话暂无已记录的下属任务</div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-primary)] px-3 py-2 text-[10px] text-[var(--text-tertiary)]">
        {!focused && (
          <div aria-label="连线图例" className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="w-4 border-t border-dashed border-[var(--text-tertiary)]" />会话分组</span>
            {sessionParents.size > 0 && <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="w-4 border-t-2 border-[var(--accent-purple)]" />父会话 → 创建的协作会话</span>}
            {relations.some(relation => relation.kind === "handoff") && <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="w-4 border-t border-dashed border-[var(--accent-purple)]" />任务交接</span>}
          </div>
        )}
        {focused && <button type="button" onClick={() => onAgent(focused.roleObj, focused.sessionExec)} className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline"><Icon path={mdiOpenInNew} size={0.5} />会话详情与纠偏</button>}
      </div>

      {focused && delegatedSessions.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-primary)] px-3 py-2 text-[10px] text-[var(--text-secondary)]">
        <span>创建的协作会话：</span>{delegatedSessions.map(child => <button type="button" key={child.sessionExec.id}
          className="max-w-[220px] truncate rounded-md border border-[var(--border-primary)] px-2 py-1 text-[var(--accent-text)] hover:bg-[var(--bg-hover)] focus-ring"
          onClick={() => { setQuery(""); focusSession(child.sessionExec.id); }}>{child.title}</button>)}
      </div>}
      <span className="sr-only" aria-live="polite">{expandedRoleGroup ? `${roleLabel(expandedRoleGroup.roleName)} 的 ${expandedRoleGroup.executions.length} 轮执行已在画布展开。按 Escape 收起。` : ""}</span>
    </section>
  );
}
