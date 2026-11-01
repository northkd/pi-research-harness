import {
  mdiBrain,
  mdiClose,
  mdiCurrencyCny,
  mdiFlash,
  mdiReceiptTextOutline,
  mdiSpeedometer,
} from "@mdi/js";
import Icon from "@mdi/react";
import React, { useEffect, useRef, useState } from "react";
import { SessionCost } from "./SessionCost.js";
import type { ActiveGeneration, BillingSummary, SpeedRecord, SpeedStatsResponse } from "./types.js";
import { type SpeedMonitorState, useSpeedStats } from "./useSpeedStats.js";

// Helper for rendering Icon component reliably across environments
const SafeIcon = (Icon as unknown as { default?: typeof Icon }).default || Icon;

export interface SpeedIndicatorProps {
  sessionId?: string;
  sessionStatus?: string;
  className?: string;
  align?: "left" | "right";
  monitor?: SpeedMonitorState;
  costOnly?: boolean;
}

/**
 * Clean up verbose model strings like `gpt-6.1-sol(max)[1m]` -> `gpt-6.1-sol(max)`
 */
function cleanModelName(model?: string): string {
  if (!model || model === "unknown") return "—";
  return model.replace(/\[\d+m\]/gi, "").trim();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function clampSize(value: number, minimum: number, available: number): number {
  const maximum = Math.max(1, Math.min(850, available));
  return Math.min(maximum, Math.max(Math.min(minimum, maximum), value));
}

function savedSize(key: string, fallback: number, minimum: number, available: number): number {
  try {
    const saved = Number(localStorage.getItem(key));
    return clampSize(Number.isFinite(saved) && saved > 0 ? saved : fallback, minimum, available);
  } catch { return clampSize(fallback, minimum, available); }
}

/**
 * Top Context-Bar Speed & Performance Indicator (方案B)
 *
 * Integrated directly into the native context & token bar (TokenStatsBar).
 * Uses dashboard native CSS variables (--bg-*, --border-*, --text-*, --accent-*)
 * to stay 100% consistent with the system color scheme in all themes, with solid opaque styling.
 * Supports interactive resizing via edge & bottom drag bars with localStorage persistence.
 * Isolates Subagents records so high-frequency main agent calls never overwrite subagents metrics.
 * Supports sliding tabs to toggle between Speed Monitor and Billing Details.
 */
export function SpeedIndicator({
  sessionId,
  sessionStatus,
  className = "",
  align = "left",
  monitor,
  costOnly = false,
}: SpeedIndicatorProps) {
  const ownMonitor = useSpeedStats(sessionId, sessionStatus, !monitor);
  const { stats, elapsed, isStreaming } = monitor ?? ownMonitor;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [activeView, setActiveView] = useState<"speed" | "billing">(costOnly ? "billing" : "speed");
  const [historyTab, setHistoryTab] = useState<"all" | "main" | "subagent">("all");
  const [billingHistoryTab, setBillingHistoryTab] = useState<"all" | "main" | "subagent">("all");
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Resizable window dimensions (persisted)
  const [popoverWidth, setPopoverWidth] = useState(() => savedSize("speed-monitor-popover-width", 560, 340, window.innerWidth - 24));

  const [popoverHeight, setPopoverHeight] = useState(() => savedSize("speed-monitor-popover-height", 640, 300, window.innerHeight - 120));

  const isResizingRef = useRef<"width" | "bottom" | "corner" | null>(null);
  const startPosRef = useRef({ x: 0, y: 0, startW: 375, startH: 520 });
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  useEffect(() => {
    if (!popoverOpen) resizeCleanupRef.current?.();
    const fit = () => {
      const bounds = buttonRef.current?.getBoundingClientRect();
      const width = bounds ? (align === "left" ? window.innerWidth - bounds.left - 12 : bounds.right - 12) : window.innerWidth - 24;
      const height = bounds ? window.innerHeight - bounds.bottom - 20 : window.innerHeight - 120;
      setPopoverWidth(w => clampSize(w, 340, width));
      setPopoverHeight(h => clampSize(h, 300, height));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [popoverOpen, align]);
  useEffect(() => {
    try {
      localStorage.setItem("speed-monitor-popover-width", String(popoverWidth));
      localStorage.setItem("speed-monitor-popover-height", String(popoverHeight));
    } catch { /* Storage may be disabled. */ }
  }, [popoverWidth, popoverHeight]);

  const latest = stats?.latest;
  const avgTps = stats?.averageTps ?? 0;

  // Drag-to-resize handler
  const startResize = (mode: "width" | "bottom" | "corner", e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeCleanupRef.current?.();
    isResizingRef.current = mode;
    startPosRef.current = {
      x: e.clientX,
      y: e.clientY,
      startW: popoverWidth,
      startH: popoverHeight,
    };
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isResizingRef.current) return;
      const dx = moveEv.clientX - startPosRef.current.x;
      const dy = moveEv.clientY - startPosRef.current.y;

      if (isResizingRef.current === "width" || isResizingRef.current === "corner") {
        const deltaW = align === "left" ? dx : -dx;
        const bounds = buttonRef.current?.getBoundingClientRect();
        const available = bounds ? (align === "left" ? window.innerWidth - bounds.left - 12 : bounds.right - 12) : window.innerWidth - 24;
        const newW = clampSize(startPosRef.current.startW + deltaW, 340, available);
        setPopoverWidth(newW);
      }
      if (isResizingRef.current === "bottom" || isResizingRef.current === "corner") {
        const available = window.innerHeight - (buttonRef.current?.getBoundingClientRect().bottom ?? 100) - 20;
        const newH = clampSize(startPosRef.current.startH + dy, 300, available);
        setPopoverHeight(newH);
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

  // Close popover when clicking outside (bypassed during active resizing)
  useEffect(() => {
    if (!popoverOpen) return;
    function handleDocumentClick(e: MouseEvent) {
      if (isResizingRef.current) return;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [popoverOpen]);

  // Don't render anything if no data and not streaming
  if (!stats && !isStreaming) {
    return null;
  }

  const cacheHitPercent =
    latest && latest.totalTokens > 0
      ? Math.round((latest.cacheRead / latest.totalTokens) * 100)
      : 0;

  // Selected history list based on tab
  // Selected history lists based on tabs
  const displayList =
    historyTab === "subagent"
      ? (stats?.subagentHistory ?? [])
      : historyTab === "main"
      ? (stats?.mainHistory ?? [])
      : (stats?.history ?? []);

  const billingDisplayList =
    billingHistoryTab === "subagent"
      ? (stats?.billingSubagentHistory ?? stats?.subagentHistory ?? [])
      : billingHistoryTab === "main"
      ? (stats?.billingMainHistory ?? stats?.mainHistory ?? [])
      : (stats?.billingHistory ?? stats?.history ?? []);

  const billing = stats?.billing;

  return (
    <div className={`relative inline-flex items-center shrink-0 ${className}`}>
      {/* Indicator Pill: uses system theme variables, 100% solid, non-transparent */}
      <button
        ref={buttonRef}
        type="button"
        data-testid="speed-indicator-badge"
        aria-label="会话用量与计费"
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        onClick={() => setPopoverOpen((prev) => !prev)}
        title="点击查看详细输出速率、主/子智能体模型与计费明细（窗口可自由拖拽缩放）"
        className={`group flex h-6.5 items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-mono leading-none cursor-pointer select-none transition-all shadow-sm active:scale-95 ${
          costOnly
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60 shadow-emerald-500/5 hover:shadow-md"
            : isStreaming
            ? "bg-[var(--bg-surface)] border-[var(--accent-green)] text-[var(--accent-green-text)] shadow-sm shadow-emerald-500/10"
            : "bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--border-secondary)] hover:bg-[var(--bg-surface)]"
        }`}
      >
        {costOnly ? (
          <span className="flex items-center gap-1 font-sans">
            <SafeIcon path={mdiCurrencyCny} size={0.48} className="text-emerald-400 transition-transform group-hover:scale-110" />
            <span className="font-semibold text-emerald-400 text-[11px]">费用</span>
            <span className="font-mono font-bold text-emerald-300 ml-0.5">
              <SessionCost billing={stats?.billing} />
            </span>
          </span>
        ) : isStreaming ? (
          <>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-green)] animate-pulse" />
            <SafeIcon path={mdiFlash} size={0.46} className="text-[var(--accent-green-text)]" />
            <span className="font-semibold text-[var(--accent-green-text)]">
              生成中 {elapsed.toFixed(1)}s
            </span>
            {avgTps > 0 && (
              <span className="text-[var(--text-tertiary)] text-[10px]">
                (~{avgTps} t/s)
              </span>
            )}
          </>
        ) : latest && latest.tps > 0 ? (
          <>
            <SafeIcon path={mdiFlash} size={0.46} className="text-[var(--accent-yellow-text)]" />
            <span className="font-semibold text-[var(--text-primary)]">{latest.tps}</span>
            <span className="text-[var(--text-tertiary)] text-[10px]">t/s</span>
            <span className="text-[var(--text-secondary)] text-[10px]">·</span>
            <span className="text-[var(--text-secondary)] text-[10px]">{latest.durationSeconds.toFixed(0)}s</span>
            {avgTps > 0 && (
              <span className="text-[var(--text-secondary)] text-[10px]">
                (均 {avgTps})
              </span>
            )}
          </>
        ) : (
          <>
            <SafeIcon path={mdiSpeedometer} size={0.46} className="text-[var(--text-tertiary)]" />
            <span className="text-[var(--text-tertiary)]">
              {avgTps > 0 ? `均速 ${avgTps} t/s` : "速度监控"}
            </span>
          </>
        )}
      </button>

      {/* Popover on click: uses system theme variables, 100% solid, resizable */}
      {popoverOpen && (
        <div
          ref={popoverRef}
          data-testid="speed-indicator-popover"
          role="dialog"
          aria-label="会话用量与计费"
          style={{
            width: `${popoverWidth}px`,
            height: `${popoverHeight}px`,
            maxHeight: "calc(100vh - 120px)",
            maxWidth: "calc(100vw - 24px)",
          }}
          className={`@container absolute ${align === "left" ? "left-0" : "right-0"} top-full mt-2 z-50 flex flex-col rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 text-xs shadow-2xl text-[var(--text-primary)] select-text`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Edge Resize Bar (调节宽度) */}
          {align === "left" ? (
            <div
              onMouseDown={(e) => startResize("width", e)}
              className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize group/resizer z-20 flex items-center justify-center select-none"
              title="左右拖拽调节窗口宽度"
            >
              <div className="w-1 h-12 rounded-full bg-[var(--border-secondary)] opacity-50 group-hover/resizer:opacity-100 group-hover/resizer:bg-[var(--accent-primary)] group-hover/resizer:w-1.5 transition-all" />
            </div>
          ) : (
            <div
              onMouseDown={(e) => startResize("width", e)}
              className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize group/resizer z-20 flex items-center justify-center select-none"
              title="左右拖拽调节窗口宽度"
            >
              <div className="w-1 h-12 rounded-full bg-[var(--border-secondary)] opacity-50 group-hover/resizer:opacity-100 group-hover/resizer:bg-[var(--accent-primary)] group-hover/resizer:w-1.5 transition-all" />
            </div>
          )}

          {/* Bottom Edge Resize Bar (调节高度) */}
          <div
            onMouseDown={(e) => startResize("bottom", e)}
            className="absolute left-0 right-0 bottom-0 h-2.5 cursor-ns-resize group/b-resizer z-20 flex items-center justify-center select-none"
            title="上下拖拽调节窗口高度"
          >
            <div className="h-1 w-12 rounded-full bg-[var(--border-secondary)] opacity-50 group-hover/b-resizer:opacity-100 group-hover/b-resizer:bg-[var(--accent-primary)] group-hover/b-resizer:h-1.5 transition-all" />
          </div>

          {/* Corner Resize Handle (对角调节) */}
          {align === "left" ? (
            <div
              onMouseDown={(e) => startResize("corner", e)}
              className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-30 group/c-resizer flex items-end justify-end p-1 select-none"
              title="对角拖拽同时调节宽高"
            >
              <div className="w-2.5 h-2.5 border-b-2 border-r-2 border-[var(--border-secondary)] group-hover/c-resizer:border-[var(--accent-primary)] transition-colors" />
            </div>
          ) : (
            <div
              onMouseDown={(e) => startResize("corner", e)}
              className="absolute bottom-0 left-0 w-5 h-5 cursor-nesw-resize z-30 group/c-resizer flex items-end justify-start p-1 select-none"
              title="对角拖拽同时调节宽高"
            >
              <div className="w-2.5 h-2.5 border-b-2 border-l-2 border-[var(--border-secondary)] group-hover/c-resizer:border-[var(--accent-primary)] transition-colors" />
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-[var(--border-primary)] shrink-0">
            <div className="flex items-center gap-2 font-bold text-[var(--text-primary)] text-sm">
              <div className={`flex h-7 w-7 items-center justify-center rounded-lg shadow-sm ${
                activeView === "billing" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"
              }`}>
                <SafeIcon
                  path={activeView === "billing" ? mdiCurrencyCny : mdiSpeedometer}
                  size={0.65}
                />
              </div>
              <span>{activeView === "billing" ? "会话计费与模型消费明细" : "实时速度与模型性能明细"}</span>
              <span className="text-[11px] text-[var(--text-secondary)] font-normal hidden @sm:inline select-none">
                (边条可拖拽调节)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setPopoverOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              title="关闭"
              aria-label="关闭用量面板"
            >
              <SafeIcon path={mdiClose} size={0.6} />
            </button>
          </div>

          {/* Sliding View Switcher Tabs (滑动的窗口切换控制器) */}
          <div className="relative flex p-1 mb-3 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-xl text-xs font-semibold select-none shrink-0 shadow-inner">
            {/* Sliding background pill indicator */}
            <div
              className="absolute top-1 bottom-1 rounded-lg transition-all duration-200 ease-out bg-[var(--bg-surface)] border border-[var(--border-secondary)] shadow-sm"
              style={{
                left: activeView === "speed" ? "4px" : "calc(50% + 2px)",
                width: "calc(50% - 6px)",
              }}
            />
            <button
              type="button"
              data-testid="tab-view-speed"
              onClick={() => setActiveView("speed")}
              className={`relative z-10 flex-1 py-1.5 flex items-center justify-center gap-1.5 cursor-pointer rounded-lg transition-colors ${
                activeView === "speed"
                  ? "text-[var(--text-primary)] font-bold"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <SafeIcon path={mdiSpeedometer} size={0.48} className={activeView === "speed" ? "text-amber-400" : ""} />
              <span>速度与性能</span>
            </button>
            <button
              type="button"
              data-testid="tab-view-billing"
              onClick={() => setActiveView("billing")}
              className={`relative z-10 flex-1 py-1.5 flex items-center justify-center gap-1.5 cursor-pointer rounded-lg transition-colors ${
                activeView === "billing"
                  ? "text-[var(--text-primary)] font-bold"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <SafeIcon path={mdiCurrencyCny} size={0.48} className={activeView === "billing" ? "text-emerald-400" : ""} />
              <span>计费明细</span>
              {billing && billing.sessionTotalCost > 0 && (
                <span className="text-[11px] px-2 py-0.2 rounded-full bg-emerald-500/15 text-emerald-400 font-mono ml-1 font-semibold border border-emerald-500/20">
                  ¥{billing.sessionTotalCost.toFixed(2)}
                </span>
              )}
            </button>
          </div>

          {/* Keep filters and scroll positions mounted, but show only the selected pane. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="min-w-0">
              {/* ======================================================== */}
              {/* SLIDE 1: 速度与性能 (Speed & Performance View)           */}
              {/* ======================================================== */}
              <div data-testid="speed-panel" inert={activeView !== "speed"} aria-hidden={activeView !== "speed"} style={{ display: activeView === "speed" ? "flex" : "none" }} className="w-full min-w-0 flex-col gap-3">
                {/* Current / Latest Metrics */}
                {latest ? (
                  <div className="space-y-1.5 text-[11px] shrink-0">
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">主 Agent 模型:</span>
                      <span
                        className="font-mono text-[var(--text-primary)] truncate max-w-[210px] px-1 py-0.2 rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)]"
                        title={stats?.latestMain?.model || latest.model}
                      >
                        {cleanModelName(stats?.latestMain?.model || latest.model)}
                      </span>
                    </div>

                    {/* Subagents highlights card (never overwritten by main agent) */}
                    {stats?.latestSubagent && (
                      <div className="flex justify-between items-center px-1.5 py-0.5 rounded border border-[var(--accent-purple)]/30 bg-[var(--accent-purple)]/10 text-[10px]">
                        <span className="text-[var(--accent-purple)] font-medium flex items-center gap-1">
                          <SafeIcon path={mdiBrain} size={0.4} />
                          <span>Subagent 最新:</span>
                        </span>
                        <div className="flex items-center gap-2 font-mono">
                          <span
                            className="text-[var(--text-primary)] px-1 rounded bg-[var(--bg-surface)] border border-[var(--border-primary)]"
                            title={stats.latestSubagent.model}
                          >
                            {cleanModelName(stats.latestSubagent.model)}
                          </span>
                          <span className="text-[var(--accent-yellow-text)] font-semibold">
                            {stats.latestSubagent.tps} t/s
                          </span>
                          <span className="text-[var(--text-secondary)] text-[11px]">
                            ({stats.latestSubagent.durationSeconds.toFixed(0)}s)
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Subagent models catalog chips */}
                    {stats?.subagentModels && stats.subagentModels.length > 0 && (
                      <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[var(--text-tertiary)]">Subagents 所用模型:</span>
                        <div className="flex flex-wrap gap-1 justify-end max-w-[220px]">
                          {stats.subagentModels.map((m) => (
                            <span
                              key={m}
                              className="px-1.5 py-0.2 rounded bg-[var(--bg-tertiary)] border border-[var(--accent-purple)]/20 text-[var(--accent-purple)] font-mono text-[11px]"
                              title={m}
                            >
                              {cleanModelName(m)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">上一轮生成速率:</span>
                      <span className="font-mono text-[var(--accent-yellow-text)] font-semibold">
                        {latest.tps} tokens/s
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">近几轮加权均速:</span>
                      <span className="font-mono text-[var(--text-primary)] font-medium">
                        {avgTps} tokens/s
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">上一轮响应耗时:</span>
                      <span className="font-mono text-[var(--text-primary)]">
                        {latest.durationSeconds.toFixed(1)} 秒
                      </span>
                    </div>
                    {latest.reasoningTokens > 0 && (
                      <div className="flex justify-between items-center">
                        <span className="text-[var(--text-tertiary)] flex items-center gap-1">
                          <SafeIcon path={mdiBrain} size={0.45} className="text-[var(--accent-purple)]" />
                          <span>思考 (Reasoning):</span>
                        </span>
                        <span className="font-mono text-[var(--accent-purple)]">
                          {latest.reasoningTokens.toLocaleString()} tokens
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">正文输出 (Content):</span>
                      <span className="font-mono text-[var(--text-primary)]">
                        {latest.contentTokens.toLocaleString()} tokens
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">总输出 Tokens:</span>
                      <span className="font-mono text-[var(--text-primary)] font-medium">
                        {latest.totalOutputTokens.toLocaleString()} tokens
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">上下文总计:</span>
                      <span className="font-mono text-[var(--text-primary)]">
                        {(latest.totalTokens / 1000).toFixed(1)}k tokens
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--text-tertiary)]">缓存命中率:</span>
                      <span className="font-mono text-[var(--accent-green-text)] font-medium">
                        {cacheHitPercent}%
                        <span className="text-[var(--text-secondary)] text-[10px] ml-1">
                          ({(latest.cacheRead / 1000).toFixed(1)}k / {(latest.totalTokens / 1000).toFixed(1)}k)
                        </span>
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-[var(--text-tertiary)] text-center py-2 shrink-0">
                    暂无当前会话的生成记录
                  </div>
                )}

                {/* Speed History Section with Tabs */}
                {stats && stats.history.length > 0 && (
                  <div className="mt-2.5 pt-2 border-t border-[var(--border-primary)] flex-1 min-h-0 flex flex-col">
                    {/* Filter Tabs */}
                    <div className="flex items-center justify-between pb-1.5 shrink-0">
                      <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] p-0.5 rounded border border-[var(--border-primary)] text-[10px]">
                        <button
                          type="button"
                          data-testid="tab-speed-all"
                          onClick={() => setHistoryTab("all")}
                          className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                            historyTab === "all"
                              ? "bg-[var(--bg-surface)] text-[var(--text-primary)] font-medium"
                              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                          }`}
                        >
                          全部 ({stats.history.length})
                        </button>
                        <button
                          type="button"
                          data-testid="tab-speed-main"
                          onClick={() => setHistoryTab("main")}
                          className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                            historyTab === "main"
                              ? "bg-[var(--bg-surface)] text-[var(--text-primary)] font-medium"
                              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                          }`}
                        >
                          主 Agent ({stats.mainHistory?.length ?? 0})
                        </button>
                        <button
                          type="button"
                          data-testid="tab-speed-subagent"
                          onClick={() => setHistoryTab("subagent")}
                          disabled={!stats.subagentHistory || stats.subagentHistory.length === 0}
                          className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                            historyTab === "subagent"
                              ? "bg-[var(--accent-purple)]/25 border border-[var(--accent-purple)]/50 text-[var(--accent-purple)] font-medium"
                              : stats.subagentHistory && stats.subagentHistory.length > 0
                              ? "text-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/10"
                              : "text-[var(--text-secondary)] cursor-not-allowed opacity-50"
                          }`}
                          title={
                            stats.subagentHistory && stats.subagentHistory.length > 0
                              ? "独立查看 Subagents 速度与模型历史（永不被主 Agent 覆盖）"
                              : "当前会话暂无 Subagent 调用记录"
                          }
                        >
                          Subagents ({stats.subagentHistory?.length ?? 0})
                        </button>
                      </div>
                      <span className="text-[11px] text-[var(--text-secondary)] hidden @sm:inline">
                        (时间 · 身份 · 模型 · 速率)
                      </span>
                    </div>

                    {/* History list */}
                    <div data-testid="speed-history" className="flex-1 min-h-[140px] overflow-y-auto space-y-1 font-mono text-[10px] pr-0.5">
                      {displayList.slice(-20).reverse().map((r, i) => (
                        <div
                          key={r.id || i}
                          data-testid="speed-history-row"
                          className="grid min-h-11 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 hover:border-[var(--border-secondary)] @sm:min-h-0 @sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]"
                        >
                          <span data-testid="history-time" className="text-[11px] text-[var(--text-secondary)]">
                            {new Date(r.timestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                          <span
                            className={`justify-self-start rounded border px-1 text-[10px] ${
                              r.agentType === "subagent"
                                ? "border-[var(--accent-purple)]/40 bg-[var(--accent-purple)]/15 text-[var(--accent-purple-text)]"
                                : "border-[var(--border-secondary)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                            }`}
                            title={r.agentType === "subagent" ? "子智能体 (Subagent)" : "主智能体 (Main Agent)"}
                          >
                            {r.agentType === "subagent" ? "Sub" : "Main"}
                          </span>
                          <span
                            data-testid="history-model"
                            className="col-span-3 col-start-1 row-start-2 min-w-0 break-all text-[11px] text-[var(--text-primary)] @sm:col-span-1 @sm:col-start-3 @sm:row-start-1 @sm:truncate"
                            title={`完整模型: ${r.model}`}
                          >
                            {cleanModelName(r.model)}
                          </span>
                          <span className="col-start-4 row-start-2 whitespace-nowrap text-[11px] text-[var(--text-secondary)] @sm:row-start-1">
                            {r.durationSeconds.toFixed(0)}s · {r.totalOutputTokens}t
                          </span>
                          <span className="col-start-4 row-start-1 justify-self-end whitespace-nowrap text-[11px] font-semibold text-[var(--accent-yellow-text)] @sm:col-start-5">
                            {r.tps} t/s
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ======================================================== */}
              {/* SLIDE 2: 计费细节 (Billing Details View)                 */}
              {/* ======================================================== */}
              <div data-testid="billing-panel" inert={activeView !== "billing"} aria-hidden={activeView !== "billing"} style={{ display: activeView === "billing" ? "flex" : "none" }} className="w-full min-w-0 flex-col gap-3">
                {/* Hero Total Card (高质感现代卡片设计) */}
                <div className="p-3.5 rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] shadow-sm shrink-0 space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-[11px] text-[var(--text-tertiary)] font-medium">
                        {billing?.complete ? "本月会话等价消耗 (RMB)" : "本月已定价消耗 (RMB)"}
                      </div>
                      {stats?.billingPeriod && (
                        <div className="text-[11.5px] text-[var(--text-secondary)] font-medium mt-0.5">
                          {stats.billingPeriod.month} · 北京时间
                        </div>
                      )}
                      <div className="text-2xl font-extrabold font-mono text-[var(--accent-green-text)] tracking-tight mt-1 flex items-baseline gap-1.5">
                        <span>{billing ? `¥${billing.sessionTotalCost.toFixed(4)}` : "—"}</span>
                        {billing?.complete ? (
                          <span className="text-[10px] font-sans font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            完整计费
                          </span>
                        ) : null}
                      </div>
                      {billing && !billing.complete && (
                        <div className="text-[11px] text-amber-400 font-medium mt-1">
                          {billing.unpricedTurns} 轮待定价 · {billing.invalidRecords} 条用量未能读取
                        </div>
                      )}
                    </div>
                    {billing?.totalCacheSavings && billing.totalCacheSavings > 0 ? (
                      <div className="text-right rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1.5">
                        <div className="text-[10.5px] text-emerald-400 font-semibold">缓存节省</div>
                        <div className="text-xs font-mono text-[var(--accent-green-text)] font-bold">
                          +¥{billing.totalCacheSavings.toFixed(4)}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* Agent breakdown row */}
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--border-primary)] text-xs">
                    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-primary)] shadow-sm">
                      <span className="text-[var(--text-tertiary)] font-medium">主 Agent:</span>
                      <span className="font-mono text-[var(--text-primary)] font-bold">
                        ¥{(billing?.mainTotalCost ?? 0).toFixed(4)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[var(--bg-surface)] border border-purple-500/30 shadow-sm">
                      <span className="text-purple-300 font-medium flex items-center gap-1">
                        <SafeIcon path={mdiBrain} size={0.38} />
                        <span>Subagents:</span>
                      </span>
                      <span className="font-mono text-purple-300 font-bold">
                        ¥{(billing?.subagentTotalCost ?? 0).toFixed(4)}
                      </span>
                    </div>
                  </div>

                  {/* Token & Cost Category Pills */}
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono text-center">
                    <div className="p-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-primary)] shadow-sm">
                      <div className="text-[var(--text-secondary)] font-sans text-[11px] font-semibold">输入</div>
                      <div className="text-[var(--text-primary)] font-bold mt-0.5">
                        ¥{(billing?.totalInputCost ?? 0).toFixed(4)}
                      </div>
                      <div className="text-[var(--text-tertiary)] text-[10.5px]">
                        {formatTokens(billing?.totalInputTokens ?? 0)}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-primary)] shadow-sm">
                      <div className="text-[var(--text-secondary)] font-sans text-[11px] font-semibold">输出/思考</div>
                      <div className="text-[var(--text-primary)] font-bold mt-0.5">
                        ¥{(billing?.totalOutputCost ?? 0).toFixed(4)}
                      </div>
                      <div className="text-[var(--text-tertiary)] text-[10.5px]">
                        {formatTokens(billing?.totalOutputTokens ?? 0)}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-primary)] shadow-sm">
                      <div className="text-[var(--text-secondary)] font-sans text-[11px] font-semibold">缓存读取 / 写入</div>
                      <div className="text-[var(--accent-green-text)] font-bold mt-0.5">
                        ¥{(billing?.totalCacheCost ?? 0).toFixed(4)} / ¥{(billing?.totalCacheWriteCost ?? 0).toFixed(4)}
                      </div>
                      <div className="text-[var(--text-tertiary)] text-[10.5px]">
                        {formatTokens(billing?.totalCacheRead ?? 0)} / {formatTokens(billing?.totalCacheWrite ?? 0)}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-primary)] shadow-sm">
                      <div className="text-[var(--text-secondary)] font-sans text-[11px] font-semibold">按次费用</div>
                      <div className="font-bold text-[var(--text-primary)] mt-0.5">¥{(billing?.totalRequestCost ?? 0).toFixed(4)}</div>
                    </div>
                  </div>
                </div>

                {/* Model Pricing Rate Catalog */}
                {billing?.modelBreakdown && billing.modelBreakdown.length > 0 && (
                  <div className="shrink-0 p-2 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[10px]">
                    <div className="flex items-center justify-between text-[var(--text-tertiary)] pb-1 mb-1 border-b border-[var(--border-primary)] text-[11px]">
                      <span className="font-medium text-[var(--text-secondary)]">当前会话各模型单价与消耗</span>
                      <span className="text-[var(--text-secondary)]">费率 (¥/1M tokens 或 ¥/次)</span>
                    </div>
                    <div className="max-h-[160px] overflow-y-auto space-y-1 pr-0.5">
                      {billing.modelBreakdown.map((m) => (
                        <div
                          key={`${m.provider}/${m.model}`}
                          className="flex items-center justify-between text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-primary)]"
                        >
                          <div className="flex items-center gap-1 min-w-0">
                            <span
                              className={`text-[10px] px-1 rounded border ${
                                m.agentType === "subagent"
                                  ? "bg-[var(--accent-purple)]/15 border-[var(--accent-purple)]/40 text-[var(--accent-purple)]"
                                  : m.agentType === "mixed"
                                  ? "bg-[var(--accent-yellow)]/15 border-[var(--accent-yellow)]/40 text-[var(--accent-yellow-text)]"
                                  : "bg-[var(--bg-tertiary)] border-[var(--border-secondary)] text-[var(--text-tertiary)]"
                              }`}
                            >
                              {m.agentType === "subagent" ? "Sub" : m.agentType === "mixed" ? "Mix" : "Main"}
                            </span>
                            <span className="min-w-0 break-all text-[var(--text-primary)] font-medium" title={`${m.provider}/${m.model}`}>
                              {cleanModelName(m.model)}
                            </span>
                            <span className="text-[var(--text-secondary)] text-[10px]">({m.callCount}次)</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {m.rates && (
                              <span
                                className="text-[var(--text-secondary)] text-[10px] hidden @sm:inline"
                                title={m.rates.unit === "request" ? `按请求 ¥${m.rates.request}/次` : `输入: ¥${m.rates.input}/M · 输出: ¥${m.rates.output}/M · 缓存读取: ¥${m.rates.cacheRead}/M · 缓存写入: ¥${m.rates.cacheWrite}/M`}
                              >
                                {m.rates.unit === "request" ? `¥${m.rates.request}/次` : `${m.rates.input}/${m.rates.output}`}
                              </span>
                            )}
                            <span className="text-[var(--accent-green-text)] font-semibold">
                              {m.unpricedCalls > 0 && m.cost === 0 ? "待定价" : `${m.unpricedCalls > 0 ? `${m.unpricedCalls} 轮待定价 · ≥` : ""}¥${m.cost.toFixed(4)}`}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Turn-by-Turn Billing History */}
                <div className="flex-1 min-h-0 flex flex-col pt-1 border-t border-[var(--border-primary)]">
                  {/* Filter tabs */}
                  <div className="flex items-center justify-between pb-1 shrink-0">
                    <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] p-0.5 rounded border border-[var(--border-primary)] text-[10px]">
                      <button
                        type="button"
                        onClick={() => setBillingHistoryTab("all")}
                        className={`px-1.5 py-0.2 rounded cursor-pointer transition-colors ${
                          billingHistoryTab === "all"
                            ? "bg-[var(--bg-surface)] text-[var(--text-primary)] font-medium"
                            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                        }`}
                      >
                        全部 ({(stats?.billingHistory ?? stats?.history)?.length ?? 0})
                      </button>
                      <button
                        type="button"
                        onClick={() => setBillingHistoryTab("main")}
                        className={`px-1.5 py-0.2 rounded cursor-pointer transition-colors ${
                          billingHistoryTab === "main"
                            ? "bg-[var(--bg-surface)] text-[var(--text-primary)] font-medium"
                            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                        }`}
                      >
                        主 Agent ({(stats?.billingMainHistory ?? stats?.mainHistory)?.length ?? 0})
                      </button>
                      <button
                        type="button"
                        onClick={() => setBillingHistoryTab("subagent")}
                        disabled={(stats?.billingSubagentHistory ?? stats?.subagentHistory ?? []).length === 0}
                        className={`px-1.5 py-0.2 rounded cursor-pointer transition-colors ${
                          billingHistoryTab === "subagent"
                            ? "bg-[var(--accent-purple)]/25 border border-[var(--accent-purple)]/50 text-[var(--accent-purple)] font-medium"
                            : (stats?.billingSubagentHistory ?? stats?.subagentHistory ?? []).length > 0
                            ? "text-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/10"
                            : "text-[var(--text-secondary)] cursor-not-allowed opacity-50"
                        }`}
                      >
                        Subagents ({(stats?.billingSubagentHistory ?? stats?.subagentHistory)?.length ?? 0})
                      </button>
                    </div>
                    <span className="text-[11px] text-[var(--text-secondary)] hidden @sm:inline">
                      (时间 · 身份 · 模型 · 轮次费用)
                    </span>
                  </div>

                  {/* History item list */}
                  <div className="flex-1 min-h-[100px] overflow-y-auto space-y-1 font-mono text-[10px] pr-0.5">
                    {billingDisplayList.slice(-25).reverse().map((r, i) => (
                      <div
                        key={r.id || i}
                        data-testid="billing-history-row"
                        className="grid min-h-11 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 hover:border-[var(--border-secondary)] @sm:min-h-0 @sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]"
                        title={
                          r.cost
                            ? `输入: ¥${r.cost.input.toFixed(5)} (${formatTokens(r.inputTokens)})\n输出: ¥${r.cost.output.toFixed(5)} (${formatTokens(r.totalOutputTokens)})\n缓存读取: ¥${r.cost.cacheRead.toFixed(5)}\n缓存写入: ¥${r.cost.cacheWrite.toFixed(5)}\n按次: ¥${(r.cost.request ?? 0).toFixed(5)}\n总计: ¥${r.cost.total.toFixed(5)}`
                            : undefined
                        }
                      >
                        <span data-testid="history-time" className="text-[11px] text-[var(--text-secondary)]">
                          {new Date(r.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                        <span
                          className={`justify-self-start rounded border px-1 text-[10px] ${
                            r.agentType === "subagent"
                              ? "border-[var(--accent-purple)]/40 bg-[var(--accent-purple)]/15 text-[var(--accent-purple-text)]"
                              : "border-[var(--border-secondary)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                          }`}
                        >
                          {r.agentType === "subagent" ? "Sub" : "Main"}
                        </span>
                        <span
                          data-testid="history-model"
                          className="col-span-3 col-start-1 row-start-2 min-w-0 break-all text-[11px] text-[var(--text-primary)] @sm:col-span-1 @sm:col-start-3 @sm:row-start-1 @sm:truncate"
                          title={r.model}
                        >
                          {cleanModelName(r.model)}
                        </span>
                        <span className="col-start-4 row-start-2 whitespace-nowrap text-[11px] text-[var(--text-secondary)] @sm:row-start-1">
                          ↓{formatTokens(r.inputTokens + r.cacheRead)} ↑{formatTokens(r.totalOutputTokens)}
                        </span>
                        <span className="col-start-4 row-start-1 justify-self-end whitespace-nowrap text-[11px] font-semibold text-[var(--accent-green-text)] @sm:col-start-5">
                          {r.cost ? `¥${r.cost.total.toFixed(4)}` : "待定价"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Legacy stub: composer-panel is removed per Option B.
 */
export function SpeedComposerPanel() {
  return null;
}

/**
 * Legacy stub: content-header-sticky is removed per Option B.
 */
export function SpeedHeaderPill() {
  return null;
}

export { billingPeriod } from "./billing-period.js";
export { FolderBillingCost, SessionBillingCost, SessionCost } from "./SessionCost.js";
export type { BillingPeriod, BillingReport, BillingReportDirectory, BillingReportSession, BillingSummary, ModelUsageSummary } from "./types.js";
export type { SpeedMonitorState } from "./useSpeedStats.js";
export type { ActiveGeneration, SpeedRecord, SpeedStatsResponse };
export { useSpeedStats };
