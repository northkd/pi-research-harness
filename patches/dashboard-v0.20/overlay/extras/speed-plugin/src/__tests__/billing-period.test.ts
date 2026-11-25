import { describe, expect, it } from "vitest";
import { billingPeriod, inBillingPeriod } from "../billing-period.js";

describe("Beijing billing calendar", () => {
  it.each([
    ["2026-10-31T15:59:59.999Z", "2026-10"],
    ["2026-10-31T16:00:00.000Z", "2026-11"],
    ["2026-12-31T15:59:59.999Z", "2026-12"],
    ["2026-12-31T16:00:00.000Z", "2027-01"],
  ])("assigns %s to %s", (time, month) => {
    expect(billingPeriod(undefined, Date.parse(time)).month).toBe(month);
  });
  it.each([
    ["2026-02", 28],
    ["2028-02", 29],
    ["2026-10", 31],
  ])("uses the actual length of %s", (month, days) => {
    const period = billingPeriod(String(month));
    expect(period.endTime - period.startTime).toBe(Number(days) * 86400000);
    expect(inBillingPeriod(period.startTime, period)).toBe(true);
    expect(inBillingPeriod(period.endTime, period)).toBe(false);
  });
  it.each([
    "2026-13",
    "2026-00",
    "2026-1",
    "all",
    "../2026-10",
  ])("rejects invalid month %s", (month) => {
    expect(() => billingPeriod(month)).toThrow("Invalid billing month");
  });
});
