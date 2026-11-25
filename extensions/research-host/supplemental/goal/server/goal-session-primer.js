function oneLine(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function buildGoalPrimerCommands(goal) {
  const objective = oneLine(goal.objective);
  if (!objective) return [];
  return [`/goal ${objective}`];
}
function goalSessionTitle(goal) {
  return oneLine(goal.objective).slice(0, 80);
}
const REPRIME_VERDICTS = 8;
function buildGoalReprime(goal) {
  const objective = oneLine(goal.objective);
  if (!objective) return "";
  const lines = [];
  lines.push(`Resuming goal after a fresh restart. Objective: ${objective}`);
  const criteria = (goal.criteria ?? []).map((c) => oneLine(c.text)).filter(Boolean);
  if (criteria.length > 0) {
    lines.push("Success criteria:");
    for (const c of criteria) lines.push(`- ${c}`);
  }
  const verdicts = (goal.verdicts ?? []).slice(-REPRIME_VERDICTS);
  if (verdicts.length > 0) {
    lines.push("Recent judge verdicts (oldest first):");
    for (const v of verdicts) {
      const note = oneLine(v.note);
      lines.push(`- turn ${v.turn}: ${v.verdict}${note ? ` \u2014 ${note}` : ""}`);
    }
  }
  if (typeof goal.totalTurnsUsed === "number" && goal.totalTurnsUsed > 0) {
    lines.push(`Turns used so far: ${goal.totalTurnsUsed}.`);
  }
  return lines.join("\n");
}
function primeGoalSession(deps, sessionId, goal) {
  const commands = buildGoalPrimerCommands(goal);
  if (commands.length === 0) return;
  const title = goalSessionTitle(goal);
  if (title) deps.renameSession(sessionId, title);
  for (const cmd of commands) deps.sendPrompt(sessionId, cmd);
}
export {
  buildGoalPrimerCommands,
  buildGoalReprime,
  goalSessionTitle,
  primeGoalSession
};
