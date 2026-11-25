const DEFAULT_MAX_CONCURRENT_SPAWNS = 4;
function actionLabelFor(action) {
  if (action.skill) return action.skill;
  const flow = action.payload?.flow;
  if (typeof flow === "string" && flow.length > 0) return `${action.kind}:${flow}`;
  return action.kind;
}
function actionEntries(automation) {
  const cfg = automation.config;
  if (!cfg) return [];
  if (cfg.actions && cfg.actions.length > 0) return cfg.actions;
  if (cfg.action) return [cfg.action];
  return [];
}
function effectiveBound(automation, settingsDefault = DEFAULT_MAX_CONCURRENT_SPAWNS) {
  const declared = automation.config?.maxConcurrentSpawns;
  return typeof declared === "number" && declared >= 1 ? declared : settingsDefault;
}
function settingsDefaultBound(configValue, envValue) {
  if (typeof configValue === "number" && Number.isInteger(configValue) && configValue >= 1) {
    return configValue;
  }
  if (envValue !== void 0 && envValue.trim().length > 0) {
    const n = Number(envValue);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return DEFAULT_MAX_CONCURRENT_SPAWNS;
}
function resolveChildren(automation, bound) {
  const all = [];
  for (const action of actionEntries(automation)) {
    const count = typeof action.count === "number" && action.count >= 1 ? action.count : 1;
    const label = actionLabelFor(action);
    for (let i = 0; i < count; i++) {
      all.push({ action, actionLabel: label });
    }
  }
  const cap = Math.max(1, Math.floor(bound));
  if (all.length <= cap) return { specs: all, truncated: 0 };
  return { specs: all.slice(0, cap), truncated: all.length - cap };
}
export {
  DEFAULT_MAX_CONCURRENT_SPAWNS,
  effectiveBound,
  resolveChildren,
  settingsDefaultBound
};
