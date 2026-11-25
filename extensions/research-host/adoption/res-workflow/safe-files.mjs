import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { openVerifiedRegularFile } from "../access/verified-read.mjs";
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
async function assertNoLinks(root, target) {
  const realRoot = await realpath(root).catch(() => root);
  const realTarget = await realpath(target).catch(() => target);
  if (!inside(realRoot, realTarget)) throw new Error("path-outside-root");
  let current = realRoot;
  for (const part of path.relative(realRoot, realTarget).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink");
  }
}
async function readBoundedRegular(file, maxBytes, root) {
  if (root) await assertNoLinks(root, file);
  const handle = await openVerifiedRegularFile(file);
  try {
    const before = await handle.stat();
    if (before.size > maxBytes) throw new Error("byte-budget");
    if (process.platform === "linux" && root && await realpath(`/proc/self/fd/${handle.fd}`) !== file) throw new Error("path-outside-root");
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytesRead > maxBytes) throw new Error("source-changed");
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead, timestamp: before.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}
async function ensureProjectDirectory(cwd, parts) {
  const realCwd = await realpath(cwd).catch(() => cwd);
  let current = realCwd;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[/\\]/.test(part)) throw new Error("invalid-directory-part");
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 448 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const entry = await lstat(current);
    const realCurrent = await realpath(current).catch(() => current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !inside(realCwd, realCurrent)) throw new Error("unsafe-research-directory");
  }
  return current;
}
export {
  assertNoLinks,
  ensureProjectDirectory,
  inside,
  readBoundedRegular
};
