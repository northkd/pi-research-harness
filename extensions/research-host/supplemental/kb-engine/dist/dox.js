import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchRow } from "./dox-row.js";
import { loadGitignoreMatcher } from "./gitignore.js";
import { readStaleness } from "./staleness.js";
const DEFAULT_EXCLUDE = /(^|\/)(node_modules|\.git|\.github|dist|build|out|\.next|coverage|\.kb|\.worktrees|\.reverse-spec-scratch|openspec\/(?:changes|specs|groups)|doc-example|bundled-extensions|mockups|research|site|Prompt stories)(\/|$)|(^|\/)\.pi\/(dashboard|npm|git|flows)(\/|$)|(^|\/)electron\/resources\/server(\/|$)|(^|\/)(CHANGELOG|CLAUDE)\.md$|^README\.md$/;
const AGENTS_OVERRIDE_FILE = "AGENTS.override.md";
const AGENTS_FILES = [AGENTS_OVERRIDE_FILE, "AGENTS.md"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/;
const MD_EXT = /\.(md|mdx)$/i;
function isSourceFile(name) {
  return SOURCE_EXT.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}
function isMdFile(name) {
  return MD_EXT.test(name) && !AGENTS_FILES.includes(name) && !name.endsWith(".AGENTS.md") && !name.endsWith(".agent.md");
}
const AREA_FILE_THRESHOLD = 8;
const ROW_CAP = 40;
const AGENTS_BYTE_CAP = 3e4;
const COMPANION_LOC = 300;
const COMPANION_BYTES = 15e3;
function agentsChain(cwd, targetPath, opts = {}) {
  const names = opts.claudeMd ? [...AGENTS_FILES, "CLAUDE.md"] : AGENTS_FILES;
  const target = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  const withinCwd = (p) => p === cwd || p.startsWith(cwd + sep);
  const dirs = [];
  const d = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  for (let cur = d; withinCwd(cur); cur = dirname(cur)) {
    dirs.push(cur);
    if (cur === cwd) break;
  }
  if (!dirs.includes(cwd)) dirs.push(cwd);
  const ordered = dirs.reverse();
  const chain = [];
  ordered.forEach((dir, depth) => {
    const override = join(dir, AGENTS_OVERRIDE_FILE);
    if (existsSync(override)) {
      chain.push({ path: override, rel: relative(cwd, override) || AGENTS_OVERRIDE_FILE, depth });
      return;
    }
    for (const name of names) {
      if (name === AGENTS_OVERRIDE_FILE) continue;
      const p = join(dir, name);
      if (existsSync(p)) chain.push({ path: p, rel: relative(cwd, p) || name, depth });
    }
  });
  let manifest = null;
  if (chain.length === 0 && opts.fallbackManifest) {
    manifest = fallbackManifest(cwd, target);
  }
  return { chain, manifest };
}
function fallbackManifest(cwd, targetPath, store) {
  const target = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  const walkRoot = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
  const files = walkMd(walkRoot);
  const lines = [`# KB routing manifest for ${relative(cwd, target) || target}`, "", "No AGENTS.md on this path. Generated map of nearby markdown:", ""];
  for (const f of files.slice(0, 50)) {
    const rel = relative(cwd, f) || basename(f);
    lines.push(`- \`${rel}\``);
  }
  if (store) {
    lines.push("", "## Top sections in this subtree");
    const hits = store.search(relative(cwd, target) || basename(target), { limit: 10 });
    for (const h of hits) lines.push(`- \`${h.path}\` :: ${h.headingPath}`);
  }
  return lines.join("\n");
}
const FILE_TABLE_HEADER = /^\|\s*File\s*\|\s*Purpose\s*\|\s*$/;
const TABLE_DELIMITER = /^\|(?:\s*:?-+:?\s*\|)+$/;
const ROW_PATH = /^\|\s*`([^`]+)`\s*\|/;
function scanDoxRows(text) {
  const rows = [];
  const emptyFileTables = [];
  const lines = text.split("\n");
  let open = false;
  let seenDelimiter = false;
  let rowsInTable = 0;
  let headerLine = -1;
  const closeTable = () => {
    if (open && rowsInTable === 0) emptyFileTables.push({ line: headerLine });
    open = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FILE_TABLE_HEADER.test(line)) {
      closeTable();
      open = true;
      seenDelimiter = false;
      rowsInTable = 0;
      headerLine = i;
      continue;
    }
    if (!open) continue;
    if (!line.startsWith("|") || !line.slice(1).includes("|")) {
      closeTable();
      continue;
    }
    if (TABLE_DELIMITER.test(line)) {
      if (seenDelimiter) closeTable();
      else seenDelimiter = true;
      continue;
    }
    const m = line.match(ROW_PATH);
    if (m) {
      rows.push({ path: m[1], line, lineIndex: i });
      rowsInTable++;
    }
  }
  closeTable();
  return { rows, emptyFileTables };
}
const FILE_TABLE_TEMPLATE = "| File | Purpose |\n|---|---|\n";
function insertRows(text, newRows) {
  const scan = scanDoxRows(text);
  const lines = text.split("\n");
  if (scan.rows.length > 0) {
    const at = scan.rows[scan.rows.length - 1].lineIndex + 1;
    lines.splice(at, 0, ...newRows);
    return lines.join("\n");
  }
  if (scan.emptyFileTables.length > 0) {
    const h = scan.emptyFileTables[scan.emptyFileTables.length - 1].line;
    const at = h + 1 < lines.length && TABLE_DELIMITER.test(lines[h + 1]) ? h + 2 : h + 1;
    lines.splice(at, 0, ...newRows);
    return lines.join("\n");
  }
  const prefix = text === "" ? "" : text.endsWith("\n") ? text : `${text}
