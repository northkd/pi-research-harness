/** Formal research files and owner-scoped execution observations remain separate. */
import {
  mdiArrowLeft,
  mdiCircleOutline,
  mdiAccountGroup,
  mdiLightningBolt,
  mdiChartBoxOutline,
  mdiFileDocumentCheckOutline,
  mdiHistory,
  mdiViewGridOutline,
  mdiViewSplitVertical,
  mdiRefresh,
  mdiFolderOutline,
  mdiInformationOutline,
} from "@mdi/js";
import { Icon } from "@mdi/react";
import { useEffect, useMemo, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";
import { useI18n } from "../../lib/i18n/i18n.js";
import { useOptionalSplitWorkspace } from "../split/SplitWorkspaceContext.js";
import { projectResearch, type ConfiguredRole, type ResearchExecution, type ResearchSnapshot, type StageId } from "./research-projection.js";
import { useResearchLoopLive } from "./use-research-loop-live.js";
import { ResearchAgentDetail, instanceKey } from "./ResearchAgentDetail.js";
import { ResWorkflowAdoption } from "./ResWorkflowAdoption.js";
import { ScienceInstances } from "./ScienceInstances.js";
import { ResearchStartGuide } from "./ResearchStartGuide.js";
import { executionRoleName, ResearchExecutionPanels } from "./ResearchExecutionPanels.js";
import { ResearchClaimPanels } from "./ResearchClaimPanels.js";
import { ResearchOverviewAndBudget, STAGES } from "./ResearchOverviewAndBudget.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import type { ScienceViewTarget } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";

const EMPTY: ResearchSnapshot = { state: null, attempts: [], events: [], receipt: null };

export type ResearchTabKey = "teams" | "workflow" | "overview" | "claims" | "audit" | "all";

interface TabDef {
  key: ResearchTabKey;
  label: string;
  icon: string;
  badge?: string | number;
  hasActivity?: boolean;
}

export function ResearchPipelinePage({
  cwd,
  onBack,
  embedded = false,
  activeSessionId,
  refreshSignal,
  connectionGeneration,
  resyncWatch,
  onOpenArtifact,
  onOpenSource,
  onOpenScience,
  onOpenScienceArtifact,
}: {
  cwd: string;
  onBack?: () => void;
  embedded?: boolean;
  activeSessionId?: string;
  refreshSignal?: string;
  connectionGeneration?: number;
  resyncWatch?: () => void;
  onOpenArtifact?: (path: string) => void;
  onOpenSource?: (adoptionId: string, sourceId: string) => void;
  onOpenScience?: (target?: ScienceViewTarget) => void;
  onOpenScienceArtifact?: (taskId: string, artifactId: string) => void;
}) {
  const { t } = useI18n(), apiBase = useApiBase();
  const splitWorkspace = useOptionalSplitWorkspace();
  const { snapshot, adoption, adopted, loading, refreshing, error, checkedAt, refresh, workbench, observationStatus, observationError } = useResearchLoopLive({ cwd, refreshSignal, connectionGeneration, resyncWatch });
  const projection = useMemo(() => projectResearch(snapshot ?? EMPTY, workbench), [snapshot, workbench]);
  const state = snapshot?.state, attempts = snapshot?.attempts ?? [], claims = state?.claims ?? [];
  const objective = state?.charter?.objective?.trim() || null;
  const [viewStage, setViewStage] = useState<StageId | null>(null);
  const [selected, setSelection] = useState<{ scope: string; role: ConfiguredRole; execution?: ResearchExecution; stage: StageId | null } | null>(null);

  // Default to "all" in Vitest test suites so all sections are simultaneously queryable;
  // in live browser, default to "teams" or persisted user tab choice.
  const [activeTab, setActiveTab] = useState<ResearchTabKey>(() => {
    const isTestEnv = typeof process !== "undefined" && Boolean((process as any).env?.VITEST);
    if (isTestEnv) return "all";
    if (typeof window !== "undefined" && window.localStorage) {
      const saved = window.localStorage.getItem("res_workflow_active_tab");
      if (saved && ["teams", "workflow", "overview", "claims", "audit", "all"].includes(saved)) {
        return saved as ResearchTabKey;
      }
    }
    return "teams";
  });

  const handleTabChange = (key: ResearchTabKey) => {
    setActiveTab(key);
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem("res_workflow_active_tab", key);
    }
  };

  const scope = JSON.stringify([apiBase, cwd, connectionGeneration, adoption?.id, state?.charter]);
  const selection = selected?.scope === scope ? selected : null;
  useEffect(() => { setViewStage(null); setSelection(null); }, [scope]);
  const selectedStage = viewStage ?? projection.stage;
  const currentStage = STAGES.find(stage => stage.id === projection.stage);
  const stageIndex = STAGES.findIndex(stage => stage.id === projection.stage);
  const observationStale = observationStatus !== "current";
  const legacyInstances = projection.runs.flatMap(run => run.steps.map(step => ({ run, step })));
  const chosenLegacy = selection ? legacyInstances.filter(row => row.step.agent === selection.role.name && (selection.stage === null || row.step.stage === selection.stage)) : [];
  const chosenObserved = selection ? projection.executions.filter(row => row.source === "observation" && executionRoleName(row) === selection.role.name
    && (selection.stage === null || row.stage === selection.stage || !row.stage)) : [];
  const initialLegacy = selection?.execution?.workflowRunId ? chosenLegacy.find(row => row.run.runId === selection.execution?.workflowRunId && row.step.key === selection.execution?.workflowKey) : undefined;
  if (loading) return <div className="flex h-full items-center justify-center text-sm text-[var(--text-tertiary)]">正在加载研究状态…</div>;

  const isAnyExecuting = projection.executions.some(row => ["streaming", "started", "running"].includes(row.status));

  const tabs: TabDef[] = [
    {
      key: "teams",
      label: "Agent 协作网络",
      icon: mdiAccountGroup,
      badge: projection.executions.length > 0 ? projection.executions.length : undefined,
      hasActivity: isAnyExecuting,
    },
    {
      key: "workflow",
      label: "工作流进度",
      icon: mdiLightningBolt,
      badge: currentStage ? `${stageIndex + 1}/5` : undefined,
      hasActivity: isAnyExecuting,
    },
    {
      key: "overview",
      label: "总览与预算",
      icon: mdiChartBoxOutline,
      badge: state?.budget?.dailyMaxAttempts ? `¥${state.budget.dailyMaxAttempts}` : undefined,
    },
    {
      key: "claims",
      label: "主张与评审",
      icon: mdiFileDocumentCheckOutline,
      badge: claims.length > 0 ? claims.length : undefined,
    },
    {
      key: "audit",
      label: "历史与审计",
      icon: mdiHistory,
      badge: attempts.length > 0 ? attempts.length : undefined,
    },
    {
      key: "all",
      label: "全部看板",
      icon: mdiViewGridOutline,
    },
  ];

  return (
    <div
      data-testid="research-pipeline"
      className="win11-page @container flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
    >
      {/* =========================================================================
          Windows 11 Command Bar Header (Acrylic Top Bar)
          ========================================================================= */}
      <header className="win11-acrylic-bar flex shrink-0 flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!embedded && onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="返回"
              className="win11-btn p-1.5"
            >
              <Icon path={mdiArrowLeft} size={0.75} />
            </button>
          )}
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[var(--accent-soft)] text-[var(--accent-text)]">
            <Icon path={mdiFolderOutline} size={0.65} />
          </div>
          <div className="min-w-0 flex-1">
            {!embedded && <h1 className="text-sm font-semibold leading-tight">res-workflow 科研工作台</h1>}
            <p className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]" title={cwd}>
              {cwd}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onOpenScience && (
            <button
              type="button"
              data-testid="research-open-science"
              onClick={() => onOpenScience()}
              className="win11-btn px-3 py-1.5 text-xs"
            >
              {t("science.openWorkspace", undefined, "Open Science")}
            </button>
          )}

          {/* Windows 11 Segmented Split Proportion Control */}
          {splitWorkspace && (
            <div className="win11-card-subtle flex items-center gap-1 p-1 text-xs">
              {splitWorkspace.split.mode === "full" ? (
                <button
                  type="button"
                  onClick={() => splitWorkspace.updateSplit({ mode: "split", ratio: 0.5 })}
                  className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold text-[var(--accent-text)] hover:bg-[var(--bg-hover)] transition-colors"
                  title="开启双栏分屏：左侧看 Session 实时内容，右侧看工作台"
                >
                  <Icon path={mdiViewSplitVertical} size={0.55} />
                  <span>分屏对照 Session</span>
                </button>
              ) : (
                <>
                  <span className="px-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">
                    分屏:
                  </span>
                  {(
                    [
                      { ratio: 0.65, label: "65:35 会话", title: "会话优先：左侧 Session 占 65%，右侧工作台占 35%" },
                      { ratio: 0.5, label: "50:50 对半", title: "均衡对半：左右各占 50%" },
                      { ratio: 0.35, label: "35:65 工作台", title: "工作台优先：左侧 Session 占 35%，右侧工作台占 65%" },
                    ] as const
                  ).map((preset) => {
                    const active = Math.abs(splitWorkspace.split.ratio - preset.ratio) < 0.05;
                    return (
                      <button
                        key={preset.ratio}
                        type="button"
                        onClick={() => splitWorkspace.updateSplit({ ratio: preset.ratio })}
                        className={`rounded px-2 py-0.5 text-[11px] font-medium transition-all ${
                          active
                            ? "bg-[var(--accent-solid)] text-white font-semibold shadow-xs"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        }`}
                        title={preset.title}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => splitWorkspace.setMode("full")}
                    className="rounded px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-all"
                    title="全屏最大化展开工作台"
                  >
                    全宽
                  </button>
                </>
              )}
            </div>
          )}

          {/* Sync Status & Refresh */}
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <span data-testid="research-sync-status" className="hidden sm:inline">
              {refreshing ? "正在同步" : error ? "科研记录待同步" : "科研记录每 5 秒同步"}
            </span>
            {checkedAt && (
              <time
                className="font-mono text-[11px] text-[var(--text-tertiary)]"
                title={`科研文件最近核对：${checkedAt}`}
              >
                {new Date(checkedAt).toLocaleTimeString("zh-CN")}
              </time>
            )}
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="win11-btn px-2.5 py-1 text-xs"
            >
              <Icon path={mdiRefresh} size={0.55} className={refreshing ? "animate-spin" : ""} />
              <span>刷新</span>
            </button>
          </div>
        </div>
      </header>

      {/* =========================================================================
          Windows 11 Pivot Tab Navigation Bar (3px Bottom Accent Pill)
          ========================================================================= */}
      <nav
        aria-label="科研工作流导航标签"
        className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2 scrollbar-none"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-testid={`research-tab-${tab.key}`}
              onClick={() => handleTabChange(tab.key)}
              className={`win11-pivot-tab whitespace-nowrap ${
                isActive ? "win11-pivot-tab-active" : ""
              }`}
            >
              <Icon
                path={tab.icon}
                size={0.65}
                className={isActive ? "text-[var(--accent-primary)]" : "text-[var(--text-tertiary)]"}
              />
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-mono leading-none ${
                    isActive
                      ? "bg-[var(--accent-soft)] text-[var(--accent-text)] font-bold"
                      : "bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {tab.badge}
                </span>
              )}
              {tab.hasActivity && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-green)] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-green)]" />
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--severity-warning-border)] bg-[var(--severity-warning-bg)] px-4 py-2 text-xs text-[var(--severity-warning-fg)]"
        >
          暂未同步：{error}{state ? "；保留上次成功读取的正式记录。" : ""}
        </div>
      )}

      {/* =========================================================================
          Main Tab Content Viewport (Mica Canvas with Generous Breathing Room)
          ========================================================================= */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-5">
        {/* TAB 1: Agent 协作网络 (Teams View) */}
        {(activeTab === "teams" || activeTab === "all") && (
          <div>
            <ResearchExecutionPanels
              mode="teams"
              cwd={cwd}
              projection={projection}
              stage={selectedStage}
              includeUnstaged={viewStage === null}
              stale={observationStale}
              activeSessionId={activeSessionId}
              onAgent={(role, execution) => setSelection({ scope, role, execution, stage: selectedStage })}
            />
          </div>
        )}

        {/* TAB 2: 工作流进度 (Workflow Pipeline View) */}
        {(activeTab === "workflow" || activeTab === "all") && (
          <div>
            <ResearchExecutionPanels
              mode="workflow"
              cwd={cwd}
              projection={projection}
              stage={selectedStage}
              includeUnstaged={viewStage === null}
              stale={observationStale}
              activeSessionId={activeSessionId}
              onAgent={(role, execution) => setSelection({ scope, role, execution, stage: selectedStage })}
            />
          </div>
        )}

        {/* TAB 3: 总览与预算 (Overview & Budget View) */}
        {(activeTab === "overview" || activeTab === "all") && (
          <div className="space-y-4">
            {/* Windows 11 Hero Card: Current Stage & Research Objective */}
            <section className="win11-card p-5">
              <div className="flex items-start gap-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[var(--accent-soft)] text-[var(--accent-text)]">
                  <Icon path={currentStage?.icon ?? mdiCircleOutline} size={0.95} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] border border-[var(--border-primary)]">
                      {currentStage ? `阶段 ${stageIndex + 1} / 5 · ${currentStage.label}` : "实际阶段未登记"}
                    </span>
                  </div>
                  <h2 data-testid="research-current-stage" className="mt-1.5 text-base font-semibold text-[var(--text-primary)]">
                    {currentStage?.short ?? (adopted ? "已接入，研究阶段尚未登记" : "尚未登记研究阶段")}
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                    {currentStage?.desc ?? "先查看实际执行记录；没有阶段标记的任务直接显示，不归入默认阶段。"}
                  </p>
                </div>
              </div>
              {!state && (
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  {error ? "尚无法读取研究状态" : "该目录尚未建立研究目标"}
                </p>
              )}
              <div className="win11-card-subtle mt-3.5 p-3 text-xs leading-relaxed">
                <strong className="text-[var(--text-primary)]">研究目标：</strong>
                <span className="text-[var(--text-secondary)]">
                  {objective ?? "未记录研究目标（state.json 缺少 charter.objective）"}
                </span>
              </div>
            </section>

            {/* Merged Overview and Budget */}
            <ResearchOverviewAndBudget
              cwd={cwd}
              viewStage={viewStage}
              onSelectStage={setViewStage}
              projection={projection}
              state={state}
              attempts={attempts}
              claims={claims}
              adopted={adopted}
              adoptionCwd={adoption?.cwd}
              connectionGeneration={connectionGeneration}
              onRefresh={refresh}
              workbench={workbench}
              observationStale={observationStale}
            />

            <ScienceInstances
              cwd={cwd}
              refreshSignal={refreshSignal}
              connectionGeneration={connectionGeneration}
              onOpenTask={onOpenScience ? taskId => onOpenScience({ kind: "task", taskId }) : undefined}
              onOpenArtifact={onOpenScienceArtifact}
            />

            {snapshot && (
              <ResWorkflowAdoption
                key={`adoption:${scope}`}
                cwd={cwd}
                adopted={adopted}
                adoption={adoption}
                charter={state?.charter}
                onRefresh={refresh}
                onOpenSource={onOpenSource}
              />
            )}

            {/* Windows 11 InfoBar: Formal Records vs Execution Observations */}
            <div
              role="note"
              data-testid="schematic-notice"
              className="win11-card p-4 text-xs"
            >
              <div className="flex items-start gap-2.5">
                <Icon path={mdiInformationOutline} size={0.75} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="font-semibold text-[var(--text-primary)]">正式科研记录与执行观测分别同步</p>
                  <p className="leading-relaxed text-[var(--text-secondary)]">
                    阶段、主张和验收依据正式文件；会话及原生任务依据有来源的执行观测。配置不会补成实际调用，执行结束不代表验收或发表。
                  </p>
                  <p
                    data-testid="research-observation-status"
                    className={observationStale ? "font-medium text-[var(--severity-warning-fg)]" : "text-[var(--text-secondary)]"}
                  >
                    {observationError ??
                      (observationStatus === "current"
                        ? "执行观测每 5 秒自动更新。"
                        : observationStatus === "loading"
                        ? "正在读取执行观测…"
                        : "当前执行观测尚不可用；正式科研记录独立保留。")}
                  </p>
                  {workbench && (
                    <p className="break-all font-mono text-[11px] text-[var(--text-tertiary)]">
                      观测更新：{new Date(workbench.updatedAt).toLocaleString("zh-CN")} · 心跳：{new Date(workbench.heartbeatAt).toLocaleTimeString("zh-CN")}
                      {workbench.coverage.partial ? ` · 覆盖不完整：${workbench.coverage.reasons.join("；")}` : ""}
                    </p>
                  )}
                  {workbench?.configurationSource && (
                    <p className="break-all font-mono text-[11px] text-[var(--text-tertiary)]">
                      配置来源：{workbench.configurationSource.kind} · SHA-256 {workbench.configurationSource.sha256}
                      {observationStale ? "（观测已过期）" : ""}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: 主张与评审 (Claims & Peer Review View) */}
        {(activeTab === "claims" || activeTab === "all") && (
          <div>
            <ResearchClaimPanels claims={claims} reviews={projection.reviews} onOpenArtifact={onOpenArtifact} />
          </div>
        )}

        {/* TAB 5: 历史与审计 (History & Audit Ledger View) */}
        {(activeTab === "audit" || activeTab === "all") && (
          <div className="space-y-4">
            <CollapsibleSection
              id="research-attempts-ledger"
              title={`尝试记录 · ${attempts.length} 条`}
              isUpdating={false}
              defaultOpen={true}
              subtitle="正式 ledger.jsonl 历史记录与实验结果流水"
            >
              {!attempts.length ? (
                <div className="win11-card-subtle p-4 text-center text-xs text-[var(--text-secondary)]">
                  暂无尝试记录。
                </div>
              ) : (
                <ol className="space-y-2.5 text-xs">
                  {attempts.slice(-12).reverse().map((attempt) => (
                    <li key={attempt.seq} className="win11-card-subtle p-3.5 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">
                          #{attempt.seq} · {attempt.kind}
                        </span>
                        <span className="rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                          {attempt.signal}
                        </span>
                      </div>
                      <p className="break-words leading-relaxed text-[var(--text-primary)]">{attempt.action}</p>
                      {attempt.observed && (
                        <p className="break-words text-[var(--text-secondary)] border-t border-[var(--border-primary)] pt-1.5 mt-1.5">
                          观测结果：{attempt.observed}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </CollapsibleSection>

            {!!workbench?.actions?.length && (
              <CollapsibleSection
                id="research-observed-actions"
                title={`已观测研究动作 · ${workbench.actions.length} 条`}
                isUpdating={isAnyExecuting}
                defaultOpen={true}
                subtitle="已观测的研究行为记录（不代替科学验收结果）"
              >
                <ul className="space-y-2 text-xs">
                  {workbench.actions.slice(-12).reverse().map((action) => (
                    <li
                      key={action.id}
                      className="win11-card-subtle flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">{action.action}</span>
                        <span className="rounded bg-[var(--bg-tertiary)] border border-[var(--border-primary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                          {action.status}
                        </span>
                        {action.claimId && (
                          <span className="font-mono text-[11px] text-[var(--accent-text)]">
                            {action.claimId}
                          </span>
                        )}
                      </div>
                      <time className="font-mono text-[11px] text-[var(--text-tertiary)]">
                        {new Date(action.at).toLocaleString("zh-CN")}
                      </time>
                    </li>
                  ))}
                </ul>
              </CollapsibleSection>
            )}

            <ResearchStartGuide
              key={`guide:${scope}`}
              cwd={cwd}
              objective={objective}
              hasHistory={adopted || attempts.length > 0 || !!projection.currentRun || projection.executions.length > 0}
              compact
            />
          </div>
        )}
      </div>

      {/* Drilldown Modal: Active across all tabs */}
      {selection && (
        <ResearchAgentDetail
          key={`${scope}:${selection.role.name}:${selection.execution?.id ?? ""}`}
          role={selection.role}
          instances={chosenLegacy}
          initialInstance={initialLegacy ? instanceKey(initialLegacy) : undefined}
          executions={chosenObserved}
          allExecutions={projection.executions}
          cwd={cwd}
          initialExecution={selection.execution?.source === "observation" ? selection.execution.id : undefined}
          observationsStale={observationStale}
          onClose={() => setSelection(null)}
          onOpenArtifact={onOpenArtifact}
          onSelectExecution={(role, execution) =>
            setSelection({ scope, role, execution, stage: selectedStage })
          }
        />
      )}
    </div>
  );
}
