import { useState, useMemo, useEffect } from "react";
import {
  mdiCrown,
  mdiAccountGroup,
  mdiCheckCircle,
  mdiClockOutline,
  mdiAlertCircle,
  mdiArrowRight,
  mdiHelpCircleOutline,
  mdiLightningBolt,
  mdiRocketLaunchOutline,
  mdiSync,
  mdiOpenInNew,
  mdiViewGridOutline,
  mdiSourceBranch,
  mdiLayersOutline,
  mdiChevronDown,
  mdiChevronUp,
} from "@mdi/js";
import { Icon } from "@mdi/react";
import { useApiBase } from "../../lib/api/api-context.js";
import {
  configuredRolesForStage,
  latestObservedExecution,
  RESEARCH_STAGE_IDS,
  type ConfiguredRole,
  type ResearchExecution,
  type ResearchProjection,
  type StageId,
} from "./research-projection.js";
import { executionRecordStatus, researchStatusLabel, roleLabel } from "./ResearchAgentDetail.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { ResearchAgentCanvas } from "./ResearchAgentCanvas.js";
import {
  leadArt,
  getMemberArt,
  getActionArt,
} from "./agent-teams-artwork.js";

import { getMultiAgentTitle, getAgentMission, projectRecordedSteps } from "./research-presentation.js";
export { getMultiAgentTitle, getAgentMission } from "./research-presentation.js";

export const executionRoleName = (row: ResearchExecution) =>
  row.role ?? (row.kind === "pi-session" ? getMultiAgentTitle(row) : "未报告角色");

/**
 * 专职 Subagent 角色的中英双语友好显示名
 */
export function getSubagentRoleDisplayTitle(rawRole: string): string {
  const short = roleLabel(rawRole);
  const r = short.toLowerCase();
  if (r.includes("mainline") || r.includes("supervis")) {
    return `主线收敛监督 (${short})`;
  }
  if (r.includes("numeric") || r.includes("calc")) {
    return `数值模拟与合成核验 (${short})`;
  }
  if (r.includes("critic") || r.includes("review")) {
    return `苛刻评审与反例核查 (${short})`;
  }
  if (r.includes("theory")) {
    return `物理机制推导与理论建模 (${short})`;
  }
  if (r.includes("web-oracle") || r.includes("oracle")) {
    return `外部高阶理论核验 (${short})`;
  }
  if (r.includes("ssh") || r.includes("queue") || r.includes("compute")) {
    return `集群算力与远程作业调度 (${short})`;
  }
  if (r.includes("literature") || r.includes("lit") || r.includes("cite")) {
    return `文献方法溯源与引文核查 (${short})`;
  }
  if (r.includes("model-assessor") || r.includes("assessor")) {
    return `模型交付诊断与路由评估 (${short})`;
  }
  if (r.includes("explorer") || r.includes("explore") || r.includes("idea")) {
    return `结构拓扑初筛与探索 (${short})`;
  }
  if (r.includes("agy")) {
    return `独立算法与合成检验 (${short})`;
  }
  return short;
}

/**
 * 明确区分 Multi-Agent 与 Subagent 与主 Agent 的协作层级关系（使用主题自适应样式）
 */
export function getAgentRelation(
  isCaptain: boolean,
  kind?: string
): { tag: string; label: string; linkText: string; tintClass: string } {
  if (isCaptain) {
    return {
      tag: "👑 主控入口",
      label: "工作流主控 · 驱动多智能体集群并接收用户指令",
      linkText: "主控入口",
      tintClass: "tint-action-orange",
    };
  }
  if (kind === "pi-session") {
    return {
      tag: "🤖 Multi-Agent 独立会话",
      label: "与主控双向状态同步 · 上下文镜像与协同推演",
      linkText: "双向状态同步 ⇄",
      tintClass: "tint-action-blue",
    };
  }
  return {
    tag: "⚡ Subagent 派发微任务",
    label: "由上级会话单向派发 · 独立沙箱计算后汇交结果",
    linkText: "单向任务派发 →",
    tintClass: "tint-action-purple",
  };
}

export function getActualSkills(row: ResearchExecution | undefined, role?: ConfiguredRole): string[] {
  const skills = new Set<string>();
  if (role?.skills) {
    for (const s of role.skills) skills.add(s);
  }
  if (row?.currentTool && row.currentTool !== "bash") {
    skills.add(row.currentTool);
  }
  const text = `${row?.prompt ?? ""} ${row?.output ?? ""}`;
  const allKnownSkills = [
    "idea-discovery", "research-lit", "idea-creator", "novelty-check", "deepxiv", "openalex",
    "experiment-bridge", "experiment-plan", "run-experiment", "analyze-results", "experiment-queue",
    "auto-review-loop", "research-review", "kill-argument", "citation-audit", "paper-claim-audit",
    "paper-writing", "mineru", "playwright"
  ];
  for (const skill of allKnownSkills) {
    if (text.includes(skill)) skills.add(skill);
  }
  return Array.from(skills);
}

const live = (row: ResearchExecution) =>
  !["completed", "failed", "blocked", "stopped", "cancelled", "paused"].includes(row.workflowStatus ?? "") &&
  ["streaming", "started", "running", "queued", "pending", "stopping"].includes(row.status);

