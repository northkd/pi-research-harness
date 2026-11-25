#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { indexOptionsFromConfig, loadConfig } from "./config.js";
import { agentsChain, doxInit, doxLint, listEmptyPurposeRows } from "./dox.js";
import { ackTargets, applyDecisions, buildWorkItems } from "./dox-triage.js";
import { evaluate, loadGolden } from "./eval.js";
import { beginForcedSource, sourceGateIsStale, stampPass, stampSource } from "./index-gate.js";
import { BUILDING_LINE, isFirstIndexLive, runIndexAtomic } from "./index-run.js";
import { indexSource } from "./indexer.js";
import { kbInit } from "./init.js";
import { renderHits } from "./render.js";
import { searchOptsFromConfig } from "./search-opts.js";
import { seedOptionsFromConfig } from "./seed.js";
import { resolveAll } from "./sources.js";
import { SqliteFtsStore } from "./sqlite-store.js";
import { readStaleness } from "./staleness.js";
import { defaultPromptTrust } from "./trust.js";
import { enrichHits } from "./verdict.js";
function parse(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === void 0 || next.startsWith("--")) f[key] = true;
      else {
        if (key === "source") f.source = [].concat(f.source ?? [], next);
        else f[key] = next;
        i++;
      }
    } else f._.push(a);
  }
  return f;
}
function posInt(v, name) {
  if (v === void 0) return void 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a positive integer (got ${String(v)})`);
    process.exit(2);
  }
  return n;
}
function enumFlag(v, allowed, name) {
  if (v === void 0 || v === true) return void 0;
  if (!allowed.includes(v)) {
    console.error(`${name} must be one of ${allowed.join("|")} (got ${String(v)})`);
    process.exit(2);
  }
  return v;
}
function cfgFrom(flags) {
  const cwd = flags.cwd ?? process.cwd();
  const cfg = loadConfig(cwd, { configPath: flags.config });
  const srcs = flags.source;
  if (srcs?.length) {
    cfg.resolvedSources = srcs.map((s, i) => ({ id: s, dir: resolve(cwd, s), priority: srcs.length - i }));
  }
  if (flags.db) cfg.dbAbsPath = resolve(cwd, flags.db);
  return cfg;
}
function openStore(cfg) {
  const store = new SqliteFtsStore(cfg.dbAbsPath);
  store.init();
  return store;
}
async function runIndex(cfg, store, sources, force = false) {
  let scanned = 0, changed = 0, deleted = 0, chunks = 0;
  for (const s of sources) {
    const eff = force || sourceGateIsStale(store, cfg, s.id);
    const st = await indexSource(store, { root: s.id, dir: s.dir }, indexOptionsFromConfig(cfg, { force: eff, onFirstBatch: eff ? beginForcedSource(store, s.id) : void 0 }));
    if (!st.missing) stampSource(store, cfg, s.id);
    scanned += st.scanned;
    changed += st.changed;
    deleted += st.deleted;
    chunks += st.chunks;
  }
  stampPass(store, cfg);
  return { scanned, changed, deleted, chunks };
}
async function openStoreForQuery(cfg, sources, flags) {
  if (!existsSync(cfg.dbAbsPath)) {
    if (isFirstIndexLive(cfg.dbAbsPath)) {
      console.log(BUILDING_LINE);
      process.exit(75);
    }
    if (!flags["no-reindex"] && sources.some((s) => existsSync(s.dir))) {
      await runIndexAtomic({
        dbPath: cfg.dbAbsPath,
        sources: sources.map((x) => ({ id: x.id, dir: x.dir })),
        indexOpts: indexOptionsFromConfig(cfg),
        gate: cfg,
        seed: seedOptionsFromConfig(cfg, { noSeed: !!flags["no-seed"], explicitSources: !!flags.source?.length, customDb: !!flags.db })
      });
    } else {
      const mem = new SqliteFtsStore(":memory:");
      mem.init();
      return mem;
    }
  }
  return openStore(cfg);
}
async function sourcesForRun(cfg, flags) {
  const srcs = flags.source;
  if (srcs?.length) return srcs.map((s, i) => ({ id: s, dir: resolve(cfg.cwd, s), priority: srcs.length - i, identity: s }));
  const interactive = process.stdin.isTTY ?? false;
  return resolveAll(cfg.allSourceSpecs, {
    cwd: cfg.cwd,
    cacheDir: cfg.cacheDirAbs,
    refresh: !!flags.refresh,
    promptTrust: interactive ? defaultPromptTrust : void 0
  });
}
const HELP = `kb \u2014 markdown knowledge base
Usage:
  kb init    [--global] [--source <ref>]... [--dry-run] [--force] [--cwd <dir>]
  kb index   [--source <dir>...] [--db <path>] [--force] [--refresh] [--no-seed]
             (--no-seed: skip seeding a linked worktree's first index from the main checkout)
  kb search  "<query>" [--limit N] [--root id] [--doc-type doc|agents|source-md]
             [--expand-parent|--no-expand-parent] [--expand-graph] [--rerank]
             [--expand-query] [--json] [--no-reindex] [--source <dir>...] [--db <path>]
             [--no-source-dedup] [--no-lane-quota] [--no-coverage-rerank] [--verdicts]
             (--limit bounds distinct SOURCES, not chunks; --verdicts = opt-in trust labels)
  kb neighbors "<node>" [--depth N] [--rel child_of|links_to|references|has_tag]
  kb backlinks "<node>"
  kb get <path> [--section "<heading_path>"]
  kb agents <path>                  nearest AGENTS.md chain (root\u2192nearest); --fallback-manifest
  kb dox init [--dry-run]           scaffold a DOX AGENTS.md tree (path rows only)
  kb dox lint [--json] [--fix] [--source-rows]   audit DOX tree drift
                                    (--source-rows also reports undocumented .ts/.tsx)
  kb dox triage [--json] [--limit N]  triage STALE rows vs the git diff since ack
              [--apply <d.json> [--write]] [--ack <targets.json>]
  kb dox describe --list [--json] [--dir <path>]   list rows with an empty Purpose cell
  kb eval    --golden <file.json> [--limit N] [--doc-type ...] [--no-reindex]
             [--allow-zero] [--verbose] [--json]
             (--golden accepts a bare array of {q, expect} or an {"items": [...]} object;
              items outside the configured roots are reported as unreachable;
              a run with 0 scored items or 0 recall exits non-zero unless --allow-zero)
  kb config   show resolved config
Global: --cwd <dir>  --config <file>`;
function main() {
  const flags = parse(process.argv.slice(2));
  const cmd = flags._[0];
  if (!cmd || cmd === "help" || flags.help) {
    console.log(HELP);
    return;
  }
  if (cmd === "config") {
    const cfg = cfgFrom(flags);
    console.log(JSON.stringify({ origin: cfg.origin, dbAbsPath: cfg.dbAbsPath, cacheDirAbs: cfg.cacheDirAbs, sources: cfg.resolvedSources, allSourceSpecs: cfg.allSourceSpecs, maxFileCount: cfg.maxFileCount, indexAgentsFiles: cfg.indexAgentsFiles }, null, 2));
    return;
  }
  if (cmd === "init") {
    const r = kbInit({
      global: !!flags.global,
      force: !!flags.force,
      dryRun: !!flags["dry-run"],
      sources: flags.source,
      cwd: flags.cwd ?? process.cwd()
    });
    if (!flags["dry-run"] && r.wrote) {
      console.log(`wrote ${r.configPath}`);
      if (r.gitignoreAdded) console.log(`gitignored ${r.gitignoreAdded} in ${r.gitignorePath}`);
    }
    return;
  }
  if (cmd === "agents") {
    const cwd = flags.cwd ?? process.cwd();
    const { chain, manifest } = agentsChain(cwd, flags._[1] ?? cwd, { claudeMd: true, fallbackManifest: flags["no-fallback-manifest"] ? false : true });
    if (flags.json) console.log(JSON.stringify({ chain: chain.map((c) => c.rel), manifest }, null, 2));
    else if (chain.length) for (const c of chain) console.log(c.rel);
    else if (manifest) console.log(manifest);
    else console.log("(no AGENTS.md on path and no manifest)");
    return;
  }
  if (cmd === "dox") {
    const sub = flags._[1];
    const cwd = flags.cwd ?? process.cwd();
    if (sub === "init") {
      const plan = doxInit({ cwd, dryRun: !!flags["dry-run"] });
      if (flags["dry-run"]) console.log(`# dry-run dox init
create: ${plan.created.join(", ") || "(none)"}
append: ${plan.appended.map((a) => a.file + " +" + a.rows.length).join(", ") || "(none)"}`);
      else console.log(`created ${plan.created.length} AGENTS.md, appended rows to ${plan.appended.length} files`);
      return;
    }
    if (sub === "lint") {
      const r = doxLint({ cwd, json: !!flags.json, fix: !!flags.fix, sourceFileRows: !!flags["source-rows"] });
      if (flags.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.filesScanned} files, ${r.rowsScanned} rows scanned, ${r.issues.length} findings`);
        for (const i of r.issues) console.log(`${i.kind}	${i.agentsFile}${i.path ? "	" + i.path : ""}	${i.detail}`);
      }
      if (r.issues.length) process.exit(1);
      return;
    }
    if (sub === "triage") {
      const stalenessFile = flags["staleness-file"] ?? join(cwd, ".pi/dashboard/kb/dox-staleness.json");
      if (flags.apply) {
        const decisions = JSON.parse(readFileSync(flags.apply, "utf8"));
        const r = applyDecisions({ cwd, decisions, write: !!flags.write });
        for (const s of r.skipped) console.error(`skipped: ${s}`);
        console.log(`${flags.write ? "applied" : "dry-run"}: ${r.rewritten} rewritten, ${r.kept} kept`);
        if (!flags.write) console.log("re-run with --write to apply");
        return;
      }
      if (flags.ack) {
        const targets = JSON.parse(readFileSync(flags.ack, "utf8"));
        console.log(`re-acked ${ackTargets({ cwd, targets, stalenessFile })} entries`);
        return;
      }
      const staleness = readStaleness(stalenessFile);
      const items = buildWorkItems({ cwd, issues: doxLint({ cwd }).issues, staleness, limit: flags.limit ? Number(flags.limit) : void 0 });
      if (flags.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      const noBase = items.filter((i) => !i.baselineFound);
      console.log(`stale rows: ${items.length}`);
      console.log(`  with a recoverable diff : ${items.length - noBase.length}`);
      console.log(`  no baseline (needs eyes): ${noBase.length}`);
      for (const i of items) console.log(`  ${i.baselineFound ? "diff" : "????"}	${i.agentsFile}	${i.row}`);
      return;
    }
    if (sub === "describe") {
      const r = listEmptyPurposeRows({ cwd, dir: typeof flags.dir === "string" ? flags.dir : void 0 });
      if (flags.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      if (r.total === 0) {
        console.log("no empty-purpose rows");
        return;
      }
      console.log(`${r.total} empty-purpose row(s) across ${r.groups.length} AGENTS.md file(s)`);
      for (const g of r.groups) {
        console.log(g.agentsPath);
        for (const s of g.subjects) console.log(`  ${s}`);
      }
      return;
    }
    console.error(`unknown dox subcommand: ${sub}`);
    process.exit(2);
  }
  void runCmd(cmd, flags).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
async function runCmd(cmd, flags) {
  const cfg = cfgFrom(flags);
  const isIndex = cmd === "index";
  if (!cfg.allSourceSpecs.length && isIndex && !flags.source?.length) {
    console.error("no sources configured. add sources[] to .pi/dashboard/knowledge_base.json or pass --source <dir>");
    process.exit(2);
  }
  const sources = await sourcesForRun(cfg, flags);
  if (!sources.length && isIndex) {
    console.error("no sources resolved");
    process.exit(2);
  }
  if (cmd === "index") {
    const explicit = !!flags.source?.length;
    const t = performance.now();
    const s = await runIndexAtomic({
      dbPath: cfg.dbAbsPath,
      sources: sources.map((x) => ({ id: x.id, dir: x.dir })),
      indexOpts: indexOptionsFromConfig(cfg, { force: !!flags.force }),
      gate: cfg,
      explicit,
      seed: seedOptionsFromConfig(cfg, { noSeed: !!flags["no-seed"], explicitSources: explicit, customDb: !!flags.db })
    });
    console.log(`indexed ${s.scanned} files (${s.changed} changed, ${s.deleted} deleted, ${s.chunks} chunks) in ${(performance.now() - t).toFixed(0)}ms`);
    console.log(JSON.stringify(s.counts));
    return;
  }
  const store = await openStoreForQuery(cfg, sources, flags);
  try {
    if (cmd === "search") {
      const q = flags._[1];
      if (!q) {
        console.error("search needs a query");
        process.exit(2);
      }
      const limit = posInt(flags.limit, "--limit");
      const docType = enumFlag(flags["doc-type"], ["doc", "agents", "source-md"], "--doc-type");
      if (!flags["no-reindex"]) await runIndex(cfg, store, sources);
      const so = {
        limit: limit ?? 10,
        root: flags.root,
        docType,
        ...searchOptsFromConfig(cfg, {
          sources,
          overrides: {
            sourceDedup: flags["no-source-dedup"] ? false : void 0,
            laneQuota: flags["no-lane-quota"] ? 0 : void 0,
            coverageRerank: flags["no-coverage-rerank"] ? false : void 0,
            expandParent: flags["no-expand-parent"] ? false : flags["expand-parent"] ? true : void 0,
            expandGraph: flags["expand-graph"] ? true : void 0,
            rerank: flags.rerank ? true : void 0,
            queryExpansion: flags["expand-query"] && cfg.queryExpansion.mode === "off" ? "synonym" : void 0
          }
        })
      };
      const hits = store.search(q, so);
      if (flags.verdicts) await enrichHits(hits, { cwd: cfg.cwd });
      if (flags.json) console.log(JSON.stringify(hits, null, 2));
      else if (hits.length) console.log(renderHits(hits, { leading: "score", parentGlyph: "[parent: ", multiline: false }));
    } else if (cmd === "neighbors") {
      const depth = posInt(flags.depth, "--depth") ?? 2;
      const rel = enumFlag(flags.rel, ["child_of", "links_to", "references", "has_tag"], "--rel");
      const n = store.neighbors(flags._[1], depth, rel);
      console.log(flags.json ? JSON.stringify(n, null, 2) : n.map((x) => `${x.type}	${x.name}`).join("\n"));
    } else if (cmd === "backlinks") {
      const n = store.backlinks(flags._[1]);
      console.log(flags.json ? JSON.stringify(n, null, 2) : n.map((x) => `${x.type}	${x.name}`).join("\n"));
    } else if (cmd === "get") {
      let c = null;
      for (const s of sources) {
        c = store.getChunk(s.id, flags._[1], flags.section);
        if (c) break;
      }
      const more = c?.suppressedSections ?? 0;
      console.log(c ? more > 0 ? `${c.body}

(+${more} more section${more === 1 ? "" : "s"} in this file \u2014 pass --section <headingPath> to fetch one)` : c.body : `(not found: ${flags._[1]})`);
    } else if (cmd === "eval") {
      const gf = flags.golden;
      if (!gf) {
        console.error("eval needs --golden <file.json>");
        process.exit(2);
      }
      if (!flags["no-reindex"]) await runIndex(cfg, store, sources);
      const golden = loadGolden(JSON.parse(readFileSync(resolve(cfg.cwd, gf), "utf8")), gf);
      const roots = sources.map((s) => ({ id: s.id, relPrefix: relative(cfg.cwd, s.dir), dir: s.dir }));
      const limit = posInt(flags.limit, "--limit") ?? 10;
      const docType = enumFlag(flags["doc-type"], ["doc", "agents", "source-md"], "--doc-type");
      const m = evaluate(store, golden, {
        k: limit,
        docType,
        verbose: !!flags.verbose,
        roots,
        ...searchOptsFromConfig(cfg, { sources, overrides: { expandGraph: false, rerank: false } })
      });
      console.log(JSON.stringify(m, null, flags.json ? 2 : 0));
      if (flags.verbose && m.unreachablePaths?.length) {
        for (const p of m.unreachablePaths) console.error(`[kb eval] unreachable: ${p}`);
      }
      const why = m.n === 0 ? golden.length === 0 ? "the golden fixture has no items" : `all ${m.unreachable} of ${golden.length} golden items are unreachable under the configured roots (${roots.map((r) => r.relPrefix || ".").join(", ")}) \u2014 check root normalization` : m["Recall@K"] === 0 ? `recall is 0 across all ${m.n} scored items \u2014 check the fixture shape and root normalization` : null;
      if (why) {
        console.error(`[kb eval] VACUOUS RUN: ${why}. Re-run with --allow-zero to measure anyway.`);
        if (!flags["allow-zero"]) process.exit(1);
      }
    } else {
      console.error(`unknown command: ${cmd}

${HELP}`);
      process.exit(2);
    }
  } finally {
    store.close();
  }
}
main();
