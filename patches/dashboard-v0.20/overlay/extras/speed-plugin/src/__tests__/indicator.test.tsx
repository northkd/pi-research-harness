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
import { TokenStatsBar } from "../../../../packages/client/src/components/session/TokenStatsBar.js";
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
    expect(document.activeElement).toBe(screen.getByTestId("speed-indicator-badge"));
  });
  it("opens outside a clipped host and maximizes without losing filters, scroll or restored size", () => {
    const { container } = render(<div style={{ overflow: "hidden", width: 100 }}><SpeedIndicator sessionId="test" monitor={monitor} /></div>);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    const panel = screen.getByTestId("speed-indicator-popover");
    expect(container.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(document.body);
    const size = { width: panel.style.width, height: panel.style.height };
    const history = screen.getByTestId("speed-history");
    const content = screen.getByTestId("usage-panel-scroll");
    history.scrollTop = 47;
    content.scrollTop = 80;
    fireEvent.click(within(screen.getByTestId("speed-panel")).getByRole("button", { name: /主 Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "最大化用量面板" }));
    expect(panel.getAttribute("data-maximized")).toBe("true");
    expect(screen.queryByRole("separator", { name: "调整用量面板宽度" })).toBeNull();
    expect(screen.getByTestId("speed-history")).toBe(history);
    fireEvent.click(screen.getByRole("button", { name: "还原用量面板" }));
    expect(panel.style.width).toBe(size.width);
    expect(panel.style.height).toBe(size.height);
    expect(history.scrollTop).toBe(47);
    expect(content.scrollTop).toBe(80);
    expect(within(history).queryByText("sub-model")).toBeNull();
    expect(localStorage.getItem("speed-monitor-popover-width")).toBe(String(Number.parseFloat(size.width)));
  });
  it("resizes from the left edge, supports keyboard size adjustment and stays inside a narrow viewport", () => {
    render(<SpeedIndicator sessionId="test" monitor={monitor} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    const panel = screen.getByTestId("speed-indicator-popover");
    const widthHandle = screen.getByRole("separator", { name: "调整用量面板宽度" });
    const before = Number.parseFloat(panel.style.width);
    fireEvent.keyDown(widthHandle, { key: "ArrowLeft" });
    expect(Number.parseFloat(panel.style.width)).toBe(before + 24);
    fireEvent.mouseDown(widthHandle, { clientX: 300, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 260, clientY: 0 });
    fireEvent.mouseUp(document);
    expect(Number.parseFloat(panel.style.width)).toBe(before + 64);
    const heightHandle = screen.getByRole("separator", { name: "调整用量面板高度" });
    const height = Number.parseFloat(panel.style.height);
    fireEvent.keyDown(heightHandle, { key: "ArrowUp" });
    expect(Number.parseFloat(panel.style.height)).toBe(height - 24);
    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 640);
    fireEvent(window, new Event("resize"));
    expect(Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(344);
    expect(Number.parseFloat(panel.style.height)).toBeLessThanOrEqual(624);
  });
  it("uses the same partial-total and pending-pricing semantics in the inspector and its trigger", () => {
    const stats = monitor.stats!;
    const { rerender } = render(<SpeedIndicator sessionId="test" monitor={{ ...monitor, stats: { ...stats, billing: { ...billing, complete: false, unpricedTurns: 1 } } }} costOnly />);
    expect(screen.getByTestId("speed-indicator-badge").textContent).toContain("≥¥3.00");
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    expect(screen.getByTestId("billing-total").textContent).toBe("≥¥3.0000");
    rerender(<SpeedIndicator sessionId="test" monitor={{ ...monitor, stats: { ...stats, billing: { ...billing, complete: false, unpricedTurns: 1, sessionTotalCost: 0 } } }} costOnly />);
    expect(screen.getByTestId("speed-indicator-badge").textContent).toContain("待定价");
    expect(screen.getByTestId("billing-total").textContent).toBe("待定价");
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

const observed: SpeedRecord = {
  ...main,
  model: "observed-model",
  durationSeconds: 10,
  firstTokenSeconds: 2,
  generationSeconds: 8,
  tps: 125,
  estimatedTps: null,
  timingSource: "pi-stream",
  firstOutputKind: "thinking",
  speedStatus: "measured",
  contentTokens: 1000,
  totalOutputTokens: 1000,
  totalTokens: 1000,
};

function performanceMonitor(latest: SpeedRecord): SpeedMonitorState {
  return {
    ...monitor,
    stats: {
      ...monitor.stats!,
      latest,
      latestMain: main,
      latestSubagent: latest.agentType === "subagent" ? latest : sub,
      history: [latest],
      mainHistory: latest.agentType === "subagent" ? [] : [latest],
      subagentHistory: latest.agentType === "subagent" ? [latest] : [],
      averageTps: latest.tps,
      averageEstimatedTps: latest.estimatedTps ?? null,
      recentCount: latest.tps === null ? 0 : 1,
      estimatedCount: latest.estimatedTps === null || latest.estimatedTps === undefined ? 0 : 1,
      averageScope: {
        provider: latest.provider ?? "",
        model: latest.model,
        agentType: latest.agentType ?? "main",
      },
    },
  };
}

describe("speed measurement semantics", () => {
  it("uses the actual latest record identity when a subagent finishes after the main agent", () => {
    const latest = { ...observed, id: "latest-sub", agentType: "subagent" as const, model: "latest-sub-model", provider: "other-provider" };
    render(<SpeedIndicator sessionId="test" monitor={performanceMonitor(latest)} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    const details = within(screen.getByTestId("latest-speed-record"));
    expect(details.getByTestId("latest-speed-model").textContent).toBe("latest-sub-model");
    expect(details.getByTestId("latest-speed-identity").textContent).toContain("Subagent");
    expect(details.getByTestId("latest-speed-identity").textContent).toContain("other-provider");
    expect(details.getByTestId("latest-speed-value").textContent).toBe("125 tokens/s");
    expect(screen.getByTestId("main-speed-summary").textContent).toContain("main-model");
    expect(screen.getByTestId("subagent-speed-summary").textContent).toContain("latest-sub-model");
    expect(details.getByTestId("speed-average-scope").textContent).toContain("other-provider");
  });

  it("shows elapsed time without presenting historical throughput as a live speed", () => {
    const activeMonitor = performanceMonitor(observed);
    activeMonitor.isStreaming = true;
    activeMonitor.elapsed = 8.5;
    activeMonitor.stats!.averageTps = 777;
    render(<SpeedIndicator sessionId="test" monitor={activeMonitor} />);
    const badge = screen.getByTestId("speed-indicator-badge");
    expect(badge.textContent).toContain("生成中 8.5s");
    expect(badge.textContent).toContain("完成后统计");
    expect(badge.textContent).not.toContain("777");
    expect(badge.textContent).not.toContain("t/s");
  });

  it("separates observed output speed, TTFT and full-response estimates", () => {
    const { rerender } = render(<SpeedIndicator sessionId="test" monitor={performanceMonitor(observed)} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    expect(screen.getByTestId("current-speed-label").textContent).toBe("输出速率");
    expect(screen.getByTestId("latest-speed-value").textContent).toBe("125 tokens/s");
    expect(screen.getByTestId("latest-speed-ttft").textContent).toBe("2.0 秒");
    expect(screen.getByTestId("latest-speed-generation").textContent).toBe("8.0 秒");
    expect(screen.getByTestId("latest-speed-duration").textContent).toBe("10.0 秒");
    expect(screen.getByTestId("first-output-kind").textContent).toBe("思考");
    expect(screen.getByTestId("measured-speed-average").textContent).toBe("125 tokens/s · 1 次");
    const estimated: SpeedRecord = {
      ...observed,
      tps: null,
      estimatedTps: 100,
      firstTokenSeconds: null,
      generationSeconds: null,
      firstOutputKind: null,
      timingSource: "legacy-timestamps",
      speedStatus: "estimated",
    };
    rerender(<SpeedIndicator sessionId="test" monitor={performanceMonitor(estimated)} />);
    expect(screen.getByTestId("current-speed-label").textContent).toBe("全程估算速率");
    expect(screen.getByTestId("latest-speed-value").textContent).toBe("≈100 tokens/s");
    expect(screen.getByTestId("latest-speed-ttft").textContent).toBe("—");
    expect(screen.getByTestId("latest-speed-generation").textContent).toBe("—");
    expect(screen.getByTestId("latest-speed-duration").textContent).toBe("10.0 秒");
    expect(screen.getByTestId("estimated-speed-average").textContent).toBe("≈100 tokens/s · 1 次");
    expect(within(screen.getByTestId("speed-history")).getByText("≈100 t/s")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tab-view-billing"));
    expect(screen.getByTestId("billing-total").textContent).toBe("¥3.0000");
  });

  it("keeps unknown timing distinct from a recorded zero first-output delay", () => {
    const unknown: SpeedRecord = {
      ...observed,
      tps: null,
      estimatedTps: null,
      durationSeconds: null,
      firstTokenSeconds: null,
      generationSeconds: null,
      firstOutputKind: null,
      timingSource: "unavailable",
      speedStatus: "missing-timing",
    };
    const { rerender } = render(<SpeedIndicator sessionId="test" monitor={performanceMonitor(unknown)} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    for (const id of ["latest-speed-value", "latest-speed-ttft", "latest-speed-generation", "latest-speed-duration"])
      expect(screen.getByTestId(id).textContent).toBe("—");
    expect(screen.getByTestId("speed-panel").textContent).not.toMatch(/(?:NaN|Infinity|0 tokens\/s)/);
    expect(screen.getByTestId("speed-measurement-note").textContent).toContain("计时");
    rerender(<SpeedIndicator sessionId="test" monitor={performanceMonitor({ ...observed, firstTokenSeconds: 0, generationSeconds: 10, tps: 100 })} />);
    expect(screen.getByTestId("latest-speed-ttft").textContent).toBe("0.0 秒");
  });

  it("does not label legacy rates or another provider's averages as observed model speed", () => {
    const { rerender } = render(<SpeedIndicator sessionId="test" monitor={monitor} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    expect(screen.getByTestId("latest-speed-value").textContent).toBe("—");
    expect(screen.getByTestId("measured-speed-average").textContent).toBe("—");
    const mismatched = performanceMonitor(observed);
    mismatched.stats!.averageTps = 999;
    mismatched.stats!.averageScope = { provider: "another-provider", model: observed.model, agentType: "main" };
    rerender(<SpeedIndicator sessionId="test" monitor={mismatched} />);
    expect(screen.getByTestId("latest-speed-value").textContent).toBe("125 tokens/s");
    expect(screen.getByTestId("measured-speed-average").textContent).toBe("—");
    expect(screen.getByTestId("speed-panel").textContent).not.toContain("999");
  });

  it("keeps positive slow responses visible and explains unobserved reasoning in estimates", () => {
    const slow: SpeedRecord = { ...observed, durationSeconds: 81002, generationSeconds: 81000, tps: 1000 / 81000 };
    const { rerender } = render(<SpeedIndicator sessionId="test" monitor={performanceMonitor(slow)} />);
    fireEvent.click(screen.getByTestId("speed-indicator-badge"));
    expect(screen.getByTestId("latest-speed-value").textContent).toBe("0.012 tokens/s");
    expect(screen.getByTestId("measured-speed-average").textContent).toBe("0.012 tokens/s · 1 次");
    expect(within(screen.getByTestId("speed-history")).getByTestId("history-speed").textContent).toBe("0.012 t/s");
    const reasoningEstimate: SpeedRecord = {
      ...slow,
      tps: null,
      estimatedTps: 1000 / 81002,
      firstOutputKind: "text",
      reasoningTokens: 600,
      contentTokens: 400,
      speedStatus: "estimated",
      speedCaveat: "reasoning-not-observed",
    };
    rerender(<SpeedIndicator sessionId="test" monitor={performanceMonitor(reasoningEstimate)} />);
    expect(screen.getByTestId("latest-speed-value").textContent).toBe("≈0.012 tokens/s");
    expect(screen.getByTestId("estimated-speed-average").textContent).toBe("≈0.012 tokens/s · 1 次");
    expect(screen.getByTestId("speed-measurement-note").textContent).toContain("思考用量无法与输出阶段对齐");
    expect(screen.getByTestId("speed-indicator-badge").textContent).toContain("≈0.012");
  });
});
