/** Node-only finite record wire projections for the private host socket. */
import { createHash } from "node:crypto";
import { projectScienceArtifact, projectScienceDetailResponse, projectScienceListResponse, projectScienceUnavailable, SCIENCE_RECORD_LIMITS, type ScienceArtifact, type ScienceArtifactReadResponse, type ScienceInstanceDetailResponse, type ScienceInstanceListResponse, type ScienceReadUnavailable } from "./science-instances.js";

export type ScienceHostArtifactResult = { availability: "ready"; artifact: ScienceArtifact; contentBase64: string } | ScienceReadUnavailable;
export type ScienceHostRecordsReply =
  | { type: "instances"; id: number; result: ScienceInstanceListResponse }
  | { type: "instance"; id: number; result: ScienceInstanceDetailResponse }
  | { type: "artifact"; id: number; result: ScienceHostArtifactResult };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const invalidHostRead = (): ScienceReadUnavailable => ({ availability: "unknown", reason: "invalid-host-response" });
export function hostListResult(value: unknown): ScienceInstanceListResponse { return projectScienceListResponse(value); }
export function hostDetailResult(value: unknown, instanceId: string): ScienceInstanceDetailResponse {
  const result = projectScienceDetailResponse(value);
  return result.availability === "ready" && result.instance.id !== instanceId ? invalidHostRead() : result;
}
function checkedArtifactBytes(artifact: ScienceArtifact, content: Uint8Array): Buffer | null {
  if (content.byteLength > SCIENCE_RECORD_LIMITS.artifactBytes || content.byteLength !== artifact.bytes) return null;
  const bytes = Buffer.from(content);
  return createHash("sha256").update(bytes).digest("hex") === artifact.sha256 ? bytes : null;
}
export function hostArtifactResult(value: unknown, artifactId: string): ScienceHostArtifactResult {
  if (!object(value) || value.availability !== "ready") return projectScienceUnavailable(value);
  const artifact = projectScienceArtifact(value.artifact);
  if (!artifact || artifact.id !== artifactId || !(value.content instanceof Uint8Array)) return invalidHostRead();
  const bytes = checkedArtifactBytes(artifact, value.content);
  return bytes ? { availability: "ready", artifact, contentBase64: bytes.toString("base64") } : invalidHostRead();
}
export function hostArtifactRead(value: unknown, artifactId: string): ScienceArtifactReadResponse {
  if (!object(value) || value.availability !== "ready") return projectScienceUnavailable(value);
  const artifact = projectScienceArtifact(value.artifact), encoded = value.contentBase64;
  if (!artifact || artifact.id !== artifactId || typeof encoded !== "string" || encoded.length > 4 * Math.ceil(SCIENCE_RECORD_LIMITS.artifactBytes / 3) || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return invalidHostRead();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !checkedArtifactBytes(artifact, bytes)) return invalidHostRead();
  return { availability: "ready", artifact, content: new Uint8Array(bytes) };
}
/** Only projected results are emitted. Unknown metadata never crosses the socket. */
export function hostRecordsPacket(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every(key => ["type", "id", "result"].includes(key)) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) return false;
  switch (value.type) {
    case "instances": return JSON.stringify(value.result) === JSON.stringify(hostListResult(value.result));
    case "instance": {
      const result = projectScienceDetailResponse(value.result);
      return JSON.stringify(value.result) === JSON.stringify(result);
    }
    case "artifact": return validArtifactResult(value.result);
    default: return false;
  }
}
function validArtifactResult(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.availability !== "ready") return JSON.stringify(value) === JSON.stringify(projectScienceUnavailable(value));
  const artifact = projectScienceArtifact(value.artifact);
  if (!artifact) return false;
  const read = hostArtifactRead(value, artifact.id);
  if (read.availability !== "ready") return false;
  return JSON.stringify(value) === JSON.stringify({ availability: "ready", artifact: read.artifact, contentBase64: value.contentBase64 });
}
