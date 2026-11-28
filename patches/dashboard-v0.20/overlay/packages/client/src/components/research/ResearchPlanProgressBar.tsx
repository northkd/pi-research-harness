import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiClockOutline, mdiFormatListChecks, mdiProgressClock } from "@mdi/js";
import { Icon } from "@mdi/react";
import type { PlansAggregateSummary, PlanSummary } from "./research-plan-topology.js";
import { triStateLabel } from "./research-plan-topology.js";

function planPillTone(plan: PlanSummary): { icon: string; iconClass: string; countClass: string; statusHint: string | null } {
  const incomplete = plan.blocked + plan.failed;
  if (incomplete > 0 && plan.state === "ended") {
    return {
      icon: mdiAlertCircleOutline,
      iconClass: "text-[var(--accent-red)]",
      countClass: "text-[var(--accent-red)] font-semibold",
      statusHint: `${incomplete} 受阻`,
    };
  }
  if (plan.state === "ended") {
    return {
      icon: mdiCheckCircleOutline,
      iconClass: "text-[var(--accent-green)]",
      countClass: "text-[var(--text-tertiary)]",
      statusHint: null,
    };
  }
  if (plan.state === "queued") {
    return {
      icon: mdiClockOutline,
      iconClass: "text-[var(--accent-orange)]",
      countClass: "text-[var(--accent-orange)] font-medium",
      statusHint: triStateLabel(plan.state),
    };
  }
  return {
    icon: mdiProgressClock,
    iconClass: "text-[var(--accent-blue)]",
    countClass: "text-[var(--accent-blue)] font-medium",
    statusHint: plan.queued > 0 ? `排队 ${plan.queued}` : triStateLabel(plan.state),
  };
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
    completedTasks,
    blockedTasks,
    failedTasks,
    inProgressTasks,
    queuedTasks,
    progressPercent,
    plans,
  } = summary;
  const incompleteEnded = blockedTasks + failedTasks;
  const incompletePercent = totalTasks > 0 ? Math.min(100 - progressPercent, Math.round((incompleteEnded / totalTasks) * 100)) : 0;

  if (compact) {
    return (
      <div
        data-testid="canvas-captain-plan-progress"
        className="flex items-center gap-2 text-[9.5px]"
      >
        <span className="shrink-0 font-medium text-[var(--text-secondary)]">
          {totalPlans === 0 ? "先 Plan 后 Work" : `Plan 进度 ${endedPlans}/${totalPlans}`}
        </span>
        {totalPlans > 0 ? (
          <>
            <div
              role="progressbar"
              aria-label="主 Agent Plan 完成进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              className="flex h-1 min-w-[36px] flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
            >
              <div
                className="h-full bg-[var(--accent-green)] transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
              {incompletePercent > 0 && (
                <div
                  className="h-full bg-[var(--accent-red)] transition-all duration-300"
                  style={{ width: `${incompletePercent}%` }}
                />
              )}
            </div>
            <span className="shrink-0 font-mono text-[var(--text-tertiary)]">
              {completedTasks}/{totalTasks}
              {incompleteEnded > 0 && <span className="ml-1 text-[var(--accent-red)]">({incompleteEnded}受阻)</span>}
            </span>
          </>
        ) : (
          <span className="ml-auto font-mono text-[var(--text-tertiary)]">待制定</span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="research-main-plan-progress"
      className="flex flex-col gap-1.5 border-t border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-primary)_45%,var(--bg-secondary))] px-3 py-2 text-[11px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[var(--text-secondary)]">
            <Icon path={mdiFormatListChecks} size={0.54} className="text-[var(--accent-primary)]" />
            <span>先 Plan 后 Work</span>
          </span>
          <span className="text-[11px] text-[var(--text-primary)]">
            {phase === "awaiting-plan"
              ? "等待主 Agent 制定执行计划"
              : `主 Agent Plan 进度：${endedPlans}/${totalPlans} 个 Plan 已结束 · 完成 ${completedTasks}/${totalTasks} (${progressPercent}%)`}
          </span>
        </div>
        {totalPlans > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] tabular-nums">
            {inProgressTasks > 0 && (
              <span className="rounded border px-1.5 py-0 border-sky-500/25 bg-sky-500/10 text-[var(--accent-blue)]">
                进行中 {inProgressTasks}
              </span>
            )}
            {queuedTasks > 0 && (
              <span className="rounded border px-1.5 py-0 border-amber-500/25 bg-amber-500/10 text-[var(--accent-orange)]">
                排队中 {queuedTasks}
              </span>
            )}
            {endedTasks > 0 && (
              <span className="rounded border px-1.5 py-0 border-emerald-500/25 bg-emerald-500/10 text-[var(--accent-green)]">
                已结束 {endedTasks}
              </span>
            )}
            {incompleteEnded > 0 && (
              <span className="rounded border px-1.5 py-0 border-red-500/30 bg-red-500/10 font-medium text-[var(--accent-red)]">
                受阻 {incompleteEnded}
              </span>
            )}
          </div>
        )}
      </div>

      <div
        role="progressbar"
        aria-label="主 Agent Plan 总完成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
      >
        <div
          className="h-full bg-[var(--accent-green)] transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
        {incompletePercent > 0 && (
          <div
            className="h-full bg-[var(--accent-red)] transition-all duration-300"
            style={{ width: `${incompletePercent}%` }}
          />
        )}
      </div>

      {plans.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {plans.map((plan: PlanSummary) => {
            const active = selectedPlanId === plan.id;
            const tone = planPillTone(plan);
            return (
              <button
                key={plan.id}
                type="button"
                data-testid="plan-progress-open-todo"
                aria-haspopup="dialog"
                aria-expanded={active}
                title={`点击查看「${plan.label}」的任务清单`}
                onClick={() => onSelectPlan?.(plan.id)}
                className={`focus-ring inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? "border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-text)] font-semibold"
                    : "border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60 hover:bg-[var(--bg-hover)]"
                }`}
              >
                <Icon path={tone.icon} size={0.52} className={`shrink-0 ${tone.iconClass}`} />
                <span className="max-w-[240px] truncate">{plan.label}</span>
                {tone.statusHint && (
                  <span className={`text-[10px] ${tone.countClass}`}>{tone.statusHint}</span>
                )}
                <span className={`font-mono text-[10px] ${tone.countClass}`}>
                  {plan.completed}/{plan.total}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
