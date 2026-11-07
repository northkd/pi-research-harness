/**
 * Compatibility export for older goal-plugin callers. Goal turn and spend
 * counters are observational; historical budget fields never pause a loop.
 */
import type { GoalBudget } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface BudgetGuardSnapshot {
  status: string;
  turnsUsed: number;
}

export interface BudgetHaltDecision {
  halt: boolean;
  /** Command to dispatch when `halt` is true. */
  command?: string;
}

/**
 * Explicit pause, completion and the crash-loop breaker remain separate.
 */
export function decideBudgetHalt(
  _snapshot: BudgetGuardSnapshot,
  _budget: GoalBudget | undefined,
): BudgetHaltDecision {
  return { halt: false };
}
