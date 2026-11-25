import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const DEFAULT_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1e3;
function keyForFile(fileName, size, mtimeMs) {
  return crypto.createHash("sha256").update(`${fileName}\0${size}\0${Math.trunc(mtimeMs)}`).digest("hex").slice(0, 16);
}
function createFolderWorkSource(opts) {
  const dir = path.resolve(opts.dir);
  const inflightRoot = path.join(dir, "inflight");
  const now = opts.now ?? (() => Date.now());
  const rawTimeout = opts.visibilityTimeoutMs;
  if (rawTimeout !== void 0 && (!Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
    throw new Error(
      `createFolderWorkSource: visibilityTimeoutMs must be a positive finite number, got ${rawTimeout}`
    );
  }
  const timeout = rawTimeout ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  const leases = /* @__PURE__ */ new Map();
  let counter = 0;
  function ensureDirs() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(inflightRoot, { recursive: true });
  }
  function moveLeaseDirBackToPool(leaseDir) {
    let files;
    try {
      files = fs.readdirSync(leaseDir);
    } catch {
      return;
    }
    for (const f of files) {
      const dest = path.join(dir, f);
      if (fs.existsSync(dest)) continue;
      try {
        fs.renameSync(path.join(leaseDir, f), dest);
      } catch {
      }
    }
    try {
      if (fs.readdirSync(leaseDir).length === 0) fs.rmdirSync(leaseDir);
    } catch {
    }
  }
  function reclaim() {
    const t = now();
    let tokens;
    try {
      tokens = fs.readdirSync(inflightRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const token of tokens) {
      const lease = leases.get(token);
      if (lease && lease.expiresAt > t) continue;
      moveLeaseDirBackToPool(path.join(inflightRoot, token));
      leases.delete(token);
    }
  }
  ensureDirs();
  reclaim();
  function next(n) {
    ensureDirs();
    reclaim();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const available = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    const handles = [];
    for (const fileName of available) {
      if (handles.length >= n) break;
      const token = `${now()}-${counter++}`;
      const leaseDir = path.join(inflightRoot, token);
      const inflightPath = path.join(leaseDir, fileName);
      try {
        fs.mkdirSync(leaseDir, { recursive: true });
        fs.renameSync(path.join(dir, fileName), inflightPath);
      } catch {
        try {
          fs.rmSync(leaseDir, { recursive: true, force: true });
        } catch {
        }
        continue;
      }
      const lease = { token, fileName, inflightPath, expiresAt: now() + timeout };
      leases.set(token, lease);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(inflightPath);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
      }
      handles.push({
        item: inflightPath,
        leaseToken: token,
        idempotencyKey: keyForFile(fileName, size, mtimeMs)
      });
    }
    return handles;
  }
  function fenceExpired(leaseToken) {
    const lease = leases.get(leaseToken);
    if (!lease) return true;
    if (lease.expiresAt <= now()) {
      moveLeaseDirBackToPool(path.join(inflightRoot, leaseToken));
      leases.delete(leaseToken);
      return true;
    }
    return false;
  }
  function ack(leaseToken) {
    if (fenceExpired(leaseToken)) return;
    try {
      fs.rmSync(path.join(inflightRoot, leaseToken), { recursive: true, force: true });
    } catch {
    }
    leases.delete(leaseToken);
  }
  function nack(leaseToken) {
    if (fenceExpired(leaseToken)) return;
    moveLeaseDirBackToPool(path.join(inflightRoot, leaseToken));
    leases.delete(leaseToken);
  }
  return { next, ack, nack };
}
export {
  createFolderWorkSource
};
