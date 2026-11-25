import { readFileSync } from "node:fs";
import { frontmatterConfigHash, indexOptionsHash } from "./config.js";
import { SCHEMA_VERSION } from "./sqlite-store.js";
const gateKey = (root) => `gate:${root}`;
const engineKey = (root) => `engine:${root}`;
const gateValue = (cfg) => `${SCHEMA_VERSION}:${indexOptionsHash(cfg)}`;
let engineCache;
function runningEngine() {
  if (engineCache !== void 0) return engineCache;
  const env = process.env.KB_ENGINE_FINGERPRINT;
  if (env) return engineCache = env;
  try {
    const raw = JSON.parse(readFileSync(new URL("../engine-fingerprint.json", import.meta.url), "utf8"));
    engineCache = typeof raw.srcHash === "string" && raw.srcHash ? raw.srcHash : null;
  } catch {
    engineCache = null;
  }
  return engineCache;
}
function setRunningEngineForTest(v) {
  engineCache = v;
}
function sourceGateIsStale(store, cfg, root) {
  if ((store.getUserVersion?.() ?? 0) < SCHEMA_VERSION) return true;
  if ((store.getMeta?.(gateKey(root)) ?? null) !== gateValue(cfg)) return true;
  const eng = runningEngine();
  return eng !== null && (store.getMeta?.(engineKey(root)) ?? null) !== eng;
}
function stampSource(store, cfg, root, opts = {}) {
  store.setMeta?.(gateKey(root), gateValue(cfg));
  const eng = opts.engine === void 0 ? runningEngine() : opts.engine;
  if (eng !== null) store.setMeta?.(engineKey(root), eng);
}
function beginForcedSource(store, root) {
  return () => store.deleteMeta?.(engineKey(root));
}
function sourceIsSeedable(store, cfg, root) {
  return runningEngine() !== null && !sourceGateIsStale(store, cfg, root);
}
function stampPass(store, cfg) {
  store.setUserVersion?.(SCHEMA_VERSION);
  store.setMeta?.("facetConfigHash", frontmatterConfigHash(cfg.frontmatter));
}
export {
  beginForcedSource,
  runningEngine,
  setRunningEngineForTest,
  sourceGateIsStale,
  sourceIsSeedable,
  stampPass,
  stampSource
};
