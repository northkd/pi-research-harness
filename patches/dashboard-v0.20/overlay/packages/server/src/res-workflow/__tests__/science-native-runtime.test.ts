import type { BigIntStats } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const instrument = vi.hoisted(() => ({
  actualIo: vi.fn(() => { throw new Error("Actual filesystem access is forbidden in runtime proof tests"); }),
  hashes: 0,
}));
vi.mock("node:fs/promises", () => ({ lstat: instrument.actualIo, open: instrument.actualIo, readlink: instrument.actualIo }));
// No real pinned ELF is read. This fake digest recognizes only toy fixture
// bytes; production imports Node's SHA256 primitive without this interception.
vi.mock("node:crypto", () => ({ createHash: vi.fn((algorithm: string) => {
  expect(algorithm).toBe("sha256"); instrument.hashes++;
  const chunks: Uint8Array[] = [];
  return { update(value: Uint8Array) { chunks.push(value); return this; }, digest(format: string) { expect(format).toBe("hex"); return Buffer.concat(chunks).toString() === "fixture-approved-elf" ? "2139fa524389ec338ad86d50f66e7e7d0c4aa8bf9d7036a15fb196b5bde6a31b" : "0".repeat(64); } };
}) }));

import { createNativeRuntimeAssertion, NATIVE_RUNTIME_PATHS, NATIVE_SCIENCE_SHA256, type NativeRuntimeFacts, type NativeRuntimeIo, type NativeRuntimeStat } from "../science-native-runtime.js";

