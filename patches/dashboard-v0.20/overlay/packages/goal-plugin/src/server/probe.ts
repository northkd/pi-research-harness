/**
 * Probe the `@ricoyudog/pi-goal-hermes` command surface to pick how much of a
 * goal's config (judge model and criteria) the dashboard can
 * push into the live loop.
 *
 * The extension is NOT vendored in this repo, so we cannot import its command
 * grammar. The probe takes a `GoalCommandSurface` descriptor — what the host
 * has detected the running extension accepts — and maps it to a tier. With no
 * descriptor (extension absent / unknown), it falls back to the safe tier.
 *
 * Tiers (design Decision 2):
 *   full                      — extension accepts `/goal config …`: push judge.
 *   criteria-dashboard-budget — only `/goal <text>` + `/subgoal <text>`: criteria via
 *                               /subgoal, judge intent-only (historical tier name).
 *   intent-only               — unknown surface: record on GoalRecord, no loop coupling.
 *
 * Upgrade seam: when a future extension advertises `acceptsConfig`, `goalConfigCommand`
 * emits the config command; until then it returns null and the caller degrades.
 *
 * See change: sophisticate-goal-authoring-and-control (tasks 3.1, 3.2).
 */
import type { GoalBudget, GoalJudge } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export type GoalCommandTier = "full" | "criteria-dashboard-budget" | "intent-only";

/** What the host detected the running extension's command surface accepts. */
export interface GoalCommandSurface {
  /** Extension accepts a structured config command (e.g. `/goal config …`). */
  acceptsConfig?: boolean;
  /** Extension accepts `/subgoal <text>` for criteria. */
  acceptsSubgoal?: boolean;
}

/** Map a detected command surface to a coupling tier. */
export function probeGoalCommandSurface(surface?: GoalCommandSurface | null): GoalCommandTier {
  if (!surface) return "intent-only";
  if (surface.acceptsConfig) return "full";
  if (surface.acceptsSubgoal) return "criteria-dashboard-budget";
  return "intent-only";
}

/**
 * Emit the structured config command for the `full` tier, or `null` when the
 * tier can't accept it (caller records intent).
 * Command grammar is provisional — the upgrade seam for a vendored extension.
 */
/** Strip whitespace, slashes, quotes, and control chars that could break a
 *  slash-command argument. Returns `null` if nothing usable remains. */
function sanitizeArg(raw: string): string | null {
  const clean = raw.replace(/[\s/"'`\\\x00-\x1f]+/g, "").trim();
  return clean.length > 0 ? clean : null;
}

export function goalConfigCommand(
  tier: GoalCommandTier,
  config: { budget?: GoalBudget; judge?: GoalJudge },
): string | null {
  if (tier !== "full") return null;
  const parts: string[] = ["/goal config"];
  if (config.judge) {
    const provider = sanitizeArg(config.judge.provider);
    const modelId = sanitizeArg(config.judge.modelId);
    if (provider && modelId) parts.push(`--judge ${provider}/${modelId}`);
  }
  if (parts.length === 1) return null;
  return parts.join(" ");
}

/** Compatibility query: no command tier enforces research budget caps. */
export function tierEnforcesBudgetDashboardSide(_tier: GoalCommandTier): boolean {
  return false;
}
