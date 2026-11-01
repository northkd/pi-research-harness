/** Node-only private host protocol. Never export from browser protocol/barrels. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hostRecordsPacket, type ScienceHostRecordsReply } from "./science-host-records.js";
import { isScienceArtifactId, isScienceInstanceId } from "./science-paths.js";
import { isScienceViewInput, type ScienceViewFrame, type ScienceViewInput, type ScienceViewPartition, type ScienceViewReason } from "./science-viewer.js";

export const SCIENCE_HOST_VERSION = 1;
export const SCIENCE_HOST_MAX_PACKET = 3 * 1024 * 1024;
export const SCIENCE_HOST_MAX_REQUEST = 16 * 1024;
export const SCIENCE_HOST_AUTH_LIMIT = 1024;
export interface ScienceHostObservation {
  event: "science_host"; side: "client" | "daemon"; requestId: string;
  phase: "validate" | "connect" | "auth" | "open" | "subscribe" | "input" | "unsubscribe" | "close" | "instances-list" | "instance-detail" | "artifact-read";
  outcome: "ok" | "unavailable" | "unknown" | "denied";
  error: "none" | "private-files" | "transport" | "auth" | "binding" | "protocol" | "limit";
  elapsedMs: number;
}
export type ScienceHostObserver = (event: Readonly<ScienceHostObservation>) => void;
export const hostRequestId = () => `sh-${randomBytes(8).toString("hex")}`;
export function observeHost(observer: ScienceHostObserver | undefined, side: ScienceHostObservation["side"], requestId: string, phase: ScienceHostObservation["phase"], outcome: ScienceHostObservation["outcome"], error: ScienceHostObservation["error"], started: number) {
  const event = Object.freeze({ event: "science_host" as const, side, requestId, phase, outcome, error, elapsedMs: Math.max(0, Math.min(86400000, Date.now() - started)) });
  try { observer?.(event); } catch { /* Diagnostics never alter authorization or lifecycle. */ }
}
export interface ScienceHostPartitionAccess extends ScienceViewPartition { revalidate(): Promise<void> }
export type ScienceHostClientPacket =
  | { type: "auth"; proof: string }
  | { type: "open"; id: number; partition: ScienceViewPartition; instanceId?: string }
  | { type: "subscribe"; id: number; viewId: string }
  | { type: "input"; id: number; viewId: string; input: ScienceViewInput }
  | { type: "instances-list"; id: number; partition: ScienceViewPartition }
  | { type: "instance-detail"; id: number; partition: ScienceViewPartition; instanceId: string }
  | { type: "artifact-read"; id: number; partition: ScienceViewPartition; instanceId: string; artifactId: string }
  | { type: "unsubscribe"; viewId: string };
export type ScienceHostServerPacket =
  | { type: "challenge"; version: 1; nonce: string; proof: string }
  | { type: "authenticated" }
  | { type: "view"; id: number; availability: "ready"; viewId: string }
  | { type: "view"; id: number; availability: "unavailable" | "unknown"; reason: ScienceViewReason }
  | { type: "ack"; id: number; ok: boolean }
  | { type: "unavailable"; viewId: string }
  | { type: "frame"; viewId: string; frame: ScienceViewFrame }
  | ScienceHostRecordsReply;
