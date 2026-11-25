import * as fs from "node:fs";
import * as path from "node:path";
const VALID_EVENTS = ["created", "changed", "deleted"];
const defaultWatch = (dir) => fs.watch(dir, { persistent: false });
function parseFileConfig(rawOn) {
  const on = rawOn;
  const p = on?.path;
  if (typeof p !== "string" || p.trim().length === 0) {
    throw new Error(`file trigger requires a non-empty \`path\` (got: ${JSON.stringify(p)})`);
  }
  let events = ["created"];
  if (Array.isArray(on?.events)) {
    const picked = on.events.filter(
      (e) => typeof e === "string" && VALID_EVENTS.includes(e)
    );
    if (picked.length > 0) events = picked;
  }
  const settle = on?.settle === "rename-only" || on?.settle === void 0 ? "rename-only" : "rename-only";
  return { path: p, events, settle };
}
function makeFileTrigger(watch = defaultWatch) {
  return {
    kind: "file",
    parse: parseFileConfig,
    arm(cfg, fire, deps) {
      let disposed = false;
      const seen = /* @__PURE__ */ new Set();
      let watcher = null;
      const isFile = (full) => {
        try {
          return fs.statSync(full).isFile();
        } catch {
          return false;
        }
      };
      const onEvent = (eventType, filename) => {
        if (disposed) return;
        const name = filename == null ? "" : String(filename);
        if (!name) return;
        const full = path.join(cfg.path, name);
        if (eventType === "rename") {
          const exists = isFile(full);
          if (exists && cfg.events.includes("created")) {
            if (seen.has(full)) return;
            seen.add(full);
            fire({ firedAt: deps.now(), value: full });
          } else if (!exists && cfg.events.includes("deleted")) {
            seen.delete(full);
            fire({ firedAt: deps.now(), value: full });
          }
        } else if (eventType === "change" && cfg.events.includes("changed")) {
          if (isFile(full)) fire({ firedAt: deps.now(), value: full });
        }
      };
      try {
        watcher = watch(cfg.path);
        watcher.on("change", (...a) => onEvent(a[0], a[1]));
        watcher.on("error", () => {
          try {
            watcher?.close();
          } catch {
          }
          watcher = null;
        });
      } catch {
        watcher = null;
      }
      return {
        dispose() {
          disposed = true;
          try {
            watcher?.close();
          } catch {
          }
          watcher = null;
        }
      };
    }
  };
}
const fileTrigger = makeFileTrigger();
export {
  fileTrigger,
  makeFileTrigger
};
