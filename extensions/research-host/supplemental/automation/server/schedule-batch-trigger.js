import { isValidCron, nextFire } from "./cron.js";
const scheduleBatchTrigger = {
  kind: "schedule.batch",
  parse(rawOn) {
    const on = rawOn;
    const cron = on?.cron;
    if (typeof cron !== "string" || !isValidCron(cron)) {
      throw new Error(
        `schedule.batch trigger requires a valid 5-field \`cron\` (got: ${JSON.stringify(cron)})`
      );
    }
    const source = on?.source;
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("schedule.batch trigger requires a non-empty `on.source`");
    }
    return { cron, source };
  },
  arm(cfg, fire, deps) {
    let timer = null;
    let disposed = false;
    const schedule = () => {
      if (disposed) return;
      const next = nextFire(cfg.cron, new Date(deps.now()));
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
  scheduleBatchTrigger
};
