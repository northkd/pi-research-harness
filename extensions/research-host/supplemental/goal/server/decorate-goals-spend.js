function sumSpend(sessionIds, sessions) {
  let total = 0;
  for (const sid of sessionIds) {
    try {
      total += sessions.get(sid)?.cost ?? 0;
    } catch {
    }
  }
  return total;
}
function decorateGoalsWithSpend(goals, sessions) {
  return goals.map((g) => ({ ...g, totalSpendUsd: sumSpend(g.sessionIds, sessions) }));
}
export {
  decorateGoalsWithSpend
};
