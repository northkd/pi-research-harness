/** Pure read adapter. The existing registry retains its writer and authority. */
import { createHash } from "node:crypto";
import { isScienceArtifactId, isScienceInstanceId, projectScienceDetailResponse, projectScienceListResponse, SCIENCE_RECORD_LIMITS, type ScienceArtifact, type ScienceArtifactReadResponse, type ScienceInstanceDetailResponse, type ScienceInstancesHost, type ScienceReadUnavailable } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import type { ScienceViewPartition } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import type { ScienceRegistry } from "./science-registry.js";

export type ScienceRegistryReads = Pick<ScienceRegistry, "list" | "detail" | "readArtifact">;
const bindingUnavailable: ScienceReadUnavailable = { availability: "unavailable", reason: "binding-unavailable" };
const invalidResponse: ScienceReadUnavailable = { availability: "unknown", reason: "invalid-host-response" };

function readFailure(error: unknown): ScienceReadUnavailable {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "registry-not-found" || code === "registry-access-denied" || code === "registry-artifact-refused") return { ...bindingUnavailable };
  return { availability: "unknown", reason: "host-offline" };
}

function collectedRead(artifact: ScienceArtifact, value: unknown): ScienceArtifactReadResponse {
  if (!value || typeof value !== "object" || !("bytes" in value) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength > SCIENCE_RECORD_LIMITS.artifactBytes || value.bytes.byteLength !== artifact.bytes
    || !("name" in value) || value.name !== artifact.name || !("mediaType" in value) || value.mediaType !== artifact.mediaType || !("sha256" in value) || value.sha256 !== artifact.sha256) return { ...invalidResponse };
  const content = Uint8Array.from(value.bytes);
  if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) return { ...invalidResponse };
  return { availability: "ready", artifact, content };
}

/** Inject only an already-open host-owned registry. This never opens a writer. */
export function createScienceInstancesHost(registry: ScienceRegistryReads): ScienceInstancesHost {
  const detail = async (partition: ScienceViewPartition, taskId: string): Promise<ScienceInstanceDetailResponse> => {
    if (!isScienceInstanceId(taskId)) return { ...bindingUnavailable };
    try {
      const result = projectScienceDetailResponse({ availability: "ready", instance: await registry.detail({ ...partition }, taskId) });
      return result.availability === "ready" && result.instance.id !== taskId ? { ...invalidResponse } : result;
    } catch (error) { return readFailure(error); }
  };
  return {
    async list(partition) {
      try { return projectScienceListResponse({ availability: "ready", instances: await registry.list({ ...partition }) }); }
      catch (error) { return readFailure(error); }
    },
    detail,
    async readArtifact(partition, taskId, artifactId) {
      if (!isScienceInstanceId(taskId) || !isScienceArtifactId(artifactId)) return { ...bindingUnavailable };
      const selected = { ...partition };
      const result = await detail(selected, taskId);
      if (result.availability !== "ready") return result;
      const artifact = result.instance.artifacts.find(value => value.id === artifactId);
      if (!artifact) return { ...bindingUnavailable };
      try { return collectedRead(artifact, await registry.readArtifact(selected, taskId, artifactId)); }
      catch (error) { return readFailure(error); }
    },
  };
}
