/** Bounded Science record projections. No prompts, page addresses or authority. */

import { isScienceArtifactId, isScienceInstanceId } from "./science-paths.js";
import type { ScienceViewPartition } from "./science-viewer.js";

export { isScienceArtifactId, isScienceInstanceId, isSciencePanePath, parseScienceArtifactTabPath, scienceArtifactTabPath } from "./science-paths.js";

export const SCIENCE_RECORD_LIMITS = { instances: 128, artifacts: 32, artifactBytes: 1024 * 1024 } as const;
export type ScienceInstanceStatus = "unknown" | "running" | "completed" | "failed" | "waiting-approval" | "cancelled";
export type ScienceArtifactMediaType = "image/png" | "image/jpeg" | "application/pdf" | "text/csv" | "text/plain";
export interface ScienceInstanceSummary {
  id: string;
  status: ScienceInstanceStatus;
  createdAt: number;
  lastObservedAt: number | null;
  stale: boolean;
}
export interface ScienceArtifact {
  id: string;
  name: string;
  mediaType: ScienceArtifactMediaType;
  bytes: number;
  sha256: string;
}
export interface ScienceInstanceDetail extends ScienceInstanceSummary {
  modelIds: string[];
  /** No observed usage/cost contract is available in this driver version. */
  usage: null;
  cost: null;
  artifacts: ScienceArtifact[];
}
export type ScienceReadReason = "host-unconfigured" | "host-offline" | "binding-unavailable" | "invalid-host-response";
export type ScienceReadUnavailable = { availability: "unavailable" | "unknown"; reason: ScienceReadReason };
export type ScienceInstanceListResponse = { availability: "ready"; instances: ScienceInstanceSummary[] } | ScienceReadUnavailable;
export type ScienceInstanceDetailResponse = { availability: "ready"; instance: ScienceInstanceDetail } | ScienceReadUnavailable;
export type ScienceArtifactReadResponse = { availability: "ready"; artifact: ScienceArtifact; content: Uint8Array } | ScienceReadUnavailable;

/** Host-only injection. Callers cannot obtain write grants through these reads. */
export interface ScienceInstancesHost {
  list(partition: ScienceViewPartition): Promise<ScienceInstanceListResponse>;
  detail(partition: ScienceViewPartition, taskId: string): Promise<ScienceInstanceDetailResponse>;
  readArtifact(partition: ScienceViewPartition, taskId: string, artifactId: string): Promise<ScienceArtifactReadResponse>;
}

const STATUS = new Set(["unknown", "running", "completed", "failed", "waiting-approval", "cancelled"]);
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "application/pdf", "text/csv", "text/plain"]);
const MODEL_IDS = new Set(["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

export function projectScienceSummary(value: unknown): ScienceInstanceSummary | null {
  if (!object(value) || !isScienceInstanceId(value.id) || !STATUS.has(value.status as string) || !timestamp(value.createdAt) || value.lastObservedAt !== null && !timestamp(value.lastObservedAt) || typeof value.stale !== "boolean") return null;
  return { id: value.id, status: value.status as ScienceInstanceStatus, createdAt: value.createdAt, lastObservedAt: value.lastObservedAt as number | null, stale: value.stale };
}
export function projectScienceArtifact(value: unknown): ScienceArtifact | null {
  if (!object(value) || !isScienceArtifactId(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f/\\:?#%]/.test(value.name) || value.name === "." || value.name === ".." || !MEDIA_TYPES.has(value.mediaType as string) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > SCIENCE_RECORD_LIMITS.artifactBytes || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return { id: value.id, name: value.name, mediaType: value.mediaType as ScienceArtifactMediaType, bytes: value.bytes, sha256: value.sha256 };
}
export function projectScienceDetail(value: unknown): ScienceInstanceDetail | null {
  const summary = projectScienceSummary(value);
  if (!summary || !object(value) || !Array.isArray(value.modelIds) || value.modelIds.length > 3 || value.modelIds.some(id => typeof id !== "string" || !MODEL_IDS.has(id)) || new Set(value.modelIds).size !== value.modelIds.length || value.usage !== null || value.cost !== null || !Array.isArray(value.artifacts) || value.artifacts.length > SCIENCE_RECORD_LIMITS.artifacts) return null;
  const artifacts = value.artifacts.map(projectScienceArtifact);
  if (artifacts.some(artifact => !artifact) || new Set(artifacts.map(artifact => artifact!.id)).size !== artifacts.length) return null;
  return { ...summary, modelIds: [...value.modelIds], usage: null, cost: null, artifacts: artifacts as ScienceArtifact[] };
}
export function projectScienceUnavailable(value: unknown): ScienceReadUnavailable {
  if (object(value) && (value.availability === "unavailable" || value.availability === "unknown") && ["host-unconfigured", "host-offline", "binding-unavailable", "invalid-host-response"].includes(value.reason as string)) return { availability: value.availability, reason: value.reason as ScienceReadReason };
  return { availability: "unknown", reason: "invalid-host-response" };
}
export function projectScienceListResponse(value: unknown): ScienceInstanceListResponse {
  if (!object(value) || value.availability !== "ready") return projectScienceUnavailable(value);
  if (!Array.isArray(value.instances) || value.instances.length > SCIENCE_RECORD_LIMITS.instances) return { availability: "unknown", reason: "invalid-host-response" };
  const instances = value.instances.map(projectScienceSummary);
  if (instances.some(instance => !instance) || new Set(instances.map(instance => instance!.id)).size !== instances.length) return { availability: "unknown", reason: "invalid-host-response" };
  return { availability: "ready", instances: instances as ScienceInstanceSummary[] };
}
export function projectScienceDetailResponse(value: unknown): ScienceInstanceDetailResponse {
  if (!object(value) || value.availability !== "ready") return projectScienceUnavailable(value);
  const instance = projectScienceDetail(value.instance);
  return instance ? { availability: "ready", instance } : { availability: "unknown", reason: "invalid-host-response" };
}
