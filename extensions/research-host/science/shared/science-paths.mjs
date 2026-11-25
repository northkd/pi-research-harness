import { parseScienceTabPath } from "./science-viewer.mjs";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TASK_ID = new RegExp(`^si-${UUID}$`);
const ARTIFACT_ID = new RegExp(`^sa-${UUID}$`);
const isScienceInstanceId = (value) => typeof value === "string" && TASK_ID.test(value);
const isScienceArtifactId = (value) => typeof value === "string" && ARTIFACT_ID.test(value);
function scienceArtifactTabPath(taskId, artifactId) {
  if (!isScienceInstanceId(taskId) || !isScienceArtifactId(artifactId)) throw new Error("invalid-science-artifact");
  return `science:artifact:${taskId}:${artifactId}`;
}
function parseScienceArtifactTabPath(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  return parts.length === 4 && parts[0] === "science" && parts[1] === "artifact" && isScienceInstanceId(parts[2]) && isScienceArtifactId(parts[3]) ? { taskId: parts[2], artifactId: parts[3] } : null;
}
function isSciencePanePath(value) {
  return parseScienceTabPath(value) !== null || parseScienceArtifactTabPath(value) !== null;
}
export {
  isScienceArtifactId,
  isScienceInstanceId,
  isSciencePanePath,
  parseScienceArtifactTabPath,
  scienceArtifactTabPath
};
