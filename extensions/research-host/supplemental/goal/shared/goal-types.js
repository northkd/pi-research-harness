const GOAL_PLUGIN_ID = "goal";
const GOAL_STATUS_MESSAGE = "goal_status";
const GOAL_HERMES_EVENT_CUSTOM_TYPE = "pi-goal-hermes:event";
const GOAL_STATUS_EVENT_TYPE = "goal_status";
function detailsToSnapshot(d) {
  const status = d.eventType === "goal-achieved" ? "done" : d.eventType === "goal-paused" ? "paused" : d.eventType === "goal-cleared" ? "cleared" : "active";
  return {
    status,
    goal: d.goal,
    turnsUsed: d.turnsUsed,
    maxTurns: null,
    lastVerdict: d.lastVerdict,
    lastReason: d.pausedReason ?? d.lastReason
  };
}
export {
  GOAL_HERMES_EVENT_CUSTOM_TYPE,
  GOAL_PLUGIN_ID,
  GOAL_STATUS_EVENT_TYPE,
  GOAL_STATUS_MESSAGE,
  detailsToSnapshot
};
