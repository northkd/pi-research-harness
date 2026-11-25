const HEAD = /^\|\s*`([^`]+)`\s*\|/;
const TERMINATOR = /[\n\r\u2028\u2029]/;
function matchRow(line) {
  const m = HEAD.exec(line);
  if (!m) return null;
  const t = line.slice(m[0].length).trim();
  if (!t.endsWith("|")) return null;
  const purpose = t.slice(0, -1).trim();
  if (TERMINATOR.test(purpose)) return null;
  return { path: m[1], purpose };
}
function matchRowLoose(line) {
  const m = HEAD.exec(line);
  if (!m) return null;
  let t = line.slice(m[0].length).trim();
  if (TERMINATOR.test(t)) return null;
  if (t.endsWith("|")) t = t.slice(0, -1).trim();
  return { path: m[1], purpose: t };
}
export {
  matchRow,
  matchRowLoose
};
