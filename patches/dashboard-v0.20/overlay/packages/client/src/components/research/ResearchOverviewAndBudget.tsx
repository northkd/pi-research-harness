import { Icon } from "@mdi/react";
import {
  mdiLightbulbOnOutline,
  mdiFlaskOutline,
  mdiMagnifyScan,
  mdiFileDocumentOutline,
  mdiBookOpenPageVariantOutline,
} from "@mdi/js";
import type { StageId, Claim, Attempt, LoopState, ResearchProjection } from "./research-projection.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";

export const STAGES = [
  { id: "1-idea", label: "Idea Discovery", short: "调研与发散", desc: "文献调研、独立发散、收窄问题", icon: mdiLightbulbOnOutline },
  { id: "2-experiment", label: "Experiment", short: "实验与验证", desc: "最小可判定实验、真实运行与原始输出", icon: mdiFlaskOutline },
  { id: "3-review", label: "Review", short: "对抗评审", desc: "跨模型族评审、反例、多轮收敛", icon: mdiMagnifyScan },
  { id: "4-summary", label: "Summary", short: "结论核对", desc: "claim 与证据逐条核对、边界声明", icon: mdiFileDocumentOutline },
  { id: "5-writing", label: "Writing", short: "论文与审计", desc: "论文、引用审计、投稿产物", icon: mdiBookOpenPageVariantOutline },
] as const;

export function ResearchOverviewAndBudget({
  cwd,
  viewStage,
  onSelectStage,
  projection,
  state,
  attempts,
  claims,
  adoptionCwd,
  workbench,
  observationStale,
  showStageSelector = true,
}: {
  cwd: string;
  viewStage: StageId | null;
  onSelectStage: (stage: StageId | null) => void;
  projection: ResearchProjection;
  state: LoopState | null | undefined;
  attempts: Attempt[];
  claims: Claim[];
  adopted: boolean;
  adoptionCwd?: string;
  connectionGeneration?: number;
  onRefresh?: () => void;
  workbench?: ResearchWorkbenchObservation | null;
  observationStale?: boolean;
  showStageSelector?: boolean;
}) {
  const selectedStage = viewStage ?? projection.stage;
  const isUpdating = projection.executions.some((ex) =>
    !(observationStale && ex.source === "observation") && ["streaming", "started", "running"].includes(ex.status)
  );
  const observed = workbench?.schema === "res-workflow.workbench-observation.v1" && workbench.cwd === (adoptionCwd ?? cwd)
    && workbench.observedUsage?.metric === "observed-assistant-responses"
    && [workbench.observedUsage.responses, workbench.observedUsage.inputTokens, workbench.observedUsage.outputTokens, workbench.observedUsage.inheritedExcluded]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    ? workbench : null;

  return (
    <CollapsibleSection
      id="research-overview-and-budget"
      testId="research-overview-and-budget"
      title="研究总览"
      isUpdating={isUpdating}
      defaultOpen={true}
      subtitle="正式研究指标与实际执行用量"
    >
      <div className="space-y-4">
        {/* Stage Selection Card (WinUI 3 Surface) */}
        {showStageSelector && <div className="win11-card-subtle p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--text-secondary)]">
              正在查看：
              <strong className="text-[var(--text-primary)]">
                {viewStage
                  ? STAGES.find((s) => s.id === viewStage)?.short
                  : "当前实际记录（含阶段未登记的执行）"}
              </strong>
            </p>
            {viewStage && (
              <button
                type="button"
                onClick={() => onSelectStage(null)}
                className="win11-btn px-3 py-1 text-xs font-medium text-[var(--accent-text)]"
              >
                跟随当前实际记录
              </button>
            )}
          </div>

          <ol className="win11-grid-stage-pills">
            {STAGES.map((stage) => {
              const isSelected = selectedStage === stage.id;
              const isCurrent = projection.stage === stage.id;
              return (
                <li key={stage.id}>
                  <button
                    type="button"
                    data-testid={`research-stage-${stage.id}`}
                    aria-label={`查看阶段：${stage.short}`}
                    aria-pressed={isSelected}
                    aria-current={isCurrent ? "step" : undefined}
                    onClick={() => onSelectStage(stage.id)}
                    className={`w-full rounded-[6px] border p-3 text-left text-xs transition-all ${
                      isSelected
                        ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] shadow-xs"
                        : "border-[var(--border-primary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                      <Icon
                        path={stage.icon}
                        size={0.65}
                        className={isSelected ? "text-[var(--accent-primary)]" : "text-[var(--text-secondary)]"}
                      />
                      <span>{stage.short}</span>
                    </div>
                    <span className="mt-1 block text-[11px] text-[var(--text-tertiary)]">
                      {isCurrent
                        ? "最近进入"
                        : projection.enteredStages.has(stage.id)
                        ? "此前进入"
                        : "无进入记录"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>}

        {/* 4 Stats KPI Cards (Auto-Fit Grid prevents squishing in any Split Ratio) */}
        <section data-testid="research-stats" className="win11-grid-stats">
          <Stat
            label="尝试次数"
            value={String(attempts.length)}
            note="正式 ledger.jsonl 记录"
          />
          <Stat
            label="主张"
            value={String(claims.length)}
            note={`${claims.filter((c) => c.acceptance?.verdict === "accepted").length} 条内部验收`}
          />
          <Stat
            label="发表授权"
            value={String(claims.filter((c) => c.publication?.authorized).length)}
            note="用户授权 ≠ 已实际发表"
          />
          <Stat
            label="循环阶段"
            value={state?.phase === undefined ? "未记录" : String(state.phase)}
            note="控制环版本，非研究阶段"
          />
        </section>

        <section data-testid="research-observed-usage" className="win11-card-subtle space-y-2 p-4 text-xs">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">实际用量</h3>
          {observed ? <>
            <p data-testid="research-observed-responses">已观测模型响应至少 {observed.observedUsage.responses} 次 · 输入 {observed.observedUsage.inputTokens} tokens · 输出 {observed.observedUsage.outputTokens} tokens</p>
            {observed.observedUsage.inheritedExcluded > 0 && <p>已排除 {observed.observedUsage.inheritedExcluded} 条继承的历史响应，避免重复计数。</p>}
            {observationStale && <p role="status">观测记录已过期，当前显示上次取得的用量。</p>}
            {observed.coverage.partial && <p role="status">正在补齐已接入会话记录，当前观测尚不完整。</p>}
          </> : <p>尚无可核验的会话用量观测，实际调用次数仍未知。</p>}
          <p className="text-[var(--text-secondary)]">用量来自加入工作台后保存的会话与子代理模型响应，未保存的失败和重试可能未计入，不包含接入助手或外部 agy。费用请在计费明细中核对。</p>
        </section>
      </div>
    </CollapsibleSection>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="win11-card-subtle min-w-0 p-4">
      <p className="text-xs font-medium text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tracking-tight text-[var(--text-primary)]">{value}</p>
      <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">{note}</p>
    </div>
  );
}
