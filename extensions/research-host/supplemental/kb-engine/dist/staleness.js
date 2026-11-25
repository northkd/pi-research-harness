import { existsSync, readFileSync } from "node:fs";
const STALENESS_VERSION = 2;
function readStaleness(stalenessFile) {
  if (!existsSync(stalenessFile)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(stalenessFile, "utf8"));
  } catch {
    return {};
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (!("version" in raw)) {
    const out2 = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") out2[k] = { sha256: v };
    }
    return out2;
  }
  if (raw.version !== STALENESS_VERSION) return {};
  const files = raw.files;
  if (files == null || typeof files !== "object" || Array.isArray(files)) return {};
  const out = {};
  for (const [k, rec] of Object.entries(files)) {
    if (rec == null || typeof rec !== "object") continue;
    const r = rec;
    if (typeof r.sha256 !== "string") continue;
    out[k] = {
      sha256: r.sha256,
      size: typeof r.size === "number" ? r.size : void 0,
      mtimeMs: typeof r.mtimeMs === "number" ? r.mtimeMs : void 0
    };
  }
  return out;
}
function stalenessVersionOnDisk(stalenessFile) {
  if (!existsSync(stalenessFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(stalenessFile, "utf8"));
    return typeof raw?.version === "number" ? raw.version : null;
  } catch {
    return null;
  }
}
export {
  STALENESS_VERSION,
  readStaleness,
  stalenessVersionOnDisk
};
