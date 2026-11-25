const SESSION_TARGETING_TOOLS = ["send_prompt", "abort"];
function normaliseSessionId(value) {
  let out = value.trim();
  const first = out.at(0);
  const last = out.at(-1);
  if (out.length >= 2 && (first === '"' || first === "'") && last === first) {
    out = out.slice(1, -1).trim();
  }
  return out.toLowerCase();
}
function evaluateSelfTarget(caller, targetSessionId, tool) {
  if (caller.kind !== "session") return { allowed: true };
  if (typeof targetSessionId !== "string") return { allowed: true };
  if (normaliseSessionId(caller.sessionId) !== normaliseSessionId(targetSessionId)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "self-target",
    callerSessionId: caller.sessionId,
    targetSessionId,
    tool
  };
}
export {
  SESSION_TARGETING_TOOLS,
  evaluateSelfTarget
};
