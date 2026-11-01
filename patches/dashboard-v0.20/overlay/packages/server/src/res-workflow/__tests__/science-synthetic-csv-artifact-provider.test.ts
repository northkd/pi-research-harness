import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSyntheticCsvArtifactProvider, SYNTHETIC_CSV_ARTIFACT_PATHS as P, type SyntheticCsvArtifactIo, type SyntheticCsvArtifactProviderOptions, type SyntheticCsvArtifactStat } from "../science-synthetic-csv-artifact-provider.js";

const REQUEST = "cdde40745c26fab81103b2d29619ed6766777a35b23717ee6e46d7ec4842b690";
const EXPORTER = "91c34a99b2ac6dd59f399a4aa4facc24cac6c4961ae03c17b386241497296b62";
const BINDING = { projectId: "proj_0123456789ab", taskId: "11111111-1111-4111-8111-111111111111", rootFrameId: "11111111-1111-4111-8111-111111111111", frameId: "11111111-1111-4111-8111-111111111111" };
const PARTITION = { ownerKey: "synthetic-owner", cwd: "/workspace/synthetic" };
const BINDING_FILE = "/var/lib/pi-claude-science-viewer-authority/p0-binding.json";
function metadata(ino: bigint, kind: "file" | "dir" | "link", uid = 0n, gid = 0n, mode = kind === "dir" ? 0o40755n : 0o100440n): SyntheticCsvArtifactStat {
  return { dev: 7n, ino, mode, uid, gid, nlink: 1n, size: 0n, mtimeNs: 10n, ctimeNs: 11n, isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link" };
}
interface Entry { stat: SyntheticCsvArtifactStat; body: Buffer }
function fixture() {
  const entries = new Map<string, Entry>();
  const add = (file: string, stat: SyntheticCsvArtifactStat, body = Buffer.alloc(0)) => { const entry = { stat: { ...stat, size: BigInt(body.length) }, body }; entries.set(file, entry); return entry; };
  for (const file of ["/", "/var", "/var/lib", "/var/lib/pi-claude-science"]) add(file, metadata(BigInt(entries.size + 100), "dir"));
  for (const file of ["/var/lib/pi-claude-science/home", "/var/lib/pi-claude-science/home/.local", "/var/lib/pi-claude-science/home/.local/state", "/var/lib/pi-claude-science/home/.local/state/pi-science-p0", P.sourceRoot]) add(file, metadata(BigInt(entries.size + 100), "dir", 1000n, 1000n, 0o40700n));
  const proofDirectory = add(P.proofDirectory, metadata(200n, "dir", 0n, 1000n, 0o40750n));
  const source = add(P.sourceFile, metadata(900n, "file", 1000n, 1000n, 0o100600n), Buffer.from("value\r\n1\r\n2\r\n3\r\n"));
  const bindingFile = add(BINDING_FILE, metadata(850n, "file", 0n, 1000n, 0o100440n), Buffer.from(JSON.stringify(BINDING)));
  const proof = { schemaVersion: 1, requestSha256: REQUEST, bindingFile: { dev: "7", ino: "850", bytes: bindingFile.body.length, mtimeNs: "10", ctimeNs: "11" }, exporterSha256: EXPORTER, bytes: source.body.length,
    sha256: createHash("sha256").update(source.body).digest("hex"), fileDev: "7", fileIno: "900" };
  const descriptor = add(P.proof, metadata(800n, "file", 0n, 1000n, 0o100440n), Buffer.from(JSON.stringify(proof)));
  const calls = { opens: [] as string[], reads: [] as string[], stats: [] as string[], closes: 0 };
  let afterRead: (() => void) | undefined; let afterOpen: ((file: string) => void) | undefined; let revoked = false; let serial = 3000;
  const descriptors = new Map<number, string>();
  const io: SyntheticCsvArtifactIo = {
    async lstat(file) { calls.stats.push(file); const value = entries.get(file); if (!value) throw Object.assign(new Error("PRIVATE missing path"), { code: "ENOENT" }); return { ...value.stat }; },
    async realpath(file) { if (file.startsWith("/proc/self/fd/")) return descriptors.get(Number(file.slice(14))) ?? "PRIVATE bad fd"; return file; },
    async open(file) {
      calls.opens.push(file); const entry = entries.get(file); if (!entry) throw new Error("PRIVATE open error");
      const fd = serial++; descriptors.set(fd, file); afterOpen?.(file);
      return { fd, async stat() { return { ...entry.stat }; }, async read(offset, length) {
        calls.reads.push(file); if (file !== P.proof) throw new Error("CSV body and existing binding body must not be read here");
        const value = Uint8Array.from(entry.body.subarray(offset, offset + length)); afterRead?.(); return value;
      }, async close() { calls.closes++; descriptors.delete(fd); } };
    },
  };
  const revalidate = vi.fn(async () => { if (revoked) throw new Error("PRIVATE scope revoked"); });
  const options: SyntheticCsvArtifactProviderOptions = { partition: { ...PARTITION }, binding: { ...BINDING }, revalidate };
  const provider = createSyntheticCsvArtifactProvider(options, io);
  return { entries, source, descriptor, bindingFile, proofDirectory, proof, calls, options, provider, revalidate, io,
    rewrite() { descriptor.body = Buffer.from(JSON.stringify(proof)); descriptor.stat.size = BigInt(descriptor.body.length); descriptor.stat.mtimeNs++; descriptor.stat.ctimeNs++; },
    afterRead(fn: typeof afterRead) { afterRead = fn; }, afterOpen(fn: typeof afterOpen) { afterOpen = fn; }, revoke() { revoked = true; } };
}

describe("fixed synthetic CSV provider attests metadata, never authority", () => {
  it("constructs without IO and returns only the fixed attested source after fresh scopes", async () => {
    const f = fixture(); expect(f.calls.opens).toEqual([]); expect(f.calls.stats).toEqual([]);
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBe(P.sourceRoot);
    expect(await f.provider.sourcesFor(BINDING)).toEqual([{ name: "synthetic-values.csv", bytes: f.proof.bytes, sha256: f.proof.sha256, taskId: BINDING.taskId,
      root: P.sourceRoot, relativePath: "synthetic-values.csv", mediaType: "text/csv" }]);
    expect(f.calls.reads.every(file => file === P.proof)).toBe(true); expect(f.revalidate).toHaveBeenCalled();
    expect(f.descriptor.body.toString()).not.toContain(BINDING.projectId); expect(f.descriptor.body.toString()).not.toContain(BINDING.taskId);
    expect(f.provider.status()).toEqual({ available: true, code: "synthetic-csv-artifact-ready" });
  });
  it("missing proof is safely unavailable with no sources or cached-state writes", async () => {
    const f = fixture(); f.entries.delete(P.proof);
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull(); expect(await f.provider.sourcesFor(BINDING)).toEqual([]);
    expect(JSON.stringify(f.provider.status())).not.toMatch(/PRIVATE|proj_|\/var/);
  });
  it.each(["uid", "gid", "mode", "link", "nlink", "oversize"])("rejects unsafe Root proof %s", async field => {
    const f = fixture();
    if (field === "uid") f.descriptor.stat.uid = 1000n;
    if (field === "gid") f.descriptor.stat.gid = 0n;
    if (field === "mode") f.descriptor.stat.mode = 0o100640n;
    if (field === "link") f.descriptor.stat.isSymbolicLink = () => true;
    if (field === "nlink") f.descriptor.stat.nlink = 2n;
    if (field === "oversize") f.descriptor.stat.size = 4097n;
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull(); expect(await f.provider.sourcesFor(BINDING)).toEqual([]);
  });
  it("requires independent Root sibling ownership and every Root ancestor", async () => {
    const f = fixture(); f.proofDirectory.stat.uid = 1000n;
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull();
    f.proofDirectory.stat.uid = 0n; f.entries.get("/var/lib")!.stat.uid = 1000n;
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull();
  });
  it.each(["binding-file", "request", "exporter", "digest", "dev", "ino", "path"])("rejects unproven proof %s", async field => {
    const f = fixture();
    if (field === "binding-file") f.proof.bindingFile.ino = "851";
    if (field === "request") f.proof.requestSha256 = "0".repeat(64);
    if (field === "exporter") f.proof.exporterSha256 = "0".repeat(64);
    if (field === "digest") f.proof.sha256 = "bad";
    if (field === "dev") f.proof.fileDev = "8";
    if (field === "ino") f.proof.fileIno = "901";
    if (field === "path") Object.assign(f.proof, { relativePath: "/PRIVATE/key" });
    f.rewrite(); expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull();
  });
  it.each(["uid", "gid", "mode", "link", "nlink", "bytes", "mtimeNs", "ctimeNs"])("requires the protected existing binding file %s", async field => {
    const f = fixture();
    const changes = { uid: () => { f.bindingFile.stat.uid = 1000n; }, gid: () => { f.bindingFile.stat.gid = 0n; },
      mode: () => { f.bindingFile.stat.mode = 0o100640n; }, link: () => { f.bindingFile.stat.isSymbolicLink = () => true; },
      nlink: () => { f.bindingFile.stat.nlink = 2n; }, bytes: () => { f.proof.bindingFile.bytes++; },
      mtimeNs: () => { f.proof.bindingFile.mtimeNs = "12"; }, ctimeNs: () => { f.proof.bindingFile.ctimeNs = "12"; } };
    changes[field as keyof typeof changes]();
    f.rewrite(); expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull(); expect(f.calls.reads).not.toContain(BINDING_FILE);
  });
  it("rejects foreign incoming partition or binding before proof IO", async () => {
    const f = fixture(); expect(await f.provider.rootFor({ ...PARTITION, ownerKey: "other" }, BINDING)).toBeNull();
    expect(await f.provider.rootFor(PARTITION, { ...BINDING, taskId: "22222222-2222-4222-8222-222222222222" })).toBeNull();
    expect(await f.provider.sourcesFor({ ...BINDING, projectId: "proj_abcdef012345" })).toEqual([]); expect(f.calls.opens).toEqual([]);
  });
  it.each(["uid", "gid", "mode", "link", "nlink", "size"])("rejects unsafe user CSV %s without reading bytes", async field => {
    const f = fixture();
    if (field === "uid") f.source.stat.uid = 0n;
    if (field === "gid") f.source.stat.gid = 0n;
    if (field === "mode") f.source.stat.mode = 0o100644n;
    if (field === "link") f.source.stat.isSymbolicLink = () => true;
    if (field === "nlink") f.source.stat.nlink = 2n;
    if (field === "size") f.source.stat.size++;
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull(); expect(f.calls.reads).not.toContain(P.sourceFile);
  });
  it("refuses descriptor inode replacement during bounded proof read", async () => {
    const f = fixture(); let swapped = false;
    f.afterRead(() => { if (!swapped) { swapped = true; f.entries.set(P.proof, { ...f.descriptor, stat: { ...f.descriptor.stat, ino: 801n } }); } });
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull();
  });
  it("refuses a source mtime change between lstat and open", async () => {
    const f = fixture(); f.afterOpen(file => { if (file === P.sourceFile) f.source.stat.mtimeNs++; });
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull();
  });
  it("refuses inode/mtime/proof digest changes between rootFor and sourcesFor", async () => {
    for (const change of ["inode", "mtime", "proof", "binding-file"] as const) {
      const f = fixture(); expect(await f.provider.rootFor(PARTITION, BINDING)).toBe(P.sourceRoot);
      if (change === "inode") f.source.stat.ino++;
      if (change === "mtime") f.source.stat.mtimeNs++;
      if (change === "proof") { f.proof.sha256 = "0".repeat(64); f.rewrite(); }
      if (change === "binding-file") f.bindingFile.stat.mtimeNs++;
      expect(await f.provider.sourcesFor(BINDING)).toEqual([]); expect(f.provider.status().available).toBe(false);
    }
  });
  it("fails closed on boolean scope results and late revocation", async () => {
    for (const value of [true, false]) {
      const f = fixture(); f.revalidate.mockImplementation(async () => value as never);
      expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull(); expect(f.calls.opens).toEqual([]);
    }
    const f = fixture(); f.afterRead(() => f.revoke()); expect(await f.provider.rootFor(PARTITION, BINDING)).toBeNull();
  });
  it("captures code-owned refs and never accepts a scope replacement", async () => {
    const f = fixture(); f.options.revalidate = async () => {}; f.options.binding.projectId = "proj_abcdef012345"; f.options.partition.ownerKey = "other";
    expect(await f.provider.rootFor(PARTITION, BINDING)).toBe(P.sourceRoot); f.revoke(); expect(await f.provider.sourcesFor(BINDING)).toEqual([]);
  });
});
