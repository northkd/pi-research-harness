import crypto from "node:crypto";
import { pathKey } from "../shared/session-group-path.mjs";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const SESSION_STATUSES = [
  "active",
  "idle",
  "streaming",
  "ended"
];
function sessionSortKey(session) {
  return session.endedAt ?? session.lastActivityAt ?? session.startedAt;
}
function sortPos(session) {
  const key = sessionSortKey(session);
  return { key, finite: Number.isFinite(key), id: session.id };
}
function comparePos(a, b) {
  if (a.finite && b.finite) {
    if (a.key !== b.key) return b.key - a.key;
  } else if (a.finite !== b.finite) {
    return a.finite ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function normalizedCwd(cwd, platform) {
  return cwd === void 0 ? null : pathKey(cwd, platform);
}
function digestOf(args, platform) {
  const canonical = JSON.stringify({
    limit: args.limit ?? DEFAULT_LIMIT,
    status: args.status ? [...args.status].sort() : null,
    cwd: normalizedCwd(args.cwd, platform),
    since: args.since ?? null
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
function encodeCursor(pos, digest) {
  const payload = { key: pos.finite ? pos.key : null, id: pos.id, digest };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { key, id, digest } = parsed;
    if (key !== null && typeof key !== "number") return null;
    if (typeof id !== "string" || typeof digest !== "string") return null;
    return { key, id, digest };
  } catch {
    return null;
  }
}
function cursorPos(payload) {
  return {
    key: payload.key ?? Number.NaN,
    finite: payload.key !== null,
    id: payload.id
  };
}
function validateListSessionsArgs(args) {
  const limit = args.limit;
  if (limit !== void 0) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) {
      return 'list_sessions "limit" must be an integer';
    }
    if (limit < 1 || limit > MAX_LIMIT) {
      return `list_sessions "limit" must be between 1 and ${MAX_LIMIT}`;
    }
  }
  const status = args.status;
  if (status !== void 0) {
    if (!Array.isArray(status)) return 'list_sessions "status" must be an array';
    for (const value of status) {
      if (!SESSION_STATUSES.includes(value)) {
        return `list_sessions "status" must be one of ${SESSION_STATUSES.join(", ")}`;
      }
    }
  }
  const cursor = args.cursor;
  if (cursor === void 0) return null;
  if (typeof cursor !== "string") return 'list_sessions "cursor" must be a string';
  const decoded = decodeCursor(cursor);
  if (!decoded) return "list_sessions was given a cursor that cannot be decoded";
  if (decoded.digest !== digestOf(args, process.platform)) {
    return "list_sessions cursor does not match the supplied filters or limit";
  }
  return null;
}
function listSessions(rows, args = {}, platform = process.platform) {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const digest = digestOf(args, platform);
  let filtered = rows.filter((s) => s.hidden !== true);
  if (args.status) {
    const wanted = new Set(args.status);
    filtered = filtered.filter((s) => wanted.has(s.status));
  }
  if (args.cwd !== void 0) {
    const key = pathKey(args.cwd, platform);
    filtered = filtered.filter((s) => pathKey(s.cwd, platform) === key);
  }
  if (args.since !== void 0) {
    const since = args.since;
    filtered = filtered.filter((s) => {
      const key = sessionSortKey(s);
      return Number.isFinite(key) && key >= since;
    });
  }
  const total = filtered.length;
  if (args.cursor !== void 0) {
    const decoded = decodeCursor(args.cursor);
    if (decoded) {
      const cur = cursorPos(decoded);
      filtered = filtered.filter((s) => comparePos(sortPos(s), cur) > 0);
    }
  }
  const sorted = [...filtered].sort((a, b) => comparePos(sortPos(a), sortPos(b)));
  const page = sorted.slice(0, limit);
  const hasMore = page.length > 0 && sorted.length > limit;
  const nextCursor = hasMore ? encodeCursor(sortPos(page[page.length - 1]), digest) : void 0;
  return nextCursor === void 0 ? { sessions: page, total } : { sessions: page, total, nextCursor };
}
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SESSION_STATUSES,
  listSessions,
  sessionSortKey,
  validateListSessionsArgs
};
