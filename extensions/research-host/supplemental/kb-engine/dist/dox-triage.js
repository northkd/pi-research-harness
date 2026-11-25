import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { resolveRowPath } from "./dox.js";
import { matchRow } from "./dox-row.js";
import { readStaleness, STALENESS_VERSION, stalenessVersionOnDisk } from "./staleness.js";
const DEFAULT_DEPTH = 60;
const DIFF_CAP = 6e3;
function parseRows(md) {
  const rows = [];
  md.split("\n").forEach((line, i) => {
    const m = matchRow(line);
    if (!m) return;
    if (/^-+$/.test(m.path)) return;
    rows.push({ line: i, path: m.path, purpose: m.purpose });
  });
  return rows;
}
function replaceRowPurpose(md, rowPath, newPurpose) {
  let hit = false;
  const out = md.split("\n").map((line) => {
    if (hit) return line;
    const m = matchRow(line);
    if (!m || m.path !== rowPath) return line;
    hit = true;
    return `| \`${m.path}\` | ${newPurpose} |`;
  });
  return hit ? out.join("\n") : md;
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function resolveBaseline(opts) {
  const { cwd, file, ackedSha, depth = DEFAULT_DEPTH } = opts;
  let commits = [];
  try {
    commits = git(cwd, ["rev-list", `-n${depth}`, "HEAD", "--", file]).trim().split("\n").filter(Boolean);
  } catch {
    return { found: false, commit: null, diff: "", reason: "no-history" };
  }
  if (!commits.length) return { found: false, commit: null, diff: "", reason: "untracked" };
  for (const c of commits) {
    let blob;
    try {
      blob = execFileSync("git", ["show", `${c}:${file}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    if (sha256(blob) !== ackedSha) continue;
    let diff = "";
    try {
      diff = git(cwd, ["diff", c, "--", file]);
    } catch {
      diff = "";
    }
    return {
      found: true,
      commit: c,
      diff: diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}
\u2026[diff truncated]` : diff,
      reason: null
    };
  }
  return { found: false, commit: null, diff: "", reason: `no-match-in-last-${depth}` };
}
function buildWorkItems(opts) {
  const { cwd, issues, staleness, depth = DEFAULT_DEPTH, limit = Number.POSITIVE_INFINITY } = opts;
  const items = [];
  for (const iss of issues) {
    if (iss.kind !== "stale" || !iss.path) continue;
    if (items.length >= limit) break;
    const agentsAbs = join(cwd, iss.agentsFile);
    if (!existsSync(agentsAbs)) continue;
    const abs = resolveRowPath(dirname(agentsAbs), cwd, iss.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const target = relative(cwd, abs);
    const row = parseRows(readFileSync(agentsAbs, "utf8")).find((r) => r.path === iss.path);
    if (!row) continue;
    const acked = staleness[target] ?? staleness[iss.path];
    const base = acked?.sha256 ? resolveBaseline({ cwd, file: target, ackedSha: acked.sha256, depth }) : { found: false, commit: null, diff: "", reason: "not-acked" };
    items.push({
      agentsFile: iss.agentsFile,
      row: iss.path,
      target,
      purpose: row.purpose,
      baseline: base.commit,
      baselineFound: base.found,
      reason: base.reason,
      diff: base.diff
    });
  }
  return items;
}
function applyDecisions(opts) {
  const { cwd, decisions, write = false } = opts;
  const res = { rewritten: 0, kept: 0, skipped: [] };
  for (const d of decisions) {
    if (d.verdict !== "REWRITE" || !d.purpose) {
      res.kept++;
      continue;
    }
    const p = join(cwd, d.agentsFile);
    if (!existsSync(p)) {
      res.skipped.push(`${d.agentsFile} (missing)`);
      continue;
    }
    const before = readFileSync(p, "utf8");
    const after = replaceRowPurpose(before, d.row, d.purpose);
    if (after === before) {
      res.skipped.push(`${d.agentsFile} :: ${d.row} (row not found)`);
      continue;
    }
    if (write) writeFileSync(p, after, "utf8");
    res.rewritten++;
  }
  return res;
}
function ackTargets(opts) {
  const { cwd, targets, stalenessFile } = opts;
  const onDisk = stalenessVersionOnDisk(stalenessFile);
  if (onDisk != null && onDisk > STALENESS_VERSION) {
    throw new Error(`dox-staleness.json is version ${onDisk} (> supported ${STALENESS_VERSION}); refusing to overwrite \u2014 upgrade the kb package first`);
  }
  const map = readStaleness(stalenessFile);
  let n = 0;
  for (const t of targets) {
    const p = join(cwd, t);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const st = statSync(p);
    map[t] = { sha256: sha256(readFileSync(p)), size: st.size, mtimeMs: st.mtimeMs };
    n++;
  }
  const file = { version: STALENESS_VERSION, files: map };
  writeFileSync(stalenessFile, `${JSON.stringify(file, null, 2)}
`, "utf8");
  return n;
}
export {
  DEFAULT_DEPTH,
  DIFF_CAP,
  ackTargets,
  applyDecisions,
  buildWorkItems,
  parseRows,
  replaceRowPurpose,
  resolveBaseline
};
