import { ForgeRateLimited, ForgeUnavailable } from "./types.js";
const GITEA_PAGE = 50;
function giteaRate(h, now) {
  const rl = h.get("ratelimit");
  const pol = h.get("ratelimit-policy");
  const r = /;\s*r=(\d+)/.exec(rl ?? "");
  const t = /;\s*t=(\d+)/.exec(rl ?? "");
  const q = /;\s*q=(\d+)/.exec(pol ?? "");
  if (!r || !q) return null;
  return { remaining: Number(r[1]), limit: Number(q[1]), resetAt: now + Number(t?.[1] ?? 0) * 1e3 };
}
const toUtc = (ts) => ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString().replace(".000Z", "Z") : "";
function mapGiteaItem(i) {
  const isPr = !!i.pull_request;
  return {
    kind: isPr ? "pr" : "issue",
    number: i.number,
    title: i.title ?? "",
    body: i.body ?? "",
    state: isPr && i.pull_request?.merged ? "merged" : i.state === "closed" ? "closed" : "open",
    author: i.user?.login ?? "ghost",
    labels: (i.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    createdAt: toUtc(i.created_at),
    updatedAt: toUtc(i.updated_at)
  };
}
function networkReason(e, timedOut) {
  if (timedOut) return "request timed out";
  const code = e.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
  return "https required";
}
function statusError(res, rate, hasToken, now) {
  const retryAfter = res.headers.get("retry-after");
  if (res.status === 429 || res.status === 403 && retryAfter) {
    const ra = Number(retryAfter);
    return new ForgeRateLimited(Number.isFinite(ra) && ra > 0 ? now + ra * 1e3 : null, rate);
  }
  if (res.status === 401 || res.status === 403) return new ForgeUnavailable(hasToken ? "access forbidden" : "authentication required");
  if (res.status === 404) return new ForgeUnavailable("repository not found or no access");
  return new ForgeUnavailable(`forge answered HTTP ${res.status}`);
}
function createGiteaAdapter(deps, ref, auth) {
  const base = `https://${ref.host}/api/v1/repos/${ref.path}`;
  const token = auth.allowlisted ? deps.env[auth.tokenEnv] : void 0;
  const get = async (url, etag, signal) => {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `token ${token}`;
    if (etag) headers["if-none-match"] = etag;
    const timeout = AbortSignal.timeout(deps.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await deps.fetch(url, { headers, signal: combined, redirect: "error" });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ForgeUnavailable(networkReason(e, timeout.aborted));
    }
    const rate = giteaRate(res.headers, deps.now());
    if (res.status === 200 || res.status === 304) return { res, rate };
    throw statusError(res, rate, !!token, deps.now());
  };
  return {
    id: "gitea",
    endpoints: ["issues"],
    sharedNumberSpace: true,
    async list(_ep, a) {
      const q = `state=all&type=all&sort=leastupdate&since=${encodeURIComponent(a.since)}&limit=${GITEA_PAGE}&page=${a.page}`;
      const { res, rate } = await get(`${base}/issues?${q}`, a.etag, a.signal);
      if (res.status === 304) return { status: "not_modified", items: [], full: false, etag: a.etag, rate };
      const rows = await res.json();
      return { status: "ok", items: rows.map(mapGiteaItem), full: rows.length >= GITEA_PAGE, etag: res.headers.get("etag"), rate };
    },
    async comments(_kind, n, etag, signal) {
      const { res, rate } = await get(`${base}/issues/${n}/comments`, etag, signal);
      if (res.status === 304) return { status: "not_modified", comments: [], etag, rate };
      const rows = await res.json();
      const comments = rows.map((c) => ({ author: c.user?.login ?? "ghost", createdAt: toUtc(c.created_at), body: c.body ?? "" }));
      return { status: "ok", comments, etag: res.headers.get("etag"), rate };
    }
  };
}
export {
  createGiteaAdapter
};
