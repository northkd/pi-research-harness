import { isScienceArtifactId, isScienceInstanceId } from "./science-paths.mjs";
import { isScienceArtifactId as isScienceArtifactId2, isScienceInstanceId as isScienceInstanceId2, isSciencePanePath, parseScienceArtifactTabPath, scienceArtifactTabPath } from "./science-paths.mjs";
const SCIENCE_RECORD_LIMITS = { instances: 128, artifacts: 32, artifactBytes: 1024 * 1024 };
const STATUS = /* @__PURE__ */ new Set(["unknown", "running", "completed", "failed", "waiting-approval", "cancelled"]);
const MEDIA_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "application/pdf", "text/csv", "text/plain"]);
const MODEL_IDS = /* @__PURE__ */ new Set(["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"]);
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 864e13;
function projectScienceSummary(value) {
  if (!object(value) || !isScienceInstanceId(value.id) || !STATUS.has(value.status) || !timestamp(value.createdAt) || value.lastObservedAt !== null && !timestamp(value.lastObservedAt) || typeof value.stale !== "boolean") return null;
  return { id: value.id, status: value.status, createdAt: value.createdAt, lastObservedAt: value.lastObservedAt, stale: value.stale };
}
function projectScienceArtifact(value) {
  if (!object(value) || !isScienceArtifactId(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f/\\:?#%]/.test(value.name) || value.name === "." || value.name === ".." || !MEDIA_TYPES.has(value.mediaType) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > SCIENCE_RECORD_LIMITS.artifactBytes || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return { id: value.id, name: value.name, mediaType: value.mediaType, bytes: value.bytes, sha256: value.sha256 };
}
function projectScienceDetail(value) {
  const summary = projectScienceSummary(value);
  if (!summary || !object(value) || !Array.isArray(value.modelIds) || value.modelIds.length > 3 || value.modelIds.some((id) => typeof id !== "string" || !MODEL_IDS.has(id)) || new Set(value.modelIds).size !== value.modelIds.length || value.usage !== null || value.cost !== null || !Array.isArray(value.artifacts) || value.artifacts.length > SCIENCE_RECORD_LIMITS.artifacts) return null;
  const artifacts = value.artifacts.map(projectScienceArtifact);
  if (artifacts.some((artifact) => !artifact) || new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) return null;
  return { ...summary, modelIds: [...value.modelIds], usage: null, cost: null, artifacts };
}
function projectScienceUnavailable(value) {
  if (object(value) && (value.availability === "unavailable" || value.availability === "unknown") && ["host-unconfigured", "host-offline", "binding-unavailable", "invalid-host-response"].includes(value.reason)) return { availability: value.availability, reason: value.reason };
  return { availability: "unknown", reason: "invalid-host-response" };
}
function projectScienceListResponse(value) {
  if (!object(value) || value.availability !== "ready") return projectScienceUnavailable(value);
  if (!Array.isArray(value.instances) || value.instances.length > SCIENCE_RECORD_LIMITS.instances) return { availability: "unknown", reason: "invalid-host-response" };
  const instances = value.instances.map(projectScienceSummary);
  if (instances.some((instance) => !instance) || new Set(instances.map((instance) => instance.id)).size !== instances.length) return { availability: "unknown", reason: "invalid-host-response" };
  return { availability: "ready", instances };
}
function projectScienceDetailResponse(value) {
  if (!object(value) || value.availability !== "ready") return projectScienceUnavailable(value);
  const instance = projectScienceDetail(value.instance);
  return instance ? { availability: "ready", instance } : { availability: "unknown", reason: "invalid-host-response" };
}
export {
  SCIENCE_RECORD_LIMITS,
  isScienceArtifactId2 as isScienceArtifactId,
  isScienceInstanceId2 as isScienceInstanceId,
  isSciencePanePath,
  parseScienceArtifactTabPath,
  projectScienceArtifact,
  projectScienceDetail,
  projectScienceDetailResponse,
  projectScienceListResponse,
  projectScienceSummary,
  projectScienceUnavailable,
  scienceArtifactTabPath
};
