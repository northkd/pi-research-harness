import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { areaFiles } from "./dox.js";
import { matchRowLoose } from "./dox-row.js";
import { finalRows, mergeIndex, planDirs, renderAgentsMd, validateAuthored } from "./migrate-file-index.js";
const PACKAGES_ROOT_RE = /^packages\//;
function loadSplitTexts(cwd) {
  const docs = join(cwd, "docs");
  return readdirSync(docs).filter((f) => /^file-index-.*\.md$/.test(f)).map((f) => readFileSync(join(docs, f), "utf8"));
}
function buildDirPlans(cwd) {
  const index = mergeIndex(loadSplitTexts(cwd));
  const groups = new Map([...areaFiles(cwd)].filter(([dir]) => PACKAGES_ROOT_RE.test(dir)));
  return planDirs(groups, index);
}
const STOP = /* @__PURE__ */ new Set(["React", "DOM", "JSON", "HTML", "URL", "API", "HTTP", "CSS", "UI", "TODO"]);
function significantIds(span) {
  const ids = span.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  return ids.filter((id) => id.length >= 3 && !STOP.has(id) && (/[a-z]/.test(id) && /[A-Z]/.test(id) || id.includes("_")));
}
function groundingCheck(purpose, sourceText, known) {
  const spans = [...purpose.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const ungrounded = [];
  for (const span of spans) {
    for (const id of significantIds(span)) {
      if (known?.has(id)) continue;
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`).test(sourceText)) ungrounded.push(id);
    }
  }
  return { ok: ungrounded.length === 0, ungrounded: [...new Set(ungrounded)] };
}
function knownStems(plans) {
  const s = /* @__PURE__ */ new Set();
  for (const p of plans) for (const f of p.files) s.add(f.base.replace(/\.[^.]+$/, ""));
  return s;
}
function makeBatches(plans, opts = {}) {
  const maxMiss = opts.maxMiss ?? 20;
  const maxDirs = opts.maxDirs ?? 8;
  const batches = [];
  let cur = { dirs: [], miss: [] };
  const flush = () => {
    if (cur.miss.length) batches.push(cur);
    cur = { dirs: [], miss: [] };
  };
  for (const plan of plans.filter((p) => p.tier === 1)) {
    const misses = plan.files.filter((f) => f.status === "miss").map((f) => ({ dir: plan.dir, base: f.base, rel: f.rel }));
    if (misses.length > maxMiss) {
      flush();
      for (let i = 0; i < misses.length; i += maxMiss) batches.push({ dirs: [plan.dir], miss: misses.slice(i, i + maxMiss) });
      continue;
    }
    if (cur.miss.length + misses.length > maxMiss || cur.dirs.length + 1 > maxDirs) flush();
    cur.dirs.push(plan.dir);
    cur.miss.push(...misses);
  }
  flush();
  return batches;
}
function subagentPrompt(cwd, batch) {
  const lines = batch.miss.map((m) => `- ${m.rel}`).join("\n");
  return `You author one-line "purpose" table rows for a per-directory AGENTS.md file index. READ-ONLY: you may Read source files; you MUST NOT write or edit anything. Output ONLY the table rows, one per file, nothing else.

Repo root: ${cwd}
Author a row for EACH of these ${batch.miss.length} files (Read each fully first):
${lines}

Row schema (path column = the EXACT repo-relative path from the list above, one line per file):
| \`<repo-relative-path>\` | <purpose> |

CAVEMAN STYLE for the purpose column (mandatory):
- Short declarative fragments. Drop articles (a/an/the) and copulas when meaning survives.
- Subject \u2192 verb \u2192 object, present tense. No hedging, no "we"/"you", no marketing.
- One fact per clause. Prefer concrete tokens (exported symbols, types, function names, paths) over prose.
- Keep identifiers verbatim inside backticks. Name the key exports + the file's role.
- Do NOT invent a "See change:" annotation. Only real source facts.

Output exactly ${batch.miss.length} lines (the rows), each starting with the file's repo-relative path in backticks, nothing before or after.`;
}
function parseAuthoredBatch(text) {
  const out = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    const m = matchRowLoose(line);
    if (!m) continue;
    if (m.purpose) out.set(m.path.trim(), m.purpose);
  }
  return out;
}
function recordAuthored(state, batch, byRel) {
  let recorded = 0;
  const missing = [];
  for (const m of batch.miss) {
    const purpose = byRel.get(m.rel);
    if (!purpose) {
      missing.push(m.rel);
      continue;
    }
    (state.authored[m.dir] ??= {})[m.base] = purpose;
    recorded++;
  }
  return { recorded, missing };
}
function writeDir(cwd, plan, authoredMiss, opts = {}) {
  const authored = plan.files.map(
    (f) => f.status === "hit" ? { base: f.base, purpose: f.purpose } : { base: f.base, purpose: authoredMiss.get(f.base) ?? "" }
  );
  const v = validateAuthored(plan, authored);
  const ungrounded = [];
  for (const f of plan.files) {
    if (f.status !== "miss") continue;
    const purpose = authoredMiss.get(f.base) ?? "";
    const src = readFileSync(join(cwd, f.rel), "utf8");
    const g = groundingCheck(purpose, src, opts.known);
    if (!g.ok) ungrounded.push({ base: f.base, ids: g.ungrounded });
  }
  if (!v.ok) return { ok: false, errors: v.errors, ungrounded };
  if (!opts.dryRun) {
    const md = renderAgentsMd(plan.dir, finalRows(plan, authored));
    const file = join(cwd, plan.dir, "AGENTS.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, md, "utf8");
  }
  return { ok: v.ok, errors: v.errors, ungrounded };
}
const stateDir = (cwd) => join(cwd, ".pi", "dashboard", "kb");
function loadState(cwd) {
  const f = join(stateDir(cwd), "migration-state.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  return { authored: {}, doneDirs: [], gaps: {} };
}
function saveState(cwd, s) {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration-state.json"), JSON.stringify(s, null, 2), "utf8");
}
export {
  PACKAGES_ROOT_RE,
  buildDirPlans,
  groundingCheck,
  knownStems,
  loadSplitTexts,
  loadState,
  makeBatches,
  parseAuthoredBatch,
  recordAuthored,
  saveState,
  subagentPrompt,
  writeDir
};
