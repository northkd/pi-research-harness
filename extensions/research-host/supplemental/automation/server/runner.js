import { automationKey } from "./scheduler.js";
function createRunner(deps) {
  const log = deps.log ?? (() => {
  });
  const warn = deps.warn ?? (() => {
  });
  const active = /* @__PURE__ */ new Map();
  function begin(automation, ctx) {
    const key = automationKey(automation);
    const started = deps.startRun(automation, ctx);
    if (!started) {
      warn(`[runner] startRun failed for ${key}`);
      return;
    }
    active.set(key, { runId: started.runId, queue: active.get(key)?.queue ?? [] });
  }
  return {
    fire(automation, ctx) {
      const key = automationKey(automation);
      const state = active.get(key);
      const policy = automation.config?.concurrency ?? "skip";
      if (!state) {
        begin(automation, ctx);
        return;
      }
      switch (policy) {
        case "skip":
          log(`[runner] skip: drop overlapping fire for ${key} (active run ${state.runId})`);
          return;
        case "queue":
          state.queue.push({ automation, ctx });
          log(`[runner] queue: deferred fire for ${key} (depth ${state.queue.length})`);
          return;
        case "parallel":
          begin(automation, ctx);
          return;
      }
    },
    completeRun(key) {
      const state = active.get(key);
      if (!state) return;
      const next = state.queue.shift();
      if (next) {
        active.delete(key);
        begin(next.automation, next.ctx);
        const newState = active.get(key);
        if (newState) newState.queue = state.queue;
      } else {
        active.delete(key);
      }
    },
    activeRunId(key) {
      return active.get(key)?.runId ?? null;
    },
    queuedCount(key) {
      return active.get(key)?.queue.length ?? 0;
    }
  };
}
export {
  createRunner
};
