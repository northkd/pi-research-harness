import type { PlansAggregateSummary, PlanSummary, WorkTriState } from "./research-plan-topology.js";
import { triStateLabel } from "./research-plan-topology.js";

function stateBadgeClass(state: WorkTriState): string {
  if (state === "ended") return "border-emerald-500/25 bg-emerald-500/10 text-[var(--accent-green)]";
  if (state === "queued") return "border-amber-500/25 bg-amber-500/10 text-[var(--accent-orange)]";
  return "border-sky-500/25 bg-sky-500/10 text-[var(--accent-blue)]";
}

export function ResearchMainPlanProgress({
  summary,
  selectedPlanId,
  onSelectPlan,
  compact = false,
}: {
  summary: PlansAggregateSummary;
  selectedPlanId?: string | null;
  onSelectPlan?: (planId: string) => void;
  compact?: boolean;
}) {
  const {
    phase,
    totalPlans,
    endedPlans,
    totalTasks,
    endedTasks,
    inProgressTasks,
    queuedTasks,
    progressPercent,
    plans,
  } = summary;

  if (compact) {
    return (
      <div
        data-testid="canvas-captain-plan-progress"
        className="research-fleet-box space-y-1 text-[9.5px]"
      >
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-semibold text-[var(--text-primary)]">
            {totalPlans === 0 ? "先 Plan 后 Work" : `Plan 进度 ${endedPlans}/${totalPlans}`}
          </span>
          <span className="font-mono text-[var(--text-secondary)]">
            {totalPlans === 0 ? "待制定 Plan" : `${endedTasks}/${totalTasks} (${progressPercent}%)`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="主 Agent Plan 完成进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
        >
          <div
            className="h-full rounded-full bg-[var(--accent-green)] transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        {totalPlans > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[9px] text-[var(--text-tertiary)]">
            <span>进行 {inProgressTasks}</span>
            <span>·</span>
            <span>排队 {queuedTasks}</span>
            <span>·</span>
            <span>结束 {endedTasks}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="research-main-plan-progress"
      className="flex flex-col gap-1.5 border-t border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-primary)_55%,var(--bg-secondary))] px-3 py-2 text-[11px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-primary)]">
            先 Plan 后 Work
          </span>
          <span className="font-medium text-[var(--text-primary)]">
            {phase === "awaiting-plan"
              ? "等待主 Agent 提交执行 Plan（再分派 Multi-Agent）"
              : `主 Agent Plan 进度：${endedPlans}/${totalPlans} 个 Plan 已结束 · ${endedTasks}/${totalTasks} 个 Multi-Agent 任务 (${progressPercent}%)`}
          </span>
        </div>
        {totalPlans > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] tabular-nums">
            <span className="rounded border px-1.5 py-0.5 border-sky-500/25 bg-sky-500/10 text-[var(--accent-blue)]">
              进行中 {inProgressTasks}
            </span>
            <span className="rounded border px-1.5 py-0.5 border-amber-500/25 bg-amber-500/10 text-[var(--accent-orange)]">
              排队中 {queuedTasks}
            </span>
            <span className="rounded border px-1.5 py-0.5 border-emerald-500/25 bg-emerald-500/10 text-[var(--accent-green)]">
              已结束 {endedTasks}
            </span>
          </div>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="主 Agent Plan 总完成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
      >
        <div
          className="h-full rounded-full bg-[var(--accent-green)] transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      {plans.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {plans.map((plan: PlanSummary) => {
            const active = selectedPlanId === plan.id;
            return (
              <button
                key={plan.id}
                type="button"
                onClick={() => onSelectPlan?.(plan.id)}
                className={`focus-ring inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] transition-colors ${
                  active
                    ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-text)] font-semibold"
                    : "border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <span className="max-w-[140px] truncate">{plan.label}</span>
                <span className={`rounded border px-1 py-0 text-[9.5px] ${stateBadgeClass(plan.state)}`}>
                  {triStateLabel(plan.state)}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                  {plan.ended}/{plan.total}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
