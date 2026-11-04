import type {
  BillingReport,
  BillingSummary,
} from "@blackbelt-technology/pi-dashboard-speed-plugin";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingStatsSection } from "../BillingStatsSection.js";

const summary = (cost: number, complete = true): BillingSummary => ({
  currency: "CNY",
  complete,
  unpricedTurns: complete ? 0 : 1,
  invalidRecords: 0,
  sessionTotalCost: cost,
  mainTotalCost: cost * 0.8,
  subagentTotalCost: cost * 0.2,
  totalInputCost: 0,
  totalOutputCost: cost,
  totalCacheCost: 0,
  totalCacheWriteCost: 0,
  totalRequestCost: 0,
  totalCacheSavings: 0,
  totalInputTokens: 0,
  totalOutputTokens: 1000,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalTokens: 1000,
  modelBreakdown: [
    {
      provider: "cliproxy",
      model: "test-model",
      agentType: "mixed",
      callCount: 2,
      inputTokens: 0,
      outputTokens: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1000,
      cost,
      unpricedCalls: complete ? 0 : 1,
    },
  ],
});
function report(month = "2026-02", cost = 3, complete = true): BillingReport {
  const billing = summary(cost, complete);
  return {
    billingPeriod: {
      month,
      timeZone: "Asia/Shanghai",
      startTime: 0,
      endTime: 1,
    },
    availableMonths: ["2026-02", "2026-01"],
    generatedAt: Date.parse("2026-02-02T00:00:00Z"),
    unavailableSessions: 0,
    billing,
    directories: [{ cwd: "/one", sessionCount: 1, billing }],
    sessions: [
      {
        key: "file",
        id: "old",
        name: "Ended session",
        cwd: "/one",
        turnCount: 2,
        lastActivity: 0,
        billing,
      },
    ],
  };
}
let requests: { url: string; resolve: (value: unknown) => void }[];
async function respond(index: number, data: BillingReport) {
  await act(async () =>
    requests[index].resolve({ ok: true, json: async () => data }),
  );
}
beforeEach(() => {
  requests = [];
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-02-02T00:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise((resolve) => requests.push({ url, resolve })),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("billing statistics", () => {
  it("sorts model costs high to low by default and toggles direction without refetching", async () => {
    render(<BillingStatsSection />);
    const data = report();
    const model = data.billing.modelBreakdown[0];
    data.billing.modelBreakdown = [
      { ...model, model: "cheap", cost: 1 },
      { ...model, model: "expensive", cost: 9 },
      { ...model, model: "middle", cost: 5 },
    ];
    await respond(0, data);
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    const names = () =>
      screen
        .getAllByTestId("billing-model-row")
        .map((row) => row.textContent?.match(/^(cheap|expensive|middle)/)?.[0]);
    expect(names()).toEqual(["expensive", "middle", "cheap"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Usage: high to low ↓" }),
    );
    expect(names()).toEqual(["cheap", "middle", "expensive"]);
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(names()).toEqual(["cheap", "middle", "expensive"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Usage: low to high ↑" }),
    );
    expect(names()).toEqual(["expensive", "middle", "cheap"]);
    expect(requests).toHaveLength(1);
    expect(data.billing.modelBreakdown.map((entry) => entry.model)).toEqual([
      "cheap",
      "expensive",
      "middle",
    ]);
  });
  it("loads monthly CNY totals and filters directory, session and model details without another request", async () => {
    render(<BillingStatsSection />);
    await waitFor(() => expect(requests).toHaveLength(1));
    const data = report();
    data.directories.push({
      cwd: "/two",
      sessionCount: 1,
      billing: summary(7),
    });
    data.sessions.push({
      ...data.sessions[0],
      key: "other",
      name: "Other session",
      cwd: "/two",
      billing: summary(7),
    });
    data.billing = summary(10);
    await respond(0, data);
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "¥10.00",
    );
    fireEvent.change(screen.getByLabelText("Directory"), {
      target: { value: "/one" },
    });
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "¥3.00",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(screen.getByText("Ended session")).toBeTruthy();
    expect(screen.queryByText("Other session")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByText("test-model")).toBeTruthy();
    expect(screen.getByTestId("billing-model-row").textContent).toContain(
      "¥3.0000",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/speed-monitor/billing?month=2026-02");
  });
  it("clears old values on month selection and rejects late responses after a quick second switch", async () => {
    render(<BillingStatsSection />);
    await respond(0, report());
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "2026-01" },
    });
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "—",
    );
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "2026-02" },
    });
    await respond(2, report("2026-02", 7));
    await respond(1, report("2026-01", 99));
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "¥7.00",
    );
    expect(screen.getByLabelText<HTMLSelectElement>("Month").value).toBe(
      "2026-02",
    );
  });
  it("shows a failed load separately from a genuinely empty free month and retries with GET", async () => {
    render(<BillingStatsSection />);
    await act(async () => requests[0].resolve({ ok: false, status: 503 }));
    expect(screen.getByRole("alert").textContent).toContain("HTTP 503");
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "—",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const empty = report("2026-02", 0);
    empty.sessions = [];
    empty.directories = [];
    await respond(1, empty);
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "¥0.00",
    );
    expect(
      screen.getByText("No usage recorded for this month and directory."),
    ).toBeTruthy();
    const fetch = vi.mocked(global.fetch);
    expect(
      fetch.mock.calls.every(
        ([, options]) => !options?.method || options.method === "GET",
      ),
    ).toBe(true);
  });
  it("labels partial totals and unavailable sessions without claiming zero means free", async () => {
    render(<BillingStatsSection />);
    const data = report("2026-02", 0, false);
    data.unavailableSessions = 1;
    await respond(0, data);
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "Pending pricing",
    );
    expect(screen.getByText(/1 unavailable sessions/)).toBeTruthy();
    expect(
      screen.queryByText("No usage recorded for this month and directory."),
    ).toBeNull();
  });
  it("allows viewing a historical month even when it has no saved usage", async () => {
    render(<BillingStatsSection />);
    await respond(0, report());
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "2025-12" },
    });
    expect(requests.at(-1)?.url).toContain("month=2025-12");
  });
  it("rejects a server report for another month", async () => {
    render(<BillingStatsSection />);
    await respond(0, report("2026-01", 99));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "—",
    );
  });
  it("keeps entry names on the left and pins cost amounts to the right", async () => {
    render(<BillingStatsSection />);
    await respond(0, report());
    const expectPinnedCost = (row: HTMLElement) => {
      const amounts = Array.from(
        row.querySelectorAll<HTMLElement>("span, div"),
      ).filter(
        (element) =>
          element.children.length === 0 &&
          element.textContent?.trim() === "¥3.0000",
      );
      expect(amounts).toHaveLength(1);
      const tokens = amounts[0].className.split(/\s+/);
      expect(tokens).toEqual(
        expect.arrayContaining([
          "shrink-0",
          "text-right",
          "font-mono",
          "tabular-nums",
        ]),
      );
      expect(tokens).not.toContain("text-left");
      const breakdown = row.querySelector(".flex-wrap");
      if (breakdown) expect(breakdown.className).toContain("tabular-nums");
    };
    expectPinnedCost(screen.getByTestId("billing-directory-row"));
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    expectPinnedCost(screen.getByTestId("billing-session-row"));
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    expectPinnedCost(screen.getByTestId("billing-model-row"));
  });
  it("keeps a selected historical month when the calendar rolls forward", async () => {
    vi.useFakeTimers();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-02-28T15:59:59.900Z"));
    render(<BillingStatsSection />);
    await respond(0, report());
    fireEvent.change(screen.getByLabelText("Month"), {
      target: { value: "2026-01" },
    });
    await respond(1, report("2026-01", 8));
    clock.mockReturnValue(Date.parse("2026-02-28T16:00:00.100Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByLabelText<HTMLSelectElement>("Month").value).toBe(
      "2026-01",
    );
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "¥8.00",
    );
    fireEvent.click(screen.getByRole("button", { name: "This month" }));
    expect(requests.at(-1)?.url).toContain("month=2026-03");
    expect(screen.getByTestId("billing-sessionTotalCost").textContent).toBe(
      "—",
    );
  });
});
