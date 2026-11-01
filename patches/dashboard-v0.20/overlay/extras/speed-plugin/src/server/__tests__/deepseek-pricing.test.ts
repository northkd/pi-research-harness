import { describe, expect, it } from "vitest";
import { deepseekMultiplier } from "../deepseek-pricing.js";

const priceAt = (
  time: string,
  provider = "cliproxy",
  model = "deepseek-v4-pro",
) => deepseekMultiplier(provider, model, Date.parse(time));

describe("official DeepSeek peak schedule", () => {
  it.each([
    ["2026-10-19T08:59:59+08:00", 0.5],
    ["2026-10-19T09:00:00+08:00", 1],
    ["2026-10-19T11:59:59+08:00", 1],
    ["2026-10-19T12:00:00+08:00", 0.5],
    ["2026-10-19T14:00:00+08:00", 1],
    ["2026-10-19T18:00:00+08:00", 0.5],
    ["2026-10-17T10:00:00+08:00", 0.5],
    ["2026-10-10T10:00:00+08:00", 0.5], // Makeup Saturday is still outside Mon–Fri.
    ["2026-10-01T10:00:00+08:00", 0.5],
    ["2026-10-07T10:00:00+08:00", 0.5],
    ["2026-10-08T10:00:00+08:00", 1],
  ])("%s uses multiplier %s", (time, expected) => {
    expect(priceAt(time as string)).toBe(expected);
  });
  it("does not discount Coding Plan or another provider with the same model ID", () => {
    expect(
      priceAt("2026-10-17T10:00:00+08:00", "cliproxy", "deepseek-v4.1-flash"),
    ).toBe(1);
    expect(priceAt("2026-10-17T10:00:00+08:00", "other")).toBe(1);
  });
  it("uses explicit provider metadata ahead of our timestamp estimate", () => {
    expect(
      deepseekMultiplier(
        "deepseek",
        "deepseek-flash",
        Date.parse("2026-10-19T10:00:00+08:00"),
        "offPeak",
      ),
    ).toBe(0.5);
    expect(
      deepseekMultiplier(
        "deepseek",
        "deepseek-flash",
        Date.parse("2026-10-17T10:00:00+08:00"),
        "peak",
      ),
    ).toBe(1);
  });
  it("does not assume future weekday holidays are ordinary peak days", () => {
    expect(priceAt("2027-01-01T10:00:00+08:00")).toBeUndefined();
  });
});
