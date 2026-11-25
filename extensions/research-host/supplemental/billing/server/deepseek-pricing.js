const HOLIDAYS = {
  2026: [
    ["2026-01-01", "2026-01-03"],
    ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"],
    ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"],
    ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"]
  ]
};
const DIRECT_NAMES = /* @__PURE__ */ new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro"
]);
function deepseekMultiplier(provider, normalizedModel, completedAt, reportedPeriod) {
  const direct = provider === "cliproxy" && (normalizedModel === "deepseek-v4-flash-vision-exp" || normalizedModel === "deepseek-v4-pro") || provider === "deepseek" && DIRECT_NAMES.has(normalizedModel);
  if (!direct) return 1;
  if (reportedPeriod) return reportedPeriod === "offPeak" ? 0.5 : 1;
  const time = new Date(completedAt);
  const weekday = time.getUTCDay();
  const minutes = time.getUTCHours() * 60 + time.getUTCMinutes();
  const peakWindow = weekday >= 1 && weekday <= 5 && (minutes >= 60 && minutes < 240 || minutes >= 360 && minutes < 600);
  if (!peakWindow) return 0.5;
  const holidays = HOLIDAYS[time.getUTCFullYear()];
  if (!holidays) return void 0;
  const date = time.toISOString().slice(0, 10);
  return holidays.some(([from, to]) => date >= from && date <= to) ? 0.5 : 1;
}
export {
  deepseekMultiplier
};