const REASONS = new Set(["host-unconfigured", "host-offline", "binding-unavailable", "view-unavailable", "lease-expired", "access-revoked", "invalid-host-response", "busy"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const shape = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const validHostViewId = (value: unknown): value is string => typeof value === "string" && /^hv-[a-f0-9]{48}$/.test(value);
export const validHostInstanceId = (value: unknown): value is string => typeof value === "string" && /^si-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const proof = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export function validHostPartition(value: unknown): value is ScienceViewPartition {
  if (!object(value) || !shape(value, ["ownerKey", "cwd"]) || typeof value.cwd !== "string" || !value.cwd.startsWith("/") || value.cwd.length > 4096 || value.cwd.includes("\0") || typeof value.ownerKey !== "string" || value.ownerKey.length > 2048) return false;
  try { const owner = JSON.parse(value.ownerKey); return Array.isArray(owner) && owner.length === 2 && owner.every(part => typeof part === "string" && part.length > 0 && part.length <= 1024 && !part.includes("\0")); } catch { return false; }
}
export function hostFrame(value: unknown): ScienceViewFrame | null {
  if (!object(value) || !object(value.metadata) || typeof value.jpegBase64 !== "string" || value.jpegBase64.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.jpegBase64)) return null;
  const { deviceWidth, deviceHeight, timestamp } = value.metadata;
  if (![deviceWidth, deviceHeight, timestamp].every(n => typeof n === "number" && Number.isFinite(n)) || !Number.isInteger(deviceWidth) || !Number.isInteger(deviceHeight) || (deviceWidth as number) < 1 || (deviceWidth as number) > 16384 || (deviceHeight as number) < 1 || (deviceHeight as number) > 16384 || (timestamp as number) < 0) return null;
  return { jpegBase64: value.jpegBase64, metadata: { deviceWidth: deviceWidth as number, deviceHeight: deviceHeight as number, timestamp: timestamp as number } };
}
export function clientPacket(value: unknown): value is ScienceHostClientPacket {
  if (!object(value)) return false;
  switch (value.type) {
    case "auth": return shape(value, ["type", "proof"]) && proof(value.proof);
    case "open": return shape(value, ["type", "id", "partition", "instanceId"]) && id(value.id) && validHostPartition(value.partition) && (value.instanceId === undefined || validHostInstanceId(value.instanceId));
    case "subscribe": return shape(value, ["type", "id", "viewId"]) && id(value.id) && validHostViewId(value.viewId);
    case "input": return shape(value, ["type", "id", "viewId", "input"]) && id(value.id) && validHostViewId(value.viewId) && isScienceViewInput(value.input);
    case "unsubscribe": return shape(value, ["type", "viewId"]) && validHostViewId(value.viewId);
    case "instances-list": return shape(value, ["type", "id", "partition"]) && id(value.id) && validHostPartition(value.partition);
    case "instance-detail": return shape(value, ["type", "id", "partition", "instanceId"]) && id(value.id) && validHostPartition(value.partition) && isScienceInstanceId(value.instanceId);
    case "artifact-read": return shape(value, ["type", "id", "partition", "instanceId", "artifactId"]) && id(value.id) && validHostPartition(value.partition) && isScienceInstanceId(value.instanceId) && isScienceArtifactId(value.artifactId);
    default: return false;
  }
}
export function serverPacket(value: unknown): value is ScienceHostServerPacket {
  if (!object(value)) return false;
  switch (value.type) {
    case "challenge": return shape(value, ["type", "version", "nonce", "proof"]) && value.version === 1 && proof(value.nonce) && proof(value.proof);
    case "authenticated": return shape(value, ["type"]);
    case "view": return id(value.id) && (value.availability === "ready" ? shape(value, ["type", "id", "availability", "viewId"]) && validHostViewId(value.viewId) : shape(value, ["type", "id", "availability", "reason"]) && ["unknown", "unavailable"].includes(value.availability as string) && REASONS.has(value.reason as string));
    case "ack": return shape(value, ["type", "id", "ok"]) && id(value.id) && typeof value.ok === "boolean";
    case "unavailable": return shape(value, ["type", "viewId"]) && validHostViewId(value.viewId);
    case "frame": return shape(value, ["type", "viewId", "frame"]) && validHostViewId(value.viewId) && !!hostFrame(value.frame);
    case "instances": case "instance": case "artifact": return hostRecordsPacket(value);
    default: return false;
  }
}
export function hostProof(secret: Buffer, role: "host" | "client", nonce: string): string {
  return createHmac("sha256", secret).update(`pi-science-host-v1\n${role}\n${nonce}`).digest("base64url");
}
export function verifyHostProof(secret: Buffer, role: "host" | "client", nonce: string, value: string): boolean {
  return proof(nonce) && proof(value) && timingSafeEqual(Buffer.from(hostProof(secret, role, nonce)), Buffer.from(value));
}
export function hostChallenge(secret: Buffer): Extract<ScienceHostServerPacket, { type: "challenge" }> {
  const nonce = randomBytes(32).toString("base64url");
  return { type: "challenge", version: 1, nonce, proof: hostProof(secret, "host", nonce) };
}
export function encodeHostPacket(value: ScienceHostClientPacket | ScienceHostServerPacket): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > SCIENCE_HOST_MAX_PACKET) throw new Error("science-host-packet-limit");
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
function decodeHostPayload(payload: Buffer): unknown {
  const text = payload.toString("utf8");
  if (!Buffer.from(text).equals(payload)) throw new Error("science-host-invalid-utf8");
  try { return JSON.parse(text); } catch { throw new Error("science-host-invalid-json"); }
}
/** One allocation per bounded packet; no unbounded chunk list or quadratic concat. */
export class ScienceHostDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  limit: number;
  private readonly receive: (value: unknown) => void;
  constructor(limit: number, receive: (value: unknown) => void) { this.limit = limit; this.receive = receive; }
  push(data: Buffer) {
    let offset = 0, packets = 0;
    while (offset < data.length) {
      if (!this.payload) {
        const take = Math.min(4 - this.headerBytes, data.length - offset);
        data.copy(this.header, this.headerBytes, offset, offset + take); this.headerBytes += take; offset += take;
        if (this.headerBytes < 4) continue;
        const size = this.header.readUInt32BE(); this.headerBytes = 0;
        if (!size || size > this.limit) throw new Error("science-host-packet-limit");
        this.payload = Buffer.alloc(size); this.payloadBytes = 0;
      }
      const take = Math.min(this.payload.length - this.payloadBytes, data.length - offset);
      data.copy(this.payload, this.payloadBytes, offset, offset + take); this.payloadBytes += take; offset += take;
      if (this.payloadBytes !== this.payload.length) continue;
      const payload = this.payload; this.payload = undefined;
      if (++packets > 128) throw new Error("science-host-packet-burst");
      this.receive(decodeHostPayload(payload));
    }
  }
}
