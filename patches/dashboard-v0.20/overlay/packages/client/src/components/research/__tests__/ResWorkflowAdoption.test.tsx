import type { ResWorkflowAdoption as Adoption } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../lib/api/res-workflow-api.js";
import { ResWorkflowAdoption } from "../ResWorkflowAdoption.js";

vi.mock("../../../lib/api/res-workflow-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/api/res-workflow-api.js")>(),
  getResWorkflowModels: vi.fn(), getResWorkflowHistoryCandidates: vi.fn(), joinResWorkflowSession: vi.fn(), createResWorkflowAdoption: vi.fn(), analyzeResWorkflowAdoption: vi.fn(), confirmResWorkflowAdoption: vi.fn(), cancelResWorkflowAdoption: vi.fn(),
  createResWorkflowAgent: vi.fn(), prepareResWorkflowHistoryReview: vi.fn(), analyzeResWorkflowHistoryReview: vi.fn(),
}));
vi.mock("../../settings/ModelSelector.js", () => ({ ModelSelector: ({ onSelect, disabled }: { onSelect: (label: string) => void; disabled?: boolean }) => <button disabled={disabled} onClick={() => onSelect("proxy/anthropic/nested-model")}>pick exact model</button> }));
const CWD = "/isolated/project";
const HISTORY = [
  { id: "hist-aaaaaaaaaaaaaaaaaaaaaaaa", sessionId: "research-session", name: "Research notes", kind: "local" as const, registered: true, timestamp: "2026-10-23T00:00:00Z", incomplete: false },
  { id: "hist-bbbbbbbbbbbbbbbbbbbbbbbb", sessionId: "ordinary-session", name: "Unrelated conversation", kind: "local" as const, registered: true, incomplete: false },
];
const job = (overrides: Partial<Adoption> = {}): Adoption => ({ id: "adopt-1", cwd: CWD, status: "inventory", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", partial: false, progress: { files: 0, sessions: 0, bytes: 0 }, sources: [], skipped: [], charterHash: "none", ...overrides });
const props = () => ({ cwd: CWD, adopted: false, adoption: null, onRefresh: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getResWorkflowModels).mockResolvedValue([{ provider: "proxy", id: "anthropic/nested-model", name: "Selected model" }]);
  vi.mocked(api.getResWorkflowHistoryCandidates).mockResolvedValue({ candidates: HISTORY, partial: false, skipped: [] });
  vi.mocked(api.createResWorkflowAdoption).mockResolvedValue(job());
  vi.mocked(api.createResWorkflowAgent).mockImplementation(async body => job({
    id: "intake-one", model: body.model, historySelection: body.historySelection,
    agentJob: { mode: "full-history-agent-v2", phase: "preparing", authorized: false, workerActive: true, resumeRequired: false,
      coverage: { selectedHistories: body.historySelection.length, completedHistories: 0, eligibleMessages: 0, completedMessages: 0, eligibleBytes: 0, completedBytes: 0, completedBatches: 0, totalBatches: 0 },
      budget: { baseRequests: 0, retryReserve: 0, maxRequests: 0, usedRequests: 0, baseUsed: 0, recoveryUsed: 0, remainingRequests: 0, inFlightRequests: 0, unknownRequests: 0 }, completedNodes: 0, reusedCheckpoints: 0 },
  }));
  vi.mocked(api.joinResWorkflowSession).mockResolvedValue({ sessionId: "research-session", resWorkflow: { canonicalCwd: CWD, joinedAt: "2026-10-23T00:02:00Z", via: "manual" } });
});
afterEach(cleanup);

async function sources() {
  fireEvent.click(screen.getByTestId("res-workflow-connect-next"));
  await waitFor(() => expect((screen.getByTestId("res-workflow-sources-next") as HTMLButtonElement).disabled).toBe(false));
}
async function models() {
  fireEvent.click(screen.getByTestId("res-workflow-sources-next"));
  await waitFor(() => expect((screen.getByText("pick exact model") as HTMLButtonElement).disabled).toBe(false));
}
async function authorize() {
  fireEvent.click(screen.getByText("pick exact model"));
  fireEvent.click(screen.getByTestId("res-workflow-consent"));
  fireEvent.click(screen.getByTestId("res-workflow-start"));
  await waitFor(() => expect(api.createResWorkflowAdoption).toHaveBeenCalledTimes(1));
}

describe("res-workflow inline explicit adoption", () => {
  it("shows an inline introduction and cancellation reads no candidates/models and creates no task", () => {
    render(<ResWorkflowAdoption {...props()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("res-workflow-connect-intro")).toBeTruthy();
    fireEvent.click(screen.getByTestId("res-workflow-decline"));
    expect(screen.getByTestId("res-workflow-connect-next")).toBeTruthy();
    expect(api.getResWorkflowHistoryCandidates).not.toHaveBeenCalled();
    expect(api.getResWorkflowModels).not.toHaveBeenCalled();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("does not issue preparation requests from a frozen inert underlay", () => {
    render(<div inert><ResWorkflowAdoption {...props()} /></div>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.getResWorkflowHistoryCandidates).not.toHaveBeenCalled();
    expect(api.getResWorkflowModels).not.toHaveBeenCalled();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("lists metadata without preselecting unrelated same-directory histories", async () => {
    render(<ResWorkflowAdoption {...props()} />);
    await sources();
    expect(screen.getByText("Research notes")).toBeTruthy();
    expect(screen.getByText("Unrelated conversation")).toBeTruthy();
    for (const item of HISTORY) expect((screen.getByTestId(`res-workflow-history-${item.id}`) as HTMLInputElement).checked).toBe(false);
    expect(api.getResWorkflowModels).not.toHaveBeenCalled();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("prepares only selected opaque histories with the exact physical model before paid authorization", async () => {
    render(<ResWorkflowAdoption {...props()} />);
    await sources();
    fireEvent.click(screen.getByTestId(`res-workflow-history-${HISTORY[0].id}`));
    await models();
    const start = screen.getByTestId("res-workflow-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByText("pick exact model"));
    expect(screen.getByTestId("res-workflow-recipient").textContent).toContain("proxy/anthropic/nested-model");
    expect(start.disabled).toBe(false);
    expect(screen.queryByTestId("res-workflow-consent")).toBeNull();
    fireEvent.click(start);
    await waitFor(() => expect(api.createResWorkflowAgent).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.createResWorkflowAgent).mock.calls[0][0];
    expect(body).toMatchObject({ cwd: CWD, historySelection: [HISTORY[0].id], model: { provider: "proxy", id: "anthropic/nested-model" } });
    expect(body).not.toHaveProperty("consent");
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(HISTORY[1].id);
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.analyzeResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("allows an explicit files-only connection with an empty history selection", async () => {
    render(<ResWorkflowAdoption {...props()} />);
    await sources();
    fireEvent.click(screen.getByTestId("res-workflow-files-only"));
    await waitFor(() => expect((screen.getByText("pick exact model") as HTMLButtonElement).disabled).toBe(false));
    await authorize();
    expect(vi.mocked(api.createResWorkflowAdoption).mock.calls[0][0].historySelection).toEqual([]);
  });

  it("returns to a reusable inline introduction after cancelling selection", async () => {
    render(<ResWorkflowAdoption {...props()} />);
    await sources();
    fireEvent.click(screen.getByTestId(`res-workflow-history-${HISTORY[0].id}`));
    fireEvent.click(screen.getByTestId("res-workflow-decline"));
    expect(screen.getByTestId("res-workflow-connect-intro")).toBeTruthy();
    await sources();
    expect((screen.getByTestId(`res-workflow-history-${HISTORY[0].id}`) as HTMLInputElement).checked).toBe(false);
    expect(api.getResWorkflowHistoryCandidates).toHaveBeenCalledTimes(2);
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("distinguishes failed candidate loading from an empty list and permits a read-only retry", async () => {
    vi.mocked(api.getResWorkflowHistoryCandidates).mockRejectedValueOnce(new Error("candidate catalogue unavailable"));
    render(<ResWorkflowAdoption {...props()} />);
    fireEvent.click(screen.getByTestId("res-workflow-connect-next"));
    expect(await screen.findByText(/candidate catalogue unavailable/)).toBeTruthy();
    expect((screen.getByTestId("res-workflow-sources-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("res-workflow-history-retry"));
    expect(await screen.findByTestId(`res-workflow-history-${HISTORY[0].id}`)).toBeTruthy();
    expect(api.getResWorkflowHistoryCandidates).toHaveBeenCalledTimes(2);
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("shows a failed model catalogue without substituting a default and can retry the catalogue only", async () => {
    vi.mocked(api.getResWorkflowModels).mockRejectedValueOnce(new Error("selected SDK unavailable"));
    render(<ResWorkflowAdoption {...props()} />);
    await sources();
    fireEvent.click(screen.getByTestId("res-workflow-sources-next"));
    expect(await screen.findByText(/selected SDK unavailable/)).toBeTruthy();
    expect((screen.getByTestId("res-workflow-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("res-workflow-model-retry"));
    await waitFor(() => expect((screen.getByText("pick exact model") as HTMLButtonElement).disabled).toBe(false));
    expect(api.getResWorkflowModels).toHaveBeenCalledTimes(2);
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("clears material consent when going back to change the history scope", async () => {
    render(<ResWorkflowAdoption {...props()} />);
    await sources();
    await models();
    fireEvent.click(screen.getByText("pick exact model"));
    fireEvent.click(screen.getByTestId("res-workflow-consent"));
    fireEvent.click(screen.getByTestId("res-workflow-back-sources"));
    await waitFor(() => expect((screen.getByTestId("res-workflow-sources-next") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId(`res-workflow-history-${HISTORY[0].id}`));
    await models();
    expect(screen.queryByTestId("res-workflow-consent")).toBeNull();
    expect((screen.getByTestId("res-workflow-start") as HTMLButtonElement).disabled).toBe(true);
    expect(api.createResWorkflowAgent).not.toHaveBeenCalled();
    expect(api.analyzeResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("opens an adopted directory without repeating inventory, candidates or model selection", () => {
    render(<ResWorkflowAdoption {...props()} adopted adoption={job({ status: "confirmed" })} />);
    expect(screen.queryByTestId("res-workflow-connect-intro")).toBeNull();
    expect(screen.getByTestId("res-workflow-rescan")).toBeTruthy();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.getResWorkflowHistoryCandidates).not.toHaveBeenCalled();
    expect(api.getResWorkflowModels).not.toHaveBeenCalled();
  });

  it("shows a recovered blocked job without retrying its external request", () => {
    render(<ResWorkflowAdoption {...props()} adoption={job({ status: "blocked", partial: true, error: "发送结果不确定，需明确重试" })} />);
    expect(screen.getByText("发送结果不确定，需明确重试")).toBeTruthy();
    expect(screen.getByTestId("res-workflow-partial")).toBeTruthy();
    expect(api.analyzeResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.getResWorkflowHistoryCandidates).not.toHaveBeenCalled();
  });

  it("requires a fresh selected scope and authorization before replacing a blocked task", async () => {
    const blocked = job({ status: "blocked", error: "explicit-new-adoption-required" });
    vi.mocked(api.cancelResWorkflowAdoption).mockResolvedValue({ ...blocked, status: "cancelled" });
    render(<ResWorkflowAdoption {...props()} adoption={blocked} />);
    fireEvent.click(screen.getByTestId("res-workflow-retry"));
    await sources();
    await models();
    await authorize();
    expect(api.cancelResWorkflowAdoption).toHaveBeenCalledWith("adopt-1", CWD, expect.anything());
    expect(api.analyzeResWorkflowAdoption).not.toHaveBeenCalled();
  });

  it("prepares and separately authorizes an existing task against its frozen history selection", async () => {
    const model = { provider: "proxy", id: "anthropic/nested-model" };
    const frozen = job({ status: "awaiting-model", model, historySelection: [HISTORY[0].id], selectedHistories: [HISTORY[0]] });
    const prepared = job({ ...frozen, updatedAt: "2026-10-23T00:00:01.000Z", historyReview: { status: "prepared", canConfirm: false,
      plan: { planId: "fixed-plan", planHash: "fixed-hash", model, contextWindow: 32000, maxTokens: 4096, maxRequests: 2, batchCount: 1, mergeCallCount: 1, eligibleMessages: 1, eligibleBytes: 100, histories: [{ id: HISTORY[0].id, sessionId: HISTORY[0].sessionId, eligibleMessages: 1, eligibleBytes: 100, chunkCount: 1 }], blockers: [] },
      coverage: { selectedHistories: 1, completedHistories: 0, eligibleMessages: 1, completedMessages: 0, eligibleBytes: 100, completedBytes: 0, completedBatches: 0, totalBatches: 1 },
    } });
    vi.mocked(api.prepareResWorkflowHistoryReview).mockResolvedValue(prepared);
    vi.mocked(api.analyzeResWorkflowHistoryReview).mockResolvedValue({ ...prepared, updatedAt: "2026-10-23T00:00:02.000Z", status: "analyzing", historyReview: { ...prepared.historyReview!, status: "running" } });
    render(<ResWorkflowAdoption {...props()} adoption={frozen} />);
    await waitFor(() => expect((screen.getByTestId("res-workflow-history-prepare") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("res-workflow-history-prepare"));
    await waitFor(() => expect(screen.getByTestId("res-workflow-history-consent")).toBeTruthy());
    expect(api.analyzeResWorkflowHistoryReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("res-workflow-history-consent"));
    fireEvent.click(screen.getByTestId("res-workflow-history-analyze"));
    await waitFor(() => expect(api.analyzeResWorkflowHistoryReview).toHaveBeenCalledTimes(1));
    expect(api.getResWorkflowHistoryCandidates).not.toHaveBeenCalled();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.analyzeResWorkflowAdoption).not.toHaveBeenCalled();
    expect(vi.mocked(api.analyzeResWorkflowHistoryReview).mock.calls[0][1]).toMatchObject({ model, consent: { analysisMode: "full-history-review-v1", planId: "fixed-plan", planHash: "fixed-hash" } });
    expect(vi.mocked(api.analyzeResWorkflowHistoryReview).mock.calls[0][1].consent).not.toHaveProperty("maxRequests");
    expect(vi.mocked(api.analyzeResWorkflowHistoryReview).mock.calls[0][1]).not.toHaveProperty("historySelection");
  });

  it("confirms source-linked proposals using the proposal hash without replacing an existing charter", async () => {
    const draft = job({ status: "proposal-ready", proposalHash: "proposal-sha", proposal: { summary: "未核验整理", objective: "模型猜的目标", successCriteria: ["模型猜的标准"], unresolved: ["尚缺原始数据"], items: [] } });
    vi.mocked(api.confirmResWorkflowAdoption).mockResolvedValue({ ...draft, status: "confirmed" });
    render(<ResWorkflowAdoption {...props()} adoption={draft} charter={{ objective: "已冻结目标", successCriteria: ["已冻结标准"] }} />);
    fireEvent.click(screen.getByTestId("res-workflow-confirm"));
    await waitFor(() => expect(api.confirmResWorkflowAdoption).toHaveBeenCalledTimes(1));
    expect(api.confirmResWorkflowAdoption).toHaveBeenCalledWith("adopt-1", { cwd: CWD, proposalHash: "proposal-sha", objective: "已冻结目标", successCriteria: ["已冻结标准"] }, expect.anything());
    expect(screen.queryByDisplayValue("模型猜的目标")).toBeNull();
  });

  it("does not reuse a successful association mask from a previous adoption", async () => {
    const first = job({ id: "operation-a", status: "confirmed", participantFailures: [{ sessionId: "research-session", reason: "first failure" }] });
    const base = props();
    const view = render(<ResWorkflowAdoption {...base} adopted adoption={first} />);
    fireEvent.click(screen.getByTestId("res-workflow-retry-participant-research-session"));
    await waitFor(() => expect(screen.queryByTestId("res-workflow-participant-failures")).toBeNull());
    view.rerender(<ResWorkflowAdoption {...base} adopted adoption={{ ...first, id: "operation-b", participantFailures: [{ sessionId: "research-session", reason: "fresh failure" }] }} />);
    expect(screen.getByTestId("res-workflow-participant-failures").textContent).toContain("fresh failure");
    expect(screen.getByTestId("res-workflow-retry-participant-research-session")).toBeTruthy();
    expect(api.joinResWorkflowSession).toHaveBeenCalledTimes(1);
  });

  it("ignores an older adoption's late association success after a new failure arrives", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.joinResWorkflowSession>>) => void;
    vi.mocked(api.joinResWorkflowSession).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = job({ id: "operation-a", status: "confirmed", participantFailures: [{ sessionId: "research-session", reason: "first failure" }] });
    const base = props();
    const view = render(<ResWorkflowAdoption {...base} adopted adoption={first} />);
    fireEvent.click(screen.getByTestId("res-workflow-retry-participant-research-session"));
    view.rerender(<ResWorkflowAdoption {...base} adopted adoption={{ ...first, id: "operation-b", participantFailures: [{ sessionId: "research-session", reason: "fresh failure" }] }} />);
    await act(async () => finish({ sessionId: "research-session", resWorkflow: { canonicalCwd: CWD, joinedAt: "2026-10-23T00:02:00Z", via: "manual" } }));
    expect(screen.getByTestId("res-workflow-participant-failures").textContent).toContain("fresh failure");
    expect((screen.getByTestId("res-workflow-retry-participant-research-session") as HTMLButtonElement).disabled).toBe(false);
    expect(api.joinResWorkflowSession).toHaveBeenCalledTimes(1);
  });

  it("does not display an older adoption's late association error on the current operation", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(api.joinResWorkflowSession).mockReturnValueOnce(new Promise((_resolve, no) => { reject = no; }));
    const first = job({ id: "operation-a", status: "confirmed", participantFailures: [{ sessionId: "research-session", reason: "first failure" }] });
    const base = props();
    const view = render(<ResWorkflowAdoption {...base} adopted adoption={first} />);
    fireEvent.click(screen.getByTestId("res-workflow-retry-participant-research-session"));
    view.rerender(<ResWorkflowAdoption {...base} adopted adoption={{ ...first, id: "operation-b", participantFailures: [{ sessionId: "research-session", reason: "fresh failure" }] }} />);
    await act(async () => reject(new Error("stale operation error")));
    expect(screen.queryByText("stale operation error")).toBeNull();
    expect(screen.getByTestId("res-workflow-participant-failures").textContent).toContain("fresh failure");
  });

  it("retries a partial association without repeating confirmation, scanning or analysis", async () => {
    const connected = job({ status: "confirmed", participantFailures: [{ sessionId: "research-session", reason: "metadata-busy" }] });
    render(<ResWorkflowAdoption {...props()} adopted adoption={connected} />);
    fireEvent.click(screen.getByTestId("res-workflow-retry-participant-research-session"));
    await waitFor(() => expect(api.joinResWorkflowSession).toHaveBeenCalledWith(CWD, "research-session", expect.anything()));
    await waitFor(() => expect(screen.queryByTestId("res-workflow-retry-participant-research-session")).toBeNull());
    expect(api.confirmResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.createResWorkflowAdoption).not.toHaveBeenCalled();
    expect(api.analyzeResWorkflowAdoption).not.toHaveBeenCalled();
  });
});
