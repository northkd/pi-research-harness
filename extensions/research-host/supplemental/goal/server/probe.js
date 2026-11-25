function probeGoalCommandSurface(surface) {
  if (!surface) return "intent-only";
  if (surface.acceptsConfig) return "full";
  if (surface.acceptsSubgoal) return "criteria-dashboard-budget";
  return "intent-only";
}
function sanitizeArg(raw) {
  const clean = raw.replace(/[\s/"'`\\\x00-\x1f]+/g, "").trim();
  return clean.length > 0 ? clean : null;
}
function goalConfigCommand(tier, config) {
  if (tier !== "full") return null;
  const parts = ["/goal config"];
  if (config.judge) {
    const provider = sanitizeArg(config.judge.provider);
    const modelId = sanitizeArg(config.judge.modelId);
    if (provider && modelId) parts.push(`--judge ${provider}/${modelId}`);
  }
  if (parts.length === 1) return null;
  return parts.join(" ");
}
function tierEnforcesBudgetDashboardSide(_tier) {
  return false;
}
export {
  goalConfigCommand,
  probeGoalCommandSurface,
  tierEnforcesBudgetDashboardSide
};
