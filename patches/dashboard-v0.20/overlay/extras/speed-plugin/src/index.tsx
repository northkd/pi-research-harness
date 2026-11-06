import {
  mdiBrain,
  mdiClose,
  mdiCurrencyCny,
  mdiFlash,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiReceiptTextOutline,
  mdiSpeedometer,
} from "@mdi/js";
import Icon from "@mdi/react";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./details-panel.css";
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

function recordedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatRate(value: number): string {
  // Keep a positive slow response visible instead of rounding it to zero.
  return value > 0 && value < 0.1
    ? String(Number(value.toPrecision(2)))
    : String(Number(value.toFixed(1)));
}

function formatDuration(value: number | null | undefined, compact = false): string {
  if (!recordedNumber(value)) return "—";
  if (value > 0 && value < 1) return `${Math.round(value * 1000)} ms`;
  return `${value.toFixed(1)}${compact ? "s" : " 秒"}`;
}

function speedPresentation(record?: SpeedRecord | null): { kind: "measured" | "estimated" | "unavailable"; rate: number | null } {
  if (!record || record.speedStatus === "failed" || record.speedStatus === "invalid-timing")
    return { kind: "unavailable", rate: null };
  // Old responses used tps for a timestamp-derived full-response estimate.
  // Only the explicit stream provenance makes the new output-window claim.
  if (record.timingSource === "pi-stream" && record.speedCaveat !== "reasoning-not-observed" && recordedNumber(record.tps))
    return { kind: "measured", rate: record.tps };
  if (recordedNumber(record.estimatedTps))
    return { kind: "estimated", rate: record.estimatedTps };
  return { kind: "unavailable", rate: null };
}

function formatSpeed(record?: SpeedRecord | null, unit = "t/s"): string {
  const speed = speedPresentation(record);
  return speed.rate === null ? "—" : `${speed.kind === "estimated" ? "≈" : ""}${formatRate(speed.rate)} ${unit}`;
}

function speedNote(record?: SpeedRecord | null): string {
  const speed = speedPresentation(record);
  const caveat = record?.speedCaveat === "reasoning-not-observed" ? "思考用量无法与输出阶段对齐。" : "";
  if (speed.kind === "measured")
    return "输出 tokens ÷ 首个有效输出后的耗时。本地观测包含网络传输，首次输出可以是正文、思考或工具调用。";
  if (speed.kind === "estimated")
    return `${caveat}输出 tokens ÷ 完整响应耗时，包含首个有效输出前的等待；≈ 表示全程估算，不与输出阶段的速率混算。`;
  switch (record?.speedStatus) {
    case "failed": return "请求失败或已取消，本轮不计入速度均值。";
    case "insufficient-output": return `${caveat}输出样本过少，本轮不计算速度。用量记录仍然保留。`;
    case "too-short": return `${caveat}有效计时过短，本轮不计算速度。用量记录仍然保留。`;
    case "invalid-timing": return "计时记录不一致，本轮不计算速度。";
    default: return `${caveat}缺少可核验的计时信息，本轮不计算速度。用量记录仍然保留。`;
  }
}

function timingSourceLabel(record: SpeedRecord): string {
  switch (record.timingSource) {
    case "pi-stream": return "Pi 流式事件";
    case "sdk-duration": return "SDK 耗时";
    case "legacy-timestamps": return "历史时间戳";
    default: return "未记录";
  }
}

function firstOutputLabel(record: SpeedRecord): string | null {
  switch (record.firstOutputKind) {
    case "text": return "正文";
    case "thinking": return "思考";
    case "toolcall": return "工具调用";
    default: return null;
  }
}

