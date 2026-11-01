// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { ResearchBudgetControls } from "../ResearchBudgetControls.js";

vi.mock("../../../lib/api/api-context.js", () => ({ useApiBase: () => "", getApiBase: () => "" }));
vi.mock("../../../lib/api/res-workflow-api.js", () => ({
  getResWorkflowResearchBudget: vi.fn(async () => ({
    cwd: "/synthetic", revision: null, limits: { attempts: 100, modelRequests: 60 },
    usage: { attempts: 0, modelRequests: 0, inFlight: 0, unknown: 0 }, updatedAt: null,
    enforcement: { attempts: true, modelRequests: false, scope: "native-research-workflow", physicalTransport: "sse-http" },
  })),
  updateResWorkflowResearchBudget: vi.fn(() => { throw new Error("observation must not save a budget"); }),
}));

const observation = {
  schema: "res-workflow.workbench-observation.v1", cwd: "/synthetic", adoptionId: "adopt-synthetic",
  charterHash: `sha256:${"a".repeat(64)}`, revision: `sha256:${"b".repeat(64)}`,
  updatedAt: "2026-10-30T09:00:00.000Z", heartbeatAt: "2026-10-30T09:01:00.000Z",
  coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 1 }, executions: [], relations: [],
  observedUsage: { responses: 17, inputTokens: 100, outputTokens: 50, inheritedExcluded: 2, metric: "observed-assistant-responses" },
} as ResearchWorkbenchObservation;
let root: Root | undefined, element: HTMLDivElement;
async function render(value?: ResearchWorkbenchObservation, stale = false) {
  if (!root) { element = document.createElement("div"); document.body.append(element); root = createRoot(element); }
  await act(async () => { root!.render(<ResearchBudgetControls cwd="/synthetic" observation={value} observationStale={stale} />); });
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; element?.remove(); vi.clearAllMocks(); });

test("observed responses update while physical budget usage stays independent", async () => {
  await render(observation);
  expect(element.querySelector('[data-testid="research-budget-observed-responses"]')?.textContent).toContain("17");
  expect(element.querySelector('[data-testid="research-budget-model-row"]')?.textContent).toContain("未接管");
  expect(element.querySelector('[data-testid="research-budget-observed-usage"]')?.textContent).toContain("不能相加");
  await render({ ...observation, observedUsage: { ...observation.observedUsage, responses: 18 } });
  expect(element.querySelector('[data-testid="research-budget-observed-responses"]')?.textContent).toContain("18");
  const api = await import("../../../lib/api/res-workflow-api.js");
  expect(api.updateResWorkflowResearchBudget).not.toHaveBeenCalled();
});

test("missing, stale and partial observation never promise zero or exact physical accounting", async () => {
  await render();
  expect(element.querySelector('[data-testid="research-budget-observed-usage"]')?.textContent).toContain("尚无");
  await render({ ...observation, coverage: { ...observation.coverage, partial: true } }, true);
  const text = element.querySelector('[data-testid="research-budget-observed-usage"]')?.textContent;
  expect(text).toContain("过期"); expect(text).toContain("补齐"); expect(text).toContain("重试");
});

test("another directory or unsafe counts never appear in the budget panel", async () => {
  await render({ ...observation, cwd: "/another" });
  expect(element.querySelector('[data-testid="research-budget-observed-responses"]')).toBeNull();
  await render({ ...observation, observedUsage: { ...observation.observedUsage, responses: -1 } });
  expect(element.querySelector('[data-testid="research-budget-observed-responses"]')).toBeNull();
});
