import { cliRequest } from "./cli.js";
import { PAGE_SIZE } from "./types.js";
function gitlabRate(h) {
  const remaining = Number(h["ratelimit-remaining"]);
  const limit = Number(h["ratelimit-limit"]);
  const reset = Number(h["ratelimit-reset"]);
  if (h["ratelimit-remaining"] === void 0 || h["ratelimit-limit"] === void 0 || !Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return null;
  return { remaining, limit, resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1e3 : 0 };
}
function mapGitlabItem(kind, i) {
  return {
    kind,
    number: i.iid,
    title: i.title ?? "",
    body: i.description ?? "",
    state: i.state === "merged" ? "merged" : i.state === "closed" ? "closed" : "open",
    author: i.author?.username ?? "ghost",
    labels: (i.labels ?? []).map((l) => typeof l === "string" ? l : l.name ?? "").filter(Boolean),
    createdAt: i.created_at ?? "",
    updatedAt: i.updated_at ? new Date(i.updated_at).toISOString() : ""
  };
}
function createGitlabAdapter(deps, ref) {
  const project = `projects/${encodeURIComponent(ref.path)}`;
  const call = (endpoint, etag, signal) => cliRequest(deps, { cli: "glab", args: ["api", "-i", "--hostname", ref.host, ...etag ? ["-H", `If-None-Match: ${etag}`] : [], endpoint] }, gitlabRate, signal);
  return {
    id: "gitlab",
    endpoints: ["issues", "merge_requests"],
    sharedNumberSpace: false,
    async list(ep, a) {
      const q = `scope=all&updated_after=${encodeURIComponent(a.since)}&order_by=updated_at&sort=asc&per_page=${PAGE_SIZE}&page=${a.page}`;
      const r = await call(`${project}/${ep}?${q}`, a.etag, a.signal);
      if (r.status === 304) return { status: "not_modified", items: [], full: false, etag: a.etag, rate: r.rate };
      const rows = JSON.parse(r.body || "[]");
      const kind = ep === "merge_requests" ? "pr" : "issue";
      return { status: "ok", items: rows.map((i) => mapGitlabItem(kind, i)), full: rows.length >= PAGE_SIZE, etag: r.headers.etag ?? null, rate: r.rate };
    },
    async comments(kind, n, etag, signal) {
      const r = await call(`${project}/${kind === "pr" ? "merge_requests" : "issues"}/${n}/notes?sort=asc&per_page=${PAGE_SIZE}`, etag, signal);
      if (r.status === 304) return { status: "not_modified", comments: [], etag, rate: r.rate };
      const rows = JSON.parse(r.body || "[]");
      const comments = rows.filter((c) => !c.system).map((c) => ({ author: c.author?.username ?? "ghost", createdAt: c.created_at ?? "", body: c.body ?? "" }));
      return { status: "ok", comments, etag: r.headers.etag ?? null, rate: r.rate };
    }
  };
}
export {
  createGitlabAdapter
};
