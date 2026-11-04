import { describe, expect, it } from "vitest";
import {
  configuredRolesForStage, parseResearchSnapshot, projectExecutionOrigin,
  projectResearch, projectResearchSessionRelations,
  type ResearchEvent, type ResearchExecution, type ResearchFileSet,
} from "../research-projection.js";

const state = { charter: { objective: "科研目标", successCriteria: ["可复现"] , revision: 1 }, claims: [], phase: 2 };
const files = (events: ResearchEvent[] = []): ResearchFileSet => ({
  "state.json": JSON.stringify(state), "ledger.jsonl": "", "events.jsonl": events.map(e => JSON.stringify(e)).join("\n"), "auto-run.json": null,
});
const event = (kind: string, detail: Record<string, unknown>, at = "2026-10-23T00:00:00Z"): ResearchEvent => ({ kind, detail, at });
const registered = (runId: string, launchId = runId) => event("run-registered", { runId, launchId, charterRevision: 1, parentSessionId: "parent-session" });
const step = (runId: string, status: string, extra: Record<string, unknown> = {}) => event("run-step", {
  runId, key: "explorer-1", stage: "1-idea", agent: "research-explorer", status, ...extra,
});

it("rejects broken state, incorrect field types and malformed JSONL", () => {
  expect(() => parseResearchSnapshot({ ...files(), "state.json": "{broken" })).toThrow(/研究状态文件损坏/);
  expect(() => parseResearchSnapshot({ ...files(), "state.json": JSON.stringify({ ...state, claims: {} }) })).toThrow();
  expect(() => parseResearchSnapshot({ ...files(), "events.jsonl": "{broken\n" })).toThrow(/events.jsonl/);
  expect(() => parseResearchSnapshot({ ...files(), "ledger.jsonl": JSON.stringify({ seq: 1, kind: "experiment", action: "a", signal: "__proto__" }) })).toThrow(/ledger.jsonl/);
  expect(() => parseResearchSnapshot({ ...files(), "state.json": JSON.stringify({ ...state, claims: [{ id: "c", statement: "s", status: "proposed", acceptance: { verdict: {} } }] }) })).toThrow();
});

it("keeps missing files distinct from malformed JSON", () => {
  const snapshot = parseResearchSnapshot({ ...files(), "state.json": null });
  expect(snapshot.state).toBeNull();
  expect(snapshot.events).toEqual([]);
});

