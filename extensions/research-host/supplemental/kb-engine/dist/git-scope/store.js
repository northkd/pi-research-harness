import { SqliteFtsStore } from "../sqlite-store.js";
import { ensureRepoDir } from "./repo.js";
const GIT_ROOT = "git";
const GIT_DDL = `
CREATE TABLE IF NOT EXISTS git_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS git_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT, nonce TEXT, expires_at INTEGER);
INSERT OR IGNORE INTO git_lease (id, owner, nonce, expires_at) VALUES (1, '', '', 0);
CREATE TABLE IF NOT EXISTS git_comments (kind TEXT, n INTEGER, json TEXT, etag TEXT, fetched_at INTEGER, PRIMARY KEY (kind, n));
`;
const isBusy = (e) => /locked|busy/i.test(e?.message ?? "");
const sleepSync = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function hasGitSupport(store) {
  return typeof store.immediate === "function" && typeof store.replaceItem === "function" && typeof store.ensureNode === "function" && typeof store.findPathsByPrefix === "function" && typeof store.read === "function";
}
function openGitStore(repo, baseDir, busyMs) {
  ensureRepoDir(repo, baseDir);
  let last;
  for (let attempt = 0; attempt < 12; attempt++) {
    let store = null;
    try {
      store = new SqliteFtsStore(repo.dbPath, { busyTimeoutMs: 2e3 });
      store.init();
      store.immediate((db) => db.exec(GIT_DDL));
      store.setBusyTimeout(busyMs);
      return store;
    } catch (e) {
      last = e;
      try {
        store?.close();
      } catch {
      }
      if (!isBusy(e)) throw e;
      sleepSync(40 + attempt * 20);
    }
  }
  throw last;
}
function metaGet(db, key) {
  const r = db.prepare("SELECT value FROM git_meta WHERE key=?").get(key);
  return r ? r.value : null;
}
function metaSet(db, key, value) {
  db.prepare("INSERT INTO git_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function metaDelete(db, key) {
  db.prepare("DELETE FROM git_meta WHERE key=?").run(key);
}
function metaJson(db, key) {
  const v = metaGet(db, key);
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
function metaSetJson(db, key, value) {
  metaSet(db, key, JSON.stringify(value));
}
export {
  GIT_ROOT,
  hasGitSupport,
  metaDelete,
  metaGet,
  metaJson,
  metaSet,
  metaSetJson,
  openGitStore
};
