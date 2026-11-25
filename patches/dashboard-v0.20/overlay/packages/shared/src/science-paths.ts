/** Component-free Science virtual paths; safe for the editor's cold graph. */
import { parseScienceTabPath } from "./science-viewer.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TASK_ID = new RegExp(`^si-${UUID}$`);
const ARTIFACT_ID = new RegExp(`^sa-${UUID}$`);
export const isScienceInstanceId = (value: unknown): value is string => typeof value === "string" && TASK_ID.test(value);
export const isScienceArtifactId = (value: unknown): value is string => typeof value === "string" && ARTIFACT_ID.test(value);

export function scienceArtifactTabPath(taskId: string, artifactId: string): string {
  if (!isScienceInstanceId(taskId) || !isScienceArtifactId(artifactId)) throw new Error("invalid-science-artifact");
  return `science:artifact:${taskId}:${artifactId}`;
}
export function parseScienceArtifactTabPath(value: unknown): { taskId: string; artifactId: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  return parts.length === 4 && parts[0] === "science" && parts[1] === "artifact" && isScienceInstanceId(parts[2]) && isScienceArtifactId(parts[3]) ? { taskId: parts[2], artifactId: parts[3] } : null;
}
export function isSciencePanePath(value: unknown): boolean { return parseScienceTabPath(value) !== null || parseScienceArtifactTabPath(value) !== null; }
