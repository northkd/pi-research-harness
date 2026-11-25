const MAX_DELAY = 2147483647;
function setLongTimer(raw, now, fn, ms) {
  const target = now() + ms;
  let handle = null;
  const arm = () => {
    const remaining = target - now();
    handle = remaining > MAX_DELAY ? raw(arm, MAX_DELAY) : raw(fn, Math.max(0, remaining));
  };
  arm();
  return { clear: () => handle?.clear() };
}
function automationKey(a) {
  return `${a.scope}:${a.dir}`;
}
function createScheduler(deps) {
  const now = deps.now ?? (() => Date.now());
  const rawSetTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === "function") t.unref();
    return { clear: () => clearTimeout(t) };
  });
  const setTimer = (fn, ms) => setLongTimer(rawSetTimer, now, fn, ms);
  const armDeps = { now, setTimer };
  const warn = deps.warn ?? ((m) => console.warn(m));
  const log = deps.log ?? (() => {
  });
  const armed = /* @__PURE__ */ new Map();
  function disposeKey(key) {
    const entry = armed.get(key);
    if (entry) {
      try {
        entry.disposable.dispose();
      } catch {
      }
      armed.delete(key);
    }
  }
  function armOne(automation) {
    if (!automation.valid || !automation.config) return;
    if (automation.config.disabled) {
      log(`[scheduler] skipping disabled ${automationKey(automation)}`);
      return;
    }
    const kind = automation.config.on.kind;
    const type = deps.registry.get(kind);
    if (!type) {
      warn(`[scheduler] no trigger type for kind="${kind}" (${automationKey(automation)})`);
      return;
    }
    let cfg;
    try {
      cfg = type.parse(automation.config.on);
    } catch (e) {
      warn(`[scheduler] parse failed for ${automationKey(automation)}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const disposable = type.arm(
      cfg,
      (ctx) => {
        try {
          deps.onFire(automation, ctx);
        } catch (e) {
          warn(`[scheduler] onFire threw for ${automationKey(automation)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      armDeps
    );
    const key = automationKey(automation);
    disposeKey(key);
    armed.set(key, { disposable });
    log(`[scheduler] armed ${automationKey(automation)} (kind=${kind})`);
  }
  return {
    armAll(automations) {
      for (const key of [...armed.keys()]) disposeKey(key);
      for (const a of automations) armOne(a);
    },
    rearmOne(key, automation) {
      disposeKey(key);
      if (automation) armOne(automation);
    },
    armedKeys() {
      return [...armed.keys()];
    },
    disposeAll() {
      for (const key of [...armed.keys()]) disposeKey(key);
    }
  };
}
export {
  MAX_DELAY,
  automationKey,
  createScheduler,
  setLongTimer
};
