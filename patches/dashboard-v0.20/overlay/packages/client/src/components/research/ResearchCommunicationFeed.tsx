import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@mdi/react";
import { mdiArrowDown, mdiClose, mdiCrosshairsGps, mdiForumOutline, mdiOpenInNew } from "@mdi/js";
import type { CollaborationCommunicationItem } from "./use-research-collaboration.js";

export type CommFeedFilter = "all" | "requests" | "peer";

export interface DisplayCommItem {
  id: string;
  fromId: string;
  toId: string;
  fromLabel: string;
  toLabel: string;
  isPeer: boolean;
  isBroadcast: boolean;
  kind: string;
  status?: string | null;
  resolved: boolean;
  peerSettled: boolean;
  pendingRequest: boolean;
  tagLabel: string;
  tone: "amber" | "blue" | "green" | "red" | "muted";
  brief: string;
  fullSummary: string;
  evidenceNames: string[];
  timeLabel: string;
  createdAt: string;
  highlightIds: string[];
}

function basenameOf(filePath: string): string {
  const cleaned = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || filePath;
}

/** Distill raw communication summaries into concise, human-readable text. */
export function cleanCommunicationSummary(raw: string, maxChars = 72): string {
  const normalized = (raw ?? "")
    // Remove leading machine receipt/protocol tags if any leaked into summary.
    .replace(/^\[(?:research_communication|research_dispatch)[^\]]*\]\s*/i, "")
    // Shorten long sha256 digests to a clean marker or omit noise.
    .replace(/\bsha256:[a-f0-9]{12,64}\b/gi, "冻结哈希")
    .replace(/\b[a-f0-9]{32,64}\b/gi, "")
    // Replace deep relative file paths with their readable basename.
    .replace(/(?:[A-Za-z0-9_.-]+\/){2,}([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g, "$1")
    // Collapse whitespace and markdown noise.
    .replace(/[`*_#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "（无附加说明）";
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function formatClock(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function shortReadableLabel(
  id: string | null | undefined,
  mainSessionId: string | null | undefined,
  sessionTitles: Record<string, string>,
  taskLabels: Record<string, string>,
): string {
  if (!id) return "未知节点";
  if (mainSessionId && id === mainSessionId) return "主 Agent";
  const titled = sessionTitles[id] || taskLabels[id];
  if (titled) {
    // Prefer the concise leading segment before separators like "｜" when very long.
    const head = titled.split(/[｜|]/)[0]?.trim() || titled;
    const chars = Array.from(head);
    return chars.length > 14 ? `${chars.slice(0, 13).join("")}…` : head;
  }
  return id.length > 12 ? `#${id.slice(0, 6)}` : id;
}

function classifyCommItem(item: CollaborationCommunicationItem): {
  tagLabel: string;
  tone: DisplayCommItem["tone"];
  pendingRequest: boolean;
} {
  if (item.kind === "request") {
    const pendingRequest = !item.resolved && !item.peerSettled;
    return {
      tagLabel: pendingRequest ? "求助 · 待回复" : "求助 · 已回复",
      tone: pendingRequest ? "amber" : "muted",
      pendingRequest,
    };
  }
  if (item.kind === "reply") {
    return { tagLabel: "回复", tone: "blue", pendingRequest: false };
  }
  if (item.kind === "decision") {
    if (item.broadcast) return { tagLabel: "全组广播", tone: "blue", pendingRequest: false };
    if (item.edgeKind === "peer") return { tagLabel: "同级对齐", tone: "blue", pendingRequest: false };
    return { tagLabel: "决策", tone: "blue", pendingRequest: false };
  }
  if (item.kind === "result") {
    if (item.status === "completed") return { tagLabel: "已完成", tone: "green", pendingRequest: false };
    if (item.status === "blocked") return { tagLabel: "受阻", tone: "red", pendingRequest: false };
    if (item.status === "failed") return { tagLabel: "失败", tone: "red", pendingRequest: false };
    return { tagLabel: "阶段交付", tone: "blue", pendingRequest: false };
  }
  return { tagLabel: "进度", tone: "muted", pendingRequest: false };
}

/** Merge broadcast fanout duplicates and build concise display rows. */
export function buildDisplayCommunications(
  items: ReadonlyArray<CollaborationCommunicationItem>,
  options: {
    mainSessionId?: string | null;
    sessionTitles?: Record<string, string>;
    taskLabels?: Record<string, string>;
  } = {},
): DisplayCommItem[] {
  const sessionTitles = options.sessionTitles ?? {};
  const taskLabels = options.taskLabels ?? {};
  const sorted = [...items].sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));

  // Collapse identical broadcast fanout copies emitted within 3s by the same sender.
  const deduped: Array<{ item: CollaborationCommunicationItem; targetIds: string[] }> = [];
  for (const item of sorted) {
    if (item.broadcast) {
      const ts = Date.parse(item.createdAt ?? "") || 0;
      const prev = deduped.findLast(
        entry =>
          entry.item.broadcast &&
          entry.item.from === item.from &&
          entry.item.summary === item.summary &&
          Math.abs((Date.parse(entry.item.createdAt ?? "") || 0) - ts) <= 3000,
      );
      if (prev) {
        if (item.to && !prev.targetIds.includes(item.to)) prev.targetIds.push(item.to);
        continue;
      }
    }
    deduped.push({ item, targetIds: item.to ? [item.to] : [] });
  }

  return deduped.map(({ item, targetIds }) => {
    const isPeer = item.edgeKind === "peer";
    const isBroadcast = item.broadcast === true;
    const fromLabel = shortReadableLabel(item.from, options.mainSessionId, sessionTitles, taskLabels);
    const toLabel = isBroadcast
      ? "全组"
      : shortReadableLabel(item.to || item.targetTaskId, options.mainSessionId, sessionTitles, taskLabels);
    const { tagLabel, tone, pendingRequest } = classifyCommItem(item);
    const highlightIds = [...new Set([item.from, ...targetIds].filter(Boolean))];
    return {
      id: item.id,
      fromId: item.from,
      toId: item.to,
      fromLabel,
      toLabel,
      isPeer,
      isBroadcast,
      kind: item.kind,
      status: item.status,
      resolved: !!item.resolved,
      peerSettled: !!item.peerSettled,
      pendingRequest,
      tagLabel,
      tone,
      brief: cleanCommunicationSummary(item.summary, 68),
      fullSummary: (item.summary ?? "").trim(),
      evidenceNames: (item.evidence ?? []).map(basenameOf),
      timeLabel: formatClock(item.createdAt),
      createdAt: item.createdAt,
      highlightIds,
    };
  });
}

const barColor: Record<DisplayCommItem["tone"], string> = {
  amber: "border-l-[var(--accent-orange)] bg-amber-500/[0.06]",
  blue: "border-l-[var(--accent-blue)] bg-[var(--bg-primary)]",
  green: "border-l-[var(--accent-green)] bg-[var(--bg-primary)]",
  red: "border-l-[var(--accent-red)] bg-red-500/[0.06]",
  muted: "border-l-[var(--border-primary)] bg-[var(--bg-primary)]/70",
};

const tagColor: Record<DisplayCommItem["tone"], string> = {
  amber: "bg-amber-500/15 text-[var(--accent-orange)]",
  blue: "bg-sky-500/15 text-[var(--accent-blue)]",
  green: "bg-emerald-500/15 text-[var(--accent-green)]",
  red: "bg-red-500/15 text-[var(--accent-red)]",
  muted: "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]",
};

export function ResearchCommunicationFeed({
  items,
  mainSessionId,
  sessionTitles,
  taskLabels,
  onClose,
  onHighlightSessions,
  onLocateSession,
  onOpenSession,
}: {
  items: ReadonlyArray<CollaborationCommunicationItem>;
  mainSessionId?: string | null;
  sessionTitles?: Record<string, string>;
  taskLabels?: Record<string, string>;
  onClose: () => void;
  onHighlightSessions?: (sessionIds: string[]) => void;
  onLocateSession?: (sessionId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<CommFeedFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(0);

  const displayItems = useMemo(
    () => buildDisplayCommunications(items, { mainSessionId, sessionTitles, taskLabels }),
    [items, mainSessionId, sessionTitles, taskLabels],
  );

  const pendingRequestCount = useMemo(
    () => displayItems.filter(item => item.pendingRequest).length,
    [displayItems],
  );
  const peerCount = useMemo(
    () => displayItems.filter(item => item.isPeer).length,
    [displayItems],
  );

  const visibleItems = useMemo(() => {
    if (filter === "requests") return displayItems.filter(item => item.kind === "request" || item.kind === "reply");
    if (filter === "peer") return displayItems.filter(item => item.isPeer);
    return displayItems;
  }, [displayItems, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    const count = visibleItems.length;
    const delta = count - prevCountRef.current;
    prevCountRef.current = count;
    if (!el) return;
    if (pinnedToBottom) {
      el.scrollTop = el.scrollHeight;
      setUnseenCount(0);
    } else if (delta > 0) {
      setUnseenCount(prev => prev + delta);
    }
  }, [visibleItems.length, pinnedToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
    setPinnedToBottom(nearBottom);
    if (nearBottom) setUnseenCount(0);
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinnedToBottom(true);
    setUnseenCount(0);
  };

  return (
    <aside
      data-testid="research-comm-feed"
      aria-label="Agent 实时通信动态"
      className="research-comm-sidebar"
      onMouseLeave={() => onHighlightSessions?.([])}
    >
      <div className="research-comm-header">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon path={mdiForumOutline} size={0.58} className="shrink-0 text-[var(--accent-text)]" />
          <span className="truncate text-[11.5px] font-semibold text-[var(--text-primary)]">通信动态</span>
          {pendingRequestCount > 0 && (
            <span
              data-testid="research-comm-pending-badge"
              className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0 text-[10px] font-medium text-[var(--accent-orange)]"
            >
              {pendingRequestCount} 待回复
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="research-comm-filters" role="tablist" aria-label="通信筛选">
            {(
              [
                ["all", "全部", displayItems.length],
                ["requests", "求助", pendingRequestCount],
                ["peer", "同级", peerCount],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`research-comm-filter-btn ${filter === key ? "active" : ""}`}
              >
                {label}
                {key !== "all" && count > 0 ? <span className="ml-0.5 tabular-nums opacity-80">{count}</span> : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="收起通信侧边栏"
            title="收起通信侧边栏"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Icon path={mdiClose} size={0.52} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="research-comm-list">
        {visibleItems.length === 0 ? (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center px-4 text-center text-[11px] text-[var(--text-tertiary)]">
            <p className="m-0">
              {filter === "peer"
                ? "本批次暂无同级 Agent 互聊"
                : filter === "requests"
                ? "暂无求助与回复记录"
                : "Agent 开始协作沟通后，动态会实时出现在这里"}
            </p>
          </div>
        ) : (
          visibleItems.map(item => {
            const expanded = expandedId === item.id;
            const arrow = item.isPeer && !item.isBroadcast ? "⇄" : "→";
            return (
              <div
                key={item.id}
                data-testid="research-comm-item"
                data-comm-kind={item.kind}
                onMouseEnter={() => onHighlightSessions?.(item.highlightIds)}
                onFocus={() => onHighlightSessions?.(item.highlightIds)}
                className={`research-comm-card ${barColor[item.tone]} ${expanded ? "ring-1 ring-[var(--accent-primary)]/40" : ""}`}
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => {
                    const next = expanded ? null : item.id;
                    setExpandedId(next);
                    onHighlightSessions?.(next ? item.highlightIds : []);
                  }}
                  className="block w-full text-left"
                >
                  <div className="flex items-center justify-between gap-1.5 text-[10.5px]">
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]" title={`${item.fromLabel} ${arrow} ${item.toLabel}`}>
                      {item.fromLabel}
                      <span aria-hidden="true" className="mx-1 text-[var(--text-tertiary)]">{arrow}</span>
                      {item.toLabel}
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0 text-[9.5px] font-medium leading-[16px] ${tagColor[item.tone]}`}>
                      {item.tagLabel}
                    </span>
                    {item.timeLabel && (
                      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-[var(--text-tertiary)]">
                        {item.timeLabel}
                      </span>
                    )}
                  </div>
                  <p className={`mt-1 mb-0 text-[11px] leading-[1.4] text-[var(--text-secondary)] ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-2"}`}>
                    {expanded ? item.fullSummary : item.brief}
                  </p>
                </button>

                {expanded && (
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[10px]">
                    {item.evidenceNames.length > 0 ? (
                      <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]" title={item.evidenceNames.join(", ")}>
                        证据：{item.evidenceNames.slice(0, 3).join(" · ")}
                        {item.evidenceNames.length > 3 ? ` 等 ${item.evidenceNames.length} 项` : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">
                        {item.isPeer ? "同级协作" : "父子协作"}
                      </span>
                    )}
                    <div className="flex shrink-0 items-center gap-1">
                      {onLocateSession && (
                        <button
                          type="button"
                          onClick={() => onLocateSession(item.fromId)}
                          className="research-fleet-mini-btn"
                          title="在拓扑中定位发送方节点"
                        >
                          <Icon path={mdiCrosshairsGps} size={0.48} />
                          <span>定位</span>
                        </button>
                      )}
                      {onOpenSession && (
                        <button
                          type="button"
                          onClick={() => onOpenSession(item.fromId)}
                          className="research-fleet-mini-btn"
                          title="打开发送方会话"
                        >
                          <Icon path={mdiOpenInNew} size={0.48} />
                          <span>看会话</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {!pinnedToBottom && visibleItems.length > 0 && (
        <button
          type="button"
          onClick={scrollToLatest}
          data-testid="research-comm-jump-latest"
          className="research-comm-jump-latest"
        >
          <Icon path={mdiArrowDown} size={0.5} />
          <span>{unseenCount > 0 ? `有 ${unseenCount} 条新消息` : "回到最新"}</span>
        </button>
      )}
    </aside>
  );
}
