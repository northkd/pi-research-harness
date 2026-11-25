const LEGACY_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_PROTOCOL_VERSIONS = [
  ...LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION
];
const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const META_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const LEGACY_SET = LEGACY_PROTOCOL_VERSIONS;
function isSupported(value) {
  return typeof value === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(value);
}
function resolveProtocolVersion(method, headerValue, params) {
  if (Array.isArray(headerValue) || typeof headerValue === "string" && headerValue.includes(",")) {
    return { ok: false, code: "AmbiguousHeader" };
  }
  const header = typeof headerValue === "string" && headerValue.length > 0 ? headerValue : void 0;
  const meta = typeof params === "object" && params !== null ? params._meta : void 0;
  const bodyVersion = typeof meta === "object" && meta !== null ? meta[META_VERSION_KEY] : void 0;
  const metaDeclaresVersion = bodyVersion !== void 0;
  if (method === "initialize") {
    const requested = typeof params === "object" && params !== null ? params.protocolVersion : void 0;
    if (typeof requested !== "string") {
      return { ok: false, code: "UnsupportedProtocolVersion" };
    }
    if (requested === MODERN_PROTOCOL_VERSION) {
      return { ok: true, era: "modern", version: MODERN_PROTOCOL_VERSION };
    }
    if (LEGACY_SET.includes(requested)) {
      return { ok: true, era: "legacy", version: requested };
    }
    return { ok: true, era: "legacy", version: "2025-11-25" };
  }
  if (header !== void 0) {
    if (metaDeclaresVersion) {
      if (typeof bodyVersion !== "string") {
        return { ok: false, code: "UnsupportedProtocolVersion" };
      }
      if (bodyVersion !== header) {
        return { ok: false, code: "HeaderMismatch" };
      }
    }
    if (!isSupported(header)) {
      return { ok: false, code: "UnsupportedProtocolVersion" };
    }
    if (header !== MODERN_PROTOCOL_VERSION) {
      return { ok: true, era: "legacy", version: header };
    }
    if (!metaDeclaresVersion) {
      return { ok: false, code: "MissingMeta" };
    }
    return { ok: true, era: "modern", version: MODERN_PROTOCOL_VERSION };
  }
  if (metaDeclaresVersion) {
    return { ok: false, code: "MissingHeader" };
  }
  return { ok: true, era: "legacy", version: "2025-03-26" };
}
export {
  LEGACY_PROTOCOL_VERSIONS,
  META_VERSION_KEY,
  MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  SUPPORTED_PROTOCOL_VERSIONS,
  resolveProtocolVersion
};
