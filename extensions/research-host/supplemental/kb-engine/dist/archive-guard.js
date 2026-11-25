import { execFile } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";
const DEFAULT_MAX_ENTRIES = 5e4;
const DEFAULT_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 12e4;
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const env = () => ({ ...process.env, LC_ALL: "C" });
const run = async (cmd, args) => (await execFileAsync(cmd, args, { encoding: "latin1", env: env(), timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_LISTING_BYTES })).stdout;
function decodeTarName(raw) {
  const simple = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "	", v: "\v", "\\": "\\", "'": "'", '"': '"' };
  return raw.replace(/\\([0-7]{1,3}|.)/gs, (_m, c) => /^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8) & 255) : simple[c] ?? `\\${c}`);
}
function checkName(name, display) {
  if (name.length === 0) throw new Error(`unsafe archive entry: empty name`);
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error(`unsafe archive entry (control character): ${JSON.stringify(display)}`);
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) throw new Error(`unsafe archive entry (absolute path): ${display}`);
  if (name.split(/[\\/]/).includes("..")) throw new Error(`unsafe archive entry (.. segment): ${display}`);
}
const lines = (s) => {
  const l = s.split("\n");
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
};
async function validateTar(archive, maxEntries) {
  const names = lines(await run("tar", ["-tf", archive]));
  const verbose = lines(await run("tar", ["-tvf", archive]));
  if (names.length > maxEntries) throw new Error(`archive has too many entries (${names.length} > ${maxEntries})`);
  if (names.length !== verbose.length) throw new Error(`cannot validate archive: listing mismatch (${names.length} names vs ${verbose.length} entries)`);
  for (let i = 0; i < names.length; i++) {
    const v = verbose[i];
    const type = v[0];
    if (type !== "-" && type !== "d") throw new Error(`unsafe archive entry (type '${type}'): ${names[i]}`);
    if (v.includes(" link to ") || v.includes(" ==> ")) throw new Error(`unsafe archive entry (link): ${names[i]}`);
    checkName(decodeTarName(names[i]), names[i]);
  }
}
async function validateZip(archive, maxEntries) {
  let header;
  try {
    header = await run("unzip", ["-Z", archive]);
  } catch (e) {
    header = String(e.stdout ?? "");
    if (!/number of entries: 0\b/.test(header)) throw e;
  }
  const hl = lines(header);
  const sizeIdx = hl.findIndex((l) => l.startsWith("Zip file size:"));
  const count = Number(/number of entries: (\d+)/.exec(hl[sizeIdx] ?? "")?.[1]);
  if (sizeIdx < 0 || !Number.isInteger(count)) throw new Error("cannot validate archive: unparseable zip listing");
  if (count > maxEntries) throw new Error(`archive has too many entries (${count} > ${maxEntries})`);
  if (count === 0) return true;
  const names = lines(await run("unzip", ["-Z1", archive]));
  const typeLines = hl.slice(sizeIdx + 1, sizeIdx + 1 + count);
  if (names.length !== count || typeLines.length !== count) throw new Error(`cannot validate archive: zip listing mismatch (${names.length} names, ${typeLines.length} types, ${count} entries)`);
  for (let i = 0; i < count; i++) {
    const type = typeLines[i][0];
    if (type !== "-" && type !== "d") throw new Error(`unsafe archive entry (type '${type}'): ${names[i]}`);
    if (/\^[@-_]/.test(names[i])) throw new Error(`unsafe archive entry (control character): ${JSON.stringify(names[i])}`);
    checkName(names[i], names[i]);
  }
  return false;
}
async function assertExpandedWithin(cmd, args, maxBytes) {
  try {
    await execFileAsync(cmd, args, { encoding: "buffer", env: env(), timeout: RUN_TIMEOUT_MS, maxBuffer: maxBytes });
  } catch (e) {
    const code = e.code;
    if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(`archive expands beyond the ${maxBytes}-byte limit`);
    throw e;
  }
}
function backstopWalk(out) {
  const root = realpathSync(out);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`extracted symlink rejected: ${p}`);
      const real = realpathSync(p);
      if (real !== root && !real.startsWith(root + sep)) throw new Error(`extracted entry escapes destination: ${p}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.nlink > 1) throw new Error(`extracted hardlink rejected: ${p}`);
    }
  };
  walk(root);
}
async function extractArchiveSafely(kind, archive, outDir, limits = {}) {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = limits.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
  if (kind === "zip") {
    const empty = await validateZip(archive, maxEntries);
    if (!empty) {
      await assertExpandedWithin("unzip", ["-p", archive], maxBytes);
      await run("unzip", ["-o", "-q", archive, "-d", outDir]);
    }
  } else {
    await validateTar(archive, maxEntries);
    await assertExpandedWithin("tar", ["-xOf", archive], maxBytes);
    await run("tar", ["-xf", archive, "-C", outDir, "--no-same-owner"]);
  }
  backstopWalk(outDir);
}
export {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXPANDED_BYTES,
  extractArchiveSafely
};
