import { createHash } from "node:crypto";
import { ForgeRateLimited, ForgeUnavailable } from "./forge/types.js";
import { LeaseLostError } from "./lease.js";
import { buildEdges, repointIssuePlaceholder, sharedNumberSpace } from "./links.js";
import { GIT_ROOT, metaDelete, metaGet, metaJson, metaSet, metaSetJson } from "./store.js";
const DEFAULT_BACKOFF_MS = 15 * 6e4;
const DAY_MS = 864e5;
function itemChunk(i) {
  const path = `${i.kind}/${i.number}`;
  const body = [i.title, "", ...i.labels.length ? [`Labels: ${i.labels.join(", ")}`] : [], `State: ${i.state}`, `Author: @${i.author}`, `Created: ${i.createdAt}`, `Updated: ${i.updatedAt}`, ...i.body.trim() ? ["", i.body.trim()] : []].join("\n");
  return {
    root: GIT_ROOT,
    path,
    chunkId: `${path}#0`,
    headingPath: `${i.kind} #${i.number} [${i.state}] \xB7 ${i.updatedAt.slice(0, 10)} \xB7 @${i.author} > ${i.title}`,
    heading: i.title,
    level: 0,
    parentChunkId: null,
    docType: "doc",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex")
  };
}
function readForgeState(store) {
  return store.read((db) => ({
    lastSyncAt: Number(metaGet(db, "forge.lastSyncAt") ?? 0),
    lastAttemptAt: Number(metaGet(db, "forge.lastAttemptAt") ?? 0),
    rate: metaJson(db, "forge.rate"),
    backoffUntil: Number(metaGet(db, "forge.backoffUntil") ?? 0),
    unavailable: metaGet(db, "forge.unavailable"),
    lastError: metaGet(db, "forge.lastError"),
    identity: metaGet(db, "forge.identity")
  }));
}
function rateFloorActive(rate, floorPercent, now) {
  if (!rate || rate.limit <= 0 || now >= rate.resetAt) return false;
  return rate.remaining / rate.limit * 100 < floorPercent;
}
function forgeSyncDue(s, cfg, now, hintMs, bypassInterval = false) {
  if (now < s.backoffUntil) return false;
  if (rateFloorActive(s.rate, cfg.forge.rateFloorPercent, now)) return false;
  if (bypassInterval) return true;
  const last = Math.max(s.lastSyncAt, s.lastAttemptAt);
  if (last === 0) return true;
  const hinted = hintMs !== null && hintMs > s.lastSyncAt;
  const interval = (hinted ? cfg.forge.hintedMinSyncIntervalSeconds : cfg.forge.minSyncIntervalSeconds) * 1e3;
  return now - last >= interval;
}
function reconcileForgeIdentity(store, identity) {
  const want = identity ?? "";
  const seen = store.read((db) => metaGet(db, "forge.identity"));
  if (seen !== null && seen === want) return;
  store.immediate((db) => {
    const cur = metaGet(db, "forge.identity");
    if (cur !== null && cur === want) return;
    db.prepare("DELETE FROM chunks WHERE rowid IN (SELECT rid FROM item_rows WHERE root=? AND (path LIKE 'pr/%' OR path LIKE 'issue/%'))").run(GIT_ROOT);
    db.prepare("DELETE FROM item_rows WHERE root=? AND (path LIKE 'pr/%' OR path LIKE 'issue/%')").run(GIT_ROOT);
    db.prepare("DELETE FROM edges WHERE src IN (SELECT id FROM nodes WHERE type='file' AND path IS NOT NULL AND (name LIKE 'pr/%' OR name LIKE 'issue/%'))").run();
    db.prepare("UPDATE nodes SET path=NULL WHERE type='file' AND (name LIKE 'pr/%' OR name LIKE 'issue/%')").run();
    db.prepare("DELETE FROM nodes WHERE type='file' AND path IS NULL AND (name LIKE 'pr/%' OR name LIKE 'issue/%') AND id NOT IN (SELECT dst FROM edges)").run();
    db.prepare("DELETE FROM git_comments").run();
    db.prepare("DELETE FROM git_meta WHERE key LIKE 'forge.%'").run();
    metaSet(db, "forge.identity", want);
  });
}
const ms = (iso) => Date.parse(iso);
function nextCursor(cur, items, full) {
  if (items.length === 0) return { since: cur.since, page: 1, first: false };
  const firstTs = items[0].updatedAt;
  const lastTs = items[items.length - 1].updatedAt;
  const advanced = ms(lastTs) > ms(cur.since) ? lastTs : cur.since;
  if (!full) return { since: advanced, page: 1, first: false };
  if (ms(firstTs) === ms(lastTs)) return { since: lastTs, page: ms(cur.since) === ms(lastTs) ? cur.page + 1 : 2, first: cur.first };
  return { since: lastTs, page: 1, first: cur.first };
}
function applyItem(a, db, item) {
  const chunk = itemChunk(item);
  a.store.replaceItem(GIT_ROOT, chunk.path, [chunk], buildEdges(db, chunk.path, `${item.title}
${item.body}`, a.link));
  if (item.kind === "pr" && sharedNumberSpace(a.adapter.id)) repointIssuePlaceholder(db, item.number);
}
class StopSync extends Error {
  by;
  constructor(by) {
    super(by);
    this.by = by;
  }
}
function applyPage(a, ep, used, next, page) {
  a.lease.fenced((db) => {
    if (metaGet(db, "forge.identity") !== a.identity) throw new LeaseLostError();
    for (const item of page.items) applyItem(a, db, item);
    if (page.rate) metaSetJson(db, "forge.rate", page.rate);
    metaSetJson(db, `forge.cursor.${ep}`, next);
    if (page.status === "ok" && used.page === 1 && page.etag) metaSetJson(db, `forge.etag.${ep}`, { etag: page.etag, since: used.since });
  });
}
function validatorFor(store, ep, cursor) {
  if (cursor.page !== 1) return null;
  const et = store.read((db) => metaJson(db, `forge.etag.${ep}`));
  return et && ms(et.since) === ms(cursor.since) ? et.etag : null;
}
function mayRequest(a, cursor, applied) {
  if (a.signal.aborted) throw new Error("aborted");
  if (rateFloorActive(a.store.read((db) => metaJson(db, "forge.rate")), a.cfg.forge.rateFloorPercent, a.deps.now())) throw new StopSync("rate-floor");
  if (cursor.first && applied >= a.cfg.forge.firstSyncMaxItems) return false;
  if (!a.lease.extend()) throw new LeaseLostError();
  return true;
}
async function syncEndpoint(a, ep, stats) {
  const { deps, cfg, store } = a;
  let cursor = store.read((db) => metaJson(db, `forge.cursor.${ep}`)) ?? { since: new Date(deps.now() - cfg.forge.firstSyncWindowDays * DAY_MS).toISOString(), page: 1, first: true };
  let applied = 0;
  for (let pages = 0; pages < cfg.forge.pagesPerSync; pages++) {
    if (!mayRequest(a, cursor, applied)) break;
    const used = cursor;
    const page = await a.adapter.list(ep, { since: used.since, page: used.page, etag: validatorFor(store, ep, used), signal: a.signal });
    stats.requests++;
    if (page.status === "not_modified") stats.notModified++;
    const next = page.status === "not_modified" ? used : nextCursor(used, page.items, page.full);
    applyPage(a, ep, used, next, page);
    stats.items += page.items.length;
    applied += page.items.length;
    cursor = next;
    if (page.status === "not_modified" || !page.full) return;
  }
  stats.capped = true;
}
async function syncForge(a) {
  const t0 = Date.now();
  const stats = { requests: 0, notModified: 0, items: 0, capped: false, stoppedBy: null };
  const record = (fn) => a.lease.fenced(fn);
  try {
    for (const ep of a.adapter.endpoints) await syncEndpoint(a, ep, stats);
    record((db) => {
      metaSet(db, "forge.lastSyncAt", String(a.deps.now()));
      metaDelete(db, "forge.unavailable");
      metaDelete(db, "forge.backoffUntil");
      metaDelete(db, "forge.lastError");
    });
  } catch (e) {
    if (e instanceof LeaseLostError || a.signal.aborted) throw e;
    const now = a.deps.now();
    if (e instanceof StopSync) {
      stats.stoppedBy = e.by;
    } else if (e instanceof ForgeRateLimited) {
      stats.stoppedBy = "back-off";
      record((db) => {
        metaSet(db, "forge.backoffUntil", String(e.retryAt ?? now + DEFAULT_BACKOFF_MS));
        metaSet(db, "forge.lastAttemptAt", String(now));
        if (e.rate) metaSetJson(db, "forge.rate", e.rate);
      });
    } else if (e instanceof ForgeUnavailable) {
      stats.stoppedBy = "unavailable";
      record((db) => {
        metaSet(db, "forge.unavailable", e.reason);
        metaSet(db, "forge.lastAttemptAt", String(now));
      });
    } else {
      stats.stoppedBy = "error";
      record((db) => {
        metaSet(db, "forge.lastError", `forge sync failed: ${e.message}`);
        metaSet(db, "forge.lastAttemptAt", String(now));
      });
    }
  }
  const rate = a.store.read((db) => metaJson(db, "forge.rate"));
  const cursors = a.adapter.endpoints.map((ep) => a.store.read((db) => metaGet(db, `forge.cursor.${ep}`)) ?? "none").join(",");
  a.deps.log(
    `forge=${a.adapter.id} endpoints=${a.adapter.endpoints.join("+")} requests=${stats.requests} not_modified=${stats.notModified} items=${stats.items} remaining=${rate?.remaining ?? "?"}/${rate?.limit ?? "?"} cursor=${cursors} capped=${stats.capped} stopped=${stats.stoppedBy ?? "no"} ms=${Date.now() - t0}`
  );
  return stats;
}
export {
  forgeSyncDue,
  rateFloorActive,
  readForgeState,
  reconcileForgeIdentity,
  syncForge
};
