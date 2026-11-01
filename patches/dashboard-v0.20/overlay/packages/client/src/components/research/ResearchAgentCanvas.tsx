import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiAccountGroup, mdiArrowLeft, mdiArrowExpandAll, mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew } from "@mdi/js";
import type { ConfiguredRole, ResearchExecution } from "./research-projection.js";
import { getMemberArt, leadArt } from "./agent-teams-artwork.js";
import { fitGraph, layoutFocusedSession, layoutOverview, zoomGraphAt, type CanvasNode, type CanvasView } from "./research-agent-canvas-layout.js";

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
}
interface Props {
  clusters: CanvasSessionCluster[];
  stale: boolean;
  onAgent: (role: ConfiguredRole, execution?: ResearchExecution) => void;
  statusLabel: (status: string) => string;
  roleLabel: (role: string) => string;
}

const nodeStyle = (node: CanvasNode) => ({ position: "absolute" as const, left: node.x, top: node.y, width: node.width, height: node.height });
const curve = (fromX: number, fromY: number, toX: number, toY: number) => {
  const middle = (fromX + toX) / 2;
  return `M ${fromX} ${fromY} C ${middle} ${fromY}, ${middle} ${toY}, ${toX} ${toY}`;
};
const verticalBranch = (parent: CanvasNode, child: CanvasNode) =>
  `M ${parent.x} ${parent.y + parent.height / 2} H 12 V ${child.y + child.height / 2} H ${child.x}`;
const isLive = (status: string) => ["streaming", "started", "running"].includes(status);

/** A read-only map of recorded sessions and their observed child roles. */
export function ResearchAgentCanvas({ clusters, stale, onAgent, statusLabel, roleLabel }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
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
      const width = element.clientWidth || 800, height = element.clientHeight || 520;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

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
    const summary = (row.prompt ?? row.summary ?? "").replace(/\s+/g, " ").trim();
    return (
      <button
        key={node.id} type="button" data-testid="canvas-session-node"
        aria-label={inFocus ? `查看 ${cluster.title} 会话详情` : `聚焦${cluster.title}`}
        onClick={() => { if (inFocus) onAgent(cluster.roleObj, row); else { setRolePage(0); setFocusedId(row.id); } }}
        style={nodeStyle(node)}
        className="win11-card-interactive focus-ring flex cursor-pointer flex-col justify-between overflow-hidden border-l-[3px] border-l-[var(--accent-primary)] p-3 text-left shadow-sm"
      >
        <span className="flex min-w-0 items-center gap-2">
          <img src={cluster.isCaptain ? leadArt : getMemberArt(cluster.title, false)} alt="" className="h-8 w-8 shrink-0 object-contain" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-bold text-[var(--text-primary)]" title={cluster.title}>{cluster.title}</span>
            <span className="mt-0.5 block truncate text-[10px] text-[var(--text-tertiary)]">{cluster.isCaptain ? "主控入口" : "协同会话"} · {row.sessionId?.slice(0, 8) ?? row.id.slice(0, 12)}</span>
          </span>
        </span>
        {summary && <span className="block truncate text-[10px] text-[var(--text-secondary)]" title={summary}>{summary}</span>}
        <span className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-secondary)]">
          <span className="inline-flex min-w-0 items-center gap-1 truncate"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isLive(row.status) ? "bg-[var(--accent-green)]" : "bg-[var(--text-tertiary)]"}`} />{statusLabel(row.status)}{stale && row.source === "observation" ? " · 观测已过期" : ""}</span>
          <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-2 py-1 font-semibold text-[var(--accent-text)]">{cluster.childSubs.length} 次派发</span>
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
            return (
              <button key={node.id} type="button" data-testid="canvas-role-node" aria-label={`查看 ${roleLabel(group.roleName)} 详情`}
                onClick={() => onAgent(group.roleObj, current)} style={nodeStyle(node)}
                className="win11-card-interactive focus-ring flex cursor-pointer flex-col justify-between overflow-hidden border-l-[3px] border-l-[var(--accent-purple)] p-3 text-left shadow-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <img src={getMemberArt(group.roleName, false)} alt="" className="h-7 w-7 shrink-0 object-contain" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-[var(--text-primary)]" title={roleLabel(group.roleName)}>{roleLabel(group.roleName)}</span>
                  <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--accent-text)]">×{group.executions.length}</span>
                </span>
                {summary && <span className="block truncate text-[10px] text-[var(--text-secondary)]" title={summary}>{summary}</span>}
                <span className="truncate text-[10px] text-[var(--text-secondary)]">{statusLabel(current.status)}{stale && current.source === "observation" ? " · 观测已过期" : ""}</span>
              </button>
            );
          })}
        </div>
        {!focused && filteredClusters.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-tertiary)]">没有匹配的会话</div>}
        {focused && focused.childRoleGroups.length === 0 && (
          <div className="absolute bottom-3 right-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">该会话暂无已记录的下属任务</div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-primary)] px-3 py-2 text-[10px] text-[var(--text-tertiary)]">
        <span>{focused ? "实线表示已记录的父子归属；按角色合并多次派发。" : "虚线仅表示工作区分组，不代表会话之间有通信记录。"}</span>
        {focused && <button type="button" onClick={() => onAgent(focused.roleObj, focused.sessionExec)} className="inline-flex items-center gap-1 font-medium text-[var(--accent-text)] hover:underline"><Icon path={mdiOpenInNew} size={0.5} />会话详情与纠偏</button>}
      </div>
    </section>
  );
}
