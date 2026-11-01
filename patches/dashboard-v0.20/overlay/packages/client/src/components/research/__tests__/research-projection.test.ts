import { describe, expect, it } from "vitest";
import {
  configuredRolesForStage, parseResearchSnapshot, projectResearch,
  type ResearchEvent, type ResearchFileSet,
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
