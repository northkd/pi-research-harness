import { supplementalHostDir } from "../../runtime-home.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { supplementalHomeDir as homedir } from "../../runtime-home.mjs";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_FACET_KEYS, DEFAULT_SEARCHABLE_KEYS } from "./frontmatter.js";
function expandTilde(p) {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
const DEFAULTS = {
  sources: [],
  get sourceCacheDir() {
    return join(supplementalHostDir(), "kb", "sources");
  },
  // Widened for AsciiDoc together with the indexer walk regex + chunker dispatch
  // (design D4) — widening one gate alone indexes zero extra files.
  include: ["**/*.md", "**/*.adoc", "**/*.asciidoc"],
  exclude: ["**/node_modules/**", "**/archive/**"],
  extensions: [".md", ".adoc", ".asciidoc"],
  maxFileCount: null,
  // no cap
  maxDepth: null,
  respectGitignore: true,
  tokenizer: "porter unicode61",
  trigram: false,
  indexAgentsFiles: true,
  includeSourceMarkdown: true,
  chunking: { minHeadingsForStructural: 1, minChunkChars: 120, maxChunkChars: 4e3, breadcrumbInBody: true },
  dedup: { exactContentCollapse: true, preferHigherPriorityRoot: true },
  graph: { wikilinks: true, headingTree: true, frontmatter: true },
  // Pull mode: `kb agents <path>` walks root→nearest AGENTS.md on demand. Safe —
  // no per-turn injection. Push mode stays gated behind the context-cost spike
  // (see change migrate-file-index-to-agents-tree design §5).
  directoryLevelAgents: { enabled: true, claudeMd: true, mode: "pull", fallbackManifest: true },
  frontmatter: { searchableKeys: DEFAULT_SEARCHABLE_KEYS, facetKeys: DEFAULT_FACET_KEYS },
  doxEnforcement: false,
  readDiscipline: { guard: { mode: "warn" } },
  doctrine: { inject: "kb", write: false },
  ranking: {
    fieldWeights: { headingPath: 10, heading: 3, body: 1 },
    proximityBoost: true,
    diversity: { enabled: true, lambda: 0.7 },
    sourceDedup: true,
    // 0.5 = the largest reserved share with NO markdown-intent regression
    // (R@10 0.630 vs 0.611 unquota'd) while source-intent rises 0.317 → 0.500.
    laneQuota: 0.5,
    coverageRerank: false,
    // Chosen by measurement over both golden sets — see
    // openspec/changes/fix-kb-search-lane-composition/measurements.md.
    laneLeadMargin: 0
  },
  expand: { parent: true, graph: false },
  rerank: { enabled: false, model: "ms-marco-MiniLM-L-6-v2", candidateK: 50 },
  // PRF is implemented engine-side but DEFAULT OFF: it is gated on coverage
  // rerank (which measures as a net regression), and adds ~3x search latency.
  queryExpansion: { mode: "off", prf: { terms: 6, topK: 10, dfCeiling: 0.1 } },
  git: {
    enabled: true,
    remote: "origin",
    searchWaitMs: 2e3,
    commits: { maxInitial: 5e4, maxPathsPerCommit: 200 },
    forge: {
      enabled: true,
      minSyncIntervalSeconds: 600,
      hintedMinSyncIntervalSeconds: 60,
      rateFloorPercent: 20,
      firstSyncWindowDays: 365,
      firstSyncMaxItems: 5e3,
      pagesPerSync: 5,
      leaseSeconds: 60,
      hosts: {},
      gitea: { tokenEnv: "GITEA_TOKEN" }
    }
  },
  seedFromMainWorktree: true,
  dbPath: ".pi/dashboard/kb/index.db"
};
const NESTED_KEYS = ["chunking", "dedup", "graph", "directoryLevelAgents", "frontmatter", "readDiscipline", "doctrine", "ranking", "expand", "rerank", "queryExpansion"];
function frontmatterConfigHash(fm) {
  const norm = {
    searchableKeys: [...fm.searchableKeys].sort(),
    facetKeys: [...fm.facetKeys].map((f) => ({ key: f.key, type: f.type ?? "string" })).sort((a, b) => a.key.localeCompare(b.key))
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}
function indexOptionsHash(cfg) {
  const norm = {
    fm: frontmatterConfigHash(cfg.frontmatter),
    includeSourceMarkdown: cfg.includeSourceMarkdown !== false
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}
function indexOptionsFromConfig(cfg, overrides = {}) {
  return {
    indexAgentsFiles: cfg.indexAgentsFiles,
    includeSourceMarkdown: cfg.includeSourceMarkdown,
    include: cfg.include,
    exclude: cfg.exclude,
    extensions: cfg.extensions,
    frontmatter: cfg.frontmatter,
    respectGitignore: cfg.respectGitignore,
    cwd: cfg.cwd,
    ...overrides
  };
}
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
function mergeConfig(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k === "git" && isPlainObject(v) && isPlainObject(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else if (NESTED_KEYS.includes(k) && v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
        out[k] = { ...out[k], ...v };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}
function validateConfig(c, origin = "config") {
  const merged = mergeConfig(DEFAULTS, c);
  const err = (msg) => new Error(`invalid KB ${origin}: ${msg}`);
  if (!Array.isArray(merged.sources)) throw err("sources must be an array");
  for (const s of merged.sources) {
    if (typeof s !== "object" || s === null || typeof s.ref !== "string") throw err("each source needs a string `ref`");
    const k = s.kind ?? "filesystem";
    if (!/^(filesystem|npm|git|https)$/.test(k)) throw err(`source kind "${k}" unknown`);
  }
  if (typeof merged.maxFileCount !== "number" && merged.maxFileCount !== null) throw err("maxFileCount must be a number or null");
  if (typeof merged.dbPath !== "string" || !merged.dbPath) throw err("dbPath must be a non-empty string");
  if (typeof merged.seedFromMainWorktree !== "boolean") throw err("seedFromMainWorktree must be a boolean");
  if (!/^(off|prf|synonym|agent)$/.test(merged.queryExpansion.mode)) throw err(`queryExpansion.mode "${merged.queryExpansion.mode}" unknown`);
  const gm = merged.readDiscipline?.guard?.mode;
  if (gm !== void 0 && !/^(off|warn|block)$/.test(gm)) throw err(`readDiscipline.guard.mode "${gm}" unknown (off | warn | block)`);
  const doc = merged.doctrine;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw err("doctrine must be an object ({ inject, write })");
  if (doc.inject !== void 0 && !/^(kb|off)$/.test(doc.inject)) throw err(`doctrine.inject "${doc.inject}" unknown (kb | off)`);
  if (doc.write !== void 0 && typeof doc.write !== "boolean") throw err("doctrine.write must be a boolean");
  const lq = merged.ranking.laneQuota;
  if (typeof lq !== "number" || !Number.isFinite(lq) || lq < 0 || lq > 1) throw err("ranking.laneQuota must be a number in [0,1]");
  const llm = merged.ranking.laneLeadMargin;
  if (typeof llm !== "number" || !Number.isFinite(llm) || llm < 0 || llm > 1) throw err("ranking.laneLeadMargin must be a number in [0,1]");
  validateGit(merged.git, err);
  const fm = merged.frontmatter;
  if (!fm || !Array.isArray(fm.searchableKeys) || fm.searchableKeys.some((k) => typeof k !== "string")) throw err("frontmatter.searchableKeys must be a string array");
  if (!Array.isArray(fm.facetKeys)) throw err("frontmatter.facetKeys must be an array");
  for (const f of fm.facetKeys) {
    if (typeof f !== "object" || f === null || typeof f.key !== "string") throw err("each frontmatter.facetKeys entry needs a string `key`");
    if (f.type != null && !/^(string|number|date)$/.test(f.type)) throw err(`frontmatter facet key "${f.key}" has unknown type "${f.type}"`);
  }
  return merged;
}
function validateGit(g, err) {
  if (!isPlainObject(g)) throw err("git must be an object");
  const posInt = (key, v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw err(`${key} must be a positive number`);
  };
  if (typeof g.enabled !== "boolean") throw err("git.enabled must be a boolean");
  if (typeof g.remote !== "string" || !g.remote.trim()) throw err("git.remote must be a non-empty string");
  posInt("git.searchWaitMs", g.searchWaitMs);
  posInt("git.commits.maxInitial", g.commits?.maxInitial);
  posInt("git.commits.maxPathsPerCommit", g.commits?.maxPathsPerCommit);
  const f = g.forge;
  if (!isPlainObject(f)) throw err("git.forge must be an object");
  if (typeof f.enabled !== "boolean") throw err("git.forge.enabled must be a boolean");
  for (const k of ["minSyncIntervalSeconds", "hintedMinSyncIntervalSeconds", "firstSyncWindowDays", "firstSyncMaxItems", "pagesPerSync", "leaseSeconds"]) posInt(`git.forge.${k}`, f[k]);
  if (typeof f.rateFloorPercent !== "number" || !Number.isFinite(f.rateFloorPercent) || f.rateFloorPercent < 0 || f.rateFloorPercent > 100) throw err("git.forge.rateFloorPercent must be a number in [0,100]");
  if (f.hintedMinSyncIntervalSeconds > f.minSyncIntervalSeconds) throw err("git.forge.hintedMinSyncIntervalSeconds must not exceed git.forge.minSyncIntervalSeconds");
  if (!isPlainObject(f.hosts)) throw err("git.forge.hosts must be an object mapping host \u2192 github|gitlab|gitea");
  for (const [h, kind] of Object.entries(f.hosts)) if (!/^(github|gitlab|gitea)$/.test(String(kind))) throw err(`git.forge.hosts["${h}"] "${String(kind)}" unknown (github | gitlab | gitea)`);
  if (typeof f.gitea?.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.gitea.tokenEnv)) throw err("git.forge.gitea.tokenEnv must be an environment variable name");
}
const warnedProjectGit = /* @__PURE__ */ new Set();
function stripGlobalOnlyGit(project, where) {
  if (!project || !isPlainObject(project.git)) return project;
  const forge = project.git.forge;
  if (!isPlainObject(forge)) return project;
  const dropped = [];
  const nextForge = { ...forge };
  if ("hosts" in nextForge) {
    delete nextForge.hosts;
    dropped.push("git.forge.hosts");
  }
  if (isPlainObject(nextForge.gitea) && "tokenEnv" in nextForge.gitea) {
    const { tokenEnv: _drop, ...rest } = nextForge.gitea;
    nextForge.gitea = rest;
    dropped.push("git.forge.gitea.tokenEnv");
  }
  if (!dropped.length) return project;
  if (!warnedProjectGit.has(where)) {
    warnedProjectGit.add(where);
    console.warn(`[kb] ignoring ${dropped.join(", ")} from project config ${where}: honoured from the global config only`);
  }
  return { ...project, git: { ...project.git, forge: nextForge } };
}
function projectConfigPath(cwd) {
  return join(cwd, ".pi", "dashboard", "knowledge_base.json");
}
function globalConfigPath() {
  return join(supplementalHostDir(), "knowledge_base.json");
}
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`invalid KB config at ${path}: ${e.message}`);
  }
}
function loadConfig(cwd, opts = {}) {
  const projectPath = opts.configPath ?? projectConfigPath(cwd);
  const rawProject = readJson(projectPath);
  const project = stripGlobalOnlyGit(rawProject, projectPath);
  const global = readJson(globalConfigPath());
  const origin = project ? "project" : global ? "global" : "defaults";
  const doctrineSource = project?.doctrine !== void 0 ? "project" : global?.doctrine !== void 0 ? "global" : "none";
  const merged = validateConfig(mergeConfig(DEFAULTS, global, project), origin);
  const fromRoots = (merged.roots ?? []).map((r) => ({ kind: "filesystem", ref: r.path, priority: r.priority }));
  const allSourceSpecs = [...fromRoots, ...merged.sources];
  const resolvedSources = allSourceSpecs.filter((s) => (s.kind ?? "filesystem") === "filesystem").map((s) => {
    const base = isAbsolute(s.ref) ? s.ref : resolve(cwd, s.ref);
    return { id: s.ref, dir: s.subdir ? join(base, s.subdir) : base, priority: s.priority ?? 0 };
  });
  const dbAbsPath = isAbsolute(merged.dbPath) ? merged.dbPath : resolve(cwd, merged.dbPath);
  const cacheDirAbs = expandTilde(merged.sourceCacheDir);
  return { ...merged, cwd, dbAbsPath, cacheDirAbs, allSourceSpecs, resolvedSources, origin, doctrineSource };
}
export {
  DEFAULTS,
  frontmatterConfigHash,
  globalConfigPath,
  indexOptionsFromConfig,
  indexOptionsHash,
  loadConfig,
  mergeConfig,
  projectConfigPath,
  validateConfig
};
