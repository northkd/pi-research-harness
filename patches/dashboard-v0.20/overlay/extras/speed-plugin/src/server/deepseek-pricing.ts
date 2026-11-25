// Verified 2026-10-17: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Holiday dates: https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html
const HOLIDAYS: Record<number, readonly (readonly [string, string])[]> = {
  2026: [
    ["2026-01-01", "2026-01-03"],
    ["2026-02-15", "2026-02-23"],
    ["2026-04-04", "2026-04-06"],
    ["2026-05-01", "2026-05-05"],
    ["2026-06-19", "2026-06-21"],
    ["2026-09-25", "2026-09-27"],
    ["2026-10-01", "2026-10-07"],
  ],
};
const DIRECT_NAMES = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
]);

/** Current official schedule; completion time is our estimate unless the log specifies a tier. */
export function deepseekMultiplier(
  provider: string,
  normalizedModel: string,
  completedAt: number,
  reportedPeriod?: "peak" | "offPeak",
): number | undefined {
  const direct =
    (provider === "cliproxy" &&
      (normalizedModel === "deepseek-v4-flash-vision-exp" ||
        normalizedModel === "deepseek-v4-pro")) ||
    (provider === "deepseek" && DIRECT_NAMES.has(normalizedModel));
  if (!direct) return 1;
  if (reportedPeriod) return reportedPeriod === "offPeak" ? 0.5 : 1;
  const time = new Date(completedAt);
  const weekday = time.getUTCDay();
  const minutes = time.getUTCHours() * 60 + time.getUTCMinutes();
  // UTC 01–04 / 06–10 == Beijing 09–12 / 14–18; dates coincide inside these windows.
  const peakWindow =
    weekday >= 1 &&
    weekday <= 5 &&
    ((minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600));
  if (!peakWindow) return 0.5;
  const holidays = HOLIDAYS[time.getUTCFullYear()];
  if (!holidays) return undefined; // An unverified holiday calendar must not create a false peak charge.
  const date = time.toISOString().slice(0, 10);
  return holidays.some(([from, to]) => date >= from && date <= to) ? 0.5 : 1;
}