describe("research evidence projection", () => {
  it("does not turn default configuration or state.stage into a running stage", () => {
    const snapshot = parseResearchSnapshot({ ...files(), "state.json": JSON.stringify({ ...state, stage: "3-review" }) });
    const result = projectResearch(snapshot);
    expect(result.stage).toBeNull();
    expect(result.enteredStages.size).toBe(0);
    expect(result.currentRun).toBeNull();
  });

  it("retains explicit legacy stages without inventing completed steps", () => {
    const result = projectResearch(parseResearchSnapshot(files([event("stage-enter", { stage: "3-review" })])));
    expect(result.stage).toBe("3-review");
    expect([...result.enteredStages]).toEqual(["3-review"]);
    expect(result.runs).toEqual([]);
    // A current stage with no execution stays idle: the panel must not render it as 待触发.
    expect(result.executions).toEqual([]);
  });

  it("shows a runless observation after frozenAt while a current run exists", () => {
    const frozen = { ...state, charter: { ...state.charter, frozenAt: "2026-10-22T00:00:00Z" } };
    const events = [
      registered("r", "l1"),
      event("stage-enter", { stage: "1-idea", source: "workflow" }, "2026-10-22T01:00:00Z"),
      event("stage-enter", { stage: "3-review", source: "conversation", evidence: ["prompt:回到评审"] }, "2026-10-23T01:00:00Z"),
    ];
    const result = projectResearch(parseResearchSnapshot({ ...files(events), "state.json": JSON.stringify(frozen) }));
    expect(result.currentRun?.runId).toBe("r");
    expect(result.stage).toBe("3-review");
    expect(result.executions).toEqual([]);
    expect(events[2].detail?.runId).toBeUndefined();
  });

  it("lets the later appended runless observation win without a synthetic run identity", () => {
    const first = event("stage-enter", { stage: "1-idea", source: "conversation" }, "2026-10-23T01:00:00Z");
    const second = event("stage-enter", { stage: "2-experiment", source: "tool-observed" }, "2026-10-23T01:00:00Z");
    const result = projectResearch(parseResearchSnapshot(files([first, second])));
    expect(result.stage).toBe("2-experiment");
    expect([...result.enteredStages]).toEqual(["1-idea", "2-experiment"]);
    expect(result.currentRun).toBeNull();
  });

  it("orders runless observations by real observation time, not append order", () => {
    const later = event("stage-enter", { stage: "2-experiment", source: "tool-observed", observedAt: "2026-10-23T12:00:00Z" }, "2026-10-24T00:00:00Z");
    const earlier = event("stage-enter", { stage: "1-idea", source: "conversation", observedAt: "2026-10-23T10:00:00Z" }, "2026-10-25T00:00:00Z");
    const result = projectResearch(parseResearchSnapshot(files([later, earlier])));
    expect(result.stage).toBe("2-experiment");
    expect([...result.enteredStages]).toEqual(["1-idea", "2-experiment"]);
  });

  it("uses source selection/observation times when ordering against a workflow stage event", () => {
    for (const [timeKey, source] of [["selectedAt", "manual"], ["observedAt", "tool-observed"]]) {
      const result = projectResearch(parseResearchSnapshot(files([
        registered("r"),
        event("stage-enter", { stage: "1-idea", source, [timeKey]: "2026-10-23T12:00:00Z" }, "2026-10-23T20:00:00Z"),
        event("stage-enter", { runId: "r", stage: "3-review", sourceSeq: 2, sourceAt: "2026-10-23T13:00:00Z" }, "2026-10-23T14:00:00Z"),
      ])));
      expect(result.stage).toBe("3-review");
    }
  });

  it("rejects stage observations written against an older charter revision", () => {
    const result = projectResearch(parseResearchSnapshot(files([
      event("stage-enter", { stage: "3-review", charterRevision: 0, source: "conversation" }),
    ])));
    expect(result.stage).toBeNull();
    expect(result.enteredStages.size).toBe(0);
  });

  it("orders launches by their original invocation, not RPC reply arrival", () => {
    const events = [event("auto-run", { launchId: "l1" }), event("auto-run", { launchId: "l2" }), registered("r2", "l2"), registered("r1", "l1")];
    expect(projectResearch(parseResearchSnapshot(files(events))).currentRun?.runId).toBe("r2");
  });

  it("does not let an old run's late stage event change the current run", () => {
    const events = [registered("old"), registered("new"), event("stage-enter", { runId: "new", stage: "1-idea", sourceSeq: 1 }), event("stage-enter", { runId: "old", stage: "3-review", sourceSeq: 99 })];
    const result = projectResearch(parseResearchSnapshot(files(events)));
    expect(result.stage).toBe("1-idea");
    expect(result.enteredStages.has("3-review")).toBe(false);
  });

  it("uses source order for recovered stage events appended out of order", () => {
    const events = [registered("r"), event("stage-enter", { runId: "r", stage: "3-review", sourceSeq: 30 }), event("stage-enter", { runId: "r", stage: "1-idea", sourceSeq: 10 })];
    expect(projectResearch(parseResearchSnapshot(files(events))).stage).toBe("3-review");
  });

  it("latches a terminal step while accepting a later actual result summary", () => {
    const events = [registered("r"), step("r", "completed", { sourceSeq: 2 }), step("r", "started", { sourceSeq: 3 }), step("r", "completed", { sourceSeq: 4, summary: "实际返回的候选", observedModel: "observed/model" })];
    const result = projectResearch(parseResearchSnapshot(files(events)));
    expect(result.currentRun?.steps).toHaveLength(1);
    expect(result.currentRun?.steps[0]).toMatchObject({ status: "completed", summary: "实际返回的候选", observedModel: "observed/model" });
    expect(parseResearchSnapshot(files(events)).attempts).toEqual([]);
    expect(parseResearchSnapshot(files(events)).state?.claims).toEqual([]);
  });

  it("deduplicates event identities and ignores steps with no registered run", () => {
    const e = step("r", "running", { eventId: "same", sourceSeq: 1 });
    const result = projectResearch(parseResearchSnapshot(files([registered("r"), e, e, step("unknown", "running")])));
    expect(result.runs).toHaveLength(1);
    expect(result.currentRun?.steps).toHaveLength(1);
    expect(result.currentRun?.steps[0].observedModel).toBeUndefined();
  });

  it("does not promote runs from an older charter into the current target", () => {
    const result = projectResearch(parseResearchSnapshot(files([event("run-registered", { runId: "old", charterRevision: 0 }), step("old", "running")])));
    expect(result.currentRun).toBeNull();
    expect(result.stage).toBeNull();
    expect(result.runs).toHaveLength(1);
  });

  it("preserves business blocked separately from process completion", () => {
    const result = projectResearch(parseResearchSnapshot(files([registered("r"), step("r", "completed", { businessStatus: "blocked" }), event("run-outcome", { runId: "r", status: "completed", outcome: "blocked", reason: "等待授权" })])));
    expect(result.currentRun).toMatchObject({ status: "completed", outcome: "blocked", reason: "等待授权" });
    expect(result.currentRun?.steps[0]).toMatchObject({ status: "completed", businessStatus: "blocked" });
  });

  it("can show an old confirmed receipt without fabricating steps or parent identity", () => {
    const snapshot = parseResearchSnapshot({ ...files(), "auto-run.json": JSON.stringify({ at: "2026-10-22T00:00:00Z", result: { details: { runId: "old-confirmed", asyncDir: "/private/native-run" } } }) });
    const result = projectResearch(snapshot);
    expect(result.currentRun?.runId).toBe("old-confirmed");
    expect(result.currentRun?.steps).toEqual([]);
    expect(result.currentRun?.parentSessionId).toBeUndefined();
    expect(result.stage).toBeNull();
  });

  it("does not expose escaping evidence paths as openable artifacts", () => {
    const result = projectResearch(parseResearchSnapshot(files([registered("r"), step("r", "completed", { evidence: ["../secret", "/etc/passwd", "runs/result.json"] })])));
    expect(result.currentRun?.steps[0].evidence).toEqual(["runs/result.json"]);
  });
});