`;
  return `${prefix}
${FILE_TABLE_TEMPLATE}${newRows.join("\n")}
`;
}
function appendRowsToAgentsFile(agentsFile, rows) {
  if (rows.length === 0) return;
  let text = "";
  try {
    text = readFileSync(agentsFile, "utf8");
  } catch {
  }
  writeFileSync(agentsFile, insertRows(text, rows), "utf8");
}
function walkFiles(dir, match, out = [], root = dir, ignore) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (DEFAULT_EXCLUDE.test(relative(root, abs))) continue;
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      const rel = relative(root, abs);
      if (ignore?.isIgnoredDir(rel)) continue;
      walkFiles(abs, match, out, root, ignore);
    } else if (match(e.name) && !ignore?.isIgnored(relative(root, abs))) out.push(abs);
  }
  return out;
}
function walkMd(dir, out = [], ignore) {
  return walkFiles(dir, isMdFile, out, dir, ignore);
}
function walkSource(dir, out = [], ignore) {
  return walkFiles(dir, isSourceFile, out, dir, ignore);
}
function resolveRowPath(agentsDir, cwd, rp) {
  if (isAbsolute(rp)) return rp;
  const dirRel = resolve(agentsDir, rp);
  if (existsSync(dirRel)) return dirRel;
  const rootRel = resolve(cwd, rp);
  return existsSync(rootRel) ? rootRel : dirRel;
}
const SIDECAR_POINTER = /→ see `[^`]+\.AGENTS\.md`/;
function countInlineRows(agentsFile) {
  if (!existsSync(agentsFile)) return 0;
  return scanDoxRows(readFileSync(agentsFile, "utf8")).rows.filter((r) => !SIDECAR_POINTER.test(r.line)).length;
}
function parseRowPaths(agentsFile) {
  if (!existsSync(agentsFile)) return [];
  return scanDoxRows(readFileSync(agentsFile, "utf8")).rows.map((r) => r.path);
}
function listEmptyPurposeRows(opts) {
  const cwd = opts.cwd;
  const dir = typeof opts.dir === "string" && opts.dir.length > 0 ? opts.dir : void 0;
  const start = dir ? resolve(cwd, dir) : cwd;
  if (start !== cwd && !start.startsWith(cwd + sep)) return { groups: [], total: 0 };
  if (basename(start) === "__tests__" || DEFAULT_EXCLUDE.test(relative(cwd, start))) return { groups: [], total: 0 };
  const gi = loadGitignoreMatcher(cwd, { cwd, prune: (rel) => DEFAULT_EXCLUDE.test(rel) });
  const agentsFiles = [];
  const walk = (dir2) => {
    if (!existsSync(dir2)) return;
    for (const e of readdirSync(dir2, { withFileTypes: true })) {
      const abs = join(dir2, e.name);
      if (DEFAULT_EXCLUDE.test(relative(cwd, abs))) continue;
      if (e.isDirectory()) {
        if (e.name === "__tests__") continue;
        const rel = relative(cwd, abs);
        if (gi.isIgnoredDir(rel)) continue;
        walk(abs);
      } else if (e.name === "AGENTS.md" && !gi.isIgnored(relative(cwd, abs))) {
        agentsFiles.push(abs);
      }
    }
  };
  walk(start);
  const groups = [];
  let total = 0;
  for (const af of agentsFiles.sort()) {
    const subjects = [];
    for (const row of scanDoxRows(readFileSync(af, "utf8")).rows) {
      const m = matchRow(row.line);
      if (m && m.purpose === "") subjects.push(row.path);
    }
    if (subjects.length > 0) {
      groups.push({ agentsPath: relative(cwd, af), subjects });
      total += subjects.length;
    }
  }
  return { groups, total };
}
function sourceFiles(cwd, ignore) {
  return walkSource(cwd, [], ignore);
}
function areaFiles(cwd, ignore) {
  const groups = /* @__PURE__ */ new Map();
  for (const f of walkSource(cwd, [], ignore)) {
    const rel = relative(cwd, f);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    (groups.get(dir) ?? groups.set(dir, []).get(dir)).push(rel);
  }
  return groups;
}
function doxInit(opts) {
  const cwd = opts.cwd;
  const gi = loadGitignoreMatcher(cwd, { cwd, prune: (rel) => DEFAULT_EXCLUDE.test(rel) });
  const plan = { created: [], appended: [] };
  const groups = areaFiles(cwd, gi);
  const ensure = (agentsFile, rows) => {
    if (existsSync(agentsFile)) {
      const existing = new Set(parseRowPaths(agentsFile));
      const missRows = rows.filter((row) => {
        const m = row.match(/`([^`]+)`/);
        return m && !existing.has(m[1]);
      });
      if (missRows.length) plan.appended.push({ file: agentsFile, rows: missRows });
      if (!opts.dryRun && missRows.length) appendRowsToAgentsFile(agentsFile, missRows);
    } else {
      plan.created.push(agentsFile);
      if (!opts.dryRun) {
        mkdirSync(dirname(agentsFile), { recursive: true });
        writeFileSync(agentsFile, `# DOX \u2014 ${relative(cwd, dirname(agentsFile)) || "root"}

Files in this area. Purposes left for the agent to author.

${FILE_TABLE_TEMPLATE}${rows.join("\n")}
`, "utf8");
      }
    }
  };
  for (const [dir, rels] of groups) {
    const areaDir = dir === "." ? cwd : join(cwd, dir);
    const rows = rels.filter((r) => !AGENTS_FILES.includes(basename(r))).map((r) => `| \`${basename(r)}\` |  |`);
    if (rows.length) ensure(join(areaDir, "AGENTS.md"), rows);
  }
  return plan;
}
function extractRefPaths(cell, topLevel) {
  const out = [];
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const raw = m[1].trim();
    if (!raw.includes("/")) continue;
    if (/^[~/@]/.test(raw)) continue;
    if (/[:?="'()[\]{}<>|,;!#\s]/.test(raw)) continue;
    if (/[^\x20-\x7e]/.test(raw)) continue;
    const p = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!p.includes("/")) continue;
    if (!topLevel.has(p.split("/")[0])) continue;
    if (!/\.[a-z0-9]{1,5}$/i.test(p) && !p.includes("*")) continue;
    if (DEFAULT_EXCLUDE.test(p)) continue;
    out.push(p);
  }
  return out;
}
function globHit(pattern, cwd) {
  const rx = new RegExp(
    `^${pattern.split("/").map(
      (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*")
    ).join("/")}$`
  );
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (DEFAULT_EXCLUDE.test(r)) continue;
      if (rx.test(r)) return true;
      if (e.isDirectory() && walk(join(dir, e.name), r)) return true;
    }
    return false;
  };
  return walk(cwd, "");
}
function fileSha(p) {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return "";
  }
}
function loc(p) {
  try {
    return readFileSync(p, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}
function doxLint(opts) {
  const cwd = opts.cwd;
  const issues = [];
  let fixed = 0;
  let filesScanned = 0;
  let rowsScanned = 0;
  const gi = loadGitignoreMatcher(cwd, { cwd, prune: (rel) => DEFAULT_EXCLUDE.test(rel) });
  const topLevelEntries = /* @__PURE__ */ new Set();
  try {
    for (const e of readdirSync(cwd, { withFileTypes: true })) topLevelEntries.add(e.name);
  } catch {
  }
  const seenRefs = /* @__PURE__ */ new Set();
  const agentsFiles = [];
  const walkAgents = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (DEFAULT_EXCLUDE.test(relative(cwd, abs))) continue;
      if (e.isDirectory()) {
        const rel = relative(cwd, abs);
        if (gi.isIgnoredDir(rel)) continue;
        walkAgents(abs);
      } else if (e.name === "AGENTS.md" && !gi.isIgnored(relative(cwd, abs))) agentsFiles.push(abs);
    }
  };
  walkAgents(cwd);
  const sf = opts.stalenessFile ?? join(cwd, ".pi", "dashboard", "kb", "dox-staleness.json");
  const staleness = readStaleness(sf);
  const allMd = new Set(walkMd(cwd, [], gi).map((f) => relative(cwd, f)));
  const rowPaths = /* @__PURE__ */ new Set();
  for (const af of agentsFiles) {
    const afRel = relative(cwd, af);
    const afBytes = statSync(af).size;
    if (afBytes > AGENTS_BYTE_CAP) issues.push({ kind: "over-threshold", agentsFile: afRel, arm: "bytes", detail: `${afBytes} bytes > cap ${AGENTS_BYTE_CAP}; auto-injected per turn \u2014 actionable: promote heaviest rows to <File>.AGENTS.md sidecars` });
    const inlineCount = countInlineRows(af);
    if (inlineCount > ROW_CAP) issues.push({ kind: "over-threshold", agentsFile: afRel, arm: "rows", detail: `${inlineCount} inline rows > cap ${ROW_CAP}; informational (advisory; no per-turn injection cost) \u2014 optional: folder into cohesive subdirectories` });
    filesScanned++;
    const text = readFileSync(af, "utf8");
    const scan = scanDoxRows(text);
    rowsScanned += scan.rows.length;
    for (const t of scan.emptyFileTables) {
      issues.push({ kind: "zero-row-table", agentsFile: afRel, detail: `file-row table header at line ${t.line + 1} has zero recognized rows` });
    }
    const pruneIdx = /* @__PURE__ */ new Set();
    const afDir = dirname(af);
    for (const row of scan.rows) {
      const rp = row.path;
      const line = row.line;
      const purposeCell = line.slice(line.indexOf("|", line.indexOf("`" + rp + "`")) + 1);
      for (const ref of extractRefPaths(purposeCell, topLevelEntries)) {
        if (seenRefs.has(ref)) continue;
        seenRefs.add(ref);
        const hit = ref.includes("*") ? globHit(ref, cwd) : existsSync(join(cwd, ref)) || existsSync(join(afDir, ref));
        if (!hit) issues.push({ kind: "broken-ref", agentsFile: afRel, path: ref, detail: `broken-ref: row prose cites ${ref}, which does not exist` });
      }
      if (rp.includes("*")) {
        if (!globHit(rp, afDir)) issues.push({ kind: "orphan", agentsFile: afRel, path: rp, detail: `orphan: no file matches ${rp}` });
        continue;
      }
      const abs = resolveRowPath(afDir, cwd, rp);
      const rel = relative(cwd, abs);
      rowPaths.add(rel);
      if (!existsSync(abs)) {
        const kind = rp.endsWith("AGENTS.md") ? "broken-pointer" : "orphan";
        issues.push({ kind, agentsFile: afRel, path: rp, detail: `${kind}: ${rp} does not exist` });
        if (opts.fix && kind === "orphan") {
          fixed++;
          pruneIdx.add(row.lineIndex);
        }
      } else if (staleness[rel]?.sha256) {
        const diskSha = fileSha(abs);
        if (diskSha && staleness[rel].sha256 !== diskSha) {
          issues.push({ kind: "stale", agentsFile: afRel, path: rp, detail: `tracked source-hash drifted` });
        }
      }
    }
    if (opts.fix && pruneIdx.size > 0) {
      const out = text.split("\n").filter((_, idx) => !pruneIdx.has(idx));
      writeFileSync(af, out.join("\n"), "utf8");
    }
  }
  const ownerOf = (mdDir) => {
    let best = null;
    let bestDepth = -1;
    for (const af of agentsFiles) {
      const aDir = relative(cwd, dirname(af)) || ".";
      const prefix = aDir === "." ? "" : aDir + "/";
      if (mdDir === aDir || mdDir.startsWith(prefix)) {
        const depth = aDir.split("/").filter(Boolean).length;
        if (depth > bestDepth) {
          best = af;
          bestDepth = depth;
        }
      }
    }
    return best;
  };
  for (const md of allMd) {
    if (rowPaths.has(md)) continue;
    const dir = md.includes("/") ? md.slice(0, md.lastIndexOf("/")) : ".";
    const owner = ownerOf(dir);
    if (owner) {
      const ownerRel = relative(cwd, owner) || "AGENTS.md";
      issues.push({ kind: "missing", agentsFile: ownerRel, path: md, detail: `no row for ${md}` });
      if (opts.fix) {
        appendRowsToAgentsFile(owner, [`| \`${md}\` |  |`]);
        fixed++;
      }
    }
  }
  if (opts.sourceFileRows) {
    for (const abs of sourceFiles(cwd, gi)) {
      const rel = relative(cwd, abs);
      if (rowPaths.has(rel)) continue;
      if (existsSync(join(cwd, `${rel}.AGENTS.md`))) continue;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
      const owner = ownerOf(dir);
      if (!owner) continue;
      issues.push({ kind: "missing", arm: "source", agentsFile: relative(cwd, owner) || "AGENTS.md", path: rel, detail: `no row for source file ${rel}` });
    }
  }
  for (const md of allMd) {
    const abs = join(cwd, md);
    if (loc(abs) > COMPANION_LOC || statSync(abs).size > COMPANION_BYTES) {
      const comp = md.replace(/\.mdx?$/i, ".agent.md");
      if (!existsSync(join(cwd, comp))) issues.push({ kind: "missing-companion", agentsFile: comp, path: md, detail: `${md} past threshold, no ${comp}` });
    }
  }
  return { issues, fixed, filesScanned, rowsScanned };
}
export {
  AGENTS_BYTE_CAP,
  agentsChain,
  areaFiles,
  countInlineRows,
  doxInit,
  doxLint,
  extractRefPaths,
  fallbackManifest,
  listEmptyPurposeRows,
  parseRowPaths,
  resolveRowPath,
  scanDoxRows,
  sourceFiles
};