const status = (native = false) => `Name:\tsynthetic\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nCapBnd:\t${native ? "000001ffffffffff" : "0000000000000000"}\nNoNewPrivs:\t1\n`;
const statLine = (ticks = "12345") => `4242 (science (fixture) runner) S ${Array(18).fill("0").join(" ")} ${ticks} 0 0\n`;
function metadata(ino: bigint, mode = 0o100444n, uid = 0n, kind: "file" | "dir" | "link" = "file"): NativeRuntimeStat {
  return { dev: 91n, ino, mode, uid, gid: uid, nlink: 1n, size: 0n, mtimeNs: 10n, ctimeNs: 11n, isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link" } as Pick<BigIntStats, keyof NativeRuntimeStat>;
}
interface Entry { stat: NativeRuntimeStat; body: Buffer; link?: string }
function fixture() {
  const facts: NativeRuntimeFacts = { schemaVersion: 1, nativePid: 4242, nativeStartTicks: "12345", nativeCgroup: "/system.slice/pi-claude-science.service", viewerCgroup: "/system.slice/pi-claude-science-viewer.service", hostUserNamespace: "user:[4026531837]", binary: { sha256: NATIVE_SCIENCE_SHA256, dev: "91", ino: "200" }, data: { dev: "91", ino: "300" } };
  const entries = new Map<string, Entry>();
  const add = (path: string, body: string, stat = metadata(BigInt(entries.size + 100))) => { const entry = { stat: { ...stat, size: BigInt(Buffer.byteLength(body)) }, body: Buffer.from(body) }; entries.set(path, entry); return entry; };
  const descriptor = add(NATIVE_RUNTIME_PATHS.facts, JSON.stringify(facts));
  const binary = add(NATIVE_RUNTIME_PATHS.binary, "fixture-approved-elf", metadata(200n, 0o100555n));
  const physical = add(NATIVE_RUNTIME_PATHS.physicalData, "", metadata(300n, 0o40700n, 1000n, "dir"));
  const alias = add(NATIVE_RUNTIME_PATHS.aliasData, "", metadata(300n, 0o40700n, 1000n, "dir"));
  const mask = add(NATIVE_RUNTIME_PATHS.maskedConfig, "DO NOT READ", metadata(400n, 0o100000n));
  add("/proc/self/status", status()); add("/proc/self/cgroup", `0::${facts.viewerCgroup}\n`);
  entries.set("/proc/self/ns/user", { stat: metadata(500n, 0o120777n, 0n, "link"), body: Buffer.alloc(0), link: facts.hostUserNamespace });
  add("/proc/4242/status", status(true)); add("/proc/4242/cgroup", `0::${facts.nativeCgroup}\n`); add("/proc/4242/stat", statLine());
  const calls = { opens: [] as string[], stats: [] as string[], links: [] as string[], closes: 0 };
  const ids = { platform: "linux", uid: 1000, euid: 1000, gid: 1000, egid: 1000 };
  let afterRead: ((path: string) => void) | undefined;
  const io: NativeRuntimeIo = {
    ids: () => ({ ...ids }),
    async lstat(path) { calls.stats.push(path); const entry = entries.get(path); if (!entry) throw new Error("private lstat detail"); return { ...entry.stat }; },
    async readlink(path) { calls.links.push(path); const link = entries.get(path)?.link; if (!link) throw new Error("private link detail"); return link; },
    async open(path) {
      calls.opens.push(path); const entry = entries.get(path); if (!entry) throw new Error("private open detail");
      return { async stat() { return { ...entry.stat }; }, async read(offset, length) { const result = Uint8Array.from(entry.body.subarray(offset, offset + length)); afterRead?.(path); return result; }, async close() { calls.closes++; } };
    },
  };
  return { facts, entries, descriptor, binary, physical, alias, mask, calls, ids, io, assertRuntime: createNativeRuntimeAssertion(io), afterRead: (value: typeof afterRead) => { afterRead = value; }, rewriteFacts() { descriptor.body = Buffer.from(JSON.stringify(facts)); descriptor.stat.size = BigInt(descriptor.body.length); } };
}
const unavailable = { name: "ScienceNativeRuntimeError", message: "science-native-runtime-unavailable" };

describe("native runtime facts assertion grants no task authority", () => {
  it("imports and constructs with zero filesystem or identity reads", () => {
    expect(instrument.actualIo).not.toHaveBeenCalled();
    const f = fixture(); expect(f.calls.opens).toEqual([]); expect(f.calls.stats).toEqual([]);
  });
  it("accepts exact facts, permits a nonzero native Bnd, and hashes only the first pinned binary", async () => {
    const f = fixture(); const before = instrument.hashes;
    await expect(f.assertRuntime()).resolves.toBeUndefined(); await expect(f.assertRuntime()).resolves.toBeUndefined();
    expect(instrument.hashes - before).toBe(1);
    expect(f.calls.opens.filter(path => path === NATIVE_RUNTIME_PATHS.binary)).toHaveLength(1);
    expect(f.calls.opens).not.toContain(NATIVE_RUNTIME_PATHS.maskedConfig);
    expect(f.calls.opens.some(path => /\/(?:cmdline|environ|exe)$/.test(path))).toBe(false);
    expect(f.calls.links).toEqual(["/proc/self/ns/user", "/proc/self/ns/user", "/proc/self/ns/user", "/proc/self/ns/user"]);
  });
  it.each(["uid", "euid", "gid", "egid"] as const)("rejects wrong self %s before file access", async key => {
    const f = fixture(); f.ids[key] = 0; await expect(f.assertRuntime()).rejects.toMatchObject(unavailable); expect(f.calls.opens).toEqual([]);
  });
  it.each(["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd", "NoNewPrivs", "Uid", "Gid"])("rejects changed self status %s", async key => {
    const f = fixture(); const entry = f.entries.get("/proc/self/status")!;
    entry.body = Buffer.from(status().replace(new RegExp(`^${key}:.*$`, "m"), `${key}:\t${key === "Uid" || key === "Gid" ? "0 1000 1000 1000" : key === "NoNewPrivs" ? "0" : "1"}`));
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it.each(["CapEff", "CapPrm", "CapInh", "CapAmb", "NoNewPrivs", "Uid", "Gid"])("rejects changed native status %s", async key => {
    const f = fixture(); const entry = f.entries.get("/proc/4242/status")!;
    entry.body = Buffer.from(status(true).replace(new RegExp(`^${key}:.*$`, "m"), `${key}:\t${key === "Uid" || key === "Gid" ? "1000 0 1000 1000" : key === "NoNewPrivs" ? "0" : "1"}`));
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it.each(["/proc/self/cgroup", "/proc/4242/cgroup"])("requires exact service cgroup in %s", async path => {
    const f = fixture(); f.entries.get(path)!.body = Buffer.from(`0::${path.includes("self") ? f.facts.viewerCgroup : f.facts.nativeCgroup}/child\n`);
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it("rejects a different user namespace", async () => {
    const f = fixture(); f.entries.get("/proc/self/ns/user")!.link = "user:[999]"; await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it("parses native startTicks after a comm containing spaces and parentheses and rejects PID reuse", async () => {
    const f = fixture(); f.entries.get("/proc/4242/stat")!.body = Buffer.from(statLine("12346")); await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it("rechecks native startTicks after asynchronous binary reads", async () => {
    const f = fixture(); f.afterRead(path => { if (path === NATIVE_RUNTIME_PATHS.binary) f.entries.get("/proc/4242/stat")!.body = Buffer.from(statLine("99999")); });
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it.each(["owner", "mode", "link", "oversize"])("refuses %s root descriptor metadata", async kind => {
    const f = fixture();
    if (kind === "owner") f.descriptor.stat.uid = 1000n;
    if (kind === "mode") f.descriptor.stat.mode = 0o100644n;
    if (kind === "link") f.descriptor.stat.isSymbolicLink = () => true;
    if (kind === "oversize") { f.descriptor.body = Buffer.alloc(8193); f.descriptor.stat.size = 8193n; }
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it.each(["malformed", "authority-field", "unsafe-pid", "binary-pin"])("refuses %s root descriptor content", async kind => {
    const f = fixture();
    if (kind === "malformed") { f.descriptor.body = Buffer.from("{"); f.descriptor.stat.size = 1n; }
    if (kind === "authority-field") { Object.assign(f.facts, { authorized: true }); f.rewriteFacts(); }
    if (kind === "unsafe-pid") { f.facts.nativePid = 2147483648; f.rewriteFacts(); }
    if (kind === "binary-pin") { f.facts.binary.sha256 = "0".repeat(64) as typeof NATIVE_SCIENCE_SHA256; f.rewriteFacts(); }
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it.each(["hash", "inode", "root-owner", "writable", "symlink", "late-stat"])("rejects %s binary and never silently recaches a drifted identity", async kind => {
    const f = fixture();
    if (kind === "hash") f.binary.body = Buffer.from("fixture-replaced-elf");
    if (kind === "inode") f.binary.stat.ino++;
    if (kind === "root-owner") f.binary.stat.uid = 1000n;
    if (kind === "writable") f.binary.stat.mode = 0o100755n;
    if (kind === "symlink") f.binary.stat.isSymbolicLink = () => true;
    if (kind === "late-stat") f.afterRead(path => { if (path === NATIVE_RUNTIME_PATHS.binary) f.binary.stat.ctimeNs++; });
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it("refuses an inode outside Root's binary descriptor before opening its bytes", async () => {
    const f = fixture(); f.binary.stat.ino++;
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
    expect(f.calls.opens).not.toContain(NATIVE_RUNTIME_PATHS.binary);
  });
  it("checks metadata again after a successful first hash without reading bytes again", async () => {
    const f = fixture(); await f.assertRuntime(); const opens = f.calls.opens.filter(path => path === NATIVE_RUNTIME_PATHS.binary).length;
    f.binary.stat.ctimeNs++; await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
    expect(f.calls.opens.filter(path => path === NATIVE_RUNTIME_PATHS.binary)).toHaveLength(opens);
  });
  it.each(["alias", "physical", "facts"])("requires exact root descriptor DATA inode for %s", async kind => {
    const f = fixture();
    if (kind === "alias") f.alias.stat.ino++;
    if (kind === "physical") f.physical.stat.ino++;
    if (kind === "facts") { f.facts.data.ino = "999"; f.rewriteFacts(); }
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it.each(["uid", "mode"])("checks only lstat root000 config mask %s", async kind => {
    const f = fixture(); if (kind === "uid") f.mask.stat.uid = 1000n; else f.mask.stat.mode = 0o100400n;
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable); expect(f.calls.opens).not.toContain(NATIVE_RUNTIME_PATHS.maskedConfig);
  });
  it("rejects descriptor identity replacement after all async reads", async () => {
    const f = fixture(); f.afterRead(path => { if (path === NATIVE_RUNTIME_PATHS.binary) f.descriptor.stat.ino++; });
    await expect(f.assertRuntime()).rejects.toMatchObject(unavailable);
  });
  it("sanitizes raw failures without exposing paths, PID, argv or credential text", async () => {
    const f = fixture(); f.io.open = async () => { throw new Error("/private/config key=value argv=secret"); };
    await expect(createNativeRuntimeAssertion(f.io)()).rejects.toMatchObject(unavailable);
    expect(instrument.actualIo).not.toHaveBeenCalled();
  });
});
