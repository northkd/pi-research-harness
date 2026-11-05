import { useEffect, useRef, useState } from "react";
import { Dialog } from "@blackbelt-technology/pi-dashboard-client-utils/Dialog";
import { useSessionSubagents } from "@blackbelt-technology/dashboard-plugin-runtime";
import { useLocation } from "wouter";
import {
  mdiContentCopy,
  mdiCheck,
  mdiAlertCircleOutline,
  mdiCrown,
  mdiRobot,
  mdiSend,
  mdiLightningBolt,
  mdiClose,
  mdiCheckCircleOutline,
  mdiAccountVoice,
  mdiCurrencyCny,
  mdiFileDocumentOutline,
  mdiShieldCheckOutline,
  mdiClockOutline,
  mdiBrain,
  mdiOpenInNew,
  mdiInformationOutline,
  mdiTagOutline,
} from "@mdi/js";
import { Icon } from "@mdi/react";
import { useApiBase } from "../../lib/api/api-context.js";
import { MarkdownContent } from "../preview/MarkdownContent.js";
import { executionRoleName, getSubagentRoleDisplayTitle } from "./ResearchExecutionPanels.js";
import type { ConfiguredRole, ResearchRun, ResearchStep, ResearchExecution } from "./research-projection.js";

export interface ResearchAgentInstance { run: ResearchRun; step: ResearchStep }

const STATUS_LABELS: Record<string, string> = {
  registered: "已登记", active: "活跃中", idle: "待命中", streaming: "正在生成", ended: "会话已结束",
  complete: "执行完成", pending: "等待派发", partial: "部分完成", stopping: "正在停止", rejected: "已拒绝",
  queued: "排队中", started: "已启动", running: "持续执行中", completed: "已结束", failed: "执行告警/失败",
  blocked: "阻塞中", paused: "已暂停", stopped: "已停止", cancelled: "已取消", waiting: "等待流程返回",
  planned: "规划完成", experiments_completed: "实验步骤结束", converged: "评审收敛通过",
  max_rounds_reached: "达到评审轮次上限", unknown: "未观测"
};

export function researchStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : status;
}

export function executionRecordStatus(row: ResearchExecution, stale = false): string {
  if (row.source === "observation" && stale) return "观测已过期";
  const source = row.source === "workflow-record" ? "工作流记录" : row.kind === "pi-session" ? "独立会话" : "原生子任务";
  return `${source} · ${researchStatusLabel(row.status)}`;
}

export function roleLabel(name: string): string { return name.replace(/^research-/, ""); }
export function instanceKey(instance: ResearchAgentInstance): string { return JSON.stringify([instance.run.runId, instance.step.key]); }

export function formatTimestamp(value?: string | number | null): string {
  if (!value) return "未记录";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDuration(start?: string | null, end?: string | null): string | null {
  if (!start || !end) return null;
  const t1 = Date.parse(start), t2 = Date.parse(end);
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 < t1) return null;
  const sec = Math.round((t2 - t1) / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min} 分 ${remSec} 秒`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr} 小时 ${remMin} 分`;
}

import { getResearchProjectCharter } from "./research-presentation.js";
export { getResearchProjectCharter } from "./research-presentation.js";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="focus-ring inline-flex items-center gap-1 rounded-md border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
      title="复制全文"
    >
      <Icon path={copied ? mdiCheck : mdiContentCopy} size={0.55} className={copied ? "text-emerald-400" : ""} />
      <span>{copied ? "已复制" : "复制"}</span>
    </button>
  );
}

interface UserCorrection {
  id: string;
  text: string;
  timestamp: string;
  status: "sending" | "delivered" | "failed";
  error?: string;
  targetSessionId: string;
  promptId?: string;
  contended?: boolean;
}

