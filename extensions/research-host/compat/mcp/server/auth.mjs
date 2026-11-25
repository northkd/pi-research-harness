import crypto from "node:crypto";
const BEARER_PREFIX = "bearer ";
function parseBearer(header) {
  if (typeof header !== "string") return null;
  if (header.length < BEARER_PREFIX.length) return null;
  if (!header.slice(0, BEARER_PREFIX.length).toLowerCase().startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : null;
}
function credentialFingerprint(header) {
  const token = parseBearer(header);
  return crypto.createHash("sha256").update(token ?? "").digest("hex");
}
function authenticate(header, deps) {
  const token = parseBearer(header);
  if (token === null) return null;
  const sessionCaller = deps.tokens.resolve(token);
  if (sessionCaller) return sessionCaller;
  if (deps.verifyDeviceTokenTier) {
    const verified = deps.verifyDeviceTokenTier(token);
    return verified ? { kind: "device", deviceId: verified.id, tier: verified.tier } : null;
  }
  const deviceId = deps.verifyDeviceToken(token);
  return deviceId ? { kind: "device", deviceId, tier: "operate" } : null;
}
export {
  authenticate,
  credentialFingerprint,
  parseBearer
};
