import { nextFire, isValidCron } from "./cron.js";
const scheduleTrigger = {
  kind: "schedule",
  parse(rawOn) {
    const on = rawOn;
    const cron = on?.cron;
    if (typeof cron !== "string" || !isValidCron(cron)) {
      throw new Error(`schedule trigger requires a valid 5-field \`cron\` (got: ${JSON.stringify(cron)})`);
    }
    return { cron };
  },
  arm(cfg, fire, deps) {
    let timer = null;
    let disposed = false;
    const schedule = () => {
      if (disposed) return;
      const now = new Date(deps.now());
      const next = nextFire(cfg.cron, now);
      if (!next) return;
      const delay = Math.max(0, next.getTime() - deps.now());
      timer = deps.setTimer(() => {
        if (disposed) return;
        fire({ firedAt: next.getTime() });
        schedule();
      }, delay);
    };
    schedule();
    return {
      dispose() {
        disposed = true;
        timer?.clear();
        timer = null;
      }
    };
  }
};
export {
  scheduleTrigger
};