export function ResearchAgentDetail({
  role,
  instances,
  initialInstance,
  executions = [],
  allExecutions,
  cwd,
  initialExecution,
  observationsStale = false,
  onClose,
  onOpenArtifact,
  onSelectExecution,
  visible = true,
}: {
  role: ConfiguredRole;
  instances: ResearchAgentInstance[];
  initialInstance?: string;
  executions?: ResearchExecution[];
  allExecutions?: ResearchExecution[];
  cwd?: string;
  initialExecution?: string;
  observationsStale?: boolean;
  onClose: () => void;
  onOpenArtifact?: (path: string) => void;
  onSelectExecution?: (role: ConfiguredRole, execution: ResearchExecution) => void;
  visible?: boolean;
}) {
  const apiBase = useApiBase();
  const [, navigate] = useLocation();

  // 轮次与实例均按照创建时间由晚到早（降序）排列
  const sortedExecutions = [...executions].sort((a, b) => {
    const timeA = a.startedAt ?? a.lastActivityAt ?? a.observedAt ?? "";
    const timeB = b.startedAt ?? b.lastActivityAt ?? b.observedAt ?? "";
    return timeB.localeCompare(timeA);
  });

  const sortedInstances = [...instances].sort((a, b) => {
    const timeA = a.step.startedAt ?? a.step.lastActivityAt ?? a.run.registeredAt ?? "";
    const timeB = b.step.startedAt ?? b.step.lastActivityAt ?? b.run.registeredAt ?? "";
    return timeB.localeCompare(timeA);
  });

  const [selectedInstance, setSelectedInstance] = useState<string | null>(
    initialInstance ?? (sortedInstances.length === 1 ? instanceKey(sortedInstances[0]) : null)
  );
  const activeInstance = sortedInstances.find(inst => instanceKey(inst) === selectedInstance);
  const subagents = useSessionSubagents(activeInstance?.run.parentSessionId ?? "");
  const hasResolvedChildConversation = Boolean(
    activeInstance?.step.childRunId &&
    activeInstance?.run.parentSessionId &&
    subagents.has(activeInstance.step.childRunId)
  );
  const [selectedExecution, setSelectedExecution] = useState(initialExecution ?? (sortedExecutions.length === 1 ? sortedExecutions[0].id : null));
  const execution = sortedExecutions.find(row => row.id === selectedExecution);

  // User real-time corrections state
  const [corrections, setCorrections] = useState<UserCorrection[]>([]);
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const followsOutput = useRef(true);
  const [showAllChildren, setShowAllChildren] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(true);

  // Auto-scroll chat when new message or correction arrives
  useEffect(() => {
    if (chatScrollRef.current && followsOutput.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [corrections, execution?.output]);

  // Determine prompt, output, error
  const promptText = execution?.prompt || (activeInstance?.step?.summary?.startsWith("任务：") ? activeInstance.step.summary : null);
  const outputText = execution?.output || activeInstance?.step?.summary || null;
  const recentOutputs = execution?.recentOutput || [];
  const errorText = execution?.error;
  const universe = allExecutions ?? executions;
  // A lead is identified only by an explicitly named role, not inferred from history.
  const isCaptain = execution?.kind === "pi-session" && role.name === "主控 Agent 会话";
  const isStale = execution?.source === "observation" && observationsStale;
  const isLive = execution && !isStale ? ["running", "streaming", "started"].includes(execution.status) : false;

  // 开始与结束时间计算
  const startTime = execution?.startedAt ?? activeInstance?.step.startedAt;
  const endTime = execution?.endedAt ?? activeInstance?.step.endedAt;
  const durationText = formatDuration(startTime, endTime);

  const displayTitle =
    execution?.kind === "native-subagent" || role.name.startsWith("research-")
      ? getSubagentRoleDisplayTitle(role.name)
      : roleLabel(role.name);

  // Parent Multi-Agent & Dispatched Child Subagent lineage
  const parentMultiAgent =
    execution?.parentExecutionId
      ? universe.find(ex => ex.id === execution.parentExecutionId)
      : undefined;
  const dispatchedChildSubagents =
    execution?.kind === "pi-session"
      ? universe.filter(ex => ex.kind === "native-subagent" && ex.parentExecutionId === execution.id)
      : [];

  // Actual used skills
  const actualSkills = execution?.currentTool ? [execution.currentTool] : [];

  // Project charter
  const charter = getResearchProjectCharter(role.name, isCaptain, execution?.kind, execution, cwd);

  // Only evidence paths actually recorded for this execution are offered.
  const projectArtifacts = Array.from(new Set([
    ...(execution?.evidence ?? []), ...(activeInstance?.step.evidence ?? []),
  ])).filter((item) => item && !item.startsWith("/") && !item.includes("\\") &&
    !item.split("/").includes("..") && !/^[a-z]+:/i.test(item))
    .map((item) => ({ title: item, path: item, desc: "执行记录中关联的证据" }));

  // Send real-time correction prompt
  const handleSendCorrection = async (overrideText?: string) => {
    const textToSend = (overrideText ?? inputText).trim();
    if (!textToSend || isSending || !execution?.sessionId) return;

    const targetSessionId = execution?.sessionId;
    const correctionId = `corr-${Date.now()}`;
    const newCorr: UserCorrection = {
      id: correctionId,
      text: textToSend,
      timestamp: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      status: "sending",
      targetSessionId,
    };

    setCorrections((prev) => [...prev, newCorr]);
    setInputText("");
    setIsSending(true);

    try {
        const res = await fetch(`${apiBase}/api/session/${encodeURIComponent(targetSessionId)}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: textToSend }),
        });
        const receipt = await res.json().catch(() => null);
        if (!res.ok) throw new Error(receipt?.error || `HTTP ${res.status}`);
        if (receipt?.success !== true || receipt?.transmitted !== true) throw new Error("服务未返回可验证的提交回执，请核对目标会话；不会自动重试。");
      setCorrections((prev) =>
        prev.map((c) => (c.id === correctionId ? { ...c, status: "delivered", promptId: typeof receipt.promptId === "string" ? receipt.promptId : undefined, contended: receipt.bridgeState === "contended" } : c))
      );
    } catch (err: any) {
      setCorrections((prev) =>
        prev.map((c) =>
          c.id === correctionId ? { ...c, status: "failed", error: err?.message || "发送失败" } : c
        )
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendCorrection();
    }
  };

  return (
    <Dialog
      open={visible}
      onClose={onClose}
      title=""
      size="full"
      flush
      ariaLabel={`${displayTitle} 执行详情`}
      testId="research-agent-detail"
    >
      <div className="research-agent-detail flex h-[90vh] min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
        {/* =========================================================================
            HEADER: 高质感顶栏，展示 Agent 身份、角色、模型、阶段与关闭按钮
            ========================================================================= */}
        <header className="win11-acrylic-bar flex shrink-0 items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3.5 min-w-0">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border shadow-xs ${
                isCaptain
                  ? "tint-action-orange"
                  : execution?.kind === "native-subagent"
                  ? "tint-action-purple"
                  : "tint-action-blue"
              }`}
            >
              <Icon path={isCaptain ? mdiCrown : execution?.kind === "native-subagent" ? mdiLightningBolt : mdiRobot} size={0.95} />
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-bold text-[var(--text-primary)] tracking-tight">
                  {displayTitle}
                </h3>

                {/* Status beacon */}
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                    isLive
                      ? "tint-action-green"
                      : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                  }`}
                >
                  {isLive && (
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-green)] opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-green)]" />
                    </span>
                  )}
                  {execution ? executionRecordStatus(execution, observationsStale) : activeInstance ? researchStatusLabel(activeInstance.step.status) : "暂无已选执行记录"}
                </span>

                {/* Subagent vs Multi-Agent Collaboration relationship */}
                <span
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-0.5 text-xs font-medium border ${
                    isCaptain
                      ? "tint-action-orange"
                      : execution?.kind === "native-subagent"
                      ? "tint-action-purple"
                      : "tint-action-blue"
                  }`}
                >
                  {isCaptain
                    ? "已登记主控角色 · 独立会话"
                    : execution?.kind === "native-subagent"
                    ? "原生 Subagent · 父会话派发任务"
                    : execution?.kind === "pi-session" ? "Multi-Agent · 独立上下文会话" : "工作流记录 / 角色配置"}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
                <span>观测模型：<strong className="font-mono text-[var(--text-primary)] font-semibold">{execution?.observedModel ?? activeInstance?.step.observedModel ?? "未观测模型"}</strong></span>
                <span>•</span>
                <span>阶段：<strong className="text-[var(--text-primary)] font-semibold">{execution?.stage ?? activeInstance?.step.stage ?? "未登记"}</strong></span>
                <span>•</span>
                <span className="inline-flex items-center gap-1 font-mono">
                  <Icon path={mdiClockOutline} size={0.5} className="text-[var(--accent-primary)]" />
                  <span>开始: <strong className="text-[var(--text-primary)] font-semibold">{formatTimestamp(startTime)}</strong></span>
                </span>
                <span>•</span>
                <span className="inline-flex items-center gap-1 font-mono">
                  <Icon path={mdiClockOutline} size={0.5} className="text-[var(--accent-primary)]" />
                  <span>结束: <strong className="text-[var(--text-primary)] font-semibold">{isLive ? "持续执行中" : formatTimestamp(endTime)}</strong></span>
                </span>
                {durationText && (
                  <>
                    <span>•</span>
                    <span>耗时: <strong className="text-[var(--accent-text)] font-semibold">{durationText}</strong></span>
                  </>
                )}
                {parentMultiAgent && (
                  <>
                    <span>•</span>
                    <span className="text-[var(--accent-text)] font-medium">
                      派发父会话：{executionRoleName(parentMultiAgent)}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button type="button" className="win11-btn px-2.5 py-1.5 text-xs" aria-expanded={metadataOpen} onClick={() => setMetadataOpen(value => !value)}>{metadataOpen ? "收起详情" : "执行详情"}</button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭对话"
              className="win11-btn p-1.5 text-[var(--text-secondary)]"
              title="关闭 (Esc)"
            >
              <Icon path={mdiClose} size={0.8} />
            </button>
          </div>
        </header>

        {/* =========================================================================
            BODY: 宽屏双栏架构 (Left: 本研究专项职责与完整元数据; Right: 对话流与实时纠偏)
            ========================================================================= */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden divide-y md:divide-y-0 md:divide-x divide-[var(--border-primary)]">
          {/* -----------------------------------------------------------------------
              LEFT COLUMN: 智能体在当前项目中的专项职责、父子协同关系、完整执行参数、工具与成果
              ----------------------------------------------------------------------- */}
          <aside hidden={!metadataOpen} className="research-agent-metadata w-full md:w-80 lg:w-[340px] shrink-0 bg-[var(--bg-secondary)] overflow-y-auto p-4 space-y-4">
            {/* Section 1: 本研究专项工作职责 */}
            <div className="win11-card p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-[var(--border-primary)] pb-2.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-primary)]">
                  <Icon path={mdiShieldCheckOutline} size={0.65} className="text-[var(--accent-green)]" />
                  <span>本研究专项工作职责</span>
                </div>
                <span className="rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-[10.5px] font-mono text-[var(--text-secondary)] border border-[var(--border-primary)]">
                  {charter.scientificScope}
                </span>
              </div>

              <div>
                <h4 className="text-sm font-bold text-[var(--accent-text)] leading-snug">
                  {charter.projectTitle}
                </h4>
                <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  {charter.dutySummary}
                </p>
              </div>

              <div className="pt-2 border-t border-[var(--border-primary)] space-y-1.5">
                <span className="text-[11px] font-semibold text-[var(--text-tertiary)]">关键成果交付项:</span>
                <div className="flex flex-wrap gap-1.5">
                  {charter.deliverables.map((item, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1 rounded bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-secondary)] border border-[var(--border-primary)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-green)]" />
                      <span>{item}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Section 1.5: 父子协同关系与融合节点 (Multi-Agent ⇄ Subagent Fused Lineage) */}
            {(parentMultiAgent || dispatchedChildSubagents.length > 0) && (
              <div className="win11-card p-4 space-y-2.5">
                <div className="flex items-center justify-between border-b border-[var(--border-primary)] pb-2 text-xs font-bold text-[var(--text-primary)]">
                  <span className="flex items-center gap-1.5">
                    <Icon path={mdiLightningBolt} size={0.65} className="text-[var(--accent-purple)]" />
                    <span>Multi-Agent ⇄ Subagent 协同归属</span>
                  </span>
                  <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">
                    {parentMultiAgent ? "子任务溯源" : `下辖 ${dispatchedChildSubagents.length} 子任务`}
                  </span>
                </div>

                {parentMultiAgent && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      本 Subagent 微任务由以下 Multi-Agent 父会话单向派发：
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const pTitle = executionRoleName(parentMultiAgent);
                        onSelectExecution?.({ name: pTitle, skills: [] }, parentMultiAgent);
                      }}
                      className="win11-card-subtle w-full text-left p-2.5 border-l-[3px] border-l-[var(--accent-blue)] hover:bg-[var(--bg-hover)] transition-all"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-bold text-[var(--accent-text)]">
                        <span className="truncate">🤖 {executionRoleName(parentMultiAgent)}</span>
                        <Icon path={mdiOpenInNew} size={0.5} className="shrink-0" />
                      </div>
                      <div className="mt-1 text-[10.5px] font-mono text-[var(--text-tertiary)] truncate">
                        Session ID: {parentMultiAgent.sessionId?.slice(0, 12) ?? parentMultiAgent.id}
                      </div>
                    </button>
                  </div>
                )}

                {dispatchedChildSubagents.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      已记录的原生 Subagent 子任务 · {dispatchedChildSubagents.length} 项
                    </div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {(showAllChildren ? dispatchedChildSubagents : dispatchedChildSubagents.slice(0, 12)).map((sub, idx) => {
                        const subRoleName = executionRoleName(sub);
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            onClick={() =>
                              onSelectExecution?.({ name: subRoleName, skills: [] }, sub)
                            }
                            className="win11-card-subtle w-full text-left p-2 border-l-[3px] border-l-[var(--accent-purple)] hover:bg-[var(--bg-hover)] transition-all"
                          >
                            <div className="flex items-center justify-between gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                              <span className="truncate">
                                ⚡ #{idx + 1} · {getSubagentRoleDisplayTitle(subRoleName)}
                              </span>
                              <span className="shrink-0 font-mono text-[10px] text-[var(--accent-text)]">
                                {executionRecordStatus(sub, observationsStale)}
                              </span>
                            </div>
                            {sub.prompt && (
                              <div className="mt-0.5 text-[10.5px] text-[var(--text-secondary)] truncate">
                                {sub.prompt.replace(/^Task:\s*/i, "").replace(/\s+/g, " ").slice(0, 60)}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {dispatchedChildSubagents.length > 12 && <button type="button" className="research-show-more" onClick={() => setShowAllChildren(value => !value)}>{showAllChildren ? "仅显示最近 12 项" : `查看全部 ${dispatchedChildSubagents.length} 项子任务`}</button>}
                  </div>
                )}
              </div>
            )}

              {/* Section 2: 完整执行遥测与参数 (Execution Telemetry & Parameters) */}
            <div className="win11-card p-4 space-y-3">
              <div className="flex items-center gap-1.5 border-b border-[var(--border-primary)] pb-2 text-xs font-bold text-[var(--text-primary)]">
                <Icon path={mdiInformationOutline} size={0.65} className="text-[var(--accent-primary)]" />
                <span>执行状态与完整遥测</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="win11-card-subtle p-2.5">
                  <div className="text-[10.5px] text-[var(--text-tertiary)] font-medium">执行识别码 (ID)</div>
                  <div className="mt-1 font-mono text-[11px] font-medium text-[var(--text-primary)] truncate" title={execution?.id}>
                    {execution?.id || "未分配 ID"}
                  </div>
                </div>

                <div className="win11-card-subtle p-2.5">
                  <div className="text-[10.5px] text-[var(--text-tertiary)] font-medium">会话通道 (Session)</div>
                  <div className="mt-1 font-mono text-[11px] font-medium text-[var(--text-primary)] truncate" title={execution?.sessionId}>
                    {execution?.sessionId ? execution.sessionId : "未记录可投递的会话"}
                  </div>
                </div>

                <div className="win11-card-subtle p-2.5">
                  <div className="text-[10.5px] text-[var(--text-tertiary)] font-medium">当前阶段</div>
                  <div className="mt-1 font-semibold text-[var(--text-primary)]">
                    {execution?.stage || activeInstance?.step.stage || "阶段未登记"}
                  </div>
                </div>

                <div className="win11-card-subtle p-2.5">
                  <div className="text-[10.5px] text-[var(--text-tertiary)] font-medium">协作形态</div>
                  <div className="mt-1 font-semibold text-[var(--accent-text)]">
                    {isCaptain ? "已登记主控角色" : execution?.kind === "native-subagent" ? "原生 Subagent" : execution?.kind === "pi-session" ? "独立协同会话" : "工作流记录"}
                  </div>
                </div>

                <div className="win11-card-subtle p-2.5">
                  <div className="text-[10.5px] text-[var(--text-tertiary)] font-medium flex items-center gap-1">
                    <Icon path={mdiClockOutline} size={0.45} />
                    <span>开始时间</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] font-medium text-[var(--text-primary)] truncate" title={formatTimestamp(startTime)}>
                    {formatTimestamp(startTime)}
                  </div>
                </div>

                <div className="win11-card-subtle p-2.5">
                  <div className="text-[10.5px] text-[var(--text-tertiary)] font-medium flex items-center gap-1">
                    <Icon path={mdiClockOutline} size={0.45} />
                    <span>结束时间</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] font-medium text-[var(--text-primary)] truncate" title={isLive ? "持续执行中" : formatTimestamp(endTime)}>
                    {isLive ? (
                      <span className="inline-flex items-center gap-1 text-[var(--accent-green)] font-semibold">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-green)] animate-ping" />
                        <span>持续执行中</span>
                      </span>
                    ) : (
                      formatTimestamp(endTime)
                    )}
                  </div>
                </div>
              </div>

              {/* Model & Config row */}
              <div data-testid="research-agent-configuration" className="win11-card-subtle p-3 text-xs space-y-1">
                <div className="flex justify-between items-center text-[10.5px] text-[var(--text-tertiary)]">
                  <span>模型配置口径</span>
                  <span className="font-mono">{execution?.observedModel ? "实际观测模型" : "静态声明模型"}</span>
                </div>
                <div className="font-mono font-semibold text-[var(--text-primary)] break-all">
                  {execution?.observedModel ?? role.model ?? "尚未观测"}
                </div>
              </div>

              {/* Skills and tools */}
              <div className="space-y-1.5 pt-1">
                <span className="text-[11px] font-semibold text-[var(--text-tertiary)] flex items-center gap-1">
                  <Icon path={mdiLightningBolt} size={0.5} className="text-[var(--accent-orange)]" />
                  <span>当前工具观测{isStale ? "（已过期）" : ""}：</span>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {actualSkills.length > 0 ? (
                    actualSkills.map((sk) => (
                      <span key={sk} className="tint-action-orange rounded border px-2 py-0.5 font-mono text-[11px]">
                        {sk}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-[var(--text-tertiary)]">暂无工具调用观测</span>
                  )}
                </div>
                <p className="text-[11px] text-[var(--text-tertiary)]">配置技能：{role.skills.length ? role.skills.join("、") : "未配置"}；配置不代表已调用。</p>
              </div>
            </div>

            {/* Section 3: 关联科研文件与成果 (Project Artifacts) */}
            <div className="win11-card p-4 space-y-2.5">
              <div className="flex items-center gap-1.5 border-b border-[var(--border-primary)] pb-2 text-xs font-bold text-[var(--text-primary)]">
                <Icon path={mdiFileDocumentOutline} size={0.65} className="text-[var(--accent-primary)]" />
                <span>关联科研文件与核心成果</span>
              </div>

              <div className="space-y-1.5">
                {projectArtifacts.length === 0 && <span className="text-xs text-[var(--text-tertiary)]">暂无已记录的关联文件</span>}
                {projectArtifacts.map((art) => (
                  <button
                    key={art.path}
                    type="button"
                    aria-label={art.path}
                    onClick={() => {
                      onOpenArtifact?.(art.path);
                      onClose();
                    }}
                    className="win11-card-subtle w-full text-left p-2.5 hover:bg-[var(--bg-hover)] transition-all group"
                  >
                    <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent-text)]">
                      <span className="truncate">{art.title}</span>
                      <Icon path={mdiOpenInNew} size={0.5} className="shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--accent-text)]" />
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-[var(--text-tertiary)] truncate">{art.desc}</div>
                  </button>
                ))}
              </div>

              {execution?.lastActivityAt && <p className="text-[11px] text-[var(--text-tertiary)]">最后活动：{formatTimestamp(execution.lastActivityAt)}（不作为结束时间）</p>}
            </div>

            {/* Legacy tests compatibility fallback */}
            {executions.length === 0 && instances.length === 0 && (
              <div data-testid="research-agent-unstarted" className="win11-card-subtle p-3 text-xs text-[var(--text-tertiary)]">
                暂无可验证运行记录
              </div>
            )}
            {sortedExecutions.length > 1 && <div className="space-y-2"><label className="text-xs text-[var(--text-tertiary)]" htmlFor="research-observed-execution">观测执行实例</label><select id="research-observed-execution" value={selectedExecution ?? ""} onChange={event => setSelectedExecution(event.target.value || null)} className="w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs"><option value="">选择要查看的执行</option>{sortedExecutions.map(row => <option key={row.id} value={row.id}>{formatTimestamp(row.startedAt ?? row.lastActivityAt)} · {researchStatusLabel(row.status)}</option>)}</select></div>}
            {instances.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-[var(--border-primary)]">
                <div className="text-xs font-semibold text-[var(--text-tertiary)]">历史实例列表:</div>
                <div className="space-y-1">
                  {instances.map((inst) => {
                    const k = instanceKey(inst);
                    return (
                      <button
                        key={k}
                        type="button"
                        data-testid="research-agent-instance"
                        onClick={() => setSelectedInstance(k)}
                        className={`w-full text-left px-2.5 py-1.5 rounded text-xs border ${
                          selectedInstance === k ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-primary)]" : "border-[var(--border-primary)] text-[var(--text-secondary)]"
                        }`}
                      >
                        {inst.step.key} · {inst.step.summary?.slice(0, 24)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {activeInstance && (
              <div data-testid="research-agent-instance-detail" className="win11-card-subtle p-3 text-xs space-y-1.5">
                <div className="font-semibold text-[var(--text-primary)]">实例详情: {activeInstance.step.key}</div>
                <div>状态: {researchStatusLabel(activeInstance.step.status)}</div>
                {activeInstance.step.businessStatus === "blocked" && <div className="text-[var(--severity-warning-fg)]">阻塞（不代表科学验收）</div>}
                <div>{activeInstance.step.observedModel ?? "尚未观测"}</div>
                <div>{activeInstance.step.summary}</div>
                {activeInstance.step.childRunId ? (
                  hasResolvedChildConversation ? (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(
                          `/session/${encodeURIComponent(activeInstance.run.parentSessionId!)}/subagent/${encodeURIComponent(activeInstance.step.childRunId!)}`
                        )
                      }
                      className="win11-btn px-2.5 py-1 text-xs text-[var(--accent-text)]"
                    >
                      打开关联对话
                    </button>
                  ) : (
                    <div className="text-[11px] text-[var(--text-secondary)]">暂无可验证的完整对话关联</div>
                  )
                ) : null}
              </div>
            )}
          </aside>

          {/* -----------------------------------------------------------------------
              RIGHT COLUMN: 宽敞、清晰易读的对话流 (Prompt + Agent Reply + 实时纠偏)
              ----------------------------------------------------------------------- */}
          <main className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
            {/* Dialogue stream scroll container */}
            <div
              ref={chatScrollRef}
              data-testid="research-agent-dialogue-stream"
              onScroll={event => { const node = event.currentTarget; followsOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64; }}
              className="flex-1 min-h-0 overflow-y-auto px-6 py-6 md:px-10 space-y-6 select-text scroll-smooth"
            >
              {/* Turn 1: User / System Input Prompt */}
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mr-1">
                  <span className="flex items-center gap-1.5 font-bold text-[var(--text-primary)]">
                    <Icon path={mdiAccountVoice} size={0.65} className="text-[var(--accent-primary)]" />
                    <span>任务输入与指令 (Prompt)</span>
                  </span>
                  {promptText && <CopyButton text={promptText} />}
                </div>
                
                <div className="win11-card w-full max-w-4xl border-l-4 border-l-[var(--accent-primary)] p-5 text-[14px] leading-relaxed text-[var(--text-primary)] break-words whitespace-pre-wrap font-sans min-w-0 max-w-full overflow-hidden [overflow-wrap:anywhere]">
                  {promptText || "暂无已记录的任务输入。"}
                </div>
              </div>

              {/* Tool Execution Strip */}
              {actualSkills.length > 0 && (
                <div className="flex items-center justify-center my-3">
                  <div className="tint-action-blue inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs shadow-xs">
                    <Icon path={mdiLightningBolt} size={0.6} />
                    <span>工具观测{isStale ? "（已过期）" : ""}：</span>
                    <div className="flex flex-wrap gap-1.5 font-mono font-semibold text-[var(--text-primary)]">
                      {actualSkills.map((sk) => (
                        <span key={sk} className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 border border-[var(--border-primary)] text-[11.5px]">
                          {sk}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Turn 2: Agent Response Bubble */}
              <div className="flex items-start gap-4">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border shadow-xs mt-0.5 ${
                    isCaptain
                      ? "tint-action-orange"
                      : execution?.kind === "native-subagent"
                      ? "tint-action-purple"
                      : "tint-action-blue"
                  }`}
                >
                  <Icon path={isCaptain ? mdiCrown : execution?.kind === "native-subagent" ? mdiLightningBolt : mdiRobot} size={0.8} />
                </div>

                <div className="flex-1 min-w-0 max-w-4xl">
                  <div className="mb-2 ml-1 flex items-center justify-between text-xs text-[var(--text-secondary)]">
                    <span className="font-bold text-[var(--text-primary)] flex items-center gap-2">
                      <span className="text-sm">{roleLabel(role.name)}</span>
                      <span className="text-xs font-normal text-[var(--text-tertiary)]">已记录输出</span>
                    </span>
                    {outputText && <CopyButton text={outputText} />}
                  </div>

                  <div className="win11-card p-6 text-[14px] leading-relaxed text-[var(--text-primary)] space-y-4 min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]">
                    {errorText && (
                      <div className="mb-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-300">
                        <div className="flex items-center gap-1.5 font-bold text-rose-400 text-xs">
                          <Icon path={mdiAlertCircleOutline} size={0.65} />
                          <span>运行告警 / 错误提示</span>
                        </div>
                        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-xs">{errorText}</pre>
                      </div>
                    )}

                    {outputText ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none break-words [overflow-wrap:anywhere] min-w-0 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--border-secondary)] [&_th]:bg-[var(--bg-tertiary)] [&_th]:p-3 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-[var(--border-secondary)] [&_td]:p-3 [&_pre]:bg-[var(--bg-primary)] [&_pre]:p-4 [&_pre]:rounded-xl [&_code]:font-mono">
                        <MarkdownContent content={outputText} />
                      </div>
                    ) : recentOutputs.length > 0 ? (
                      <div className="space-y-1.5 font-mono text-xs text-[var(--text-secondary)] bg-[var(--bg-primary)] p-4 rounded-xl border border-[var(--border-secondary)]">
                        {recentOutputs.map((line, idx) => (
                          <div key={idx} className="break-words">{line}</div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 py-6 text-[var(--text-secondary)] text-sm">
                        <span>{isStale ? "观测已过期，尚无可展示的输出。" : isLive ? "执行中，尚未观测到输出。" : "暂无已记录输出。"}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* User Dynamic Corrections Stream */}
              {corrections.map((corr) => (
                <div key={corr.id} className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mr-1">
                    <span className="font-semibold text-emerald-400 flex items-center gap-1">
                      <Icon path={mdiSend} size={0.5} />
                      <span>用户实时纠偏指令</span>
                    </span>
                    <span>•</span>
                    <time className="text-[11px] text-[var(--text-tertiary)]">{corr.timestamp}</time>
                    <span title={corr.targetSessionId}>目标会话：{corr.targetSessionId.slice(0, 16)}</span>
                    {corr.status === "delivered" && (
                      <span className="flex items-center gap-1 text-emerald-400 font-medium text-[11px]">
                        <Icon path={mdiCheckCircleOutline} size={0.5} />
                        <span title={corr.promptId}>已提交到目标会话（尚未确认接收）</span>
                      </span>
                    )}
                    {corr.status === "sending" && <span className="text-amber-400 text-[11px]">正在下达…</span>}
                    {corr.status === "failed" && <span className="text-rose-400 text-[11px]">发送失败: {corr.error}</span>}
                    {corr.status === "failed" && <button type="button" className="text-[var(--accent-text)]" onClick={() => setInputText(corr.text)}>重新编辑</button>}
                    {corr.contended && <span className="text-[var(--severity-warning-fg)]">桥接存在会话竞争，请核对实际接收情况后再决定是否重发。</span>}
                  </div>
                  <div className="w-full max-w-4xl rounded-2xl rounded-tr-sm bg-emerald-500/10 border border-emerald-500/30 border-l-4 border-l-emerald-500 text-[var(--text-primary)] p-4 text-[13.5px] leading-relaxed shadow-sm break-words whitespace-pre-wrap font-sans">
                    {corr.text}
                  </div>
                </div>
              ))}
            </div>

            {/* =========================================================================
                FOOTER: 实时纠偏与动态干预输入栏
                ========================================================================= */}
            <footer className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 md:p-5 space-y-3 shadow-inner">
              {/* Quick Intervention Shortcuts */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-[var(--text-secondary)] flex items-center gap-1">
                  <span>纠偏模板（填入后发送）:</span>
                </span>
                <button
                  type="button"
                  onClick={() => setInputText("请聚焦已记录的阶段目标，说明当前进展、关键证据及尚未解决的问题。")}
                  className="rounded-full border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1 text-[11.5px] text-[var(--text-secondary)] hover:border-emerald-500 hover:text-emerald-400 transition-colors shadow-sm"
                >
                  🎯 聚焦阶段目标
                </button>
                <button
                  type="button"
                  onClick={() => setInputText("请按本项目已声明的实验条件复核参数、收敛情况和异常点；缺少条件或证据时先列出待确认项，不自行补设数值。")}
                  className="rounded-full border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1 text-[11.5px] text-[var(--text-secondary)] hover:border-emerald-500 hover:text-emerald-400 transition-colors shadow-sm"
                >
                  🧪 核对实验条件
                </button>
                <button
                  type="button"
                  onClick={() => setInputText("请重新复核已有引文和数据来源，标记未核验项并避免主观推断。")}
                  className="rounded-full border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1 text-[11.5px] text-[var(--text-secondary)] hover:border-emerald-500 hover:text-emerald-400 transition-colors shadow-sm"
                >
                  🔍 严谨复核数据
                </button>
                <button
                  type="button"
                  onClick={() => setInputText("请评估当前思路的阻碍，提出一个替代方案，并说明切换所需的条件与影响，等待确认后再执行。")}
                  className="rounded-full border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1 text-[11.5px] text-[var(--text-secondary)] hover:border-emerald-500 hover:text-emerald-400 transition-colors shadow-sm"
                >
                  提议替代思路
                </button>
              </div>
              <p className="text-[11px] text-[var(--text-secondary)]" data-testid="research-correction-target">{execution?.sessionId ? `发送到会话 ${execution.sessionId}。这是文字指令，不会直接停止运行中的任务。` : "此记录没有可投递的 sessionId。可以编辑或复制草稿，请到实际会话发送；此处不能投递。"}</p>

              {/* Interactive Textarea & Send Button */}
              <div className="win11-card flex items-end gap-3 p-3 focus-within:border-[var(--accent-primary)] transition-all">
                <textarea
                  value={inputText}
                  aria-label="纠偏指令草稿"
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入对该 Agent 的实时纠偏指令 (按 Enter 发送，Shift+Enter 换行)..."
                  rows={2}
                  className="min-h-[44px] max-h-36 flex-1 resize-none bg-transparent text-[13.5px] text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none leading-relaxed"
                />
                <button
                  type="button"
                  disabled={!execution?.sessionId || !inputText.trim() || isSending}
                  onClick={() => handleSendCorrection()}
                  className="win11-btn-accent h-9 px-4 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon path={mdiSend} size={0.65} />
                  <span>{isSending ? "下达中…" : "发送纠偏"}</span>
                </button>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </Dialog>
  );
}
