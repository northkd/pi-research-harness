import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hostRecordsPacket } from "./science-host-records.mjs";
import { isScienceArtifactId, isScienceInstanceId } from "./science-paths.mjs";
import { isScienceViewInput } from "./science-viewer.mjs";
const SCIENCE_HOST_VERSION = 1;
const SCIENCE_HOST_MAX_PACKET = 3 * 1024 * 1024;
const SCIENCE_HOST_MAX_REQUEST = 16 * 1024;
const SCIENCE_HOST_AUTH_LIMIT = 1024;
const hostRequestId = () => `sh-${randomBytes(8).toString("hex")}`;
function observeHost(observer, side, requestId, phase, outcome, error, started) {
  const event = Object.freeze({ event: "science_host", side, requestId, phase, outcome, error, elapsedMs: Math.max(0, Math.min(864e5, Date.now() - started)) });
  try {
    observer?.(event);
  } catch {
  }
}
const REASONS = /* @__PURE__ */ new Set(["host-unconfigured", "host-offline", "binding-unavailable", "view-unavailable", "lease-expired", "access-revoked", "invalid-host-response", "busy"]);
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const shape = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const id = (value) => Number.isSafeInteger(value) && value > 0;
const validHostViewId = (value) => typeof value === "string" && /^hv-[a-f0-9]{48}$/.test(value);
const validHostInstanceId = (value) => typeof value === "string" && /^si-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const proof = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function validHostPartition(value) {
  if (!object(value) || !shape(value, ["ownerKey", "cwd"]) || typeof value.cwd !== "string" || !value.cwd.startsWith("/") || value.cwd.length > 4096 || value.cwd.includes("\0") || typeof value.ownerKey !== "string" || value.ownerKey.length > 2048) return false;
  try {
    const owner = JSON.parse(value.ownerKey);
    return Array.isArray(owner) && owner.length === 2 && owner.every((part) => typeof part === "string" && part.length > 0 && part.length <= 1024 && !part.includes("\0"));
  } catch {
    return false;
  }
}
function hostFrame(value) {
  if (!object(value) || !object(value.metadata) || typeof value.jpegBase64 !== "string" || value.jpegBase64.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.jpegBase64)) return null;
  const { deviceWidth, deviceHeight, timestamp } = value.metadata;
  if (![deviceWidth, deviceHeight, timestamp].every((n) => typeof n === "number" && Number.isFinite(n)) || !Number.isInteger(deviceWidth) || !Number.isInteger(deviceHeight) || deviceWidth < 1 || deviceWidth > 16384 || deviceHeight < 1 || deviceHeight > 16384 || timestamp < 0) return null;
  return { jpegBase64: value.jpegBase64, metadata: { deviceWidth, deviceHeight, timestamp } };
}
function clientPacket(value) {
  if (!object(value)) return false;
  switch (value.type) {
    case "auth":
      return shape(value, ["type", "proof"]) && proof(value.proof);
    case "open":
      return shape(value, ["type", "id", "partition", "instanceId"]) && id(value.id) && validHostPartition(value.partition) && (value.instanceId === void 0 || validHostInstanceId(value.instanceId));
    case "subscribe":
      return shape(value, ["type", "id", "viewId"]) && id(value.id) && validHostViewId(value.viewId);
    case "input":
      return shape(value, ["type", "id", "viewId", "input"]) && id(value.id) && validHostViewId(value.viewId) && isScienceViewInput(value.input);
    case "unsubscribe":
      return shape(value, ["type", "viewId"]) && validHostViewId(value.viewId);
    case "instances-list":
      return shape(value, ["type", "id", "partition"]) && id(value.id) && validHostPartition(value.partition);
    case "instance-detail":
      return shape(value, ["type", "id", "partition", "instanceId"]) && id(value.id) && validHostPartition(value.partition) && isScienceInstanceId(value.instanceId);
    case "artifact-read":
      return shape(value, ["type", "id", "partition", "instanceId", "artifactId"]) && id(value.id) && validHostPartition(value.partition) && isScienceInstanceId(value.instanceId) && isScienceArtifactId(value.artifactId);
    default:
      return false;
  }
}
function serverPacket(value) {
  if (!object(value)) return false;
  switch (value.type) {
    case "challenge":
      return shape(value, ["type", "version", "nonce", "proof"]) && value.version === 1 && proof(value.nonce) && proof(value.proof);
    case "authenticated":
      return shape(value, ["type"]);
    case "view":
      return id(value.id) && (value.availability === "ready" ? shape(value, ["type", "id", "availability", "viewId"]) && validHostViewId(value.viewId) : shape(value, ["type", "id", "availability", "reason"]) && ["unknown", "unavailable"].includes(value.availability) && REASONS.has(value.reason));
    case "ack":
      return shape(value, ["type", "id", "ok"]) && id(value.id) && typeof value.ok === "boolean";
    case "unavailable":
      return shape(value, ["type", "viewId"]) && validHostViewId(value.viewId);
    case "frame":
      return shape(value, ["type", "viewId", "frame"]) && validHostViewId(value.viewId) && !!hostFrame(value.frame);
    case "instances":
    case "instance":
    case "artifact":
      return hostRecordsPacket(value);
    default:
      return false;
  }
}
function hostProof(secret, role, nonce) {
  return createHmac("sha256", secret).update(`pi-science-host-v1
${role}
${nonce}`).digest("base64url");
}
function verifyHostProof(secret, role, nonce, value) {
  return proof(nonce) && proof(value) && timingSafeEqual(Buffer.from(hostProof(secret, role, nonce)), Buffer.from(value));
}
function hostChallenge(secret) {
  const nonce = randomBytes(32).toString("base64url");
  return { type: "challenge", version: 1, nonce, proof: hostProof(secret, "host", nonce) };
}
function encodeHostPacket(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > SCIENCE_HOST_MAX_PACKET) throw new Error("science-host-packet-limit");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
function decodeHostPayload(payload) {
  const text = payload.toString("utf8");
  if (!Buffer.from(text).equals(payload)) throw new Error("science-host-invalid-utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("science-host-invalid-json");
  }
}
class ScienceHostDecoder {
  header = Buffer.alloc(4);
  headerBytes = 0;
  payload;
  payloadBytes = 0;
  limit;
  receive;
  constructor(limit, receive) {
    this.limit = limit;
    this.receive = receive;
  }
  push(data) {
    let offset = 0, packets = 0;
    while (offset < data.length) {
      if (!this.payload) {
        const take2 = Math.min(4 - this.headerBytes, data.length - offset);
        data.copy(this.header, this.headerBytes, offset, offset + take2);
        this.headerBytes += take2;
        offset += take2;
        if (this.headerBytes < 4) continue;
        const size = this.header.readUInt32BE();
        this.headerBytes = 0;
        if (!size || size > this.limit) throw new Error("science-host-packet-limit");
        this.payload = Buffer.alloc(size);
        this.payloadBytes = 0;
      }
      const take = Math.min(this.payload.length - this.payloadBytes, data.length - offset);
      data.copy(this.payload, this.payloadBytes, offset, offset + take);
      this.payloadBytes += take;
      offset += take;
      if (this.payloadBytes !== this.payload.length) continue;
      const payload = this.payload;
      this.payload = void 0;
      if (++packets > 128) throw new Error("science-host-packet-burst");
      this.receive(decodeHostPayload(payload));
    }
  }
}
export {
  SCIENCE_HOST_AUTH_LIMIT,
  SCIENCE_HOST_MAX_PACKET,
  SCIENCE_HOST_MAX_REQUEST,
  SCIENCE_HOST_VERSION,
  ScienceHostDecoder,
  clientPacket,
  encodeHostPacket,
  hostChallenge,
  hostFrame,
  hostProof,
  hostRequestId,
  observeHost,
  serverPacket,
  validHostInstanceId,
  validHostPartition,
  validHostViewId,
  verifyHostProof
};
