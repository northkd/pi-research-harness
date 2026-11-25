import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
function patternMatches(rawPattern, relPath, opts = {}) {
  const pat = compile(rawPattern);
  if (!pat) return false;
  if (ancestorsOf(relPath).some((a) => matches(pat, a, true))) return true;
  return matches(pat, relPath, opts.dir === true);
}
function compile(raw) {
  const p0 = raw.replace(/\s+$/, "");
  if (p0 === "" || p0.startsWith("#")) return null;
  let p = p0;
  const negated = p.startsWith("!");
  if (negated) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  let anchored;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  } else if (p.startsWith("**/")) {
    p = p.slice(3);
    anchored = false;
  } else {
    anchored = p.includes("/");
  }
  if (p === "" || p === "!") return null;
  for (const seg of p.split("/")) {
    const open = (seg.match(/\[/g) ?? []).length;
    const close = (seg.match(/\]/g) ?? []).length;
    if (open !== close) return null;
  }
  const segs = p.split("/");
  let body;
  if (segs.length === 1 && segs[0] === "**") {
    body = ".+";
  } else {
    body = "";
    for (let i = 0; i < segs.length; i++) {
      const isLast = i === segs.length - 1;
      const seg = segs[i];
      if (seg === "**") {
        body += isLast ? ".+" : "(?:[^/]+/)*";
        continue;
      }
      body += segRe(seg);
      if (!isLast) body += "/";
    }
  }
  const full = anchored ? body : `(?:[^/]+/)*${body}`;
  let re = null;
  try {
    re = new RegExp(`^${full}$`);
  } catch {
    re = null;
  }
  return { negated, dirOnly, anchored, re };
}
function segRe(seg) {
  return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}
function ancestorsOf(rel) {
  const out = [];
  const parts = rel.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    out.push(cur);
  }
  return out;
}
function matches(pat, rel, dirMode) {
  if (!pat.re) return false;
  if (dirMode) return pat.re.test(rel);
  return pat.dirOnly ? false : pat.re.test(rel);
}
function createLoader(walkRoot, opts) {
  const boundary = opts.cwd;
  const sets = [];
  const parseFile = (abs) => {
    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const patterns = [];
    for (const line of text.split("\n")) {
      const pat = compile(line);
      if (pat) patterns.push(pat);
    }
    if (patterns.length) sets.push({ baseAbs: dirname(abs), patterns });
  };
  const up = [];
  for (let d = walkRoot; ; d = dirname(d)) {
    up.push(d);
    if (existsSync(join(d, ".git"))) break;
    if (boundary && d === boundary) break;
    if (boundary && !d.startsWith(boundary + sep)) break;
    const parent = dirname(d);
    if (parent === d) break;
  }
  for (const d of up.reverse()) {
    if (d === walkRoot) continue;
    if (existsSync(join(d, ".gitignore"))) parseFile(join(d, ".gitignore"));
  }
  const step = (dir) => {
    const rel = relative(walkRoot, dir).split(sep).join("/");
    if (rel && opts.prune?.(rel)) return [];
    if (existsSync(join(dir, ".gitignore"))) {
      parseFile(join(dir, ".gitignore"));
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const children = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === ".git") continue;
      const child = join(dir, e.name);
      if (dirIgnored(child)) continue;
      children.push(child);
    }
    return children;
  };
  const dirMemo = /* @__PURE__ */ new Map();
  const covered = (abs) => sets.some((s) => abs === s.baseAbs || abs.startsWith(s.baseAbs + sep));
  const dirIgnored = (abs) => {
    const hit = dirMemo.get(abs);
    if (hit !== void 0) return hit;
    const v = verdictAbs(abs, true);
    dirMemo.set(abs, v);
    return v;
  };
  const verdictAbs = (abs, dirMode) => {
    const parent = dirname(abs);
    if (parent !== abs && covered(parent) && dirIgnored(parent)) return true;
    let verdict = false;
    for (const set of sets) {
      const baseRel = relative(set.baseAbs, abs);
      if (!baseRel || baseRel.startsWith("..")) continue;
      const p = baseRel.split(sep).join("/");
      for (const pat of set.patterns) {
        if (matches(pat, p, dirMode)) verdict = !pat.negated;
      }
    }
    return verdict;
  };
  return {
    step,
    matcher: {
      isIgnored: (rel) => verdictAbs(join(walkRoot, rel), false),
      isIgnoredDir: (rel) => dirIgnored(join(walkRoot, rel))
    }
  };
}
function loadGitignoreMatcher(walkRoot, opts = {}) {
  const { step, matcher } = createLoader(walkRoot, opts);
  const scan = (dir) => {
    for (const child of step(dir)) scan(child);
  };
  scan(walkRoot);
  return matcher;
}
async function loadGitignoreMatcherYielding(walkRoot, opts) {
  const { step, matcher } = createLoader(walkRoot, opts);
  const stack = [walkRoot];
  let visited = 0;
  let last = performance.now();
  while (stack.length) {
    const children = step(stack.pop());
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    if (++visited % opts.yieldEvery === 0 || opts.yieldMaxMs !== void 0 && performance.now() - last >= opts.yieldMaxMs) {
      await opts.yieldFn();
      last = performance.now();
    }
  }
  return matcher;
}
export {
  loadGitignoreMatcher,
  loadGitignoreMatcherYielding,
  patternMatches
};
