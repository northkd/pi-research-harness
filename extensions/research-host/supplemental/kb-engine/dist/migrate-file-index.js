import { basename } from "node:path";
import { matchRow } from "./dox-row.js";
const SEE_CHANGE_RE = /See change:\s*([A-Za-z0-9_-]+)/g;
function parseFileIndex(text) {
  const out = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    const m = matchRow(line);
    if (!m) continue;
    const path = m.path.trim();
    const purpose = m.purpose;
    if (!purpose || path === "File") continue;
    const seeChange = [...purpose.matchAll(SEE_CHANGE_RE)].map((mm) => mm[1]);
    out.set(path, { purpose, seeChange });
  }
  return out;
}
function mergeIndex(texts) {
  const merged = /* @__PURE__ */ new Map();
  for (const t of texts) for (const [k, v] of parseFileIndex(t)) merged.set(k, v);
  return merged;
}
function planDirs(groups, index) {
  const plans = [];
  for (const [dir, rels] of groups) {
    const files = rels.map((rel) => {
      const row = index.get(rel);
      return row ? { rel, base: basename(rel), status: "hit", purpose: row.purpose } : { rel, base: basename(rel), status: "miss" };
    });
    files.sort((a, b) => a.base.localeCompare(b.base));
    const tier = files.every((f) => f.status === "hit") ? 0 : 1;
    plans.push({ dir, tier, files });
  }
  plans.sort((a, b) => a.dir.localeCompare(b.dir));
  return plans;
}
const rowFor = (base, purpose) => `| \`${base}\` | ${purpose} |`;
const byBaseAlpha = (files) => [...files].sort((a, b) => a.base.localeCompare(b.base));
function tier0Rows(plan) {
  return byBaseAlpha(plan.files).map((f) => rowFor(f.base, f.purpose ?? ""));
}
function renderAgentsMd(dir, rows) {
  return `# DOX \u2014 ${dir}

Files in this directory. One row per source file.

| File | Purpose |
|------|---------|
${rows.join("\n")}
`;
}
function validateAuthored(plan, authored) {
  const errors = [];
  const byBase = /* @__PURE__ */ new Map();
  for (const a of authored) {
    if (byBase.has(a.base)) errors.push(`duplicate row for ${a.base}`);
    byBase.set(a.base, a.purpose);
  }
  for (const f of plan.files) {
    const p = byBase.get(f.base);
    if (p === void 0) {
      errors.push(`missing row for ${f.base}`);
      continue;
    }
    if (!p.trim()) errors.push(`empty purpose for ${f.base}`);
    if (f.status === "hit" && p !== f.purpose) errors.push(`hit purpose drifted for ${f.base}`);
  }
  for (const base of byBase.keys()) {
    if (!plan.files.some((f) => f.base === base)) errors.push(`unexpected row for ${base}`);
  }
  return { ok: errors.length === 0, errors };
}
function finalRows(plan, authored) {
  const byBase = new Map(authored.map((a) => [a.base, a.purpose]));
  return byBaseAlpha(plan.files).map((f) => rowFor(f.base, byBase.get(f.base) ?? f.purpose ?? ""));
}
export {
  finalRows,
  mergeIndex,
  parseFileIndex,
  planDirs,
  renderAgentsMd,
  tier0Rows,
  validateAuthored
};
