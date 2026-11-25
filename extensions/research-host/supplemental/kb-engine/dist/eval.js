import { existsSync, readdirSync } from "node:fs";
const MSG_SHAPES = `a bare array of {q, expect} items or an object with an "items" array`;
function loadGolden(raw, file) {
  const isObj = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const items = Array.isArray(raw) ? raw : isObj && Array.isArray(raw.items) ? raw.items : void 0;
  if (!items) throw new Error(`golden fixture must be ${MSG_SHAPES} \u2014 got neither in ${file}`);
  const out = items.map((it, i) => {
    if (it === null || typeof it !== "object" || typeof it.q !== "string" || typeof it.expect !== "string") {
      throw new Error(`${file}: golden item [${i}] must be an object with string "q" and string "expect"`);
    }
    return { q: it.q, expect: it.expect };
  });
  const p = isObj ? raw : void 0;
  if (p && (p.intent !== void 0 || p.minedAt !== void 0)) {
    console.error(`[kb eval] golden set ${file}: intent=${JSON.stringify(p.intent ?? null)} minedAt=${JSON.stringify(p.minedAt ?? null)} n=${out.length}`);
  }
  return out;
}
function normPrefix(p) {
  return (p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function hasSep(expect) {
  return expect.includes("/") || expect.includes("\\");
}
function firstSeg(expect) {
  return normPrefix(expect).split("/")[0];
}
function evaluate(store, golden, opts = {}) {
  const { k = 10, roots, verbose, ...search } = opts;
  const firstSegs = /* @__PURE__ */ new Set();
  const topSegs = /* @__PURE__ */ new Set();
  for (const r of roots ?? []) {
    if (r.dir && existsSync(r.dir)) {
      try {
        for (const e of readdirSync(r.dir)) topSegs.add(e);
      } catch {
      }
    }
    const rel = normPrefix(r.relPrefix);
    if (rel) firstSegs.add(rel.split("/")[0]);
  }
  const isUnreachable = (expect) => {
    if (!hasSep(expect)) return false;
    const seg = firstSeg(expect);
    if (firstSegs.has(seg)) return false;
    return !topSegs.has(seg);
  };
  const prefixes = (roots ?? []).map((r) => normPrefix(r.relPrefix)).filter((p) => p.length > 0).sort((a, b) => b.length - a.length);
  const candidates = (expect) => {
    for (const p of prefixes) {
      if (expect.startsWith(p + "/") || expect.startsWith(p + "\\")) return [expect.slice(p.length + 1), expect];
    }
    return [expect];
  };
  let p1 = 0, p5 = 0, recall = 0, mrr = 0, ndcg = 0, lat = 0, searched = 0;
  let distinct = 0, dupShare = 0, singleSource = 0, pages = 0;
  const unreachablePaths = [];
  for (const g of golden) {
    if (isUnreachable(g.expect)) {
      unreachablePaths.push(g.expect);
      continue;
    }
    const cands = candidates(g.expect);
    const t = performance.now();
    const res = store.search(g.q, { ...search, limit: k });
    lat += performance.now() - t;
    searched++;
    let first = 0;
    res.forEach((r, i) => {
      if (!first && cands.some((c) => r.path.includes(c))) first = i + 1;
    });
    if (first === 1) p1++;
    if (first >= 1 && first <= 5) p5++;
    if (first >= 1) {
      recall++;
      mrr += 1 / first;
      ndcg += 1 / Math.log2(first + 1);
    }
    if (res.length) {
      const sources = new Set(res.map((r) => `${r.root}${r.path}`));
      distinct += sources.size;
      dupShare += (res.length - sources.size) / res.length;
      if (sources.size === 1) singleSource++;
      pages++;
    }
  }
  const n = searched;
  const m = {
    n,
    "P@1": +(p1 / (n || 1)).toFixed(3),
    "P@5": +(p5 / (n || 1)).toFixed(3),
    "Recall@K": +(recall / (n || 1)).toFixed(3),
    MRR: +(mrr / (n || 1)).toFixed(3),
    "nDCG@K": +(ndcg / (n || 1)).toFixed(3),
    distinctSourcesAtK: +(distinct / (pages || 1)).toFixed(3),
    duplicateSlotShare: +(dupShare / (pages || 1)).toFixed(3),
    singleSourcePageRate: +(singleSource / (pages || 1)).toFixed(3),
    avgLatencyMs: +(lat / (n || 1)).toFixed(2),
    unreachable: unreachablePaths.length
  };
  if (verbose) m.unreachablePaths = [...unreachablePaths];
  return m;
}
export {
  evaluate,
  loadGolden
};
