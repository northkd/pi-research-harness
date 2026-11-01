import { describe, expect, it } from "vitest";
import { isResearchWorkbenchObservation } from "../research-workbench.js";
const fixture = () => ({ schema: "res-workflow.workbench-observation.v1", cwd: "/project", adoptionId: "adoption-1", charterHash: `sha256:${"a".repeat(64)}`, revision: `sha256:${"b".repeat(64)}`, updatedAt: "2026-10-30T10:00:00.000Z", heartbeatAt: "2026-10-30T10:00:00.000Z", coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 1 }, executions: [{ id: "pi:main", kind: "pi-session", sessionId: "main", status: "streaming" }, { id: "native:child", kind: "native-subagent", parentExecutionId: "pi:main", status: "running" }], relations: [], observedUsage: { responses: 2, inputTokens: 3, outputTokens: 4, inheritedExcluded: 1, metric: "observed-assistant-responses" } });
describe("research workbench wire boundary", () => {
  it("accepts unstaged actual native records without manufacturing a run/session id", () => { expect(isResearchWorkbenchObservation(fixture())).toBe(true); });
  it("refuses raw conversation payloads, broken hashes and unbounded or duplicate identities", () => {
    expect(isResearchWorkbenchObservation({ ...fixture(), messages: [] })).toBe(false);
    expect(isResearchWorkbenchObservation({ ...fixture(), executions: [{ ...fixture().executions[0], prompt: "private" }] })).toBe(false);
    expect(isResearchWorkbenchObservation({ ...fixture(), revision: "old" })).toBe(false);
    expect(isResearchWorkbenchObservation({ ...fixture(), executions: Array(257).fill(fixture().executions[0]) })).toBe(false);
    expect(isResearchWorkbenchObservation({ ...fixture(), executions: [fixture().executions[0], fixture().executions[0]] })).toBe(false);
  });
  it("requires exact existing relation endpoints and explicit provenance", () => {
    const relation = { id: "dispatch-1", fromExecutionId: "pi:main", toExecutionId: "native:child", kind: "dispatch", evidence: { source: "tool-call", eventId: "call-1" } };
    expect(isResearchWorkbenchObservation({ ...fixture(), relations: [relation] })).toBe(true);
    expect(isResearchWorkbenchObservation({ ...fixture(), relations: [{ ...relation, evidence: { source: "native-status", eventId: "status-proof-1" } }] })).toBe(true);
    expect(isResearchWorkbenchObservation({ ...fixture(), relations: [{ ...relation, toExecutionId: "foreign" }] })).toBe(false);
    expect(isResearchWorkbenchObservation({ ...fixture(), relations: [{ ...relation, evidence: { source: "same-cwd", eventId: "call-1" } }] })).toBe(false);
  });
  it("keeps declared configuration distinct and rejects raw stage-map instructions", () => {
    const value = { ...fixture(), configuration: { stages: { "1-idea": { roles: [{ role: "explorer", model: "configured/model", skills: ["research-lit"] }] } } }, configurationSource: { kind: "stage-map", sha256: "a".repeat(64) } };
    expect(isResearchWorkbenchObservation(value)).toBe(true);
    expect(isResearchWorkbenchObservation({ ...value, configuration: { stages: { "1-idea": { ...value.configuration.stages["1-idea"], prompt: "private" } } } })).toBe(false);
  });
});
