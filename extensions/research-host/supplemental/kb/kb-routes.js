import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  beginForcedSource,
  classifyRef,
  indexOptionsFromConfig,
  indexSource,
  isFirstIndexLive,
  KbUntrustedSourceError,
  listTrustedSources,
  loadConfig,
  readStaleness,
  recordTrust,
  resolverFor,
  revokeTrustByHash,
  runIndexAtomic,
  SqliteFtsStore,
  searchOptsFromConfig,
  seedOptionsFromConfig,
  sourceGateIsStale,
  sourceHash,
  sourceSubject,
  stampPass,
  stampSource,
  validateConfig
} from "../kb-engine/dist/index.js";
import {
  admissionAllows,
  admitCwd,
  isAllowedCwd,
  issueHeldAdmission,
  releaseAdmission
} from "../cwd-admission.mjs";
import { isOutside } from "../cwd-admission.mjs";
function projectConfigPath(cwd) {
  return join(cwd, ".pi", "dashboard", "knowledge_base.json");
}
function denyCwd(reply, cwd, admission) {
  if (!cwd) {
    reply.code(400).send({ error: "Missing cwd" });
    return;
  }
  if (admission?.kind === "indeterminate") {
    reply.code(503).header("Retry-After", "1").send({
      error: "cwd-admission-unavailable",
      message: "cwd admission could not be decided right now",
      retryAfterMs: 1e3
    });
    return;
  }
  reply.code(403).send({
    error: "cwd not allowed",
    reason: "cwd is not a known session or pinned directory.",
    hint: "Pin this directory to allow it, or open a session rooted in it."
  });
}
function folderExists(cwd) {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}
function preflightWrite(cwd, opts) {
  if (!folderExists(cwd)) return "folder missing";
  if (opts.needsSources && loadConfig(cwd).allSourceSpecs.length === 0) return "no sources configured";
  return null;
}
function readCounts(dbAbsPath) {
  let store = null;
  try {
    store = SqliteFtsStore.openExisting(dbAbsPath);
    if (!store) return { files: 0, chunks: 0 };
    const sc = store.hasCurrentSchema();
    if (!sc.table || !sc.current) return { files: 0, chunks: 0 };
    return store.counts();
  } catch {
    return { files: 0, chunks: 0 };
  } finally {
    store?.close();
  }
}
function openStore(cwd) {
  const cfg = loadConfig(cwd);
  const store = new SqliteFtsStore(cfg.dbAbsPath);
  store.init();
  return { store, cfg };
}
function countStale(cwd) {
  const sf = join(cwd, ".pi", "dashboard", "kb", "dox-staleness.json");
  const records = readStaleness(sf);
  let stale = 0;
  for (const [rowPath, ack] of Object.entries(records)) {
    const abs = isAbsolute(rowPath) ? rowPath : resolve(cwd, rowPath);
    if (!existsSync(abs)) continue;
    let sha;
    try {
      sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch {
      continue;
    }
    if (sha !== ack.sha256) stale++;
  }
  return stale;
}
function kindOf(spec) {
  return spec.kind ?? classifyRef(spec.ref);
}
const errMsg = (e) => e instanceof Error ? e.message : String(e);
async function resolveSpecs(cwd, cfg, outcomes, log) {
  const resolved = [];
  for (const spec of cfg.allSourceSpecs) {
    const started = Date.now();
    try {
      const src = await resolverFor(kindOf(spec)).resolve(spec, { cwd, cacheDir: cfg.cacheDirAbs, promptTrust: async () => false });
      resolved.push({ spec, src, started });
    } catch (e) {
      const untrusted = e instanceof KbUntrustedSourceError;
      outcomes.push({ ref: spec.ref, status: untrusted ? "untrusted" : "error", error: errMsg(e), at: Date.now() });
      if (untrusted) log?.info(`[kb-plugin] source skipped (not trusted) ref=${spec.ref} ms=${Date.now() - started}`);
      else log?.warn(`[kb-plugin] source failed ref=${spec.ref} ms=${Date.now() - started}: ${errMsg(e)}`);
    }
  }
  return resolved;
}
const okOutcome = (r) => ({ ref: r.spec.ref, status: "ok", ...r.src.revision ? { revision: r.src.revision } : {}, at: Date.now() });
async function firstIndex(cfg, resolved, outcomes, log) {
  if (!resolved.some((r2) => existsSync(r2.src.dir))) return { changed: 0, chunks: 0, outcomes };
  let r;
  try {
    r = await runIndexAtomic({ dbPath: cfg.dbAbsPath, sources: resolved.map((x) => ({ id: x.src.id, dir: x.src.dir })), indexOpts: indexOptionsFromConfig(cfg), gate: cfg, seed: seedOptionsFromConfig(cfg) });
  } catch (e) {
    for (const x of resolved) {
      outcomes.push({ ref: x.spec.ref, status: "error", error: errMsg(e), at: Date.now() });
      log?.warn(`[kb-plugin] source failed ref=${x.spec.ref} ms=${Date.now() - x.started}: ${errMsg(e)}`);
    }
    return { changed: 0, chunks: 0, outcomes };
  }
  for (const x of resolved) {
    outcomes.push(okOutcome(x));
    log?.info(`[kb-plugin] source ok ref=${x.spec.ref} kind=${kindOf(x.spec)} ms=${Date.now() - x.started}`);
  }
  return { changed: r.changed, chunks: r.counts.chunks, outcomes };
}
async function indexInPlace(cwd, resolved, outcomes, log) {
  const { store, cfg } = openStore(cwd);
  try {
    let changed = 0;
    for (const x of resolved) {
      try {
        const force = sourceGateIsStale(store, cfg, x.src.id);
        const stats = await indexSource(store, { root: x.src.id, dir: x.src.dir }, indexOptionsFromConfig(cfg, { force, onFirstBatch: force ? beginForcedSource(store, x.src.id) : void 0 }));
        if (!stats.missing) stampSource(store, cfg, x.src.id);
        changed += stats.changed;
        outcomes.push(okOutcome(x));
        log?.info(`[kb-plugin] source ok ref=${x.spec.ref} kind=${kindOf(x.spec)} ms=${Date.now() - x.started}`);
      } catch (e) {
        outcomes.push({ ref: x.spec.ref, status: "error", error: errMsg(e), at: Date.now() });
        log?.warn(`[kb-plugin] source failed ref=${x.spec.ref} ms=${Date.now() - x.started}: ${errMsg(e)}`);
      }
    }
    stampPass(store, cfg);
    return { changed, chunks: store.counts().chunks, outcomes };
  } finally {
    store.close();
  }
}
async function reindexAll(cwd, log, opts = {}) {
  if (!folderExists(cwd)) throw new Error("folder missing");
  const cfg = loadConfig(cwd);
  const outcomes = [];
  const resolved = await resolveSpecs(cwd, cfg, outcomes, log);
  while (!existsSync(cfg.dbAbsPath) && isFirstIndexLive(cfg.dbAbsPath)) await new Promise((r) => setTimeout(r, opts.pollMs ?? 1e3));
  if (!folderExists(cwd)) throw new Error("folder missing");
  return existsSync(cfg.dbAbsPath) ? indexInPlace(cwd, resolved, outcomes, log) : firstIndex(cfg, resolved, outcomes, log);
}
function writeProjectConfig(cwd, obj) {
  const path = projectConfigPath(cwd);
  if (!folderExists(cwd)) throw new Error("folder missing");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}
`, "utf8");
  renameSync(tmp, path);
  return path;
}
function persistProjectConfig(cwd, merged) {
  try {
    return { ok: true, projectPath: writeProjectConfig(cwd, merged) };
  } catch (e) {
    if (e instanceof Error && e.message === "folder missing") return { ok: false, code: 409, error: "folder missing" };
    throw e;
  }
}
function applyConfigPatch(cwd, body) {
  const path = projectConfigPath(cwd);
  let current = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      return { ok: false, code: 400, error: `existing config is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const merged = { ...current };
  if (body.sources !== void 0) merged.sources = body.sources;
  if (body.include !== void 0) merged.include = body.include;
  if (body.exclude !== void 0) merged.exclude = body.exclude;
  if (body.dbPath !== void 0) merged.dbPath = body.dbPath;
  try {
    validateConfig(merged, "project");
  } catch (e) {
    return { ok: false, code: 400, error: e instanceof Error ? e.message : String(e) };
  }
  return persistProjectConfig(cwd, merged);
}
function grantSourceTrust(cwd, ref) {
  const matches = loadConfig(cwd).allSourceSpecs.filter((s) => s.ref === ref);
  if (matches.length === 0) return { ok: false, code: 404, error: `no saved source with ref ${ref}` };
  if (matches.length > 1) return { ok: false, code: 409, error: `more than one saved source has ref ${ref}; resolve the duplicate first` };
  const spec = matches[0];
  if (kindOf(spec) === "filesystem") return { ok: false, code: 400, error: "filesystem sources do not need trust" };
  if (!recordTrust(spec)) return { ok: false, code: 500, error: "could not persist the trust record" };
  return { ok: true, hash: sourceHash(spec), subject: sourceSubject(spec) };
}
function applyConfigPatchAndTrust(cwd, body) {
  const result = applyConfigPatch(cwd, body);
  if (!result.ok) return result;
  const refs = Array.isArray(body.trustRefs) ? body.trustRefs.filter((r) => typeof r === "string") : [];
  const untrustedRefs = refs.filter((ref) => !grantSourceTrust(cwd, ref).ok);
  return { ok: true, projectPath: result.projectPath, untrustedRefs };
}
const SEARCH_DOC_TYPES = ["doc", "agents", "source-md"];
const MAX_QUERY_CHARS = 512;
function parseSearchQuery(query) {
  const q = (query.q ?? "").trim();
  if (q.length < 1 || q.length > MAX_QUERY_CHARS) return { error: `q must be 1-${MAX_QUERY_CHARS} characters` };
  const docType = query.docType === "" ? void 0 : query.docType;
  if (docType !== void 0 && !SEARCH_DOC_TYPES.includes(docType)) {
    return { error: `docType must be one of ${SEARCH_DOC_TYPES.join(", ")}` };
  }
  const limit = /^\d+$/.test(query.limit ?? "") ? Math.min(50, Math.max(1, Number(query.limit))) : 10;
  return { q, limit, ...docType ? { docType } : {} };
}
function refIsOutside(cwd, ref) {
  return isOutside(cwd, isAbsolute(ref) ? ref : resolve(cwd, ref));
}
async function admitKbCwd(deps, req, reply, cwd, holdOrigin) {
  if (typeof cwd !== "string" || cwd.length === 0) return { kind: "refuse" };
  const admission = await admitCwd(cwd, deps.knownCwds, deps.admitOptions);
  if (admission.kind !== "refuse" || !holdOrigin || !deps.holdCwdDenial) return endWithRequest(reply, admission);
  const decision = await deps.holdCwdDenial(req, reply, { cwd, origin: holdOrigin });
  if (decision.kind === "indeterminate") return { kind: "indeterminate", failedProbes: [], elapsedMs: 0 };
  return endWithRequest(reply, issueHeldAdmission(decision, cwd));
}
function endWithRequest(reply, admission) {
  if (admission.kind === "admit") {
    const { token } = admission;
    reply.raw.once("close", () => releaseAdmission(token));
  }
  return admission;
}
function mountKbRoutes(fastify, deps) {
  const { registry } = deps;
  fastify.get("/api/kb/stats", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd);
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    const folderMissing = !folderExists(cwd);
    const cfg = loadConfig(cwd);
    const counts = folderMissing ? { files: 0, chunks: 0 } : readCounts(cfg.dbAbsPath);
    const job = registry.get(cwd);
    const running = registry.isRunning(cwd);
    const stats = {
      files: counts.files,
      chunks: counts.chunks,
      indexed: counts.chunks > 0,
      staleCount: folderMissing ? 0 : countStale(cwd),
      folderMissing,
      sourceCount: folderMissing ? 0 : cfg.allSourceSpecs.length,
      indexing: running,
      jobStatus: registry.statusFor(cwd),
      ...!running && job?.status === "error" && job.error ? { lastError: job.error } : {}
    };
    return stats;
  });
  fastify.post("/api/kb/reindex", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd, "kb:reindex");
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    if (!registry.isRunning(cwd)) {
      const refused = preflightWrite(cwd, { needsSources: true });
      if (refused) {
        reply.code(409);
        return { error: refused };
      }
      const { promise } = registry.start(cwd, async () => reindexAll(cwd, fastify.log));
      promise.catch(
        (err) => fastify.log.error(`[kb-plugin] reindex failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    reply.code(202);
    return { status: "running", jobId: registry.jobId(cwd) ?? "kb" };
  });
  fastify.get("/api/kb/config", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd);
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    const cfg = loadConfig(cwd);
    return { config: cfg, origin: cfg.origin, projectPath: projectConfigPath(cwd) };
  });
  fastify.delete("/api/kb/source-trust", async (req, reply) => {
    const { hash } = req.body ?? {};
    if (!hash || typeof hash !== "string") {
      reply.code(400);
      return { error: "hash is required" };
    }
    const removed = revokeTrustByHash(hash);
    if (!removed) {
      reply.code(404);
      return { success: false, error: "no such source trust entry" };
    }
    return { success: true };
  });
  fastify.get("/api/kb/search", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd);
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    const parsed = parseSearchQuery(req.query);
    if ("error" in parsed) {
      reply.code(400);
      return { error: parsed.error };
    }
    const { q, docType, limit } = parsed;
    const started = Date.now();
    const cfg = loadConfig(cwd);
    let store = null;
    try {
      store = SqliteFtsStore.openExisting(cfg.dbAbsPath);
      if (!store) return { hits: [], tookMs: Date.now() - started };
      const schema = store.hasCurrentSchema();
      if (!schema.table) return { hits: [], tookMs: Date.now() - started };
      if (!schema.current) return { hits: [], tookMs: Date.now() - started, needsReindex: true };
      const sources = cfg.allSourceSpecs.map((s) => ({ id: s.ref, dir: "", priority: s.priority ?? 0 }));
      const opts = { ...searchOptsFromConfig(cfg, { sources }), limit, ...docType ? { docType } : {} };
      const hits = store.search(q, opts).map((h) => ({
        root: h.root,
        path: h.path,
        headingPath: h.headingPath,
        chunkId: h.chunkId,
        snippet: h.snippet,
        score: h.score,
        docType: h.docType,
        ...h.suppressedSections ? { suppressedSections: h.suppressedSections } : {}
      }));
      return { hits, tookMs: Date.now() - started };
    } catch (e) {
      fastify.log.error(`[kb-plugin] search failed for ${cwd}: ${errMsg(e)}`);
      reply.code(500);
      return { error: errMsg(e) };
    } finally {
      store?.close();
    }
  });
  fastify.get("/api/kb/sources", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd);
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    const cfg = loadConfig(cwd);
    let files = {};
    let store = null;
    try {
      store = SqliteFtsStore.openExisting(cfg.dbAbsPath);
      if (store) files = store.filesByRoot();
    } catch (e) {
      fastify.log.warn(`[kb-plugin] sources count failed for ${cwd}: ${errMsg(e)}`);
    } finally {
      store?.close();
    }
    const trustedHashes = new Set(listTrustedSources().map((t) => t.hash));
    const outcomes = new Map(registry.outcomesFor(cwd).map((o) => [o.ref, o]));
    const sources = cfg.allSourceSpecs.map((spec) => {
      const kind = kindOf(spec);
      const o = outcomes.get(spec.ref);
      return {
        ref: spec.ref,
        kind,
        files: files[spec.ref] ?? 0,
        trusted: kind === "filesystem" ? null : trustedHashes.has(sourceHash(spec)),
        outside: kind === "filesystem" && refIsOutside(cwd, spec.ref),
        ...o ? { lastStatus: o.status, lastAt: o.at } : {},
        ...o?.error ? { lastError: o.error } : {},
        ...o?.revision ? { revision: o.revision } : {}
      };
    });
    return { sources };
  });
  fastify.post("/api/kb/source-trust", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd, "kb:trust");
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    const ref = req.body?.ref;
    if (typeof ref !== "string" || ref.length === 0) {
      reply.code(400);
      return { error: "ref is required" };
    }
    const g = grantSourceTrust(cwd, ref);
    if (!g.ok) {
      reply.code(g.code);
      return { error: g.error };
    }
    return { hash: g.hash, subject: g.subject };
  });
  fastify.put("/api/kb/config", async (req, reply) => {
    const { cwd } = req.query;
    const admission = await admitKbCwd(deps, req, reply, cwd, "kb:config");
    if (!admissionAllows(admission, cwd)) {
      denyCwd(reply, cwd, admission);
      return;
    }
    const body = req.body ?? {};
    const result = applyConfigPatchAndTrust(cwd, body);
    if (!result.ok) {
      reply.code(result.code);
      return { error: result.error };
    }
    let reindexSkipped = null;
    if (body.reindex) {
      reindexSkipped = preflightWrite(cwd, { needsSources: true });
      if (!reindexSkipped && !registry.isRunning(cwd)) {
        registry.start(cwd, async () => reindexAll(cwd, fastify.log)).promise.catch(() => {
        });
      }
    }
    const cfg = loadConfig(cwd);
    return {
      config: cfg,
      origin: cfg.origin,
      projectPath: result.projectPath,
      ...reindexSkipped ? { reindexSkipped } : {},
      ...result.untrustedRefs.length > 0 ? { untrustedRefs: result.untrustedRefs } : {}
    };
  });
}
export {
  applyConfigPatchAndTrust,
  isAllowedCwd,
  mountKbRoutes,
  preflightWrite,
  projectConfigPath,
  reindexAll,
  writeProjectConfig
};
