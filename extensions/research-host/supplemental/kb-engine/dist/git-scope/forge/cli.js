import { ForgeRateLimited, ForgeUnavailable } from "./types.js";
function parseHttpHead(stdout) {
  const text = stdout.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const headBlock = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 2);
  const [statusLine, ...headLines] = headBlock.split("\n");
  const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine ?? "");
  if (!m) return null;
  const headers = {};
  for (const line of headLines) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers, body };
}
function retryAtFrom(headers, now) {
  const ra = Number(headers["retry-after"]);
  if (Number.isFinite(ra) && ra > 0) return now + ra * 1e3;
  const reset = Number(headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) return reset * (reset < 1e12 ? 1e3 : 1);
  return null;
}
function headlessError(cli, r) {
  const msg = r.stderr.trim().split("\n")[0] ?? "";
  if (/auth|log ?in|token|credential/i.test(msg) || r.code === 4) return new ForgeUnavailable(`${cli} is not authenticated`);
  return new ForgeUnavailable(msg ? `${cli}: ${msg.slice(0, 120)}` : `${cli} failed (exit ${r.code})`);
}
function statusError(cli, http, rate, now) {
  const h = http.headers;
  const exhausted = h["x-ratelimit-remaining"] === "0" || h["ratelimit-remaining"] === "0";
  if (http.status === 429 || http.status === 403 && (exhausted || h["retry-after"] || /rate limit/i.test(http.body))) return new ForgeRateLimited(retryAtFrom(h, now), rate);
  if (http.status === 401) return new ForgeUnavailable(`${cli} is not authenticated`);
  if (http.status === 403) return new ForgeUnavailable("access forbidden");
  if (http.status === 404) return new ForgeUnavailable("repository not found or no access");
  return new ForgeUnavailable(`forge answered HTTP ${http.status}`);
}
async function cliRequest(deps, call, rateFrom, signal) {
  const bin = deps.resolveBin(call.cli);
  if (!bin) throw new ForgeUnavailable(`${call.cli} is not installed`);
  const r = await deps.runCli(bin, call.args, { signal, timeoutMs: deps.requestTimeoutMs });
  if (r.spawnError) throw new ForgeUnavailable(`${call.cli} could not be started`);
  const http = parseHttpHead(r.stdout);
  if (!http) throw headlessError(call.cli, r);
  const rate = rateFrom(http.headers);
  if (http.status === 200 || http.status === 304) return { ...http, rate };
  throw statusError(call.cli, http, rate, deps.now());
}
export {
  cliRequest
};
