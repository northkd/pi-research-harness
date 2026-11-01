import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { openVerifiedRegularFile } from "../access/verified-read.js";

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function assertNoLinks(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new Error("path-outside-root");
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink");
  }
  if ((await realpath(target)) !== target) throw new Error("path-outside-root");
}

export async function readBoundedRegular(file: string, maxBytes: number, root?: string): Promise<{ text: string; bytes: number; timestamp: string }> {
  if (root) await assertNoLinks(root, file);
  const handle = await openVerifiedRegularFile(file);
  try {
    const before = await handle.stat();
    if (before.size > maxBytes) throw new Error("byte-budget");
    // Linux binds the already-open handle against parent-component swaps, too.
    if (process.platform === "linux" && root && (await realpath(`/proc/self/fd/${handle.fd}`)) !== file) throw new Error("path-outside-root");
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytesRead > maxBytes) throw new Error("source-changed");
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead, timestamp: before.mtime.toISOString() };
  } finally { await handle.close(); }
}

/** Existing project components are checked, not followed or chmodded. */
export async function ensureProjectDirectory(cwd: string, parts: string[]): Promise<string> {
  let current = cwd;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[/\\]/.test(part)) throw new Error("invalid-directory-part");
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(current)) !== current) throw new Error("unsafe-research-directory");
  }
  return current;
}
