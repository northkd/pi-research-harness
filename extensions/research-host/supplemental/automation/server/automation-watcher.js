import * as fs from "node:fs";
import * as path from "node:path";
const FILTER_RE = /^[^/]+\/(?:automation\.yaml|prompt\.md)$/;
function matchesAutomationArtifact(relPath) {
  if (!relPath) return false;
  const normalized = relPath.replace(/\\/g, "/");
  return FILTER_RE.test(normalized);
}
function reconcileWatchers(watcher, wantBases) {
  const want = new Set(wantBases);
  for (const base of watcher.attachedBases()) {
    if (!want.has(base)) watcher.detach(base);
  }
  for (const base of want) watcher.attach(base);
}
function createAutomationWatcher(deps) {
  const debounceMs = deps.debounceMs ?? 300;
  const log = deps.logger ?? ((msg) => console.warn(msg));
  const attached = /* @__PURE__ */ new Map();
  const failedOnce = /* @__PURE__ */ new Set();
  function scheduleFire(scopeBase) {
    const entry = attached.get(scopeBase);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      const current = attached.get(scopeBase);
      if (!current) return;
      current.debounceTimer = null;
      try {
        deps.onChange(scopeBase);
      } catch (err) {
        log(`[automation-watcher] onChange threw for ${scopeBase}: ${err.message}`);
      }
    }, debounceMs);
  }
  function attach(scopeBase) {
    if (attached.has(scopeBase)) return false;
    const watchRoot = path.join(scopeBase, ".pi", "automation");
    let watcher;
    try {
      watcher = fs.watch(watchRoot, { recursive: true, persistent: false });
    } catch (err) {
      if (!failedOnce.has(scopeBase)) {
        failedOnce.add(scopeBase);
        const code = err.code ?? "ERR";
        log(`[automation-watcher] attach failed for ${scopeBase} (${code})`);
      }
      return false;
    }
    const entry = { watcher, debounceTimer: null };
    attached.set(scopeBase, entry);
    failedOnce.delete(scopeBase);
    const onEvent = (_eventType, filename) => {
      const rel = filename ? filename.toString() : null;
      if (!matchesAutomationArtifact(rel)) return;
      scheduleFire(scopeBase);
    };
    watcher.on("change", onEvent);
    watcher.on("rename", onEvent);
    watcher.on("error", (err) => {
      log(`[automation-watcher] error on ${scopeBase}: ${err.message}`);
      detach(scopeBase);
    });
    return true;
  }
  function detach(scopeBase) {
    const entry = attached.get(scopeBase);
    if (!entry) return;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    try {
      entry.watcher.close();
    } catch {
    }
    attached.delete(scopeBase);
  }
  function detachAll() {
    for (const scopeBase of Array.from(attached.keys())) detach(scopeBase);
  }
  function attachedBases() {
    return [...attached.keys()];
  }
  function size() {
    return attached.size;
  }
  return { attach, detach, detachAll, attachedBases, size };
}
export {
  createAutomationWatcher,
  matchesAutomationArtifact,
  reconcileWatchers
};
