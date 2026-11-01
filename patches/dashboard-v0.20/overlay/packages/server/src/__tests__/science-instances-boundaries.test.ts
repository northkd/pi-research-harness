import { hasRouteTier, routeTier } from "@blackbelt-technology/pi-dashboard-shared/route-tiers.js";
import { isSciencePanePath, parseScienceArtifactTabPath, projectScienceDetail, projectScienceListResponse, SCIENCE_RECORD_LIMITS, scienceArtifactTabPath } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { describe, expect, it } from "vitest";
import { isDenylisted } from "../../../mcp-server-plugin/src/server/tools.denylist.js";
import { classifyHttpRoad } from "../identity/http-road-classification.js";

const taskId = "si-00000000-0000-4000-8000-000000000001";
const artifactId = "sa-00000000-0000-4000-8000-000000000002";
const summary = { id: taskId, status: "unknown", createdAt: 1, lastObservedAt: null, stale: true };
const artifact = { id: artifactId, name: "values.csv", mediaType: "text/csv", bytes: 0, sha256: "a".repeat(64) };
const detail = { ...summary, modelIds: [], usage: null, cost: null, artifacts: [artifact] };

describe("Science instance projection and generic API boundaries", () => {
  it("classifies all three read roads as observe with handler-owned admission and denies generic MCP", () => {
    for (const path of ["/api/res-workflow/science/instances", "/api/res-workflow/science/instances/:taskId", "/api/res-workflow/science/instances/:taskId/artifacts/:artifactId"]) {
      expect(hasRouteTier("GET", path)).toBe(true); expect(routeTier("GET", path)).toBe("observe");
      expect(classifyHttpRoad("GET", path)).toEqual({ road: "session-handler" }); expect(isDenylisted(path)).toBe(true);
    }
  });
  it("accepts exact opaque artifact paths and rejects riders, escapes and missing IDs", () => {
    const path = scienceArtifactTabPath(taskId, artifactId);
    expect(parseScienceArtifactTabPath(path)).toEqual({ taskId, artifactId }); expect(isSciencePanePath(path)).toBe(true);
    for (const value of [`${path}:extra`, `${path}?url=http://private`, path.replace(taskId, "../../secret"), "science:artifact::", "http://private"]) expect(parseScienceArtifactTabPath(value)).toBeNull();
    expect(() => scienceArtifactTabPath("../../secret", artifactId)).toThrow("invalid-science-artifact");
  });
  it("rejects duplicate and oversized instance lists instead of inventing an empty success", () => {
    for (const rows of [[summary, summary], Array(SCIENCE_RECORD_LIMITS.instances + 1).fill(summary), [{ ...summary, stale: undefined }], [{ ...summary, status: "accepted" }]]) expect(projectScienceListResponse({ availability: "ready", instances: rows })).toEqual({ availability: "unknown", reason: "invalid-host-response" });
  });
  it("keeps unobserved models, usage and cost unknown, and strips page metadata", () => {
    expect(projectScienceDetail({ ...detail, prompt: "private", url: "http://private/?nonce=secret", title: "secret" })).toEqual(detail);
    for (const change of [{ usage: 0 }, { cost: 0 }, { modelIds: ["another-provider/model"] }, { artifacts: [artifact, artifact] }, { artifacts: Array(SCIENCE_RECORD_LIMITS.artifacts + 1).fill(artifact) }]) expect(projectScienceDetail({ ...detail, ...change })).toBeNull();
  });
});
