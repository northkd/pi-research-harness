import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { ResearchExecutionPanels } from "../ResearchExecutionPanels.js";
import { ResearchClaimPanels } from "../ResearchClaimPanels.js";
import { latestObservedExecution, parseResearchSnapshot, projectResearch, type ResearchSnapshot } from "../research-projection.js";
const snapshot: ResearchSnapshot = { state: { charter: { objective: "question", revision: 1 }, claims: [] }, events: [], attempts: [], receipt: null };
function observation(): ResearchWorkbenchObservation { return { schema: "res-workflow.workbench-observation.v1", cwd: "/project", adoptionId: "adoption-1", charterHash: `sha256:${"a".repeat(64)}`, revision: `sha256:${"b".repeat(64)}`, updatedAt: "2026-10-30T10:00:00.000Z", heartbeatAt: "2026-10-30T10:00:00.000Z", coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 1 }, executions: [{ id: "pi:main", kind: "pi-session", sessionId: "main", status: "streaming" }, { id: "native:child", kind: "native-subagent", parentExecutionId: "pi:main", role: "numerics", status: "running", observedModel: "actual/numerics", lastActivityAt: "2026-10-30T10:00:00.000Z" }], relations: [], observedUsage: { responses: 1, inputTokens: 2, outputTokens: 3, inheritedExcluded: 0, metric: "observed-assistant-responses" } }; }
afterEach(cleanup);
describe("research scientific panels", () => {
  it("does not create default roles, model names, graph nodes or a Stage 1 for an empty project", () => {
    const projection = projectResearch(snapshot); render(<ResearchExecutionPanels projection={projection} stage={null} includeUnstaged stale={false} onAgent={vi.fn()} />);
    expect(projection.stage).toBeNull(); expect(screen.queryAllByTestId("research-agent-node")).toHaveLength(0); expect(screen.queryAllByTestId("role-status")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/astra|deepseek|research-explorer|glm/);
  });
  it("shows unstaged native work and only explicit, endpoint-bound dispatch edges", () => {
    const observed = observation(), projection = projectResearch(snapshot, observed), onAgent = vi.fn();
    const view = render(<ResearchExecutionPanels projection={projection} stage={null} includeUnstaged stale={false} onAgent={onAgent} />);
    expect(screen.getAllByTestId("research-execution")).toHaveLength(2); expect(screen.queryAllByTestId("research-relation")).toHaveLength(0); expect(projection.stage).toBeNull();
    observed.relations = [{ id: "relation-1", fromExecutionId: "pi:main", toExecutionId: "native:child", kind: "dispatch", evidence: { source: "tool-call", eventId: "call-1" } }];
    view.rerender(<ResearchExecutionPanels projection={projectResearch(snapshot, observed)} stage={null} includeUnstaged stale={false} onAgent={onAgent} />);
    expect(screen.getAllByTestId("research-relation")).toHaveLength(1); expect(screen.getByText(/派发证据/).textContent).toContain("call-1");
    fireEvent.click(screen.getByTestId("research-role-numerics")); expect(onAgent).toHaveBeenCalled();
  });
  it("shows current configuration and latest actual model independently, including a newer second instance", () => {
    const observed = observation(); observed.configuration = { stages: { "2-experiment": { roles: [{ role: "numerics", model: "configured/model", skills: ["actual-skill"] }] } } };
    observed.executions[1].stage = "2-experiment"; observed.executions.push({ ...observed.executions[1], id: "native:new", observedModel: "actual/latest", lastActivityAt: "2026-10-30T10:01:00.000Z" });
    const projection = projectResearch(snapshot, observed); render(<ResearchExecutionPanels projection={projection} stage="2-experiment" includeUnstaged={false} stale={false} onAgent={vi.fn()} />);
    expect(screen.getByText("配置模型：configured/model")).toBeTruthy(); expect(screen.getByText("最新观测模型：actual/latest")).toBeTruthy(); expect(latestObservedExecution(projection.executions)?.id).toBe("native:new");
  });
  it("keeps terminal workflow statistics and formal claims when observations change or become stale", () => {
    const formal: ResearchSnapshot = { ...snapshot, events: [{ kind: "run-registered", detail: { runId: "workflow", charterRevision: 1 } }, { kind: "run-step", detail: { runId: "workflow", key: "one", agent: "numerics", status: "completed", observedModel: "actual/legacy" } }] };
    const projection = projectResearch(formal, observation()); expect(projection.currentRun?.steps).toHaveLength(1); expect(projection.executions.some(row => row.source === "workflow-record")).toBe(true);
    render(<ResearchExecutionPanels projection={projection} stage={null} includeUnstaged stale onAgent={vi.fn()} />); expect(screen.getAllByText(/观测已过期/).length).toBeGreaterThan(0); expect(screen.getByText("最新观测模型：actual/numerics（观测已过期）")).toBeTruthy();
  });
  it("shows individual gate diagnostics, reviews and safe claim evidence without global acceptance", () => {
    const open = vi.fn(); const claims = [{ id: "accepted", statement: "one accepted claim", status: "supported", acceptance: { verdict: "accepted", jury: [{ modelId: "observed/reviewer", family: "family-a" }], counterexample: { status: "completed" } } }, { id: "blocked", statement: "unresolved claim", status: "proposed", evidence: ["runs/result.csv", "../secret"], acceptance: { verdict: "blocked", diagnostics: ["second family missing"], counterexample: { status: "pending" } } }];
    render(<ResearchClaimPanels claims={claims} reviews={[{ kind: "review-gate", detail: { verdict: "blocked", diagnostics: ["review not complete"] } }]} onOpenArtifact={open} />);
    expect(screen.getAllByTestId("research-claim-gate")).toHaveLength(2); expect(screen.getByText(/1 \/ 2 条主张/)).toBeTruthy(); expect(screen.getByText("second family missing")).toBeTruthy(); expect(screen.getByText("review not complete")).toBeTruthy(); expect(screen.queryByText("../secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "runs/result.csv" })); expect(open).toHaveBeenCalledWith("runs/result.csv");
  });
  it("normalizes optional malformed gate detail without turning it into accepted evidence", () => {
    const parsed = parseResearchSnapshot({ "state.json": JSON.stringify({ claims: [{ id: "c", statement: "s", status: "proposed", acceptance: { verdict: "blocked", jury: "bad", diagnostics: [{ private: true }], counterexample: "bad" } }] }), "ledger.jsonl": "", "events.jsonl": "", "auto-run.json": null });
    render(<ResearchClaimPanels claims={parsed.state?.claims ?? []} reviews={[]} />); expect(screen.getByText("反例检查：未记录")).toBeTruthy(); expect(document.body.textContent).not.toContain("[object Object]");
  });
});
