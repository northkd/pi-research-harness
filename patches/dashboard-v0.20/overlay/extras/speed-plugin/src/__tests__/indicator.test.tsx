// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenStatsBar } from "../../../client/src/components/session/TokenStatsBar.js";
import { billingPeriod } from "../billing-period.js";
import { SpeedIndicator, type SpeedMonitorState } from "../index.js";
import { SessionCost } from "../SessionCost.js";
import type { BillingSummary, SpeedRecord } from "../types.js";

const billing: BillingSummary = {
  currency: "CNY",
  complete: true,
  unpricedTurns: 0,
  invalidRecords: 0,
  sessionTotalCost: 3,
  mainTotalCost: 1,
  subagentTotalCost: 2,
  totalInputCost: 1,
  totalOutputCost: 2,
  totalCacheCost: 0,
  totalCacheWriteCost: 0,
  totalRequestCost: 0,
  totalCacheSavings: 0,
  totalInputTokens: 1,
  totalOutputTokens: 2,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalTokens: 3,
  modelBreakdown: [],
};
const main: SpeedRecord = {
  id: "m",
  provider: "cliproxy",
  timestamp: 1,
  model: "main-model",
  agentType: "main",
  durationSeconds: 1,
  tps: 1,
  contentTokens: 1,
  reasoningTokens: 0,
  totalOutputTokens: 1,
  inputTokens: 0,
  cacheRead: 0,
  totalTokens: 1,
};
const sub: SpeedRecord = {
  ...main,
  id: "s",
  agentType: "subagent",
  model: "sub-model",
};
const monitor: SpeedMonitorState = {
  loading: false,
  elapsed: 0,
  isStreaming: false,
  refresh: async () => {},
  stats: {
    sessionId: "test",
    status: "idle",
    active: null,
    latest: main,
    latestMain: main,
    latestSubagent: sub,
    history: [main, sub],
    mainHistory: [main],
    subagentHistory: [sub],
    averageTps: 1,
    recentCount: 2,
    billing,
  },
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.style.userSelect = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("billing and popover", () => {
  it("opens billing first from the cost trigger and keeps only the selected panel visible", () => {
    render(<SpeedIndicator sessionId="test" monitor={monitor} costOnly />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    expect(screen.getByTestId("billing-panel").style.display).toBe("flex");
    expect(screen.getByTestId("speed-panel").style.display).toBe("none");
    fireEvent.click(screen.getByTestId("tab-view-speed"));
    expect(screen.getByTestId("billing-panel").style.display).toBe("none");
    expect(screen.getByTestId("speed-panel").style.display).toBe("flex");
  });
  it("keeps the model and time in each responsive history row", () => {
    render(<SpeedIndicator sessionId="test" monitor={monitor} costOnly />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    for (const kind of ["billing", "speed"]) {
      const rows = screen.getAllByTestId(`${kind}-history-row`);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(within(row).getByTestId("history-time").textContent).toBeTruthy();
        expect(within(row).getByTestId("history-model").textContent).toMatch(/^(main|sub)-model$/);
      }
    }
  });
  it("closes the panel with Escape", () => {
    render(<SpeedIndicator sessionId="test" monitor={monitor} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    expect(screen.getByRole("dialog", { name: "会话用量与计费" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("speed-indicator-popover")).toBeNull();
  });
  it("shows the aggregate rather than the legacy main-only cost and polls once", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => monitor.stats,
    }));
    vi.stubGlobal("fetch", fetch);
    render(
      <TokenStatsBar
        turnStats={[]}
        tokensIn={0}
        tokensOut={0}
        cacheRead={0}
        cacheWrite={0}
        cost={99}
        sessionId="test"
      />,
    );
    await screen.findByText("¥3.00");
    expect(screen.queryByText("¥99.00")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("distinguishes an incomplete subtotal from free usage", () => {
    const { rerender } = render(
      <SessionCost
        billing={{ ...billing, complete: false, unpricedTurns: 1 }}
      />,
    );
    expect(screen.getByText("≥¥3.00")).toBeTruthy();
    rerender(
      <SessionCost
        billing={{
          ...billing,
          complete: false,
          unpricedTurns: 1,
          sessionTotalCost: 0,
        }}
      />,
    );
    expect(screen.getByText("待定价")).toBeTruthy();
  });
  it("shows a zero new-month bill without reusing old performance rows as billing rows", () => {
    render(
      <SpeedIndicator
        sessionId="test"
        monitor={{
          ...monitor,
          stats: {
            ...monitor.stats!,
            billingPeriod: billingPeriod("2026-11"),
            billingHistory: [],
            billingMainHistory: [],
            billingSubagentHistory: [],
            billing: {
              ...billing,
              sessionTotalCost: 0,
              mainTotalCost: 0,
              subagentTotalCost: 0,
              totalInputCost: 0,
              totalOutputCost: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalTokens: 0,
            },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    const history = screen.getByTestId("speed-history");
    expect(within(history).getByText("main-model")).toBeTruthy();
    expect(within(history).getByText("sub-model")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tab-view-billing"));
    const details = within(screen.getByTestId("billing-panel"));
    expect(details.getByText("2026-11 · 北京时间")).toBeTruthy();
    expect(details.getByText("本月会话等价消耗 (RMB)")).toBeTruthy();
    expect(details.getByRole("button", { name: "全部 (0)" })).toBeTruthy();
    expect(details.queryByText("main-model")).toBeNull();
    expect(details.queryByText("sub-model")).toBeNull();
    expect(screen.getByTestId("speed-history")).toBe(history);
  });
  it("retains the history filter, DOM nodes and scroll offsets across views", () => {
    render(<SpeedIndicator sessionId="test" monitor={monitor} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    const history = screen.getByTestId("speed-history");
    history.scrollTop = 47;
    fireEvent.click(
      within(screen.getByTestId("speed-panel")).getByRole("button", {
        name: /主 Agent/,
      }),
    );
    expect(within(history).queryByText("sub-model")).toBeNull();
    fireEvent.click(screen.getByTestId("tab-view-billing"));
    expect(screen.getByTestId("speed-history")).toBe(history);
    fireEvent.click(screen.getByTestId("tab-view-speed"));
    expect(history.scrollTop).toBe(47);
    expect(within(history).queryByText("sub-model")).toBeNull();
  });
  it("recovers invalid persisted dimensions and cleans dragging on unmount and blur", () => {
    localStorage.setItem("speed-monitor-popover-width", "invalid");
    localStorage.setItem("speed-monitor-popover-height", "Infinity");
    document.body.style.userSelect = "text";
    const { unmount } = render(
      <SpeedIndicator sessionId="test" monitor={monitor} />,
    );
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    const pop = screen.getByTestId("speed-indicator-popover");
    expect(Number.parseFloat(pop.style.width)).toBeGreaterThan(0);
    const handle = screen.getByTitle("对角拖拽同时调节宽高");
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 });
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.blur(window);
    expect(document.body.style.userSelect).toBe("text");
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 });
    unmount();
    expect(document.body.style.userSelect).toBe("text");
  });
});
