import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
const SCHEMA_VERSION = 3;
const DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  root UNINDEXED, path UNINDEXED, chunk_id UNINDEXED, doc_type UNINDEXED,
  parent_chunk_id UNINDEXED, level UNINDEXED, body_hash UNINDEXED,
  heading_path, heading, body,
  -- Line anchors appended AFTER body so the body column keeps index 9 (bm25 and
  -- snippet are positional). FTS5 has no ALTER TABLE ADD COLUMN, so adding
  -- them is a SCHEMA_VERSION bump + one-time full reindex (design D3a).
  start_line UNINDEXED, end_line UNINDEXED,
  tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS files (
  root TEXT, path TEXT, mtime_ms REAL, sha256 TEXT,
  PRIMARY KEY (root, path)
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY, type TEXT, name TEXT, path TEXT,
  UNIQUE(type, name)
);
CREATE TABLE IF NOT EXISTS edges (
  src INTEGER, dst INTEGER, rel TEXT, weight REAL DEFAULT 1,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
-- owned-row lookups (heading nodes by file path) must not scan the nodes table per file.
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS properties (
  root TEXT, path TEXT, key TEXT,
  value TEXT, value_num REAL, value_date TEXT, value_raw TEXT
);
-- The unique index doubles as the (root,path) lookup for delete-by-path (its
-- leading columns), so no separate idx_props_path is needed \u2014 one fewer index to
-- maintain on the hot per-file insert path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_props_uniq ON properties(root, path, key, value);
CREATE INDEX IF NOT EXISTS idx_props_kv ON properties(key, value);
CREATE TABLE IF NOT EXISTS kb_meta (k TEXT PRIMARY KEY, v TEXT);
-- chunk rowids per (root,path): written by replaceItem (git scope) AND by every docs
-- insertChunk. \`chunks\` is FTS5 with UNINDEXED root/path, so \`DELETE \u2026 WHERE path=?\`
-- scans the whole table (O(N) per item, quadratic over a bulk ingest); a rowid delete
-- is O(log N). See change: fix-kb-index-integrity (D5).
CREATE TABLE IF NOT EXISTS item_rows (root TEXT, path TEXT, rid INTEGER, PRIMARY KEY (root, path, rid));
`;
function buildFilterClauses(filters, outer) {
  const clauses = [];
  const args = [];
  const norm = (v) => String(v).toLowerCase().trim();
  const eqCol = (t) => t === "number" ? "value_num" : t === "date" ? "value_date" : "value";
  const eqVal = (t, v) => t === "number" ? Number(v) : t === "date" ? String(v) : norm(v);
  for (const f of filters ?? []) {
    if (f.op === "eq" && f.value != null) {
      const col = eqCol(f.type);
      clauses.push(`EXISTS (SELECT 1 FROM properties p WHERE p.root=${outer}.root AND p.path=${outer}.path AND p.key=? AND p.${col}=?)`);
      args.push(f.key, eqVal(f.type, f.value));
    } else if (f.op === "in" && f.values?.length) {
      const col = eqCol(f.type);
      const ph = f.values.map(() => "?").join(",");
      clauses.push(`EXISTS (SELECT 1 FROM properties p WHERE p.root=${outer}.root AND p.path=${outer}.path AND p.key=? AND p.${col} IN (${ph}))`);
      args.push(f.key, ...f.values.map((v) => eqVal(f.type, v)));
    } else if ((f.op === "gte" || f.op === "lte") && f.value != null) {
      const col = f.type === "number" ? "value_num" : f.type === "date" ? "value_date" : "value";
      const cmp = f.op === "gte" ? ">=" : "<=";
      clauses.push(`EXISTS (SELECT 1 FROM properties p WHERE p.root=${outer}.root AND p.path=${outer}.path AND p.key=? AND p.${col} IS NOT NULL AND p.${col} ${cmp} ?)`);
      args.push(f.key, f.type === "number" ? Number(f.value) : f.type === "date" ? String(f.value) : norm(f.value));
    }
  }
  return { clauses, args };
}
function toMatch(q) {
  const terms = tokenize(q);
  const kept = terms.length ? terms : rawTokens(q);
  return kept.map((t) => `"${t}"`).join(" OR ");
}
class SqliteFtsStore {
  db;
  dbPath;
  /** Opened via `openExisting`: SELECT-only handle, must never issue DDL against the saved file. */
  existingOnly;
  /** fts5vocab view used for document frequencies (persistent in a writer, connection-local TEMP when `existingOnly`). */
  vocabTable = "chunks_vocab";
  // Prepared-statement cache: re-preparing per row on a hot insert path (chunks
  // + properties, many per file) is a measurable reindex cost. Cache by SQL.
  stmts = /* @__PURE__ */ new Map();
  prep(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  /**
   * `existingOnly` opens a side-effect-free handle for read-only callers: no
   * `mkdir`, no `journal_mode=WAL` (a mode change rewrites a DELETE-mode file
   * header), and the caller must NOT call `init()` (no DDL / schema migration).
   * Prefer {@link SqliteFtsStore.openExisting}.
   */
  constructor(dbPath, opts = {}) {
    this.dbPath = dbPath;
    this.existingOnly = opts.existingOnly === true;
    if (!opts.existingOnly && dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    if (!opts.existingOnly) this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5e3))}`);
  }
  /**
   * Open an EXISTING db without creating, migrating or re-moding it. Returns
   * null for a missing or 0-byte file (callers treat that as an empty index).
   * A read-write handle is used on purpose: a `readOnly` connection cannot
   * create the WAL `-shm` sidecar once the writer checkpointed and removed it
   * (SQLITE_CANTOPEN). Callers must only issue SELECTs.
   */
  static openExisting(dbPath) {
    try {
      if (statSync(dbPath).size === 0) return null;
    } catch {
      return null;
    }
    return new SqliteFtsStore(dbPath, { existingOnly: true });
  }
  /** True when `chunks` exists with the current column set (`start_line`). Read-only probe. */
  hasCurrentSchema() {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
    return { table: cols.length > 0, current: cols.includes("start_line") };
  }
  /** Indexed file count per root. `files` has a (root,path) PK, so this is cheap (no FTS scan). */
  filesByRoot() {
    const out = {};
    for (const r of this.db.prepare("SELECT root, COUNT(*) AS n FROM files GROUP BY root").all()) out[r.root] = Number(r.n);
    return out;
  }
  init() {
    this.migrateChunksSchema();
    this.db.exec(DDL);
  }
  /** Rebuild the `chunks` FTS5 table when its column set predates the current
   *  DDL. `CREATE VIRTUAL TABLE IF NOT EXISTS` is a NO-OP on an existing table
   *  and FTS5 has no `ALTER TABLE ADD COLUMN`, so without this an older store
   *  keeps its 10-column table and every `insertChunk` throws "table chunks has
   *  no column named start_line" — permanently un-reindexable. Chunks are
   *  derived data, so dropping is safe; `files` (the mtime/sha256 state) is
   *  cleared with them, or the next INCREMENTAL walk would skip every unchanged
   *  file and leave the rebuilt table empty. Runs for every opener, not just the
   *  `runIndexAtomic` version gate. See change: asciidoc-support (design D3a). */
  migrateChunksSchema() {
    let cols;
    try {
      cols = this.db.prepare("PRAGMA table_info(chunks)").all().map((r) => String(r.name));
    } catch {
      return;
    }
    if (cols.length === 0) return;
    if (cols.includes("start_line") && cols.includes("end_line")) return;
    this.db.exec("DROP TABLE IF EXISTS chunks");
    for (const t of ["files", "nodes", "edges", "properties", "item_rows"]) {
      try {
        this.db.exec(`DELETE FROM ${t}`);
      } catch {
      }
    }
  }
  begin() {
    this.db.exec("BEGIN");
  }
  /** Lower/raise the SQLITE_BUSY wait on this connection (git scope keeps it
   *  within the search budget). See change: add-kb-git-forge-scope (G1). */
  setBusyTimeout(ms) {
    this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(ms))}`);
  }
  /** BEGIN IMMEDIATE … COMMIT around a synchronous `fn` (ROLLBACK on throw), so
   *  the writer lock is held from the first statement to COMMIT. The existing
   *  `begin()` is a plain BEGIN and is not used by the git scope. */
  immediate(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn(this.db);
      this.db.exec("COMMIT");
      this.dfCache.clear();
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw e;
    }
  }
  /** Plain (non-transactional) read access to the raw connection. */
  read(fn) {
    return fn(this.db);
  }
  /** Placeholder node (path NULL) so `addEdge` to a not-yet-indexed target is kept. */
  ensureNode(id) {
    this.prep("INSERT OR IGNORE INTO nodes(type,name,path) VALUES('file',?,NULL)").run(id);
  }
  /** Replace chunks + OUTBOUND edges of `path`; the node (and so every inbound
   *  edge) survives, so a re-synced PR keeps the links pointing at it. */
  replaceItem(root, path, chunks, outboundEdges) {
    this.dfCache.clear();
    const old = this.prep("SELECT rid FROM item_rows WHERE root=? AND path=?").all(root, path);
    if (old.length) {
      for (const r of old) this.prep("DELETE FROM chunks WHERE rowid=?").run(r.rid);
      this.prep("DELETE FROM item_rows WHERE root=? AND path=?").run(root, path);
    }
    this.prep("INSERT INTO nodes(type,name,path) VALUES('file',?,?) ON CONFLICT(type,name) DO UPDATE SET path=excluded.path").run(path, path);
    const src = this.prep("SELECT id FROM nodes WHERE type='file' AND name=?").get(path);
    this.prep("DELETE FROM edges WHERE src=?").run(src.id);
    for (const c of chunks) {
      const r = this.insertChunkRow(c);
      this.prep("INSERT INTO item_rows(root,path,rid) VALUES(?,?,?)").run(root, path, Number(r.lastInsertRowid));
    }
    for (const e of outboundEdges) {
      this.ensureNode(e.dst);
      const dst = this.prep("SELECT id FROM nodes WHERE type='file' AND name=?").get(e.dst);
      this.prep("INSERT OR IGNORE INTO edges(src,dst,rel,weight) VALUES(?,?,?,?)").run(src.id, dst.id, e.rel, e.weight ?? 1);
    }
  }
  /** Indexed (non-placeholder) item paths starting with `prefix`. Reads the
   *  indexed `nodes(type,name)` unique key as a range, not the FTS table. */
  findPathsByPrefix(_root, prefix, max) {
    const hi = `${prefix}\uFFFF`;
    return this.prep("SELECT name FROM nodes WHERE type='file' AND path IS NOT NULL AND name >= ? AND name < ? ORDER BY name LIMIT ?").all(prefix, hi, Math.max(1, Math.trunc(max))).map((r) => r.name);
  }
  commit() {
    this.db.exec("COMMIT");
    this.dfCache.clear();
  }
  rollback() {
    try {
      this.db.exec("ROLLBACK");
    } catch {
    }
  }
  close() {
    this.db.close();
  }
  /** Fold the WAL into the main file and close, so a temp-path build is one
   *  self-contained file ready to install onto `dbPath` (hard link or online
   *  backup — see `installIndex` in index-run.ts). TRUNCATE-checkpoint + close
   *  BEFORE the install so the single main file holds every committed page.
   *  See changes: harden-kb-index-failure-atomicity, fix-kb-index-integrity (D1). */
  checkpointAndClose() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
    }
    this.db.close();
  }
  /** Close and remove this DB file + WAL sidecars — cleanup for a failed run
   *  that itself created the file (never touches a pre-existing valid DB). */
  closeAndUnlink() {
    try {
      this.db.close();
    } catch {
    }
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(this.dbPath + ext);
      } catch {
      }
    }
  }
  getFileState(root, path) {
    const r = this.db.prepare("SELECT mtime_ms, sha256 FROM files WHERE root=? AND path=?").get(root, path);
    return r ? { mtimeMs: r.mtime_ms, sha256: r.sha256 } : null;
  }
  setFileState(root, path, s) {
    this.db.prepare("INSERT INTO files(root,path,mtime_ms,sha256) VALUES(?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET mtime_ms=excluded.mtime_ms, sha256=excluded.sha256").run(root, path, s.mtimeMs, s.sha256);
  }
  listPaths(root) {
    return this.db.prepare("SELECT path FROM files WHERE root=?").all(root).map((r) => r.path);
  }
  /** Delete exactly the rows owned by file `path`: its chunks (rowid-addressed via
   *  `item_rows`, incl. the `:meta` chunk), its heading nodes, edges sourced at its
   *  file/heading nodes, properties and file state. Its FILE node is kept (so edges
   *  from OTHER files that point at it survive a re-chunk); see `demoteNode` for a
   *  deleted file. See change: fix-kb-index-integrity (D4, D5). */
  deleteByPath(root, path) {
    this.dfCache.clear();
    for (const r of this.prep("SELECT rid FROM item_rows WHERE root=? AND path=?").all(root, path)) {
      this.prep("DELETE FROM chunks WHERE rowid=? AND root=? AND path=?").run(r.rid, root, path);
    }
    this.prep("DELETE FROM item_rows WHERE root=? AND path=?").run(root, path);
    this.prep(
      `DELETE FROM edges WHERE src IN (SELECT id FROM nodes WHERE (type='file' AND name=?1) OR (type='heading' AND path=?1))
         OR dst IN (SELECT id FROM nodes WHERE type='heading' AND path=?1)`
    ).run(path);
    this.prep("DELETE FROM nodes WHERE type='heading' AND path=?").run(path);
    this.prep("DELETE FROM properties WHERE root=? AND path=?").run(root, path);
    this.prep("DELETE FROM files WHERE root=? AND path=?").run(root, path);
  }
  /** A deleted file's node becomes a placeholder (path NULL) so inbound links keep their target. */
  demoteNode(path) {
    this.prep("UPDATE nodes SET path=NULL WHERE type='file' AND name=?").run(path);
  }
  /** Remove path-less nodes (placeholders, tags) no edge references. */
  sweepPlaceholders() {
    const r = this.prep("DELETE FROM nodes WHERE path IS NULL AND id NOT IN (SELECT src FROM edges) AND id NOT IN (SELECT dst FROM edges)").run();
    return Number(r.changes);
  }
  /** `PRAGMA data_version` changes when ANOTHER connection commits to the file. */
  dataVersion() {
    return Number(this.db.prepare("PRAGMA data_version").get().data_version);
  }
  mapVersion = null;
  /** Rebuild the `item_rows` record from `chunks` (25 ms on 3000 files / 40k chunks)
   *  and drop file state of files owning non-qualified (pre-fix) heading nodes so the
   *  walk re-chunks them. Runs at the start of this connection's first pass and of
   *  every pass after another connection committed (`data_version`), inside one
   *  BEGIN IMMEDIATE; a failure throws BEFORE any per-file delete. Cheap no-op
   *  otherwise. See change: fix-kb-index-integrity (D5). */
  reconcileChunkMap() {
    if (this.existingOnly) return;
    if (this.mapVersion !== null && this.dataVersion() === this.mapVersion) return;
    this.mapVersion = this.immediate((db) => {
      db.exec("DELETE FROM item_rows");
      db.exec("INSERT OR IGNORE INTO item_rows(root,path,rid) SELECT root, path, rowid FROM chunks");
      const LEGACY = "type='heading' AND path IS NOT NULL AND substr(name, 1, length(path) + 1) <> path || '#'";
      if (db.prepare(`SELECT 1 FROM nodes WHERE ${LEGACY} LIMIT 1`).get()) {
        db.exec(`DELETE FROM files WHERE path IN (SELECT path FROM nodes WHERE ${LEGACY})`);
        db.exec(`DELETE FROM files WHERE path IN (
          SELECT c.path FROM chunks c JOIN nodes n ON n.type='heading' AND n.name = c.heading_path
          WHERE n.path IS NOT NULL AND substr(n.name, 1, length(n.path) + 1) <> n.path || '#')`);
      }
      return Number(db.prepare("PRAGMA data_version").get().data_version);
    });
  }
  deletePropertiesByPath(root, path) {
    this.db.prepare("DELETE FROM properties WHERE root=? AND path=?").run(root, path);
  }
  insertProperty(r) {
    this.prep("INSERT OR IGNORE INTO properties(root,path,key,value,value_num,value_date,value_raw) VALUES(?,?,?,?,?,?,?)").run(r.root, r.path, r.key, r.value, r.valueNum, r.valueDate, r.valueRaw);
  }
  facets(keys, opts = {}) {
    const out = {};
    if (!keys.length) return out;
    const where = [`key IN (${keys.map(() => "?").join(",")})`];
    const args = [...keys];
    if (opts.root) {
      where.push("o.root = ?");
      args.push(opts.root);
    }
    const f = buildFilterClauses(opts.filters, "o");
    where.push(...f.clauses);
    args.push(...f.args);
    const sql = `SELECT key, value, COUNT(DISTINCT root || char(31) || path) n FROM properties o WHERE ${where.join(" AND ")} GROUP BY key, value`;
    for (const r of this.db.prepare(sql).all(...args)) {
      (out[r.key] ??= {})[r.value] = r.n;
    }
    return out;
  }
  getUserVersion() {
    return this.db.prepare("PRAGMA user_version").get().user_version;
  }
  setUserVersion(v) {
    this.db.exec(`PRAGMA user_version = ${Math.trunc(v)}`);
  }
  getMeta(k) {
    const r = this.db.prepare("SELECT v FROM kb_meta WHERE k=?").get(k);
    return r ? r.v : null;
  }
  setMeta(k, v) {
    this.db.prepare("INSERT INTO kb_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }
  deleteMeta(k) {
    this.db.prepare("DELETE FROM kb_meta WHERE k=?").run(k);
  }
  /** Every source root that owns rows (files, chunk map, properties) or a gate/engine record.
   *  Run `reconcileChunkMap` first so `item_rows` covers every chunk. Seeding reads it to find
   *  the roots of a snapshot. See change: add-kb-worktree-seed (D3). */
  rootsPresent() {
    const out = /* @__PURE__ */ new Set();
    for (const sql of ["SELECT DISTINCT root AS r FROM files", "SELECT DISTINCT root AS r FROM item_rows", "SELECT DISTINCT root AS r FROM properties"]) {
      for (const row of this.db.prepare(sql).all()) if (row.r != null) out.add(row.r);
    }
    for (const row of this.db.prepare("SELECT k FROM kb_meta WHERE k LIKE 'gate:%' OR k LIKE 'engine:%'").all()) {
      out.add(row.k.slice(row.k.indexOf(":") + 1));
    }
    return [...out];
  }
  /** Remove every row a source `root` owns, in one transaction: per-path rows via `deleteByPath`
   *  (chunks, heading nodes, owned edges, properties, file state), the file node demoted to a
   *  placeholder (inbound links keep their target), its `gate:`/`engine:` records, then the
   *  unreferenced path-less nodes. Needs a complete `item_rows` (`reconcileChunkMap`). A path
   *  shared with another root loses that root's graph rows too (known limitation).
   *  See change: add-kb-worktree-seed (D3). */
  dropRoot(root) {
    this.immediate(() => {
      const paths = /* @__PURE__ */ new Set();
      for (const sql of ["SELECT path FROM files WHERE root=?", "SELECT DISTINCT path FROM item_rows WHERE root=?", "SELECT DISTINCT path FROM properties WHERE root=?"]) {
        for (const r of this.prep(sql).all(root)) paths.add(r.path);
      }
      for (const p of paths) {
        this.deleteByPath(root, p);
        this.demoteNode(p);
      }
      this.prep("DELETE FROM kb_meta WHERE k=? OR k=?").run(`gate:${root}`, `engine:${root}`);
      this.sweepPlaceholders();
    });
  }
  /** Set every file's stored mtime of `roots` to -1 so the next walk re-hashes each file
   *  (content compare) instead of trusting an mtime recorded by another checkout. */
  invalidateMtimes(roots) {
    for (const r of roots) this.prep("UPDATE files SET mtime_ms=-1 WHERE root=?").run(r);
  }
  insertChunk(c) {
    const r = this.insertChunkRow(c);
    this.prep("INSERT OR IGNORE INTO item_rows(root,path,rid) VALUES(?,?,?)").run(c.root, c.path, Number(r.lastInsertRowid));
  }
  insertChunkRow(c) {
    return this.prep("INSERT INTO chunks(root,path,chunk_id,doc_type,parent_chunk_id,level,body_hash,heading_path,heading,body,start_line,end_line) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(c.root, c.path, c.chunkId, c.docType, c.parentChunkId, c.level, c.bodyHash, c.headingPath, c.heading, c.body, c.startLine ?? null, c.endLine ?? null);
  }
  addNode(n) {
    this.prep("INSERT INTO nodes(type,name,path) VALUES(?,?,?) ON CONFLICT(type,name) DO UPDATE SET path=COALESCE(excluded.path, nodes.path)").run(n.type, n.name, n.path);
  }
  addEdge(e) {
    const src = this.prep("SELECT id FROM nodes WHERE name=? LIMIT 1").get(e.src);
    const dst = this.prep("SELECT id FROM nodes WHERE name=? LIMIT 1").get(e.dst);
    if (!src || !dst) return;
    this.prep("INSERT OR IGNORE INTO edges(src,dst,rel,weight) VALUES(?,?,?,?)").run(src.id, dst.id, e.rel, e.weight ?? 1);
  }
  /** Porter stems for raw tokens, computed by SQLite's OWN tokenizer so they
   *  match what FTS5 actually indexed. A raw token is NOT a usable key into the
   *  vocab table: FTS5 stores `collaps`, and no prefix range anchored at
   *  `collapsed` can reach a key that sorts BEFORE it. The helper tables live in
   *  `temp.`, so this works against a read-only main DB. */
  stemReady = null;
  stemCache = /* @__PURE__ */ new Map();
  stems(tokens) {
    const out = /* @__PURE__ */ new Map();
    const missing = [...new Set(tokens.filter((t) => !this.stemCache.has(t)))];
    if (this.stemReady === null) {
      try {
        this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.kb_stem USING fts5(t, tokenize='porter unicode61')");
        this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.kb_stem_vocab USING fts5vocab(kb_stem, 'instance')");
        this.stemReady = true;
      } catch {
        this.stemReady = false;
      }
    }
    if (this.stemReady && missing.length) {
      try {
        this.db.exec("DELETE FROM temp.kb_stem");
        const ins = this.db.prepare("INSERT INTO temp.kb_stem(rowid, t) VALUES(?,?)");
        missing.forEach((t, i) => ins.run(i + 1, t));
        for (const r of this.db.prepare("SELECT term, doc FROM temp.kb_stem_vocab").all()) {
          const tok = missing[(Number(r.doc) || 0) - 1];
          if (tok !== void 0) this.stemCache.set(tok, String(r.term));
        }
      } catch {
      }
    }
    for (const t of tokens) out.set(t, this.stemCache.get(t) ?? t);
    return out;
  }
  /** Corpus document frequency for raw tokens, via the fts5vocab shadow table.
   *  Keys are exact porter stems (see `stems()`), so df is exact rather than a
   *  prefix over-estimate. `fts5vocab` is a live view over the FTS index, but
   *  `dfCache` is not — it is dropped on `commit()`/`deleteByPath`, the points at
   *  which an index batch can have moved the counts. Falls back to df=0 when the
   *  vocab table cannot be created (e.g. a read-only DB). */
  dfCache = /* @__PURE__ */ new Map();
  dfVersion = null;
  vocabReady = null;
  documentFrequencies(tokens) {
    const out = /* @__PURE__ */ new Map();
    const dv = this.dataVersion();
    if (this.dfVersion !== dv) {
      this.dfCache.clear();
      this.dfVersion = dv;
    }
    const stem = this.stems(tokens);
    const keys = [...new Set(tokens.map((t) => stem.get(t)))];
    const missing = keys.filter((k) => !this.dfCache.has(k));
    if (this.vocabReady === null) {
      try {
        if (this.existingOnly) {
          const persisted = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks_vocab'").get();
          if (!persisted) {
            this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.chunks_vocab_ro USING fts5vocab(main, chunks, 'row')");
            this.vocabTable = "temp.chunks_vocab_ro";
          }
        } else {
          this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vocab USING fts5vocab(chunks, 'row')");
        }
        this.vocabReady = true;
      } catch {
        this.vocabReady = false;
      }
    }
    if (this.vocabReady && missing.length) {
      const ph = missing.map(() => "?").join(",");
      try {
        const rows = this.db.prepare(`SELECT term, doc FROM ${this.vocabTable} WHERE term IN (${ph})`).all(...missing);
        for (const k of missing) this.dfCache.set(k, 0);
        for (const r of rows) this.dfCache.set(String(r.term), Number(r.doc) || 0);
      } catch {
      }
    }
    for (const t of tokens) out.set(t, this.dfCache.get(stem.get(t)) ?? 0);
    return out;
  }
  /** IDF weights for the given tokens over the current corpus. */
  idf(tokens) {
    const n = Math.max(1, this.counts().chunks);
    const df = this.documentFrequencies(tokens);
    const out = /* @__PURE__ */ new Map();
    for (const t of tokens) out.set(t, Math.log(1 + n / (1 + (df.get(t) ?? 0))));
    return out;
  }
  search(query, opts = {}) {
    const num = (v, dflt, min, max) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
    };
    const fw = opts.fieldWeights;
    const w = {
      headingPath: num(fw?.headingPath, 8, 0, 1e3),
      heading: num(fw?.heading, 4, 0, 1e3),
      body: num(fw?.body, 1, 0, 1e3)
    };
    const limit = num(opts.limit, 10, 1, 1e3);
    const wantDedup = opts.dedup !== false;
    const wantSourceDedup = opts.sourceDedup !== false;
    const wantCoverage = opts.coverageRerank === true;
    const fetch = Math.min(4e3, wantSourceDedup ? limit * 6 : wantDedup ? limit * 4 : limit);
    const qterms = tokenize(query);
    const pass = (match2, docType, depth = fetch) => {
      const where = ["chunks MATCH ?"];
      const args = [match2];
      if (opts.root) {
        where.push("root = ?");
        args.push(opts.root);
      }
      if (docType) {
        where.push("doc_type = ?");
        args.push(docType);
      }
      if (opts.pathPrefix?.length) {
        where.push(`(${opts.pathPrefix.map(() => "path LIKE ? ESCAPE '\\'").join(" OR ")})`);
        args.push(...opts.pathPrefix.map((p) => `${p.replace(/[\\%_]/g, "\\$&")}%`));
      }
      const ff = buildFilterClauses(opts.filters, "chunks");
      where.push(...ff.clauses);
      args.push(...ff.args);
      const sql = `SELECT root, path, chunk_id chunkId, doc_type docType, body_hash bodyHash,
      parent_chunk_id parentChunkId, heading_path headingPath, heading, body,
      bm25(chunks, 0,0,0,0,0,0,0, ${w.headingPath}, ${w.heading}, ${w.body}, 0,0) score,
      snippet(chunks, 9, '[', ']', ' \u2026 ', 12) snippet
      FROM chunks WHERE ${where.join(" AND ")} ORDER BY score LIMIT ${depth}`;
      return this.db.prepare(sql).all(...args);
    };
    const mode = opts.queryExpansion ?? "off";
    let match = toMatch(expandQuery(query, opts));
    if (!match) return [];
    let extraTerms = [];
    if (mode === "prf" && wantCoverage) {
      extraTerms = this.prfTerms(query, qterms, pass(match, opts.docType), opts);
      if (extraTerms.length) match = toMatch(`${query} ${extraTerms.join(" ")}`);
    }
    const laneShare = opts.docType ? 0 : Math.min(1, Math.max(0, Number(opts.laneQuota ?? 0.5) || 0));
    const mainRows = pass(match, opts.docType);
    const agentsRows = laneShare > 0 ? pass(match, "agents") : [];
    const bodies = /* @__PURE__ */ new Map();
    const lane = (rows, captureRawBest) => {
      let hits2 = rows.map((r) => {
        bodies.set(r.chunkId, r.body);
        let score = r.score;
        if (opts.proximityBoost) score += proximityDelta(qterms, r.body);
        return { root: r.root, path: r.path, headingPath: r.headingPath, chunkId: r.chunkId, docType: r.docType, score, snippet: r.snippet, parentChunkId: r.parentChunkId };
      });
      if (wantDedup) {
        const prio = opts.rootPriority ?? {};
        const byChunk = new Map(rows.map((r) => [r.chunkId, r]));
        const groups = /* @__PURE__ */ new Map();
        for (const h of hits2) {
          const key = byChunk.get(h.chunkId).bodyHash;
          (groups.get(key) ?? groups.set(key, []).get(key)).push(h);
        }
        hits2 = [];
        for (const g of groups.values()) {
          g.sort((a, b) => (prio[b.root] ?? 0) - (prio[a.root] ?? 0) || a.score - b.score);
          const head = g[0];
          if (g.length > 1) head.akaPaths = g.slice(1).map((x) => x.path);
          hits2.push(head);
        }
        hits2.sort((a, b) => a.score - b.score);
      }
      if (wantSourceDedup) {
        const groups = /* @__PURE__ */ new Map();
        for (const h of hits2) {
          const key = `${h.root}${h.path}`;
          (groups.get(key) ?? groups.set(key, []).get(key)).push(h);
        }
        hits2 = [];
        for (const g of groups.values()) {
          g.sort((a, b) => a.score - b.score);
          const head = g[0];
          head.suppressedSections = g.length - 1;
          hits2.push(head);
        }
        hits2.sort((a, b) => a.score - b.score);
      }
      if (captureRawBest && hits2.length) captureRawBest(hits2.reduce((b, h) => Math.min(b, h.score), Number.POSITIVE_INFINITY));
      const div = opts.diversity;
      if (div?.enabled) hits2 = mmr(hits2, bodies, div.lambda, fetch);
      if (wantCoverage) hits2 = this.coverageRerank(hits2, bodies, qterms, extraTerms);
      return hits2;
    };
    const leadMargin = Math.min(1, Math.max(0, Number(opts.laneLeadMargin ?? 0) || 0));
    let mainBest = Number.NaN;
    let reservedBest = Number.NaN;
    const main = lane(mainRows, (b) => {
      mainBest = b;
    });
    let hits;
    if (laneShare > 0 && agentsRows.length) {
      const reserved = lane(agentsRows, (b) => {
        reservedBest = b;
      });
      const leadFirst = leadMargin > 0 && Number.isFinite(mainBest) && Number.isFinite(reservedBest) && reservedBest - mainBest <= leadMargin * Math.abs(mainBest);
      hits = interleaveLanes(main, reserved, laneShare, limit, wantSourceDedup, leadFirst);
    } else {
      hits = main.slice(0, limit);
    }
    if (opts.rerank) {
      const rer = opts.reranker;
      if (rer) {
        const reranked = rer(query, hits);
        if (!(reranked instanceof Promise)) hits = reranked;
      }
    }
    if (opts.expandParent) {
      for (const h of hits) {
        const pc = h.parentChunkId;
        if (!pc) continue;
        const parent = this.getChunkById(h.root, pc);
        if (parent && parent.chunkId !== h.chunkId) {
          h.parent = { headingPath: parent.headingPath };
        }
      }
    }
    return hits.map(({ ...h }) => {
      delete h.parentChunkId;
      return h;
    });
  }
  /** Resolve a node argument to ids: exact name first (file path, qualified
   *  `<file>#<heading path>`, tag); else, when it carries no `#`, every heading node
   *  whose heading-path part equals it (union over files). Exact comparison via the
   *  node's own `path`, never LIKE. See change: fix-kb-index-integrity (D4). */
  resolveNodeIds(name) {
    const exact = this.prep("SELECT id FROM nodes WHERE name = ?").all(name);
    if (exact.length || name.includes("#")) return exact.map((r) => r.id);
    return this.prep(
      "SELECT id FROM nodes WHERE type='heading' AND path IS NOT NULL AND substr(name, 1, length(path) + 1) = path || '#' AND substr(name, length(path) + 2) = ?"
    ).all(name).map((r) => r.id);
  }
  neighbors(node, depth, rel) {
    const seeds = this.resolveNodeIds(node);
    if (!seeds.length) return [];
    const ph = seeds.map(() => "?").join(",");
    const relClause = rel ? "AND e.rel = ?" : "";
    const sql = `
      WITH RECURSIVE reach(id, d) AS (
        SELECT id, 0 FROM nodes WHERE id IN (${ph})
        UNION
        SELECT e.dst, r.d+1 FROM edges e JOIN reach r ON e.src = r.id
        WHERE r.d < ? ${relClause}
      )
      SELECT DISTINCT n.type, n.name, n.path FROM reach JOIN nodes n USING(id) WHERE n.id NOT IN (${ph})`;
    const params = [...seeds, depth];
    if (rel) params.push(rel);
    params.push(...seeds);
    return this.db.prepare(sql).all(...params).map((r) => ({ type: r.type, name: r.name, path: r.path }));
  }
  backlinks(node) {
    const targets = this.resolveNodeIds(node);
    if (!targets.length) return [];
    const sql = `SELECT DISTINCT n.type, n.name, n.path FROM edges e
      JOIN nodes n ON e.src = n.id WHERE e.dst IN (${targets.map(() => "?").join(",")})`;
    return this.db.prepare(sql).all(...targets).map((r) => ({ type: r.type, name: r.name, path: r.path }));
  }
  /** Fetch a chunk by path (+ optional section). A path-only fetch of a
   *  multi-chunk file returns the FIRST chunk plus a `suppressedSections` count
   *  — it must never silently hand back one arbitrary slice of N (design D7). */
  getChunk(root, path, headingPath) {
    if (headingPath) {
      const r2 = this.db.prepare("SELECT * FROM chunks WHERE root=? AND path=? AND heading_path=? LIMIT 1").get(root, path, headingPath);
      return r2 ? rowToChunk(r2) : null;
    }
    const r = this.db.prepare("SELECT * FROM chunks WHERE root=? AND path=? ORDER BY rowid LIMIT 1").get(root, path);
    if (!r) return null;
    const n = this.db.prepare("SELECT COUNT(*) n FROM chunks WHERE root=? AND path=?").get(root, path).n;
    return { ...rowToChunk(r), suppressedSections: Math.max(0, n - 1) };
  }
  /** All chunks of a file in document order — the non-truncating companion to a
   *  path-only `getChunk`. */
  getChunks(root, path) {
    return this.db.prepare("SELECT * FROM chunks WHERE root=? AND path=? ORDER BY rowid").all(root, path).map(rowToChunk);
  }
  /** Rerank by IDF-weighted coverage of the ORIGINAL query terms, BM25 as the
   *  tiebreak. PRF-appended terms count at half weight so expansion can never
   *  dominate the sort (design D4). */
  coverageRerank(hits, bodies, qterms, extraTerms) {
    if (!qterms.length || hits.length < 2) return hits;
    const all = [...qterms, ...extraTerms];
    const idf = this.idf(all);
    const cov = /* @__PURE__ */ new Map();
    for (const h of hits) {
      const toks = new Set(tokenize(`${h.headingPath} ${bodies.get(h.chunkId) ?? ""}`));
      let c = 0;
      for (const t of qterms) if (hasStem(toks, t)) c += idf.get(t) ?? 0;
      for (const t of extraTerms) if (hasStem(toks, t)) c += 0.5 * (idf.get(t) ?? 0);
      cov.set(h.chunkId, c);
    }
    return [...hits].sort((a, b) => cov.get(b.chunkId) - cov.get(a.chunkId) || a.score - b.score);
  }
  /** RM3-style pseudo-relevance feedback: mine the top candidates of a first
   *  pass for terms absent from the query and below the corpus-frequency
   *  ceiling, rank by freq × IDF, return the top `terms` (design D4). */
  prfTerms(query, qterms, firstPass, opts) {
    const cfg = opts.prf ?? {};
    const want = Math.max(0, Math.trunc(cfg.terms ?? 6));
    const topK = Math.max(1, Math.trunc(cfg.topK ?? 10));
    const ceiling = Math.min(1, Math.max(0, cfg.dfCeiling ?? 0.1));
    if (!want || firstPass.length < MIN_FEEDBACK_DOCS) return [];
    const seen = new Set(qterms);
    const freq = /* @__PURE__ */ new Map();
    for (const r of firstPass.slice(0, topK)) {
      for (const t of tokenize(`${r.headingPath} ${r.body}`)) {
        if (seen.has(t)) continue;
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    const cands = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
    if (!cands.length) return [];
    const n = Math.max(1, this.counts().chunks);
    const df = this.documentFrequencies(cands);
    return cands.filter((t) => (df.get(t) ?? 0) / n <= ceiling).map((t) => [t, (freq.get(t) ?? 0) * Math.log(1 + n / (1 + (df.get(t) ?? 0)))]).sort((a, b) => b[1] - a[1]).slice(0, want).map(([t]) => t);
  }
  getChunkById(root, chunkId) {
    const r = this.db.prepare("SELECT * FROM chunks WHERE root=? AND chunk_id=? LIMIT 1").get(root, chunkId);
    return r ? rowToChunk(r) : null;
  }
  counts() {
    const c = (q) => this.db.prepare(q).get().n;
    return {
      files: c("SELECT COUNT(*) n FROM files"),
      chunks: c("SELECT COUNT(*) n FROM chunks"),
      nodes: c("SELECT COUNT(*) n FROM nodes"),
      edges: c("SELECT COUNT(*) n FROM edges")
    };
  }
}
const MIN_FEEDBACK_DOCS = 5;
const STOP = new Set("the for and how what with you your does can from that this are into use using get set all a an of to in on is be as it or by at do".split(" "));
const FOLD_EXCEPTIONS = {
  "\u017F": "s",
  "\u1E9B": "s",
  "\u03C2": "\u03C3",
  "\xB5": "\u03BC",
  "\u03D0": "\u03B2",
  "\u03D1": "\u03B8",
  "\u03D5": "\u03C6",
  "\u03D6": "\u03C0",
  "\u03F0": "\u03BA",
  "\u03F1": "\u03C1",
  "\u03F5": "\u03B5",
  "\u1FBE": "\u03B9"
};
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const ASCII_LETTER = /^[A-Za-z]$/;
const NONSPACING_MARK = new RegExp("^\\p{Mn}$", "u");
const COMBINING_MARK = new RegExp("^\\p{M}$", "u");
function foldChar(ch) {
  const ex = FOLD_EXCEPTIONS[ch];
  if (ex !== void 0) return ex;
  if (NONSPACING_MARK.test(ch)) return "";
  const d = ch.normalize("NFD");
  if (d.length === 2 && ASCII_LETTER.test(d[0]) && COMBINING_MARK.test(d[1])) return d[0];
  return ch;
}
function fold(s) {
  if (ASCII_ONLY.test(s)) return s.toLowerCase();
  return s.replace(/[^\x00-\x7f]/gu, foldChar).toLowerCase().replace(/\u03c2/g, "\u03C3");
}
function rawTokens(s) {
  return fold(s).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}
function tokenize(s) {
  return rawTokens(s).filter((t) => !STOP.has(t));
}
function rowToChunk(r) {
  const c = { root: r.root, path: r.path, chunkId: r.chunk_id, headingPath: r.heading_path, heading: r.heading, level: r.level, parentChunkId: r.parent_chunk_id, docType: r.doc_type, body: r.body, bodyHash: r.body_hash };
  if (r.start_line != null) c.startLine = Number(r.start_line);
  if (r.end_line != null) c.endLine = Number(r.end_line);
  return c;
}
function expandQuery(query, opts) {
  const mode = opts.queryExpansion ?? "off";
  if (mode !== "synonym" || !opts.synonyms) return query;
  const extra = [];
  for (const t of tokenize(query)) for (const syn of opts.synonyms[t] ?? []) extra.push(syn);
  return extra.length ? `${query} ${extra.join(" ")}` : query;
}
const STEM_MIN = 4;
function hasStem(tokens, term) {
  if (tokens.has(term)) return true;
  if (term.length < STEM_MIN) return false;
  for (const t of tokens) {
    if (t.length < STEM_MIN) continue;
    if (t.startsWith(term) || term.startsWith(t)) return true;
  }
  return false;
}
function interleaveLanes(main, reserved, share, limit, dedupSources, leadFirst = false) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  let mi = 0;
  let ri = 0;
  let taken = 0;
  const next = (arr, i) => {
    if (!dedupSources) return i;
    while (i < arr.length && seen.has(`${arr[i].root}${arr[i].path}`)) i++;
    return i;
  };
  while (out.length < limit) {
    mi = next(main, mi);
    ri = next(reserved, ri);
    const mHas = mi < main.length;
    const rHas = ri < reserved.length;
    if (!mHas && !rHas) break;
    const wantReserved = rHas && (!mHas || out.length === 0 && leadFirst || (taken + 1) / (out.length + 1) <= share);
    const pick = wantReserved ? reserved[ri++] : main[mi++];
    if (wantReserved) taken++;
    if (dedupSources) seen.add(`${pick.root}${pick.path}`);
    out.push(pick);
  }
  return out;
}
function proximityDelta(queryTerms, body) {
  if (queryTerms.length < 2) return 0;
  const tokens = rawTokens(body);
  const pos = /* @__PURE__ */ Object.create(null);
  tokens.forEach((t, i) => {
    (pos[t] ??= []).push(i);
  });
  let best = Infinity;
  const qt = queryTerms;
  const walk = (idx, start, span) => {
    if (idx === qt.length) {
      best = Math.min(best, span);
      return;
    }
    const arr = pos[qt[idx]];
    if (!arr) return;
    for (const p of arr) {
      if (p < start) continue;
      walk(idx + 1, p, idx === 0 ? 0 : span + (p - start));
      if (best === 1) return;
    }
  };
  walk(0, -1, 0);
  if (!isFinite(best)) return 0;
  return -Math.max(0, 2 - best / 20);
}
function mmr(ranked, bodies, lambda, limit) {
  if (ranked.length <= limit) return ranked;
  const tok = (h) => new Set(tokenize(bodies.get(h.chunkId) ?? h.headingPath));
  const sets = /* @__PURE__ */ new Map();
  ranked.forEach((h) => sets.set(h.chunkId, tok(h)));
  const jaccard = (a, b) => {
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
  };
  const out = [ranked[0]];
  const remaining = ranked.slice(1);
  while (out.length < limit && remaining.length) {
    let bestI = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const h = remaining[i];
      const rel = -h.score;
      let maxSim = 0;
      for (const o of out) maxSim = Math.max(maxSim, jaccard(sets.get(h.chunkId), sets.get(o.chunkId)));
      const score = lambda * rel - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    out.push(remaining.splice(bestI, 1)[0]);
  }
  return out;
}
export {
  SCHEMA_VERSION,
  SqliteFtsStore,
  rawTokens,
  tokenize
};