it("reads configured roles and skills from the run's configuration snapshot", () => {
  const roles = configuredRolesForStage({ stages: { "1-idea": { roles: [{ role: "research-explorer", skills: ["real-skill"] }], sequentialRole: { role: "research-critic", skills: ["review"] } } } }, "1-idea");
  expect(roles.map(r => r.name)).toEqual(["research-explorer", "research-critic"]);
  expect(roles[0].skills).toEqual(["real-skill"]);
  expect(roles[0].model).toBeUndefined();
});

const provenance = {
  schema: "pi-research-session.v1", parentSessionId: "lead-session", creatorSessionId: "lead-session",
  creatorAgent: "research_session", role: "literature", task: "Find evidence", stage: "1-idea",
  charterHash: "sha256:" + "a".repeat(64), adoptionId: "adopt-" + "b".repeat(24),
  workflowCwd: "/workspace", spawnToken: "spawn-token-1", createdAt: "2026-11-04T00:00:00.000Z",
  origin: "research_session", relation: "dispatch",
} as const;
const execution = (id: string, sessionId: string, extra: Partial<ResearchExecution> = {}): ResearchExecution => ({
  id, sessionId, kind: "pi-session", status: "running", source: "observation", evidence: [], ...extra,
});

describe("three origins and real dispatch edges", () => {
  it("labels lead-created, workflow-created and user-created sessions distinctly", () => {
    const lead = projectExecutionOrigin(
      execution("session-child", "child"),
      { id: "child", researchSession: provenance, firstMessage: "raw prompt text" },
      "lead-session",
    );
    expect(lead).toMatchObject({
      kind: "lead-agent-created", role: "literature",
      creatorSessionId: "lead-session", creatorLabel: "主agent",
    });
    const workflow = projectExecutionOrigin(execution("session-stage", "stage"), { id: "stage", via: "spawn" }, "lead-session");
    expect(workflow).toMatchObject({ kind: "workflow-created", creatorSessionId: "lead-session", creatorLabel: "工作流" });
    const user = projectExecutionOrigin(execution("session-user", "user"), { id: "user" });
    expect(user).toMatchObject({ kind: "user-created", creatorLabel: "用户" });
  });

  it("maps provenance session ids to actual workbench execution ids and omits missing endpoints", () => {
    const executions = [execution("session-lead-session", "lead-session"), execution("session-child", "child")];
    expect(projectResearchSessionRelations(executions, [{ id: "child", researchSession: provenance }])).toEqual([{
      id: "research-session:spawn-token-1",
      fromExecutionId: "session-lead-session",
      toExecutionId: "session-child",
      kind: "dispatch",
      evidence: { source: "explicit-record", eventId: "spawn-token-1" },
    }]);
    expect(projectResearchSessionRelations([executions[0]!], [{ id: "child", researchSession: provenance }])).toEqual([]);
    expect(projectResearchSessionRelations(executions, [
      { id: "child", researchSession: provenance },
      { id: "child", researchSession: provenance },
    ])).toHaveLength(1);
  });
});
