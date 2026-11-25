const MAX_LINKS = 50;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sharedNumberSpace = (forge) => forge === "github" || forge === "gitea";
function extractRefs(text, ctx) {
  const out = /* @__PURE__ */ new Set();
  const add = (id) => out.size < MAX_LINKS && out.add(id);
  if (ctx.identity) {
    const re = new RegExp(`https?://${escapeRe(ctx.identity)}/(?:-/)?(pull|pulls|issues|merge_requests)/(\\d+)`, "gi");
    for (const m of text.matchAll(re)) add(`${/^issues$/i.test(m[1]) ? "issue" : "pr"}/${m[2]}`);
  }
  for (const m of text.matchAll(/(?<![\w/&#])#(\d+)\b/g)) add(`issue/${m[1]}`);
  if (ctx.forge === "gitlab") for (const m of text.matchAll(/(?<![\w/&!])!(\d+)\b/g)) add(`pr/${m[1]}`);
  for (const m of text.matchAll(/See change:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) add(`change:${m[1]}`);
  return [...out];
}
const nodeHasItem = (db, name) => {
  const r = db.prepare("SELECT path FROM nodes WHERE type='file' AND name=?").get(name);
  return !!r && r.path !== null;
};
function buildEdges(db, srcPath, text, ctx) {
  const edges = [];
  for (const id of extractRefs(text, ctx)) {
    let dst = id;
    if (sharedNumberSpace(ctx.forge) && id.startsWith("issue/") && !nodeHasItem(db, id) && nodeHasItem(db, `pr/${id.slice(6)}`)) dst = `pr/${id.slice(6)}`;
    if (dst !== srcPath) edges.push({ src: srcPath, dst, rel: "references" });
  }
  return edges;
}
function repointIssuePlaceholder(db, n) {
  const ph = db.prepare("SELECT id FROM nodes WHERE type='file' AND name=? AND path IS NULL").get(`issue/${n}`);
  if (!ph) return;
  db.prepare("INSERT OR IGNORE INTO nodes(type,name,path) VALUES('file',?,NULL)").run(`pr/${n}`);
  const pr = db.prepare("SELECT id FROM nodes WHERE type='file' AND name=?").get(`pr/${n}`);
  db.prepare("UPDATE OR IGNORE edges SET dst=? WHERE dst=?").run(pr.id, ph.id);
  db.prepare("DELETE FROM edges WHERE dst=?").run(ph.id);
  db.prepare("DELETE FROM nodes WHERE id=?").run(ph.id);
}
function linkedItems(db, path, max = 20) {
  const rows = db.prepare(
    `SELECT n.name AS name, n.path AS path FROM edges e JOIN nodes n ON n.id = e.dst JOIN nodes s ON s.id = e.src WHERE s.type='file' AND s.name=?
       UNION SELECT s.name AS name, s.path AS path FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes n ON n.id = e.dst WHERE n.type='file' AND n.name=?
       ORDER BY name LIMIT ?`
  ).all(path, path, max);
  return rows.map((r) => ({ id: r.name, indexed: r.path !== null }));
}
export {
  buildEdges,
  extractRefs,
  linkedItems,
  repointIssuePlaceholder,
  sharedNumberSpace
};
