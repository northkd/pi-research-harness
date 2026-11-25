import { createHash } from "node:crypto";
import { isScienceArtifactId, isScienceInstanceId, projectScienceDetailResponse, projectScienceListResponse, SCIENCE_RECORD_LIMITS } from "../shared/science-instances.mjs";
const bindingUnavailable = { availability: "unavailable", reason: "binding-unavailable" };
const invalidResponse = { availability: "unknown", reason: "invalid-host-response" };
function readFailure(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : void 0;
  if (code === "registry-not-found" || code === "registry-access-denied" || code === "registry-artifact-refused") return { ...bindingUnavailable };
  return { availability: "unknown", reason: "host-offline" };
}
function collectedRead(artifact, value) {
  if (!value || typeof value !== "object" || !("bytes" in value) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength > SCIENCE_RECORD_LIMITS.artifactBytes || value.bytes.byteLength !== artifact.bytes || !("name" in value) || value.name !== artifact.name || !("mediaType" in value) || value.mediaType !== artifact.mediaType || !("sha256" in value) || value.sha256 !== artifact.sha256) return { ...invalidResponse };
  const content = Uint8Array.from(value.bytes);
  if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) return { ...invalidResponse };
  return { availability: "ready", artifact, content };
}
function createScienceInstancesHost(registry) {
  const detail = async (partition, taskId) => {
    if (!isScienceInstanceId(taskId)) return { ...bindingUnavailable };
    try {
      const result = projectScienceDetailResponse({ availability: "ready", instance: await registry.detail({ ...partition }, taskId) });
      return result.availability === "ready" && result.instance.id !== taskId ? { ...invalidResponse } : result;
    } catch (error) {
      return readFailure(error);
    }
  };
  return {
    async list(partition) {
      try {
        return projectScienceListResponse({ availability: "ready", instances: await registry.list({ ...partition }) });
      } catch (error) {
        return readFailure(error);
      }
    },
    detail,
    async readArtifact(partition, taskId, artifactId) {
      if (!isScienceInstanceId(taskId) || !isScienceArtifactId(artifactId)) return { ...bindingUnavailable };
      const selected = { ...partition };
      const result = await detail(selected, taskId);
      if (result.availability !== "ready") return result;
      const artifact = result.instance.artifacts.find((value) => value.id === artifactId);
      if (!artifact) return { ...bindingUnavailable };
      try {
        return collectedRead(artifact, await registry.readArtifact(selected, taskId, artifactId));
      } catch (error) {
        return readFailure(error);
      }
    }
  };
}
export {
  createScienceInstancesHost
};
