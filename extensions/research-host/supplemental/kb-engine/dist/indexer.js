import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chunkAsciiDoc } from "./adoc-chunker.js";
import { chunkMarkdown } from "./chunker.js";
import { buildMeta, buildProperties, DEFAULT_FACET_KEYS, DEFAULT_SEARCHABLE_KEYS } from "./frontmatter.js";
import { loadGitignoreMatcherYielding } from "./gitignore.js";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const DEFAULT_EXCLUDE = /(^|\/)(node_modules|\.git|\.worktrees|dist|build|\.next|coverage|\.kb)(\/|$)/;
const SELECTABLE_RE = /\.(md|mdx|markdown|adoc|asciidoc)$/i;
const ADOC_RE = /\.(adoc|asciidoc)$/i;
const TITLE_EXT_RE = /\.(md|mdx|markdown|adoc|asciidoc)$/i;
const YIELD_EVERY = 100;
const yieldToEventLoop = () => new Promise((r) => setImmediate(r));
const WALK_YIELD_EVERY = 500;
const WALK_YIELD_MAX_MS = 50;
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function globToRe(g) {
  const body = g.replace(/[.+^$(){}|\\]/g, "\\$&").replace(/\*\*\//g, "\xABGS\xBB").replace(/\*\*/g, "\xABG\xBB").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/«GS»/g, "(.*/)?").replace(/«G»/g, ".*");
  return new RegExp("(^|/)" + body + "$");
}
function matchAny(pats, rel) {
  return pats.some((re) => re.test(rel));
}
async function walk(dir, base, out = [], ignore, yieldFn = yieldToEventLoop, counter = { n: 0, last: performance.now() }) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (++counter.n % WALK_YIELD_EVERY === 0 || performance.now() - counter.last >= WALK_YIELD_MAX_MS) {
      await yieldFn();
      counter.last = performance.now();
    }
    const abs = join(dir, e.name);
    const rel = relative(base, abs);
    if (DEFAULT_EXCLUDE.test(rel)) continue;
    if (e.isDirectory()) {
      if (ignore?.isIgnoredDir(rel)) continue;
      await walk(abs, base, out, ignore, yieldFn, counter);
    } else if (SELECTABLE_RE.test(e.name) && !ignore?.isIgnored(rel)) out.push(abs);
  }
  return out;
}
function headingNodeName(rel, headingPath) {
  return `${rel}#${headingPath}`;
}
function docTypeOf(rel, includeSourceMarkdown) {
  const base = rel.split("/").pop() ?? "";
  if (base === "AGENTS.override.md" || base === "AGENTS.md" || base === "CLAUDE.md" || base.endsWith(".AGENTS.md")) return "agents";
  if (includeSourceMarkdown && /(^|\/)(src|lib|app|packages)\//.test(rel)) return "source-md";
  return "doc";
}
async function indexSource(store, src, opts = {}) {
  if (!existsSync(src.dir)) {
    console.warn(`kb index: source directory does not exist, skipping: ${src.dir}`);
    return { scanned: 0, changed: 0, deleted: 0, chunks: 0, missing: true };
  }
  const extRe = opts.extensions?.length ? new RegExp("(" + opts.extensions.map(escapeRegExp).join("|") + ")$", "i") : SELECTABLE_RE;
  const inc = opts.include?.map(globToRe);
  const exc = opts.exclude?.map(globToRe);
  const includeSourceMd = opts.includeSourceMarkdown !== false;
  const gi = opts.respectGitignore === false ? void 0 : await loadGitignoreMatcherYielding(src.dir, { cwd: opts.cwd, prune: (rel) => DEFAULT_EXCLUDE.test(rel), yieldEvery: WALK_YIELD_EVERY, yieldMaxMs: WALK_YIELD_MAX_MS, yieldFn: yieldToEventLoop });
  const files = (await walk(src.dir, src.dir, [], gi)).filter((abs) => {
    const rel = relative(src.dir, abs);
    if (src.include && !src.include(rel)) return false;
    if (inc && !matchAny(inc, rel)) return false;
    if (exc && matchAny(exc, rel)) return false;
    if (docTypeOf(rel, includeSourceMd) === "agents" && opts.indexAgentsFiles === false) return false;
    return true;
  });
  const stats = { scanned: files.length, changed: 0, deleted: 0, chunks: 0 };
  const live = /* @__PURE__ */ new Set();
  let sinceYield = 0;
  store.reconcileChunkMap?.();
  store.begin();
  try {
    opts.onFirstBatch?.();
    for (const abs of files) {
      if (sinceYield >= YIELD_EVERY) {
        store.commit();
        await yieldToEventLoop();
        store.begin();
        sinceYield = 0;
      }
      sinceYield++;
      opts.heartbeat?.();
      const rel = relative(src.dir, abs);
      let st;
      try {
        st = statSync(abs);
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        throw e;
      }
      live.add(rel);
      const prev = store.getFileState(src.root, rel);
      if (!opts.force && prev && prev.mtimeMs === st.mtimeMs) continue;
      let buf;
      try {
        buf = readFileSync(abs);
      } catch (e) {
        if (e?.code === "ENOENT") {
          live.delete(rel);
          continue;
        }
        throw e;
      }
      const hash = sha(buf);
      if (!opts.force && prev && prev.sha256 === hash) {
        store.setFileState(src.root, rel, { mtimeMs: st.mtimeMs, sha256: hash });
        continue;
      }
      store.deleteByPath(src.root, rel);
      const dt = docTypeOf(rel, includeSourceMd);
      const chunkFile = ADOC_RE.test(rel) ? chunkAsciiDoc : chunkMarkdown;
      const { chunks, wikilinks, mdLinks, frontmatter, parseFailed } = chunkFile({ root: src.root, path: rel, text: buf.toString("utf8"), docType: dt });
      store.addNode({ type: "file", name: rel, path: rel });
      for (const c of chunks) {
        store.insertChunk(c);
        if (c.level > 0) {
          const hName = headingNodeName(rel, c.headingPath);
          store.addNode({ type: "heading", name: hName, path: rel });
          const parentHeading = c.parentChunkId ? chunks.find((x) => x.chunkId === c.parentChunkId)?.headingPath : void 0;
          store.addEdge({ src: hName, dst: parentHeading ? headingNodeName(rel, parentHeading) : rel, rel: "child_of" });
        }
      }
      for (const w of wikilinks) {
        store.addNode({ type: "file", name: normalizeLink(w), path: null });
        store.addEdge({ src: rel, dst: normalizeLink(w), rel: "links_to" });
      }
      for (const l of mdLinks) {
        const target = normalizeRel(rel, l);
        store.addNode({ type: "file", name: target, path: null });
        store.addEdge({ src: rel, dst: target, rel: "references" });
      }
      const tags = frontmatter?.tags;
      if (Array.isArray(tags)) for (const tag of tags) {
        store.addNode({ type: "tag", name: `tag:${tag}`, path: null });
        store.addEdge({ src: rel, dst: `tag:${tag}`, rel: "has_tag" });
      }
      if (frontmatter) {
        const fmCfg = opts.frontmatter ?? { searchableKeys: DEFAULT_SEARCHABLE_KEYS, facetKeys: DEFAULT_FACET_KEYS };
        const { title, body: metaBody } = buildMeta(frontmatter, fmCfg.searchableKeys);
        const metaText = [title ?? "", metaBody].join("\n").trim();
        if (metaText) {
          const heading = title ?? (rel.split("/").pop() ?? rel).replace(TITLE_EXT_RE, "");
          store.insertChunk({ root: src.root, path: rel, chunkId: `${sha(rel).slice(0, 8)}:meta`, headingPath: heading, heading, level: 0, parentChunkId: null, docType: dt, body: metaBody, bodyHash: sha(metaText) });
          stats.chunks++;
        }
        if (store.insertProperty) for (const row of buildProperties(frontmatter, fmCfg.facetKeys)) store.insertProperty({ root: src.root, path: rel, ...row });
      }
      store.insertProperty?.({ root: src.root, path: rel, key: "docType", value: dt, valueNum: null, valueDate: null, valueRaw: dt });
      if (parseFailed) stats.parseFailures = (stats.parseFailures ?? 0) + 1;
      store.setFileState(src.root, rel, { mtimeMs: st.mtimeMs, sha256: hash });
      stats.changed++;
      stats.chunks += chunks.length;
    }
    for (const p of store.listPaths(src.root)) {
      if (!live.has(p)) {
        store.deleteByPath(src.root, p);
        store.demoteNode?.(p);
        stats.deleted++;
      }
    }
    store.sweepPlaceholders?.();
    store.commit();
  } catch (err) {
    store.rollback();
    throw err;
  }
  return stats;
}
function normalizeLink(w) {
  const name = w.split("|")[0].split("#")[0].trim();
  return name.endsWith(".md") ? name : `${name}.md`;
}
function normalizeRel(from, link) {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const parts = (dir ? dir + "/" : "") + link;
  const stack = [];
  for (const seg of parts.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}
export {
  WALK_YIELD_EVERY,
  docTypeOf,
  headingNodeName,
  indexSource,
  walk
};