export function formatTime(iso?: string | null): string {
  if (!iso) return "未记录";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const PROOF_SOURCES: Record<string, string> = {
  "tool-call": "工具调用记录",
  "native-event": "原生事件",
  "native-status": "原生状态中的父子记录",
  "explicit-record": "明确记录",
};
const proofSource = (source: string) => PROOF_SOURCES[source] ?? source;

const STAGE_LABELS: Record<StageId, { name: string; desc: string }> = {
  "1-idea": { name: "1. 探索与构思", desc: "文献调研、独立发散、收窄科研问题" },
  "2-experiment": { name: "2. 实验与验证", desc: "可判定实验、数值模拟与运行输出" },
  "3-review": { name: "3. 评审与自检", desc: "多模型族交叉对抗评审、反例寻找与收敛" },
  "4-summary": { name: "4. 主张与闭环", desc: "主张与实验证据逐条比对与边界确认" },
  "5-writing": { name: "5. 撰写与定稿", desc: "论文撰写、引用真实性审计与产物打包" },
};

export function ResearchExecutionPanels({
  projection,
  stage,
  includeUnstaged,
  stale,
  onAgent,
  activeSessionId,
  mode = "all",
  cwd,
}: {
  projection: ResearchProjection;
  stage: StageId | null;
  includeUnstaged: boolean;
  stale: boolean;
  onAgent: (role: ConfiguredRole, execution?: ResearchExecution) => void;
  activeSessionId?: string;
  mode?: "all" | "workflow" | "teams";
  cwd?: string;
}) {
  const apiBase = useApiBase();
  const executions = projection.executions.filter(
    (row) => stage === null || row.stage === stage || (includeUnstaged && !row.stage)
  );

  const configured = stage ? configuredRolesForStage(projection.configuration, stage) : [];
  const roles = new Map<string, ConfiguredRole>(configured.map((role) => [role.name, role]));
  for (const row of executions) {
    const name = executionRoleName(row);
    if (!roles.has(name)) roles.set(name, { name, skills: [] });
  }

  const relations = projection.relations.filter(
    (row) =>
      executions.some((node) => node.id === row.fromExecutionId) &&
      executions.some((node) => node.id === row.toExecutionId)
  );
  const run = projection.currentRun;
  const source = (row: ResearchExecution) =>
    row.source === "workflow-record"
      ? "已登记工作流步骤"
      : row.kind === "pi-session"
      ? "已接入 Pi 会话"
      : "已观测原生子任务";

  const isWorkflowActive = executions.some((row) => live(row));

  // Main Agent (Captain) Selection & User Confirmation
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  const [pendingMainAgentId, setPendingMainAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== mainAgentId && pendingMainAgentId !== activeSessionId) {
      if (!mainAgentId) {
        setPendingMainAgentId(activeSessionId);
      }
    }
  }, [activeSessionId, mainAgentId, pendingMainAgentId]);

  const captainExecution = useMemo(() => {
    if (mainAgentId) {
      const found = executions.find((ex) => ex.sessionId === mainAgentId || ex.id === mainAgentId);
      if (found) return found;
    }
    const piSessions = executions.filter((ex) => ex.kind === "pi-session");
    if (piSessions.length > 0) {
      // 优先选择最新活跃的 pi-session 作为默认主控入口
      const sorted = [...piSessions].sort((a, b) =>
        (b.lastActivityAt ?? b.startedAt ?? "").localeCompare(a.lastActivityAt ?? a.startedAt ?? "")
      );
      return sorted[0];
    }
    return executions[0] || null;
  }, [executions, mainAgentId]);

  const [topoViewMode, setTopoViewMode] = useState<"topology" | "swimlanes">("topology");
  const [fusionFilter, setFusionFilter] = useState<"all" | "with-subs" | "standalone">("all");
  const [fusionLayout, setFusionLayout] = useState<"canvas" | "list">("canvas");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Agent 协作网络折叠/展开覆盖状态：记录用户手动切换（完成/关闭默认收起，激活默认展开）
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});

  // 检查会话/智能体卡片是否应当展开
  const isClusterExpanded = (cluster: { sessionExec: ResearchExecution }) => {
    const isLive = live(cluster.sessionExec);
    if (collapsedOverrides[cluster.sessionExec.id] !== undefined) {
      // 若处于活跃执行中，无论之前是否手动收起，均响应“如果被激活了再自动展开”
      return isLive || collapsedOverrides[cluster.sessionExec.id];
    }
    // 默认行为：活跃的自动展开，完成或关闭的自动收起
    return isLive;
  };

  // Only recorded steps are shown; missing dependencies are not inferred.
  const agentTeamsTasks = useMemo(
    () => projectRecordedSteps(projection.currentRun),
    [projection.currentRun],
  );

  // Stage independent start state & handlers
  const [startingStageId, setStartingStageId] = useState<string | null>(null);
  const [stageStartNotification, setStageStartNotification] = useState<{
    stageName: string;
    message: string;
    type: "success" | "error";
  } | null>(null);

  const handleStartIndependentStage = async (stageId: StageId, stageName: string, stageIndex: number) => {
    if (startingStageId) return;
    setStartingStageId(stageId);
    setStageStartNotification(null);

    const targetCwd = cwd || (projection as any).cwd;
    const initialPrompt = `【阶段独立启动任务】用户要求独立/提前启动科研工作流的阶段：${stageName}（阶段 ${stageIndex + 1}/5：${stageId}）。

请按以下步骤执行工作：
1. 首先深度总结目前的研究基础与进展现状：
   - 当前已产出的核心结论、假说或已有发现
   - 目前已经具备的代码、数据、文献调研或实验结果
   - 前序阶段已完成的成果与当前阶段的承接关系
2. 然后以清晰友好的方式主动向用户提问，问清楚用户当前提前/独立启动本阶段的具体需求：
   - 您希望本次独立启动重点聚焦在 ${stageName} 的哪个具体目标或任务？
   - 是否有需要优先调整的假设、参数范围、评估指标或写作重点？
   - 请明确告诉我您的指示，我将全力推进本阶段的具体工作！`;

    try {
      const res = await fetch(`${apiBase}/api/session/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: targetCwd,
          initialPrompt,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      setStageStartNotification({
        stageName,
        message: `已成功为「${stageName}」创建新会话！新智能体已自动注入研究基础总结指令，并将主动向您询问当前阶段的工作指示。`,
        type: "success",
      });
    } catch (err: any) {
      setStageStartNotification({
        stageName,
        message: `创建新会话失败：${err?.message || "网络请求异常"}`,
        type: "error",
      });
    } finally {
      setStartingStageId(null);
    }
  };

  const stageProgression = useMemo(() => {
    return RESEARCH_STAGE_IDS.map((stageId) => {
      const stageExecs = projection.executions.filter((ex) => ex.stage === stageId);
      const isCurrent = projection.stage === stageId;
      const isCompleted = projection.enteredStages.has(stageId) && !isCurrent;
      const hasExecs = stageExecs.length > 0;
      return {
        id: stageId,
        info: STAGE_LABELS[stageId],
        executions: stageExecs,
        isCurrent,
        isCompleted,
        hasExecs,
        active: stageExecs.some((ex) => live(ex)),
      };
    });
  }, [projection.executions, projection.stage, projection.enteredStages]);

  const roleEntries = useMemo(() => [...roles.values()], [roles]);

  // ============================================================================
  // 构建 Multi-Agent (pi-session) ⇄ Subagent (native-subagent) 深度融合拓扑数据
  // ============================================================================
  const {
    piSessions,
    subagentExecutions,
    subagentsByParentId,
    parentById,
    fusedSessionClusters,
    subagentRoleSummaries,
    sessionsWithSubsCount,
    sessionsWithoutSubsCount,
  } = useMemo(() => {
    const execTime = (ex: ResearchExecution) =>
      ex.startedAt ?? ex.lastActivityAt ?? ex.observedAt ?? "";

    const pSessions = executions
      .filter((ex) => ex.kind === "pi-session")
      .sort((a, b) => {
        // 排列按照创建时间由晚到早由前到后的排列（降序：晚创建在前）
        const timeDiff = execTime(b).localeCompare(execTime(a));
        if (timeDiff !== 0) return timeDiff;
        if (captainExecution?.id === a.id) return -1;
        if (captainExecution?.id === b.id) return 1;
        return b.id.localeCompare(a.id);
      });

    const pById = new Map<string, ResearchExecution>(pSessions.map((p) => [p.id, p]));
    const subs = executions
      .filter((ex) => ex.kind !== "pi-session")
      .sort((a, b) => execTime(b).localeCompare(execTime(a)));
    const subsByParent = new Map<string, ResearchExecution[]>();

    for (const sub of subs) {
      const pid = sub.parentExecutionId ?? "";
      const list = subsByParent.get(pid) ?? [];
      list.push(sub);
      subsByParent.set(pid, list);
    }

    const clusters = pSessions.map((sessionExec) => {
      const isCaptain = captainExecution?.id === sessionExec.id;
      const childSubs = (subsByParent.get(sessionExec.id) ?? [])
        .sort((a, b) => execTime(b).localeCompare(execTime(a)));
      const byRole = new Map<string, ResearchExecution[]>();
      for (const s of childSubs) {
        const rName = executionRoleName(s);
        const arr = byRole.get(rName) ?? [];
        arr.push(s);
        byRole.set(rName, arr);
      }
      const childRoleGroups = [...byRole.entries()].map(([rName, groupExecs]) => {
        groupExecs.sort((a, b) => execTime(b).localeCompare(execTime(a)));
        const latest = groupExecs[0] ?? latestObservedExecution(groupExecs);
        return {
          roleName: rName,
          roleObj: roles.get(rName) ?? { name: rName, skills: [] },
          executions: groupExecs,
          latest,
        };
      }).sort((a, b) => execTime(b.latest).localeCompare(execTime(a.latest)));

      return {
        sessionExec,
        title: executionRoleName(sessionExec),
        roleObj: roles.get(executionRoleName(sessionExec)) ?? { name: executionRoleName(sessionExec), skills: [] },
        isCaptain,
        childSubs,
        childRoleGroups,
      };
    });

    // Subagent 专职角色聚合（包含 configured 角色与所有观测到的 Subagent 角色）
    const subRoleNames = new Set<string>();
    for (const c of configured) {
      subRoleNames.add(c.name);
    }
    for (const s of subs) {
      subRoleNames.add(executionRoleName(s));
    }

    const roleSummaries = [...subRoleNames].map((rName) => {
      const roleObj = roles.get(rName) ?? { name: rName, skills: [] };
      const roleExecs = executions.filter((ex) => executionRoleName(ex) === rName);
      const latestObserved = latestObservedExecution(roleExecs);
      const primaryExec = latestObserved ?? roleExecs[0];

      // 统计哪些 Multi-Agent 父会话派发了该角色
      const parentCounts = new Map<string, { parent: ResearchExecution; count: number; latestSub: ResearchExecution }>();
      for (const ex of roleExecs) {
        if (ex.parentExecutionId && pById.has(ex.parentExecutionId)) {
          const p = pById.get(ex.parentExecutionId)!;
          const prev = parentCounts.get(p.id);
          parentCounts.set(p.id, {
            parent: p,
            count: (prev?.count ?? 0) + 1,
            latestSub: prev?.latestSub ?? ex,
          });
        }
      }

      return {
        role: roleObj,
        roleExecs,
        latestObserved,
        primaryExec,
        parentAttributions: [...parentCounts.values()],
      };
    });

    const withSubs = clusters.filter((c) => c.childSubs.length > 0).length;
    const withoutSubs = clusters.filter((c) => c.childSubs.length === 0).length;

    return {
      piSessions: pSessions,
      subagentExecutions: subs,
      subagentsByParentId: subsByParent,
      parentById: pById,
      fusedSessionClusters: clusters,
      subagentRoleSummaries: roleSummaries,
      sessionsWithSubsCount: withSubs,
      sessionsWithoutSubsCount: withoutSubs,
    };
  }, [executions, captainExecution, configured, roles]);

  const visibleClusters = useMemo(() => {
    if (fusionFilter === "with-subs") {
      return fusedSessionClusters.filter((c) => c.childSubs.length > 0 || c.isCaptain);
    }
    if (fusionFilter === "standalone") {
      return fusedSessionClusters.filter((c) => c.childSubs.length === 0);
    }
    return fusedSessionClusters;
  }, [fusedSessionClusters, fusionFilter]);

  return (
    <div className="space-y-4">
      {/* =========================================================================
          TAB 2 (or ALL): 工作流进度 · 5大流程进度与独立启动
          ========================================================================= */}
      {(mode === "all" || mode === "workflow") && (
        <CollapsibleSection
          id="research-run-status"
          testId="research-run-status"
          title="工作流执行记录 · 5大流程进度与独立启动"
          isUpdating={isWorkflowActive}
          defaultOpen={true}
          subtitle="按科研工作流 5 大阶段流水线串联展示；支持各阶段独立创建新会话、梳理研究基础并交互启动"
        >
          <div className="space-y-4">
            {/* Main Agent Confirmation Prompt Banner (WinUI 3 InfoBar) */}
            {pendingMainAgentId && (
              <div
                role="alert"
                className="win11-card-subtle border-l-4 border-l-[var(--accent-primary)] p-4 text-xs"
              >
                <div className="flex items-start gap-3">
                  <Icon
                    path={mdiHelpCircleOutline}
                    size={0.85}
                    className="mt-0.5 shrink-0 text-[var(--accent-primary)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">
                      是否把当前对话 Session 作为工作流主 Agent 入口？
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-[var(--text-secondary)]">
                      检测到当前活动会话：{pendingMainAgentId}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setMainAgentId(pendingMainAgentId);
                          setPendingMainAgentId(null);
                        }}
                        className="win11-btn-accent px-3.5 py-1.5 text-xs"
                      >
                        确认设为主 Agent 入口
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingMainAgentId(null)}
                        className="win11-btn px-3.5 py-1.5 text-xs"
                      >
                        保持现状
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Stage Start Notification Banner */}
            {stageStartNotification && (
              <div
                role="alert"
                className={`win11-card-subtle flex items-start gap-3 border-l-4 p-4 text-xs ${
                  stageStartNotification.type === "success"
                    ? "border-l-[var(--accent-green)]"
                    : "border-l-[var(--accent-red)]"
                }`}
              >
                <Icon
                  path={stageStartNotification.type === "success" ? mdiCheckCircle : mdiAlertCircle}
                  size={0.8}
                  className={
                    stageStartNotification.type === "success"
                      ? "text-[var(--accent-green)]"
                      : "text-[var(--accent-red)]"
                  }
                />
                <div className="min-w-0 flex-1">
                  <strong className="block font-semibold text-[var(--text-primary)]">
                    {stageStartNotification.stageName} 启动反馈：
                  </strong>
                  <span className="mt-0.5 block leading-relaxed text-[var(--text-secondary)]">
                    {stageStartNotification.message}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setStageStartNotification(null)}
                  className="win11-btn px-2 py-0.5 text-xs"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Current Run Summary Header */}
            <div className="win11-card-subtle flex flex-wrap items-center justify-between gap-3 p-3.5 text-xs">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {run ? `工作流运行：${run.runId}` : "当前工作流全景进度"}
                  </span>
                  <span className="rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                    {run ? researchStatusLabel(run.status) : "独立执行观测中"}
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--text-secondary)]">
                  五个阶段均支持独立创建新会话启动；启动时自动梳理已有研究成果并向您询问当前阶段目标。
                </p>
              </div>

              {captainExecution && (
                <div className="tint-action-orange inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold">
                  <Icon path={mdiCrown} size={0.6} />
                  <span>主控入口: {executionRoleName(captainExecution)}</span>
                </div>
              )}
            </div>

            {/* 5-Stage Progression Auto-Fit Grid */}
            <div className="win11-grid-stages">
              {stageProgression.map((item, index) => {
                const isStarting = startingStageId === item.id;
                return (
                  <div
                    key={item.id}
                    className={`win11-card-subtle flex min-w-0 flex-col justify-between p-4 text-xs transition-all ${
                      item.isCurrent
                        ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] shadow-xs"
                        : ""
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                          {item.info.name}
                        </span>
                        {item.active ? (
                          <span className="tint-action-green inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold">
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-green)] animate-pulse" />
                            <span>运行中</span>
                          </span>
                        ) : item.isCompleted ? (
                          <Icon path={mdiCheckCircle} size={0.65} className="text-[var(--accent-green)]" />
                        ) : item.hasExecs ? (
                          <Icon path={mdiClockOutline} size={0.65} className="text-[var(--accent-text)]" />
                        ) : (
                          <span className="rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                            待触发
                          </span>
                        )}
                      </div>

                      <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                        {item.info.desc}
                      </p>

                      <div className="mt-2.5 font-mono text-[11px] text-[var(--text-tertiary)]">
                        {item.executions.length} 个任务记录
                      </div>
                    </div>

                    <div className="mt-3.5 border-t border-[var(--border-primary)] pt-3">
                      <button
                        type="button"
                        disabled={isStarting}
                        onClick={() => handleStartIndependentStage(item.id, item.info.name, index)}
                        className={`w-full py-1.5 px-3 text-xs ${
                          item.isCurrent ? "win11-btn-accent" : "win11-btn"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                        title="独立创建新会话启动此阶段，总结研究基础并等待指示"
                      >
                        <Icon
                          path={isStarting ? mdiSync : mdiRocketLaunchOutline}
                          size={0.55}
                          className={isStarting ? "animate-spin" : ""}
                        />
                        <span>{isStarting ? "创建会话中…" : "独立启动阶段"}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Detailed Executions List */}
            <div className="space-y-2.5 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                  实际执行记录详情（含 Multi-Agent 会话与 Subagent 子任务）
                </h3>
                <span className="rounded-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                  {executions.length} 条
                </span>
              </div>

              {!executions.length ? (
                <div className="win11-card-subtle p-4 text-center text-xs text-[var(--text-secondary)]">
                  本视图尚无实际执行记录。
                </div>
              ) : (
                <ul className="win11-grid-cards">
                  {executions.map((row) => {
                    const isCaptain = captainExecution?.id === row.id;
                    const isLive = live(row);
                    const rName = executionRoleName(row);
                    const parentRow = row.parentExecutionId ? parentById.get(row.parentExecutionId) : undefined;
                    return (
                      <li
                        key={row.id}
                        data-testid="research-execution"
                        className="win11-card-interactive min-w-0 p-4 text-xs"
                      >
                        <button
                          type="button"
                          data-testid={`research-role-${rName}`}
                          className="focus-ring w-full min-w-0 text-left"
                          onClick={() => onAgent(roles.get(rName) ?? { name: rName, skills: [] }, row)}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
                              {isCaptain && (
                                <Icon path={mdiCrown} size={0.65} className="text-[var(--accent-orange)]" />
                              )}
                              <span>
                                {row.kind === "native-subagent"
                                  ? getSubagentRoleDisplayTitle(rName)
                                  : roleLabel(rName)}
                              </span>
                            </span>
                            <span
                              className={`rounded px-2 py-0.5 text-[10.5px] font-medium border ${
                                isLive
                                  ? "tint-action-green"
                                  : "bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-secondary)]"
                              }`}
                            >
                              {executionRecordStatus(row, stale)}
                            </span>
                          </div>

                          <div className="mt-2.5 space-y-1 text-xs text-[var(--text-secondary)]">
                            <span className="block truncate">
                              来源：{source(row)} · {row.stage ? STAGE_LABELS[row.stage]?.name || row.stage : "阶段未登记"}
                            </span>
                            {parentRow && (
                              <span className="block truncate text-[var(--accent-text)] font-medium">
                                派发自 Multi-Agent：{executionRoleName(parentRow)}
                              </span>
                            )}
                            <span className="block truncate font-mono text-[11px] text-[var(--text-tertiary)]">
                              ID: {row.id}
                            </span>
                            <span className="block truncate">
                              模型：<strong className="font-mono text-[var(--text-primary)]">{row.observedModel ?? "未记录"}</strong>
                            </span>
                            {row.currentTool && (
                              <span className="block truncate font-medium text-[var(--accent-green-text)]">
                                当前工具：<code>{row.currentTool}</code>
                              </span>
                            )}
                            {row.prompt && (
                              <span className="mt-1.5 block truncate rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]">
                                任务: {row.prompt.replace(/\n+/g, " ").slice(0, 75)}…
                              </span>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Explicit Relations & Dispatch Evidence */}
            {relations.length > 0 && (
              <div className="win11-card-subtle p-3.5 space-y-2">
                <div className="text-xs font-semibold text-[var(--text-primary)]">
                  实际派发协同证据链 ({relations.length})
                </div>
                <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {relations.map((rel) => (
                    <div
                      key={rel.id}
                      data-testid="research-relation"
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]"
                    >
                      <span className="font-mono font-semibold text-[var(--accent-text)]">
                        {rel.fromExecutionId} → {rel.toExecutionId}
                      </span>
                      {rel.evidence && (
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                          派发证据：{proofSource(rel.evidence.source)} ({rel.evidence.eventId})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* =========================================================================
          TAB 1 (or ALL): Agent 协作网络 · Multi-Agent ⇄ Subagent 一体化融合拓扑
          ========================================================================= */}
      {(mode === "all" || mode === "teams") && (
        <section
          id="research-agent-topology"
          data-testid="research-agent-topology"
          className="space-y-4"
        >
          {/* 1. Windows 11 Top Command Bar for Unified Agent Collaboration Network */}
          <div className="win11-card flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
            <div className="flex items-center gap-3 min-w-0">
              <img src={leadArt} alt="Lead" className="h-7 w-7 shrink-0 object-contain" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    多智能体任务派发与通信拓扑网 (Multi-Agent ⇄ Subagent 融合视图)
                  </h2>
                  <span className="tint-action-blue rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] font-semibold">
                    🤖 {piSessions.length} 个 Multi-Agent 会话
                  </span>
                  <span className="tint-action-purple rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] font-semibold">
                    ⚡ {subagentRoleSummaries.length} 类专职 Subagent · {subagentExecutions.length} 次派发
                  </span>
                </div>
                <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
                  主控统筹全局 ⇄ Multi-Agent 独立会话分流推演（双向同步） → 下辖专职 Subagent 沙箱微任务（单向派发与结果汇交）
                </p>
              </div>
            </div>

            {/* Segmented View Switcher (WinUI 3 Segmented Control) */}
            <div className="win11-card-subtle inline-flex items-center gap-1 p-1">
              <button
                type="button"
                onClick={() => setTopoViewMode("topology")}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-all ${
                  topoViewMode === "topology"
                    ? "bg-[var(--accent-solid)] text-white font-semibold shadow-xs"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon path={mdiSourceBranch} size={0.55} />
                <span>主从融合拓扑与职责</span>
              </button>
              <button
                type="button"
                onClick={() => setTopoViewMode("swimlanes")}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-all ${
                  topoViewMode === "swimlanes"
                    ? "bg-[var(--accent-solid)] text-white font-semibold shadow-xs"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon path={mdiViewGridOutline} size={0.55} />
                <span>专职角色矩阵与归属</span>
              </button>
            </div>
          </div>

          {topoViewMode === "topology" && (
            <div className="space-y-4">
              {/* 2. Stage Delivery Progress & Dependency Flow */}
              {agentTeamsTasks.length > 0 && (
                <div className="win11-card p-4 space-y-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                      <Icon path={mdiLayersOutline} size={0.65} className="text-[var(--accent-primary)]" />
                      <span>已记录的工作流步骤（点击查看详情）</span>
                    </span>
                    <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-[var(--text-secondary)]">
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-[var(--accent-green)]" /> 已完成
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-[var(--accent-primary)]" /> 执行中
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-[var(--accent-orange)]" /> 其他状态
                      </span>
                    </div>
                  </div>

                  {/* 5-Segment Fluent Progress Bar */}
                  <div className="flex h-1.5 w-full items-center gap-1.5">
                    {agentTeamsTasks.map((t) => (
                      <div
                        key={t.id}
                        className={`h-full flex-1 rounded-full transition-all ${
                          t.status === "completed"
                            ? "bg-[var(--accent-green)]"
                            : t.status === "running"
                            ? "bg-[var(--accent-primary)]"
                            : t.status === "claimed"
                            ? "bg-[var(--accent-blue)] opacity-75"
                            : t.status === "blocked"
                            ? "bg-[var(--accent-orange)]"
                            : "bg-[var(--border-secondary)]"
                        }`}
                        title={`${t.displayId} ${t.subject}`}
                      />
                    ))}
                  </div>

                  {/* Responsive Auto-Fit Stage DAG Grid */}
                  <div data-testid="agent-flow-scroll" className="w-full">
                    <svg data-testid="agent-flow-svg" className="hidden" viewBox="0 0 100 20" />
                    <div className="win11-grid-stages">
                      {agentTeamsTasks.map((t) => {
                        const isSelected = selectedTaskId === t.id;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            data-testid="research-dag-step"
                            onClick={() => setSelectedTaskId(isSelected ? null : t.id)}
                            className={`win11-card-subtle flex flex-col justify-between border-l-[3px] p-3 text-left text-xs transition-all hover:bg-[var(--bg-hover)] ${
                              isSelected
                                ? "ring-2 ring-[var(--accent-primary)] bg-[var(--accent-soft)]"
                                : ""
                            } ${
                              t.status === "completed"
                                ? "border-l-[var(--accent-green)]"
                                : t.status === "running"
                                ? "border-l-[var(--accent-primary)]"
                                : t.status === "blocked"
                                ? "border-l-[var(--accent-orange)]"
                                : "border-l-[var(--border-strong)]"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="font-mono text-[11px] font-semibold text-[var(--text-secondary)]">
                                {t.displayId} · {t.assignee}
                              </span>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                                  t.status === "running"
                                    ? "tint-action-blue"
                                    : t.status === "completed"
                                    ? "tint-action-green"
                                    : t.status === "blocked"
                                    ? "tint-action-orange"
                                    : "bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-tertiary)]"
                                }`}
                              >
                                {researchStatusLabel(t.status)}
                              </span>
                            </div>
                            <div className="font-semibold text-[12.5px] leading-snug text-[var(--text-primary)]">
                              {t.subject}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Selected Stage Inspector Bar */}
                  {selectedTaskId && (() => {
                    const focused = agentTeamsTasks.find((t) => t.id === selectedTaskId);
                    if (!focused) return null;
                    const matchedExec =
                      executions.find((ex) =>
                        ex.workflowRunId === focused.runId && ex.workflowKey === focused.key
                      );

                    return (
                      <div className="win11-card-subtle border-l-4 border-l-[var(--accent-primary)] p-3.5 text-xs space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-bold text-[var(--accent-text)] text-sm">
                              {focused.displayId}
                            </span>
                            <span className="font-semibold text-[var(--text-primary)] text-sm">
                              {focused.subject}
                            </span>
                            <span className="rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                              核心角色: {focused.assignee}
                            </span>
                          </div>
                          {matchedExec && (
                            <button
                              type="button"
                              onClick={() =>
                                onAgent(
                                  roles.get(executionRoleName(matchedExec)) ?? {
                                    name: executionRoleName(matchedExec),
                                    skills: [],
                                  },
                                  matchedExec
                                )
                              }
                              className="win11-btn-accent px-3 py-1.5 text-xs"
                            >
                              <span>进入该阶段关联智能体</span>
                              <Icon path={mdiArrowRight} size={0.5} />
                            </button>
                          )}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 text-xs text-[var(--text-secondary)] pt-1">
                          <div>
                            <strong className="text-[var(--text-primary)]">阶段目标：</strong>
                            <span>{focused.duty}</span>
                          </div>
                          <div>
                            <strong className="text-[var(--text-primary)]">记录状态：</strong>
                            <span>{researchStatusLabel(focused.status)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* 3. 核心融合区：Multi-Agent 协同会话 ⇄ 下辖派发 Subagent 一体化拓扑树 */}
              {fusedSessionClusters.length > 0 && (
                <div className="win11-card p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-primary)] pb-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          主控 & Multi-Agent 协同会话 ⇄ 下辖 Subagent 微任务融合拓扑
                        </h3>
                        <span className="tint-action-purple rounded-full border px-2 py-0.5 text-[10.5px] font-semibold">
                          父子协同树一体展示
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                        先查看会话总览，点击会话聚焦其下属角色；也可切换到详细列表。
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <div className="win11-card-subtle inline-flex items-center gap-1 p-1 text-xs" role="group" aria-label="协作视图布局">
                        <button type="button" onClick={() => setFusionLayout("canvas")} aria-pressed={fusionLayout === "canvas"}
                          className={`rounded px-2.5 py-1 text-[11px] font-medium ${fusionLayout === "canvas" ? "bg-[var(--accent-solid)] font-semibold text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"}`}>画布</button>
                        <button type="button" onClick={() => setFusionLayout("list")} aria-pressed={fusionLayout === "list"}
                          className={`rounded px-2.5 py-1 text-[11px] font-medium ${fusionLayout === "list" ? "bg-[var(--accent-solid)] font-semibold text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"}`}>列表</button>
                      </div>
                      {fusionLayout === "list" && visibleClusters.length > 0 && (
                        <div className="win11-card-subtle inline-flex items-center gap-1 p-1 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              const openAll: Record<string, boolean> = {};
                              for (const c of visibleClusters) openAll[c.sessionExec.id] = true;
                              setCollapsedOverrides(openAll);
                            }}
                            className="rounded px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          >
                            全部展开
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const closeAll: Record<string, boolean> = {};
                              for (const c of visibleClusters) closeAll[c.sessionExec.id] = false;
                              setCollapsedOverrides(closeAll);
                            }}
                            className="rounded px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          >
                            全部收起
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Filter Pills for Multi-Agent + Subagent Clusters */}
                    {fusedSessionClusters.length > 1 && (
                      <div className="win11-card-subtle inline-flex flex-wrap items-center gap-1 p-1 text-xs">
                        <button
                          type="button"
                          onClick={() => setFusionFilter("all")}
                          className={`rounded px-2.5 py-1 text-[11px] font-medium transition-all ${
                            fusionFilter === "all"
                              ? "bg-[var(--accent-solid)] text-white font-semibold"
                              : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          全部协同会话 ({fusedSessionClusters.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setFusionFilter("with-subs")}
                          className={`rounded px-2.5 py-1 text-[11px] font-medium transition-all ${
                            fusionFilter === "with-subs"
                              ? "bg-[var(--accent-solid)] text-white font-semibold"
                              : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          含派发 Subagent ({sessionsWithSubsCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => setFusionFilter("standalone")}
                          className={`rounded px-2.5 py-1 text-[11px] font-medium transition-all ${
                            fusionFilter === "standalone"
                              ? "bg-[var(--accent-solid)] text-white font-semibold"
                              : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          本地专项会话 ({sessionsWithoutSubsCount})
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Keep the detailed list available, with the canvas as the compact default. */}
                  {fusionLayout === "canvas" ? (
                    visibleClusters.length ? <ResearchAgentCanvas clusters={visibleClusters} stale={stale} onAgent={onAgent} statusLabel={researchStatusLabel} roleLabel={getSubagentRoleDisplayTitle} />
                      : <div className="win11-card-subtle p-4 text-xs text-[var(--text-secondary)]">没有符合筛选条件的会话。</div>
                  ) : (
                  <div className="space-y-3.5">
                    {visibleClusters.map((cluster) => {
                      const { sessionExec, title, roleObj, isCaptain, childSubs, childRoleGroups } = cluster;
                      const isLive = live(sessionExec);
                      const isExpanded = isClusterExpanded(cluster);
                      const mission = getAgentMission(title, isCaptain, sessionExec.kind, sessionExec, cwd);
                      const relation = getAgentRelation(isCaptain, sessionExec.kind);
                      const avatarArt = getMemberArt(title, isCaptain);
                      const actionArt = getActionArt(sessionExec.status ?? "idle");
                      const cleanOutput = (sessionExec.output ?? "")
                        .replace(/[#*`>-]/g, "")
                        .replace(/\s+/g, " ")
                        .trim();

                      if (!isExpanded) {
                        return (
                          <div
                            key={sessionExec.id}
                            data-testid="research-agent-node"
                            className={`win11-card-interactive cursor-pointer p-3.5 text-xs border-l-4 transition-all ${
                              isLive
                                ? "ring-2 ring-emerald-500/80 shadow-[0_0_16px_rgba(16,185,129,0.25)] border-l-emerald-500 bg-gradient-to-r from-emerald-500/10 via-transparent to-transparent"
                                : isCaptain
                                ? "border-l-[var(--accent-orange)]"
                                : childSubs.length > 0
                                ? "border-l-[var(--accent-blue)]"
                                : "border-l-[var(--border-strong)]"
                            }`}
                            onClick={() => onAgent(roleObj, sessionExec)}
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className={`relative shrink-0 ${isLive ? "p-0.5 rounded-full ring-2 ring-emerald-400 ring-offset-2 ring-offset-[var(--bg-primary)] animate-pulse" : ""}`}>
                                  <img
                                    src={isCaptain ? leadArt : avatarArt}
                                    alt={title}
                                    className="h-8 w-8 object-contain"
                                  />
                                  <img
                                    src={actionArt}
                                    alt=""
                                    className="absolute -bottom-1 -right-1 h-4 w-4 object-contain"
                                  />
                                </div>
                                <div className="min-w-0 flex flex-wrap items-center gap-2">
                                  <span className="text-[13.5px] font-bold text-[var(--text-primary)]">
                                    {title}
                                  </span>
                                  <span
                                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${relation.tintClass}`}
                                  >
                                    {relation.tag}
                                  </span>
                                  {isLive ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/60 px-2.5 py-0.5 text-[10.5px] font-bold text-emerald-600 dark:text-emerald-400 shadow-sm animate-pulse">
                                      <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                      </span>
                                      <span>⚡ 执行中</span>
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]">
                                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" />
                                      <span>{executionRecordStatus(sessionExec, stale)}</span>
                                    </span>
                                  )}
                                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] font-mono">
                                    <Icon path={mdiClockOutline} size={0.45} />
                                    <span>开始: {formatTime(sessionExec.startedAt)} · 结束: {formatTime(sessionExec.endedAt ?? sessionExec.lastActivityAt)}</span>
                                  </span>
                                  {childSubs.length > 0 && (
                                    <span className="tint-action-purple rounded-full border px-2 py-0.5 text-[10px] font-semibold">
                                      ⚡ 下辖 {childSubs.length} 个 Subagent ({childRoleGroups.length} 类角色)
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center justify-end gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onAgent(roleObj, sessionExec);
                                  }}
                                  className="win11-btn px-2.5 py-1 text-xs"
                                >
                                  <Icon path={mdiOpenInNew} size={0.5} />
                                  <span>详情</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setCollapsedOverrides((prev) => ({ ...prev, [sessionExec.id]: true }));
                                  }}
                                  className="win11-btn px-2.5 py-1 text-xs text-[var(--accent-text)] flex items-center gap-1"
                                  title="展开 Agent 卡片"
                                >
                                  <Icon path={mdiChevronDown} size={0.55} />
                                  <span>展开</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={sessionExec.id}
                          data-testid="research-agent-node"
                          onClick={() => onAgent(roleObj, sessionExec)}
                          className={`win11-card-interactive cursor-pointer p-4 text-xs border-l-4 transition-all ${
                            isLive
                              ? "ring-2 ring-emerald-500/80 shadow-[0_0_20px_rgba(16,185,129,0.3)] border-l-emerald-500 bg-gradient-to-r from-emerald-500/10 via-transparent to-transparent"
                              : isCaptain
                              ? "border-l-[var(--accent-orange)]"
                              : childSubs.length > 0
                              ? "border-l-[var(--accent-blue)]"
                              : "border-l-[var(--border-strong)]"
                          }`}
                        >
                          {/* Top Part: Multi-Agent Session Header & Mission */}
                          <div
                            data-testid="research-agent-card"
                            className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                          >
                            <div className="flex min-w-0 flex-1 items-start gap-3.5">
                              <div className={`relative shrink-0 mt-0.5 ${isLive ? "p-0.5 rounded-full ring-2 ring-emerald-400 ring-offset-2 ring-offset-[var(--bg-primary)] animate-pulse" : ""}`}>
                                <img
                                  src={isCaptain ? leadArt : avatarArt}
                                  alt={title}
                                  className="h-11 w-11 object-contain"
                                />
                                <img
                                  src={actionArt}
                                  alt=""
                                  className="absolute -bottom-1 -right-1 h-5 w-5 object-contain"
                                />
                              </div>

                              <div className="min-w-0 flex-1 space-y-1.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[14px] font-bold text-[var(--text-primary)]">
                                    {title}
                                  </span>
                                  <span
                                    className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold ${relation.tintClass}`}
                                  >
                                    {relation.tag} · {relation.linkText}
                                  </span>
                                  {childSubs.length > 0 ? (
                                    <span className="tint-action-purple rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold">
                                      ⚡ 下辖 {childSubs.length} 个 Subagent 子任务 ({childRoleGroups.length} 类角色)
                                    </span>
                                  ) : (
                                    <span className="rounded-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2.5 py-0.5 text-[10.5px] text-[var(--text-tertiary)]">
                                      本地闭环推演
                                    </span>
                                  )}
                                  {isLive ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/60 px-2.5 py-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 shadow-sm animate-pulse">
                                      <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                      </span>
                                      <span>⚡ 正在全力执行中 · 活跃</span>
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10.5px] font-medium border bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-secondary)]">
                                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" />
                                      <span>{executionRecordStatus(sessionExec, stale)}</span>
                                    </span>
                                  )}
                                </div>

                                {/* Specific Research Duty in This Study */}
                                <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                                  <strong className="text-[var(--text-primary)]">本研究职责：</strong>
                                  {mission}
                                </p>

                                {/* Latest Deliverable / Output Snippet */}
                                {cleanOutput && (
                                  <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[11.5px] text-[var(--text-secondary)] truncate">
                                    <strong className="text-[var(--accent-text)]">最新阶段结论：</strong>
                                    {cleanOutput.slice(0, 115)}
                                    {cleanOutput.length > 115 ? "…" : ""}
                                  </div>
                                )}

                                {/* Telemetry & Model Row */}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] text-[var(--text-tertiary)]">
                                  <span className="font-mono">
                                    会话 ID: {sessionExec.sessionId?.slice(0, 8) ?? sessionExec.id.slice(0, 14)}
                                  </span>
                                  <span className="font-mono inline-flex items-center gap-1">
                                    <Icon path={mdiClockOutline} size={0.45} />
                                    <span>开始: {formatTime(sessionExec.startedAt)} · 结束: {isLive ? "持续执行中" : formatTime(sessionExec.endedAt ?? sessionExec.lastActivityAt)}</span>
                                  </span>
                                  {sessionExec.observedModel && (
                                    <span className="rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[var(--text-primary)]">
                                      最新观测模型：{sessionExec.observedModel}
                                      {stale && sessionExec.source === "observation" ? "（观测已过期）" : ""}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="shrink-0 flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAgent(roleObj, sessionExec);
                                }}
                                className={
                                  isCaptain
                                    ? "win11-btn-accent px-3 py-1.5 text-xs"
                                    : "win11-btn px-3 py-1.5 text-xs"
                                }
                              >
                                <Icon path={mdiOpenInNew} size={0.55} />
                                <span>会话详情与纠偏</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCollapsedOverrides((prev) => ({ ...prev, [sessionExec.id]: false }));
                                }}
                                className="win11-btn px-2.5 py-1.5 text-xs text-[var(--text-secondary)] flex items-center gap-1"
                                title="收起此 Agent 卡片"
                              >
                                <Icon path={mdiChevronUp} size={0.55} />
                                <span>收起</span>
                              </button>
                            </div>
                          </div>

                          {/* Bottom Fused Part: Child Subagents Dispatched by This Multi-Agent */}
                          {childRoleGroups.length > 0 && (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="mt-3.5 border-t border-[var(--border-primary)] pt-3 pl-2 sm:pl-6"
                            >
                              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                <span className="flex items-center gap-1.5 font-semibold text-[var(--accent-text)]">
                                  <Icon path={mdiLightningBolt} size={0.55} />
                                  <span>
                                    └─ 本会话派发 Subagent 专职微任务簇（共 {childSubs.length} 次沙箱执行 · 点击子卡片直达该 Subagent 详情）
                                  </span>
                                </span>
                                <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">
                                  父子通信协议：单向任务派发 → 独立沙箱核验 → 结果汇交父会话
                                </span>
                              </div>

                              <div className="win11-grid-cards">
                                {childRoleGroups.map((subGroup) => {
                                  const subLatest = subGroup.latest;
                                  const subLive = subGroup.executions.some((ex) => live(ex));
                                  const subTaskSnippet = (subLatest.prompt ?? subLatest.output ?? "")
                                    .replace(/^Task:\s*/i, "")
                                    .replace(/\s+/g, " ")
                                    .trim();

                                  return (
                                    <div
                                      key={`${sessionExec.id}:${subGroup.roleName}`}
                                      onClick={() => onAgent(subGroup.roleObj, subLatest)}
                                      className={`win11-card-subtle cursor-pointer p-3 hover:bg-[var(--bg-hover)] transition-all space-y-1.5 border-l-[3px] ${
                                        subLive
                                          ? "border-l-emerald-500 ring-1 ring-emerald-500/50 bg-emerald-500/5 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
                                          : "border-l-[var(--accent-purple)]"
                                      }`}
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                                        <span className="flex items-center gap-1.5 font-bold text-[12.5px] text-[var(--text-primary)]">
                                          <img
                                            src={getMemberArt(subGroup.roleName)}
                                            alt=""
                                            className={`h-5 w-5 shrink-0 object-contain ${subLive ? "ring-1 ring-emerald-400 rounded-full animate-pulse" : ""}`}
                                          />
                                          <span>{getSubagentRoleDisplayTitle(subGroup.roleName)}</span>
                                        </span>
                                        <div className="flex items-center gap-1.5">
                                          <span className="tint-action-purple rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold">
                                            派发 ×{subGroup.executions.length}
                                          </span>
                                          {subLive ? (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 border border-emerald-500/50 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 animate-pulse">
                                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
                                              <span>⚡ 执行中</span>
                                            </span>
                                          ) : (
                                            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium border bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-secondary)]">
                                              {researchStatusLabel(subLatest.status)}
                                            </span>
                                          )}
                                        </div>
                                      </div>

                                      <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)] line-clamp-2">
                                        {subTaskSnippet
                                          ? `专项任务：${subTaskSnippet.slice(0, 88)}${subTaskSnippet.length > 88 ? "…" : ""}`
                                          : getAgentMission(subGroup.roleName, false, "native-subagent", subLatest, cwd)}
                                      </p>

                                      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[10.5px] text-[var(--text-tertiary)]">
                                        <span className="font-mono truncate">
                                          模型: <strong className="text-[var(--text-primary)]">{subLatest.observedModel ?? "默认配置"}</strong>
                                        </span>
                                        <span className="text-[var(--accent-text)] font-medium inline-flex items-center gap-0.5">
                                          <span>查看 {subGroup.executions.length} 次执行</span>
                                          <Icon path={mdiArrowRight} size={0.45} />
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
              )}

              {/* 4. 专职 Subagent 角色职责与配置总览（同时显示跨会话派发归属，保持全量角色可见与测试兼容） */}
              <div className="win11-card p-4 space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                      专职 Subagent 角色职责与跨会话派发归属总览
                    </h3>
                    <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                      汇总本研究中所有专职 Subagent 角色、配置/实测模型以及调用该角色的 Multi-Agent 父会话归属
                    </p>
                  </div>
                  <span className="rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2.5 py-1 font-mono text-xs text-[var(--text-secondary)]">
                    共 {subagentRoleSummaries.length} 类专职角色 · {subagentExecutions.length} 次运行
                  </span>
                </div>

                {subagentRoleSummaries.length === 0 ? (
                  <div className="win11-card-subtle p-6 text-center text-xs text-[var(--text-secondary)]">
                    当前阶段尚无活跃或已登记的专职 Subagent 角色。
                  </div>
                ) : (
                  <div className="win11-grid-cards">
                    {subagentRoleSummaries.map(({ role, roleExecs, latestObserved, primaryExec, parentAttributions }) => {
                      const isLive = roleExecs.some((ex) => live(ex));
                      const actualSkills = getActualSkills(primaryExec, role);
                      const mission = getAgentMission(role.name, false, "native-subagent", primaryExec, cwd);
                      const relation = getAgentRelation(false, "native-subagent");
                      const avatarArt = getMemberArt(role.name, false);

                      return (
                        <div
                          key={role.name}
                          data-testid="research-agent-node"
                          onClick={() => onAgent(role, primaryExec)}
                          className="win11-card-interactive cursor-pointer p-4 text-xs flex flex-col justify-between gap-3"
                        >
                          <div className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <img src={avatarArt} alt={role.name} className="h-9 w-9 shrink-0 object-contain" />
                                <div className="min-w-0">
                                  <div className="text-[13.5px] font-bold text-[var(--text-primary)] truncate">
                                    {getSubagentRoleDisplayTitle(role.name)}
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${relation.tintClass}`}>
                                      {relation.tag}
                                    </span>
                                    <span className="rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                                      累计 {roleExecs.length} 次运行
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {primaryExec && (
                                <span
                                  className={`shrink-0 rounded px-2 py-0.5 text-[10.5px] font-medium border ${
                                    isLive
                                      ? "tint-action-green"
                                      : "bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-secondary)]"
                                  }`}
                                >
                                  {executionRecordStatus(primaryExec, stale)}
                                </span>
                              )}
                            </div>

                            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                              {mission}
                            </p>

                            {/* Fused Attribution: Which Multi-Agent Sessions Dispatched This Subagent Role */}
                            {parentAttributions.length > 0 && (
                              <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2.5 space-y-1.5">
                                <div className="text-[10.5px] font-semibold text-[var(--text-tertiary)]">
                                  派发源 Multi-Agent 会话归属 ({parentAttributions.length} 个父会话)：
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {parentAttributions.map(({ parent, count }) => (
                                    <button
                                      key={parent.id}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const pName = executionRoleName(parent);
                                        onAgent(roles.get(pName) ?? { name: pName, skills: [] }, parent);
                                      }}
                                      className="tint-action-blue rounded border px-2 py-0.5 text-[10.5px] font-medium hover:opacity-85 transition-opacity"
                                      title={`点击查看父会话：${executionRoleName(parent)}`}
                                    >
                                      🤖 {executionRoleName(parent)} (×{count})
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="border-t border-[var(--border-primary)] pt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {role.model && (
                                <span className="rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2 py-0.5 font-mono">
                                  配置模型：{role.model}
                                </span>
                              )}
                              {latestObserved?.observedModel && (
                                <span className="rounded bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[var(--text-primary)]">
                                  最新观测模型：{latestObserved.observedModel}
                                  {stale && latestObserved.source === "observation" ? "（观测已过期）" : ""}
                                </span>
                              )}
                              {actualSkills.map((sk) => (
                                <span
                                  key={sk}
                                  className="tint-action-green rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium"
                                >
                                  {sk}
                                </span>
                              ))}
                            </div>

                            <span className="text-[var(--accent-text)] font-semibold inline-flex items-center gap-1">
                              <span>角色详情</span>
                              <Icon path={mdiOpenInNew} size={0.5} />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VIEW MODE 2: 专职角色矩阵与归属 (Role-Centric Matrix with Parent Multi-Agent Links) */}
          {topoViewMode === "swimlanes" && (
            <div className="space-y-4">
              {/* Lane 1: Captain & Multi-Agent Sessions Overview */}
              <div className="win11-card border-l-4 border-l-[var(--accent-blue)] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]">
                    <Icon path={mdiAccountGroup} size={0.7} className="text-[var(--accent-blue)]" />
                    <span>1. 主控 & Multi-Agent 独立会话矩阵 ({piSessions.length} 个独立研究会话)</span>
                  </div>
                  <span className="text-[11px] text-[var(--text-secondary)]">
                    每个会话拥有独立上下文并与主控双向状态同步
                  </span>
                </div>
                <div className="win11-grid-cards">
                  {fusedSessionClusters.map(({ sessionExec, title, roleObj, isCaptain, childSubs }) => (
                    <div
                      key={sessionExec.id}
                      onClick={() => onAgent(roleObj, sessionExec)}
                      className={`win11-card-subtle cursor-pointer p-3.5 hover:bg-[var(--bg-hover)] transition-all text-xs flex items-start gap-3 ${
                        isCaptain ? "border-l-[3px] border-l-[var(--accent-orange)]" : ""
                      }`}
                    >
                      <img
                        src={isCaptain ? leadArt : getMemberArt(title)}
                        alt=""
                        className="h-9 w-9 shrink-0 object-contain"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <span className="font-bold text-sm text-[var(--text-primary)] truncate">
                            {title}
                          </span>
                          <span className="tint-action-purple rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold">
                            派发 {childSubs.length} 子任务
                          </span>
                        </div>
                        <div className="text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-2">
                          {getAgentMission(title, isCaptain, sessionExec.kind, sessionExec, cwd)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Lane 2: Subagent Roles & Individual Executions Linked to Parent Multi-Agent */}
              <div className="win11-card border-l-4 border-l-[var(--accent-purple)] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]">
                    <Icon path={mdiLightningBolt} size={0.7} className="text-[var(--accent-purple)]" />
                    <span>2. Subagent 派发微任务全量清单 ({subagentExecutions.length} 次沙箱执行)</span>
                  </div>
                  <span className="text-[11px] text-[var(--text-secondary)]">
                    标注每次微任务所属的父级 Multi-Agent 会话
                  </span>
                </div>
                <div className="win11-grid-cards">
                  {subagentExecutions.slice(0, 36).map((row) => {
                    const rName = executionRoleName(row);
                    const parentRow = row.parentExecutionId ? parentById.get(row.parentExecutionId) : undefined;
                    const taskSnippet = (row.prompt ?? row.output ?? "")
                      .replace(/^Task:\s*/i, "")
                      .replace(/\s+/g, " ")
                      .trim();
                    return (
                      <div
                        key={row.id}
                        onClick={() => onAgent(roles.get(rName) ?? { name: rName, skills: [] }, row)}
                        className="win11-card-subtle cursor-pointer p-3.5 hover:bg-[var(--bg-hover)] transition-all text-xs flex items-start gap-3"
                      >
                        <img src={getMemberArt(rName)} alt="" className="h-8 w-8 shrink-0 object-contain" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="font-bold text-[13px] text-[var(--text-primary)]">
                              {getSubagentRoleDisplayTitle(rName)}
                            </span>
                            <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                              {researchStatusLabel(row.status)}
                            </span>
                          </div>
                          {parentRow && (
                            <div className="text-[11px] font-medium text-[var(--accent-text)] truncate">
                              ← 由「{executionRoleName(parentRow)}」单向派发
                            </div>
                          )}
                          <div className="text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-2">
                            {taskSnippet
                              ? taskSnippet.slice(0, 90)
                              : getAgentMission(rName, false, row.kind, row, cwd)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