function AgentSpeedSummary({ record, subagent = false }: { record: SpeedRecord; subagent?: boolean }) {
  return (
    <div data-testid={subagent ? "subagent-speed-summary" : "main-speed-summary"} className="flex flex-wrap justify-between items-center gap-1 px-2 py-1.5 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[10px]">
      <span className={subagent ? "text-[var(--accent-purple)] font-medium" : "text-[var(--text-secondary)] font-medium"}>
        {subagent ? "Subagent 最新" : "主 Agent 最新"}
      </span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 font-mono">
        <span className="min-w-0 break-all text-[var(--text-primary)]" title={`${record.provider || "供应商未记录"} / ${record.model}`}>
          {cleanModelName(record.model)}
        </span>
        <span className="whitespace-nowrap text-[var(--accent-yellow-text)] font-semibold" title={speedNote(record)}>
          {formatSpeed(record)}
        </span>
        <span className="whitespace-nowrap text-[var(--text-secondary)]" title="完整响应耗时">
          {formatDuration(record.durationSeconds, true)}
        </span>
      </div>
    </div>
  );
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

function panelSpace(): { width: number; height: number } {
  const compact = window.innerWidth <= 640;
  return { width: window.innerWidth - (compact ? 16 : 24), height: window.innerHeight - (compact ? 16 : 76) };
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [maximized, setMaximized] = useState(false);
  const closePanel = useCallback(() => {
    setPopoverOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // Resizable window dimensions (persisted)
  const [popoverWidth, setPopoverWidth] = useState(() => savedSize("speed-monitor-popover-width", 560, 340, panelSpace().width));

  const [popoverHeight, setPopoverHeight] = useState(() => savedSize("speed-monitor-popover-height", 720, 300, panelSpace().height));

  const isResizingRef = useRef<"width" | "bottom" | "corner" | null>(null);
  const startPosRef = useRef({ x: 0, y: 0, startW: 375, startH: 520 });
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  useEffect(() => {
    if (!popoverOpen) resizeCleanupRef.current?.();
    const fit = () => {
      const { width, height } = panelSpace();
      setPopoverWidth(w => clampSize(w, 340, width));
      setPopoverHeight(h => clampSize(h, 300, height));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [popoverOpen]);
  useEffect(() => {
    if (popoverOpen) closeRef.current?.focus({ preventScroll: true });
  }, [popoverOpen]);
  useEffect(() => {
    try {
      localStorage.setItem("speed-monitor-popover-width", String(popoverWidth));
      localStorage.setItem("speed-monitor-popover-height", String(popoverHeight));
    } catch { /* Storage may be disabled. */ }
  }, [popoverWidth, popoverHeight]);

  const latest = stats?.latest;
  const latestSpeed = speedPresentation(latest);
  const averageScope = stats?.averageScope;
  const matchesAverageScope = !!latest && !!averageScope
    && averageScope.model === latest.model
    && (averageScope.provider ?? "") === (latest.provider ?? "")
    && averageScope.agentType === (latest.agentType ?? "main");
  const measuredAverage = stats?.averageTps;
  const estimatedAverage = stats?.averageEstimatedTps;
  const avgTps = matchesAverageScope && recordedNumber(measuredAverage) ? measuredAverage : null;
  const avgEstimatedTps = matchesAverageScope && recordedNumber(estimatedAverage) ? estimatedAverage : null;

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
        // The panel is docked to the right: its left edge grows toward the left.
        const newW = clampSize(startPosRef.current.startW - dx, 340, panelSpace().width);
        setPopoverWidth(newW);
      }
      if (isResizingRef.current === "bottom" || isResizingRef.current === "corner") {
        const newH = clampSize(startPosRef.current.startH + dy, 300, panelSpace().height);
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
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [popoverOpen, closePanel]);

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
        aria-controls={popoverOpen ? panelId : undefined}
        onClick={() => popoverOpen ? closePanel() : setPopoverOpen(true)}
        title={costOnly ? "查看本月费用、主/子智能体分账与输出性能；详情面板可调大小或最大化" : isStreaming ? "本轮仅显示已用时间；结束后按实际用量和计时统计速度" : speedNote(latest)}
        className={`research-usage-trigger group flex h-6.5 items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-mono leading-none cursor-pointer select-none transition-all shadow-sm active:scale-95 ${
          costOnly
            ? "border-[var(--border-primary)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:border-[var(--accent-primary)]"
            : isStreaming
            ? "bg-[var(--bg-surface)] border-[var(--accent-green)] text-[var(--accent-green-text)] shadow-sm shadow-emerald-500/10"
            : "bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--border-secondary)] hover:bg-[var(--bg-surface)]"
        }`}
      >
        {costOnly ? (
          <span className="flex items-center gap-1 font-sans">
            <SafeIcon path={mdiCurrencyCny} size={0.48} className="text-[var(--accent-primary)]" />
            <span className="font-semibold text-[var(--text-secondary)] text-[11px]">费用</span>
            <span className="font-mono font-semibold text-[var(--text-primary)] ml-0.5">
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
            <span className="text-[var(--text-tertiary)] text-[10px]">完成后统计</span>
          </>
        ) : latest && latestSpeed.rate !== null ? (
          <>
            <SafeIcon path={mdiFlash} size={0.46} className="text-[var(--accent-yellow-text)]" />
            <span className="font-semibold text-[var(--text-primary)]">{latestSpeed.kind === "estimated" ? "≈" : ""}{formatRate(latestSpeed.rate)}</span>
            <span className="text-[var(--text-tertiary)] text-[10px]">t/s</span>
            <span className="text-[var(--text-secondary)] text-[10px]">·</span>
            <span className="text-[var(--text-secondary)] text-[10px]">{formatDuration(latest.durationSeconds, true)}</span>
          </>
        ) : (
          <>
            <SafeIcon path={mdiSpeedometer} size={0.46} className="text-[var(--text-tertiary)]" />
            <span className="text-[var(--text-tertiary)]">{latest ? "速度 —" : "速度监控"}</span>
          </>
        )}
      </button>

      {/* A portal keeps the right-side inspector out of clipped editor/header containers. */}
      {popoverOpen && createPortal(
        <div
          ref={popoverRef}
          id={panelId}
          data-testid="speed-indicator-popover"
          data-maximized={maximized}
          role="dialog"
          aria-label="会话用量与计费"
          aria-modal="false"
          style={{ width: maximized ? undefined : `${popoverWidth}px`, height: maximized ? undefined : `${popoverHeight}px` }}
          className="research-usage-panel @container z-dialog flex flex-col text-[var(--text-primary)] select-text"
          onClick={(event) => event.stopPropagation()}
        >
          {!maximized && <>
            <div
              role="separator"
              tabIndex={0}
              aria-label="调整用量面板宽度"
              aria-orientation="vertical"
              aria-valuenow={Math.round(popoverWidth)}
              aria-valuemin={Math.min(340, panelSpace().width)}
              aria-valuemax={Math.min(850, panelSpace().width)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setPopoverWidth(width => clampSize(width + (event.key === "ArrowLeft" ? 24 : -24), 340, panelSpace().width));
              }}
              onMouseDown={(event) => startResize("width", event)}
              className="research-usage-resize research-usage-resize-width"
              title="左右拖拽调节窗口宽度"
            ><span /></div>
            <div
              role="separator"
              tabIndex={0}
              aria-label="调整用量面板高度"
              aria-orientation="horizontal"
              aria-valuenow={Math.round(popoverHeight)}
              aria-valuemin={Math.min(300, panelSpace().height)}
              aria-valuemax={Math.min(850, panelSpace().height)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                setPopoverHeight(height => clampSize(height + (event.key === "ArrowDown" ? 24 : -24), 300, panelSpace().height));
              }}
              onMouseDown={(event) => startResize("bottom", event)}
              className="research-usage-resize research-usage-resize-height"
              title="上下拖拽调节窗口高度"
            ><span /></div>
            <div
              onMouseDown={(event) => startResize("corner", event)}
              className="research-usage-resize research-usage-resize-corner"
              title="对角拖拽同时调节宽高"
            ><span /></div>
          </>}

          <header className="research-usage-header">
            <div className="min-w-0 flex-1">
              <p className="research-usage-eyebrow">用量与性能</p>
              <h2 className="research-usage-title">{activeView === "billing" ? "本月费用明细" : "模型输出性能"}</h2>
              <p className="research-usage-subtitle">{activeView === "billing" ? "主 Agent 与子任务的等价消耗 · 北京时间" : "首个输出、输出速率与逐次请求记录"}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => { resizeCleanupRef.current?.(); setMaximized(value => !value); }}
                className="research-usage-icon-button"
                title={maximized ? "还原面板大小" : "最大化用量面板"}
                aria-label={maximized ? "还原用量面板" : "最大化用量面板"}
                aria-pressed={maximized}
              ><SafeIcon path={maximized ? mdiFullscreenExit : mdiFullscreen} size={0.8} /></button>
              <button
                ref={closeRef}
                type="button"
                onClick={closePanel}
                className="research-usage-icon-button"
                title="关闭"
                aria-label="关闭用量面板"
              ><SafeIcon path={mdiClose} size={0.75} /></button>
            </div>
          </header>

          {/* Sliding View Switcher Tabs (滑动的窗口切换控制器) */}
          <div className="research-usage-tabs relative flex p-1 bg-[var(--bg-tertiary)] rounded-lg text-sm font-medium select-none shrink-0">
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
              aria-pressed={activeView === "speed"}
              onClick={() => setActiveView("speed")}
              className={`relative z-10 flex-1 py-1.5 flex items-center justify-center gap-1.5 cursor-pointer rounded-lg transition-colors ${
                activeView === "speed"
                  ? "text-[var(--text-primary)] font-bold"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <SafeIcon path={mdiSpeedometer} size={0.48} className={activeView === "speed" ? "text-[var(--accent-yellow-text)]" : ""} />
              <span>速度与性能</span>
            </button>
            <button
              type="button"
              data-testid="tab-view-billing"
              aria-pressed={activeView === "billing"}
              onClick={() => setActiveView("billing")}
              className={`relative z-10 flex-1 py-1.5 flex items-center justify-center gap-1.5 cursor-pointer rounded-lg transition-colors ${
                activeView === "billing"
                  ? "text-[var(--text-primary)] font-bold"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`}
            >
              <SafeIcon path={mdiCurrencyCny} size={0.48} className={activeView === "billing" ? "text-[var(--accent-green-text)]" : ""} />
              <span>计费明细</span>
              {billing && billing.sessionTotalCost > 0 && (
                <span className="text-[11px] px-2 py-0.2 rounded-full bg-emerald-500/15 text-[var(--accent-green-text)] font-mono ml-1 font-semibold border border-emerald-500/20">
                  <SessionCost billing={billing} />
                </span>
              )}
            </button>
          </div>

          {/* Keep filters and scroll positions mounted, but show only the selected pane. */}
          <div data-testid="usage-panel-scroll" className="research-usage-content flex-1 min-h-0 overflow-y-auto">
            <div className="min-w-0">
              {/* ======================================================== */}
              {/* SLIDE 1: 速度与性能 (Speed & Performance View)           */}
              {/* ======================================================== */}
              <div data-testid="speed-panel" inert={activeView !== "speed"} aria-hidden={activeView !== "speed"} style={{ display: activeView === "speed" ? "flex" : "none" }} className="w-full min-w-0 flex-col gap-3">
                {/* Current / Latest Metrics */}
                {latest ? (
                  <div className="space-y-2 text-[11px] shrink-0">
                    <div data-testid="latest-speed-record" className="space-y-1.5">
                      <div className="pb-1.5 border-b border-[var(--border-primary)]">
                        <div data-testid="latest-speed-identity" className="text-[10px] text-[var(--text-secondary)] break-all">
                          最近一次 · {latest.agentType === "subagent" ? "Subagent" : "主 Agent"} · {latest.provider || "供应商未记录"}
                        </div>
                        <div data-testid="latest-speed-model" className="mt-1 font-mono font-medium text-[var(--text-primary)] break-all" title={latest.model}>
                          {cleanModelName(latest.model)}
                        </div>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span data-testid="current-speed-label" className="text-[var(--text-tertiary)]" title={speedNote(latest)}>
                          {latestSpeed.kind === "estimated" ? "全程估算速率" : "输出速率"}
                        </span>
                        <span data-testid="latest-speed-value" className="whitespace-nowrap font-mono text-[var(--accent-yellow-text)] font-semibold">
                          {formatSpeed(latest, "tokens/s")}
                        </span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="flex flex-wrap items-center gap-1 text-[var(--text-tertiary)]" title="从请求开始到首个有效输出；可以是正文、思考或工具调用，空事件不计入。">
                          首个有效输出 (TTFT)
                          {firstOutputLabel(latest) && <span data-testid="first-output-kind" className="rounded bg-[var(--bg-tertiary)] px-1 text-[10px] text-[var(--text-secondary)]">{firstOutputLabel(latest)}</span>}
                        </span>
                        <span data-testid="latest-speed-ttft" className="whitespace-nowrap font-mono text-[var(--text-primary)]">{formatDuration(latest.firstTokenSeconds)}</span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-[var(--text-tertiary)]" title="从首个有效输出到响应完成；包含网络传输和流内停顿。">输出阶段耗时</span>
                        <span data-testid="latest-speed-generation" className="whitespace-nowrap font-mono text-[var(--text-primary)]">{formatDuration(latest.generationSeconds)}</span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-[var(--text-tertiary)]">完整响应耗时</span>
                        <span data-testid="latest-speed-duration" className="whitespace-nowrap font-mono text-[var(--text-primary)]">{formatDuration(latest.durationSeconds)}</span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-[var(--text-tertiary)]">计时来源</span>
                        <span className="text-[var(--text-secondary)]">{timingSourceLabel(latest)}</span>
                      </div>
                      <p data-testid="speed-measurement-note" className="text-[10px] leading-relaxed text-[var(--text-secondary)]">{speedNote(latest)}</p>
                      <div className="space-y-1 pt-1.5 border-t border-[var(--border-primary)]">
                        <div data-testid="speed-average-scope" className="text-[10px] text-[var(--text-secondary)] break-all">
                          {matchesAverageScope ? `${latest.provider || "供应商未记录"} / ${cleanModelName(latest.model)} · ${latest.agentType === "subagent" ? "Subagent" : "主 Agent"}` : "同模型统计范围未记录"}
                        </div>
                        <div className="flex justify-between items-center gap-2" title="同供应商、模型和身份的有效样本：输出 tokens 总和 ÷ 输出阶段耗时总和。">
                          <span className="text-[var(--text-tertiary)]">同模型输出均速</span>
                          <span data-testid="measured-speed-average" className="whitespace-nowrap font-mono text-[var(--text-primary)] font-medium">
                            {avgTps === null ? "—" : `${formatRate(avgTps)} tokens/s · ${stats?.recentCount ?? 0} 次`}
                          </span>
                        </div>
                        {avgEstimatedTps !== null && (
                          <div className="flex justify-between items-center gap-2" title="同供应商、模型和身份的估算样本：输出 tokens 总和 ÷ 完整响应耗时总和。与输出均速分别统计。">
                            <span className="text-[var(--text-tertiary)]">同模型全程估算</span>
                            <span data-testid="estimated-speed-average" className="whitespace-nowrap font-mono text-[var(--text-secondary)]">
                              ≈{formatRate(avgEstimatedTps)} tokens/s · {stats?.estimatedCount ?? 0} 次
                            </span>
                          </div>
                        )}
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
                        <span className="text-[var(--text-tertiary)]">非思考输出 (Content):</span>
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

                    {/* Preserve each agent's latest record independently of the current card. */}
                    {stats?.latestMain && <AgentSpeedSummary record={stats.latestMain} />}
                    {stats?.latestSubagent && <AgentSpeedSummary record={stats.latestSubagent} subagent />}

                    {stats?.subagentModels && stats.subagentModels.length > 0 && (
                      <div className="flex justify-between items-center gap-2 text-[10px]">
                        <span className="text-[var(--text-tertiary)]">Subagents 所用模型:</span>
                        <div className="flex flex-wrap gap-1 justify-end max-w-[220px]">
                          {stats.subagentModels.map((m) => (
                            <span key={m} className="px-1.5 py-0.2 rounded bg-[var(--bg-tertiary)] border border-[var(--accent-purple)]/20 text-[var(--accent-purple)] font-mono text-[11px] break-all" title={m}>
                              {cleanModelName(m)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
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
                          aria-pressed={historyTab === "all"}
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
                          aria-pressed={historyTab === "main"}
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
                          aria-pressed={historyTab === "subagent"}
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
                            title={`供应商: ${r.provider || "未记录"} · 完整模型: ${r.model}`}
                          >
                            {cleanModelName(r.model)}
                          </span>
                          <span className="col-start-4 row-start-2 whitespace-nowrap text-[11px] text-[var(--text-secondary)] @sm:row-start-1">
                            {formatDuration(r.durationSeconds, true)} · {r.totalOutputTokens}t
                          </span>
                          <span data-testid="history-speed" data-speed-kind={speedPresentation(r).kind} className="col-start-4 row-start-1 justify-self-end whitespace-nowrap text-[11px] font-semibold text-[var(--accent-yellow-text)] @sm:col-start-5" title={speedNote(r)}>
                            {formatSpeed(r)}
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
                        <span data-testid="billing-total">{billing ? (!billing.complete && billing.sessionTotalCost === 0 ? "待定价" : `${billing.complete ? "" : "≥"}¥${billing.sessionTotalCost.toFixed(4)}`) : "—"}</span>
                        {billing?.complete ? (
                          <span className="text-[10px] font-sans font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-[var(--accent-green-text)] border border-emerald-500/30">
                            完整计费
                          </span>
                        ) : null}
                      </div>
                      {billing && !billing.complete && (
                        <div className="text-[11px] text-[var(--accent-yellow-text)] font-medium mt-1">
                          {billing.unpricedTurns} 轮待定价 · {billing.invalidRecords} 条用量未能读取
                        </div>
                      )}
                    </div>
                    {billing?.totalCacheSavings && billing.totalCacheSavings > 0 ? (
                      <div className="text-right rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1.5">
                        <div className="text-[10.5px] text-[var(--accent-green-text)] font-semibold">缓存节省</div>
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
                      <span className="text-[var(--accent-purple-text)] font-medium flex items-center gap-1">
                        <SafeIcon path={mdiBrain} size={0.38} />
                        <span>Subagents:</span>
                      </span>
                      <span className="font-mono text-[var(--accent-purple-text)] font-bold">
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
                        aria-pressed={billingHistoryTab === "all"}
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
                        aria-pressed={billingHistoryTab === "main"}
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
                        aria-pressed={billingHistoryTab === "subagent"}
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
                  <div data-testid="billing-history" className="flex-1 min-h-[100px] overflow-y-auto space-y-1 font-mono text-[10px] pr-0.5">
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
          <footer className="research-usage-footer">费用按北京时间每月 1 日归零；等价消耗以当前定价计算。</footer>
        </div>,
        document.body,
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
