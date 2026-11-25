import { cliRequest } from "./cli.js";
import { PAGE_SIZE } from "./types.js";
function githubRate(h) {
  const remaining = Number(h["x-ratelimit-remaining"]);
  const limit = Number(h["x-ratelimit-limit"]);
  const reset = Number(h["x-ratelimit-reset"]);
  if (![remaining, limit, reset].every(Number.isFinite) || limit <= 0) return null;
  return { remaining, limit, resetAt: reset * 1e3 };
}
function mapGithubItem(i) {
  const isPr = !!i.pull_request;
  return {
    kind: isPr ? "pr" : "issue",
    number: i.number,
    title: i.title ?? "",
    body: i.body ?? "",
    state: isPr && i.pull_request?.merged_at ? "merged" : i.state === "closed" ? "closed" : "open",
    author: i.user?.login ?? "ghost",
    labels: (i.labels ?? []).map((l) => typeof l === "string" ? l : l.name ?? "").filter(Boolean),
    createdAt: i.created_at ?? "",
    updatedAt: i.updated_at ?? ""
  };
}
function createGithubAdapter(deps, ref) {
  const base = `repos/${ref.path}`;
  const call = (endpoint, etag, signal) => cliRequest(deps, { cli: "gh", args: ["api", "-i", "--hostname", ref.host, "-H", "Accept: application/vnd.github+json", ...etag ? ["-H", `If-None-Match: ${etag}`] : [], endpoint] }, githubRate, signal);
  return {
    id: "github",
    endpoints: ["issues"],
    sharedNumberSpace: true,
    async list(_ep, a) {
      const q = `state=all&sort=updated&direction=asc&since=${encodeURIComponent(a.since)}&per_page=${PAGE_SIZE}&page=${a.page}`;
      const r = await call(`${base}/issues?${q}`, a.etag, a.signal);
      if (r.status === 304) return { status: "not_modified", items: [], full: false, etag: a.etag, rate: r.rate };
      const rows = JSON.parse(r.body || "[]");
      return { status: "ok", items: rows.map(mapGithubItem), full: rows.length >= PAGE_SIZE, etag: r.headers.etag ?? null, rate: r.rate };
    },
    async comments(kind, n, etag, signal) {
      const r = await call(`${base}/issues/${n}/comments?per_page=${PAGE_SIZE}`, etag, signal);
      if (r.status === 304) return { status: "not_modified", comments: [], etag, rate: r.rate };
      const rows = JSON.parse(r.body || "[]");
      const comments = rows.map((c) => ({ author: c.user?.login ?? "ghost", createdAt: c.created_at ?? "", body: c.body ?? "" }));
      void kind;
      return { status: "ok", comments, etag: r.headers.etag ?? null, rate: r.rate };
    }
  };
}
export {
  createGithubAdapter
};
