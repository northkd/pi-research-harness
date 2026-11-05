import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiAccountGroup, mdiArrowLeft, mdiArrowExpandAll, mdiClose, mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew } from "@mdi/js";
import type { ConfiguredRole, ResearchExecution, ResearchExecutionOriginKind } from "./research-projection.js";
import type { ResearchWorkbenchRelation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { getMemberArt, leadArt } from "./agent-teams-artwork.js";
import { fitGraph, layoutFocusedSession, layoutOverview, zoomGraphAt, type CanvasNode, type CanvasView } from "./research-agent-canvas-layout.js";
import { Dialog } from "@blackbelt-technology/pi-dashboard-client-utils/Dialog";

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
  origin === "lead-agent-created" ? "🧭 Lead 创建" : origin === "workflow-created" ? "⚡ 工作流创建" : "👤 我创建的";

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
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState<{ sessionId: string; roleName: string } | null>(null);
  const expandedRoleGroup = expandedGroupKey ? clusters.find(cluster => cluster.sessionExec.id === expandedGroupKey.sessionId)?.childRoleGroups.find(group => group.roleName === expandedGroupKey.roleName) : undefined;
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
  const overview = useMemo(() => layoutOverview(filteredClusters.map(cluster => cluster.sessionExec.id), size.width), [filteredClusters, size.width]);
  const detail = useMemo(() => focused ? layoutFocusedSession(focused.sessionExec.id, visibleRoles.map(group => group.roleName), size.width) : null, [focused, page, size.width]);
  const scene = detail ?? overview;
  const sceneKey = JSON.stringify([focused?.sessionExec.id ?? null, filteredClusters.map(c => c.sessionExec.id), visibleRoles.map(g => g.roleName)]);

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
    return (
      <button
        key={node.id} type="button" data-testid="canvas-session-node"
        aria-label={inFocus ? `查看 ${cluster.title} 会话详情` : `聚焦${cluster.title}`}
        onClick={() => { if (inFocus) onAgent(cluster.roleObj, row); else { setRolePage(0); setFocusedId(row.id); } }}
        style={nodeStyle(node)}
        className={`win11-card-interactive focus-ring flex cursor-pointer flex-col justify-between overflow-hidden border-l-[3px] p-3 text-left shadow-sm transition-all ${
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
                {cluster.isCaptain ? "当前交互入口" : "独立协同会话"}
              </span>
              <span className={`rounded px-1.5 py-0.2 border text-[9.5px] font-medium ${originTint(cluster.origin)}`}>
                {originGlyph(cluster.origin)}
              </span>
              {cluster.assignedRole && (
                <span className="rounded px-1.5 py-0.2 border border-[var(--border-primary)] text-[9.5px] text-[var(--text-secondary)]">
                  角色：{roleLabel(cluster.assignedRole)}
                </span>
              )}
            </div>
          </span>
        </span>
        <span className="block truncate text-[10px] text-[var(--text-secondary)]" title={[cluster.creatorLabel && `创建者：${cluster.creatorLabel}`, cluster.workflowDuty].filter(Boolean).join(" · ") || cluster.title}>
          {cluster.origin === "lead-agent-created" && cluster.creatorLabel ? `创建者：${cluster.creatorLabel} · ` : ""}
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
    <section className="overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]" aria-label="智能体协作画布">
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
          onChange={event => { setQuery(event.target.value); setFocusedId(null); setRolePage(0); }}
          className="min-w-[120px] flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] sm:max-w-[180px]" />}
        <div className="flex flex-wrap items-center gap-1">
          {focused && <button type="button" onClick={() => { setFocusedId(null); setQuery(""); setRolePage(0); }} className="win11-btn px-2 py-1 text-[11px]" aria-label="返回全部会话"><Icon path={mdiArrowLeft} size={0.55} /><span>全部会话</span></button>}
          {focused && pageCount > 1 && <div className="inline-flex items-center gap-1 rounded-md border border-[var(--border-primary)] px-1 py-0.5 text-[10px] text-[var(--text-secondary)]">
            <button type="button" aria-label="上一组角色" disabled={page === 0} onClick={() => setRolePage(page - 1)} className="rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40">‹</button>
            <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, focused.childRoleGroups.length)} / {focused.childRoleGroups.length}</span>
            <button type="button" aria-label="下一组角色" disabled={page >= pageCount - 1} onClick={() => setRolePage(page + 1)} className="rounded px-1.5 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40">›</button>
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
        <div style={{ position: "absolute", left: 0, top: 0, width: scene.width, height: scene.height, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg aria-hidden="true" width={scene.width} height={scene.height} className="pointer-events-none absolute inset-0 overflow-visible">
            {detail && focused ? detail.children.map(child => (
              <path key={child.id} d={detail.direction === "vertical"
                ? verticalBranch(detail.parent, child)
                : curve(detail.parent.x + detail.parent.width, detail.parent.y + detail.parent.height / 2, child.x, child.y + child.height / 2)} fill="none" stroke="var(--accent-primary)" strokeWidth="2" strokeLinejoin="round" opacity="0.55" />
            )) : overview.nodes.map(node => (
              <path key={node.id} d={curve(overview.hub.x + overview.hub.width / 2, overview.hub.y + overview.hub.height, node.x + node.width / 2, node.y)} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeDasharray="5 6" opacity="0.32" />
            ))}
            {!detail && relations.map(relation => {
              const from = overview.nodes.find(node => node.id === relation.fromExecutionId);
              const to = overview.nodes.find(node => node.id === relation.toExecutionId);
              if (!from || !to) return null;
              return (
                <path
                  key={relation.id}
                  data-testid="canvas-relation-edge"
                  d={curve(from.x + from.width / 2, from.y + from.height, to.x + to.width / 2, to.y)}
                  fill="none" stroke="var(--accent-purple)" strokeWidth="2" strokeDasharray="4 5" opacity="0.7"
                />
              );
            })}
          </svg>
          {!detail && (
            <div style={nodeStyle(overview.hub)} className="win11-card-subtle flex flex-col items-center justify-center rounded-xl border border-[var(--border-secondary)] text-center shadow-sm">
              <span className="text-xs font-bold text-[var(--text-primary)]">科研协作工作区</span>
              <span className="mt-1 text-[10px] text-[var(--text-tertiary)]">{filteredClusters.length} 个已记录会话</span>
            </div>
          )}
          {detail && focused ? parentNode(detail.parent, focused, true) : overview.nodes.map((node, index) => parentNode(node, filteredClusters[index], false))}
          {detail && focused && detail.children.map((node, index) => {
            const group = visibleRoles[index];
            const current = group.latest;
            const summary = (current.prompt ?? current.summary ?? "").replace(/\s+/g, " ").trim();
            const hasMultiple = group.executions.length > 1;
            const roleLive = group.executions.some(ex => !(stale && ex.source === "observation") && isLive(ex.status));

            return (
              <div key={node.id} style={nodeStyle(node)} className="relative group">
                {/* 3D Overlapping back layers when multiple executions exist */}
                {hasMultiple && (
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
                  aria-label={`查看 ${roleLabel(group.roleName)} 详情`}
                  onClick={() => {
                    if (hasMultiple) {
                      setExpandedGroupKey({ sessionId: focused.sessionExec.id, roleName: group.roleName });
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
                        className="shrink-0 rounded-full bg-purple-500/20 border border-purple-500/40 px-2 py-0.5 text-[10px] font-semibold text-purple-300 shadow-xs"
                        title={`共 ${group.executions.length} 轮独立执行，点击平铺展开各轮卡片`}
                      >
                        📚 叠 {group.executions.length} 轮
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
                        点击平铺展开 ▾
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
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
            {relations.length > 0 && <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="w-4 border-t-2 border-dashed border-[var(--accent-purple)]" />已记录的派发 / 交接关系</span>}
          </div>
        )}
        {focused && <button type="button" onClick={() => onAgent(focused.roleObj, focused.sessionExec)} className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline"><Icon path={mdiOpenInNew} size={0.5} />会话详情与纠偏</button>}
      </div>

      {/* 铺开各轮独立执行卡片的轻量级弹层 (Spread Out Execution Cards) */}
      {expandedRoleGroup && (
        <Dialog open={visible} onClose={() => setExpandedGroupKey(null)} size="full" flush ariaLabel={`${roleLabel(expandedRoleGroup.roleName)} 的执行轮次`}>
          <div
            className="win11-card w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl border border-[var(--border-strong)] bg-[var(--bg-primary)] rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-3.5 bg-[var(--bg-secondary)]">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={getMemberArt(expandedRoleGroup.roleName, false)}
                  alt=""
                  className="h-8 w-8 object-contain shrink-0"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-[var(--text-primary)] truncate">
                      {roleLabel(expandedRoleGroup.roleName)}
                    </h3>
                    <span className="rounded-full bg-purple-500/20 border border-purple-500/50 px-2.5 py-0.5 text-[10.5px] font-semibold text-purple-300">
                      已平铺展开全部 {expandedRoleGroup.executions.length} 轮独立执行
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                    直接点击下方对应轮次的任务卡片，即可进入该轮的独立工作流详情与实时纠偏
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExpandedGroupKey(null)}
                className="win11-btn px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 rounded-lg"
              >
                <Icon path={mdiClose} size={0.7} />
                <span>收起卡片</span>
              </button>
            </div>

            {/* Body: Grid of all execution run cards */}
            <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-3.5 bg-[var(--bg-canvas)]">
              {expandedRoleGroup.executions.map((ex, roundIdx) => {
                const roundNumber = expandedRoleGroup.executions.length - roundIdx;
                const isLatest = roundIdx === 0;
                const execLive = !(stale && ex.source === "observation") && isLive(ex.status);
                const taskSnippet = (ex.prompt ?? ex.output ?? "")
                  .replace(/^Task:\s*/i, "")
                  .replace(/\s+/g, " ")
                  .trim();

                return (
                  <button type="button"
                    key={ex.id}
                    onClick={() => {
                      const targetEx = ex;
                      setExpandedGroupKey(null);
                      onAgent(expandedRoleGroup.roleObj, targetEx);
                    }}
                    className={`win11-card-interactive cursor-pointer flex flex-col justify-between p-4 rounded-xl border text-left transition-all ${
                      execLive
                        ? "border-[var(--accent-green)] bg-[var(--bg-primary)]"
                        : "border-[var(--border-primary)] hover:border-[var(--accent-primary)] hover:shadow-md bg-[var(--bg-primary)]"
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-bold text-[var(--text-primary)]">
                            第 {roundNumber} 轮执行{isLatest ? " (最新)" : ""}
                          </span>
                          {ex.id && (
                            <span className="font-mono text-[9.5px] text-[var(--text-tertiary)] opacity-70">
                              ({ex.id.slice(0, 8)})
                            </span>
                          )}
                        </div>
                        {execLive ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 border border-emerald-500/60 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 animate-pulse">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
                            <span>⚡ 正在执行中</span>
                          </span>
                        ) : (
                          <span className="rounded bg-[var(--bg-secondary)] border border-[var(--border-secondary)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">
                            {stale && ex.source === "observation" ? "观测已过期" : statusLabel(ex.status)}
                          </span>
                        )}
                      </div>

                      {ex.observedModel && (
                        <div className="text-[10px] font-mono text-[var(--text-tertiary)] mb-1.5 truncate">
                          🤖 {ex.observedModel}
                        </div>
                      )}

                      <div className="text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-3 mb-3">
                        {taskSnippet || "暂无具体任务描述，点击查看详细执行日志与结果"}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[var(--border-secondary)] flex items-center justify-between text-[10.5px]">
                      <span className="text-[var(--text-tertiary)]">
                        {ex.startedAt ? new Date(ex.startedAt).toLocaleTimeString() : "未记录时间"}
                      </span>
                      <span className="font-medium text-[var(--accent-text)] flex items-center gap-1">
                        进入此轮详情 <span>→</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
