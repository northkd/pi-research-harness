import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createSyntheticP0ScopeLoader, type ScienceP0FileStamp, type ScienceP0ScopeIo } from "../../../../claude-science/host/science-p0-scope.js";

const authority = "/var/lib/pi-claude-science-viewer-authority/p0-binding.json";
const checkpoint = "/var/lib/pi-claude-science/home/.local/state/pi-science-p0/checkpoint.json";
const cwd = "/home/example/.local/share/pi-research/dashboard-ui/claude-science/qa/synthetic-workspace";
const hash = "cdde40745c26fab81103b2d29619ed6766777a35b23717ee6e46d7ec4842b690";
const root = "11111111-1111-4111-8111-111111111111";
const descriptor = () => ({ schemaVersion: 1, runId: "a".repeat(32), intentId: "22222222-2222-4222-8222-222222222222", projectId: "proj_0123456789ab", rootFrameId: root, frameId: root, requestSha256: hash });
const originalCheckpoint = () => ({ schema: 1, run_id: "a".repeat(32), intent_id: descriptor().intentId, request_sha256: hash, project_id: descriptor().projectId, frame_id: root, creation_attempted: true, submission_attempted: true, cancel_attempted: false, approval_attempted: false });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function stamp(kind: ScienceP0FileStamp["kind"], ino: bigint, uid: number, gid: number, mode: number, size = 0): ScienceP0FileStamp {
  return { kind, dev: 1n, ino, uid, gid, mode, nlink: 1, size, mtimeNs: 1n, ctimeNs: 1n };
}

function fakeIo() {
  const files = new Map<string, { data: Uint8Array; stamp: ScienceP0FileStamp }>();
  const dirs = new Map<string, ScienceP0FileStamp>();
  const calls: string[] = [];
  for (const target of [authority, checkpoint, `${cwd}/unused`]) {
    const parts = target.split("/").slice(0, -1);
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/") || "/";
      const user = path.startsWith("/home/example") || path.startsWith("/var/lib/pi-claude-science/home");
      dirs.set(path, stamp("directory", BigInt(dirs.size + 10), user ? 1000 : 0, user ? 1000 : 0, 0o755));
    }
  }
  dirs.set("/var/lib/pi-claude-science-viewer-authority", stamp("directory", 60n, 0, 1000, 0o750));
  dirs.set("/var/lib/pi-claude-science/home/.local/state/pi-science-p0", stamp("directory", 61n, 1000, 1000, 0o700));
  dirs.set(cwd, stamp("directory", 62n, 1000, 1000, 0o700));
  function setFile(path: string, value: unknown, ino = path === authority ? 80n : 81n) {
    const data = bytes(value);
    files.set(path, { data, stamp: stamp("file", ino, path === authority ? 0 : 1000, 1000, path === authority ? 0o440 : 0o600, data.length) });
  }
  setFile(authority, descriptor());
  setFile(checkpoint, originalCheckpoint());
  let onOpen: ((path: string, saved: ScienceP0FileStamp) => void) | undefined;
  let onRead: ((path: string, saved: ScienceP0FileStamp) => void) | undefined;
  const io: ScienceP0ScopeIo = {
    async lstat(path) { calls.push(`stat:${path}`); const value = files.get(path)?.stamp ?? dirs.get(path); if (!value) throw new Error("private-fs-error"); return { ...value }; },
    async realpath(path) { calls.push(`real:${path}`); return path; },
    async open(path) {
      calls.push(`open:${path}`);
      const entry = files.get(path);
      if (!entry) throw new Error("private-open-error");
      const saved = { ...entry.stamp };
      onOpen?.(path, saved);
      return { async stat() { return { ...saved }; }, async read(offset, length) { calls.push(`read:${path}`); onRead?.(path, saved); return entry.data.slice(offset, offset + length); }, async close() { calls.push(`close:${path}`); } };
    },
  };
  return { io, files, dirs, calls, setFile, setOnOpen(value: typeof onOpen) { onOpen = value; }, setOnRead(value: typeof onRead) { onRead = value; } };
}

describe("fixed host synthetic P0 scope", () => {
  it("accepts the installed private native base only for checkpoint ancestry and reads the separate fixed Root authority", async () => {
    const fake = fakeIo(); Object.assign(fake.dirs.get("/var/lib/pi-claude-science")!, { uid: 1000, gid: 1000, mode: 0o700 });
    const loaded = await createSyntheticP0ScopeLoader(fake.io)();
    await expect(loaded.scope.revalidate()).resolves.toBeUndefined();
    expect(fake.calls).toContain(`open:${authority}`);
    expect(fake.calls.some(value => value.includes("/var/lib/pi-claude-science/viewer-authority"))).toBe(false);
  });

  it.each([
    { gid: 1001, mode: 0o700 }, { gid: 0, mode: 0o700 }, { gid: 1000, mode: 0o755 },
    { gid: 1000, mode: 0o770 }, { gid: 1000, mode: 0o777 }, { gid: 1000, mode: 0o1700 },
  ])("refuses a private native base with wrong gid or mode %j", async change => {
    const fake = fakeIo(); Object.assign(fake.dirs.get("/var/lib/pi-claude-science")!, { uid: 1000, ...change });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`open:${checkpoint}`);
  });

  it.each(["/var/lib", "/var/lib/pi-claude-science-viewer-authority"])("still rejects an application-owned Root authority ancestor %s", async path => {
    const fake = fakeIo(); Object.assign(fake.dirs.get(path)!, { uid: 1000, gid: 1000, mode: 0o700 });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`open:${authority}`);
  });

  it("never falls back to a Root-owned descriptor under the application-owned native base", async () => {
    const fake = fakeIo(), previous = "/var/lib/pi-claude-science/viewer-authority/p0-binding.json";
    fake.files.delete(authority);
    Object.assign(fake.dirs.get("/var/lib/pi-claude-science")!, { uid: 1000, gid: 1000, mode: 0o700 });
    fake.dirs.set("/var/lib/pi-claude-science/viewer-authority", stamp("directory", 800n, 0, 1000, 0o750));
    fake.setFile(previous, descriptor()); Object.assign(fake.files.get(previous)!.stamp, { uid: 0, mode: 0o440 });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`open:${previous}`);
  });

  it("accepts only the installed non-writable gid1001 workspace ancestors while the final cwd stays gid1000", async () => {
    const fake = fakeIo();
    for (const [path, value] of fake.dirs) if (path.startsWith("/home/example") && path !== cwd) value.gid = 1001;
    const loaded = await createSyntheticP0ScopeLoader(fake.io)();
    await expect(loaded.scope.revalidate()).resolves.toBeUndefined();
    expect(loaded.scope.partition.cwd).toBe(cwd);
  });

  it.each([
    ["/home/example", { gid: 1001, mode: 0o775 }],
    ["/home/example", { gid: 1000, mode: 0o775 }],
    ["/home/example", { gid: 1001, mode: 0o2755 }],
    ["/home/example", { gid: 1002, mode: 0o755 }],
    [cwd, { gid: 1001 }],
    ["/var/lib/pi-claude-science/home/.local/state/pi-science-p0", { gid: 1001 }],
    ["/var/lib/pi-claude-science-viewer-authority", { gid: 1001 }],
  ] as const)("refuses untrusted gid, writable or special-bit directories %s %j", async (path, change) => {
    const fake = fakeIo(); Object.assign(fake.dirs.get(path)!, change);
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it("keeps the checkpoint file's gid1000 requirement", async () => {
    const fake = fakeIo(); fake.files.get(checkpoint)!.stamp.gid = 1001;
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`open:${checkpoint}`);
  });

  it("constructs without IO, uses fixed partition and root task, and hides diagnostic serialization", async () => {
    const fake = fakeIo();
    const load = createSyntheticP0ScopeLoader(fake.io);
    expect(fake.calls).toEqual([]);
    const loaded = await load();
    expect(loaded.scope.partition).toEqual({ ownerKey: JSON.stringify(["host", "inert-operator"]), cwd });
    expect(loaded.scope.binding).toEqual({ projectId: descriptor().projectId, taskId: root, rootFrameId: root, frameId: root });
    expect(loaded.expectedVisibleProjectName).toBe(`science-synthetic-${descriptor().runId}`);
    expect(JSON.stringify(loaded)).not.toContain(descriptor().runId);
    expect(inspect(loaded)).not.toContain(root);
    expect(inspect(loaded.scope.binding)).not.toContain(root);
    expect(JSON.stringify(loaded.scope.partition)).not.toContain(cwd);
    await loaded.scope.revalidate();
    expect(fake.calls.some((value) => value.includes("/proc/") || value.includes("http"))).toBe(false);
  });

  it("allows atomic checkpoint inode replacement and either approval boolean without granting another task", async () => {
    const fake = fakeIo();
    const loaded = await createSyntheticP0ScopeLoader(fake.io)();
    fake.setFile(checkpoint, { ...originalCheckpoint(), approval_attempted: true }, 500n);
    await expect(loaded.scope.revalidate()).resolves.toBeUndefined();
    fake.setFile(checkpoint, { ...originalCheckpoint(), frame_id: "33333333-3333-4333-8333-333333333333" }, 501n);
    await expect(loaded.scope.revalidate()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it.each([
    { ownerKey: "attacker" }, { cwd: "/tmp/other" }, { checkpointPath: "/tmp/other" }, { authorized: true },
    { runId: root }, { rootFrameId: "33333333-3333-4333-8333-333333333333" },
    { requestSha256: "0".repeat(64) }, { projectId: "proj_other" },
  ])("rejects authority expansion or invalid descriptor %j", async (change) => {
    const fake = fakeIo(); fake.setFile(authority, { ...descriptor(), ...change });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it.each([
    { creation_attempted: false }, { submission_attempted: false }, { cancel_attempted: true },
    { approval_attempted: "true" }, { project_id: "proj_abcdef012345" }, { request_sha256: "0".repeat(64) }, { authorized: true },
  ])("rejects checkpoint flags, drift or injected authority %j", async (change) => {
    const fake = fakeIo(); fake.setFile(checkpoint, { ...originalCheckpoint(), ...change });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it.each([
    [authority, { uid: 1000 }], [authority, { mode: 0o640 }], [authority, { nlink: 2 }],
    [checkpoint, { uid: 0 }], [checkpoint, { mode: 0o644 }], [checkpoint, { kind: "other" }],
  ] as const)("rejects untrusted file provenance %s %j", async (path, change) => {
    const fake = fakeIo(); Object.assign(fake.files.get(path)!.stamp, change);
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`open:${path}`);
  });

  it.each([authority, checkpoint])("checks opened FD before reading %s", async (path) => {
    const fake = fakeIo(); fake.setOnOpen((opened, saved) => { if (opened === path) saved.ino = 900n; });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`read:${path}`);
    expect(fake.calls).toContain(`close:${path}`);
  });

  it.each([authority, checkpoint])("rejects path replacement during bounded read %s", async (path) => {
    const fake = fakeIo(); fake.setOnRead((read) => { if (read === path) fake.files.get(path)!.stamp.ino = 901n; });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it.each([authority, checkpoint])("rejects FD changes during bounded read %s", async (path) => {
    const fake = fakeIo(); fake.setOnRead((read, saved) => { if (read === path) saved.ctimeNs = 900n; });
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).toContain(`close:${path}`);
  });

  it.each([
    ["/var/lib/pi-claude-science", { uid: 1000 }],
    ["/var/lib/pi-claude-science-viewer-authority", { mode: 0o770 }],
    ["/var/lib/pi-claude-science/home", { mode: 0o777 }],
    [cwd, { mode: 0o702 }],
  ] as const)("rejects uncontrolled directory provenance %s %j", async (path, change) => {
    const fake = fakeIo(); Object.assign(fake.dirs.get(path)!, change);
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    expect(fake.calls).not.toContain(`open:${path === "/var/lib/pi-claude-science" || path.startsWith("/var/lib/pi-claude-science/home") ? checkpoint : authority}`);
  });

  it.each(["/var/lib/pi-claude-science-viewer-authority", "/var/lib/pi-claude-science/home/.local/state/pi-science-p0", cwd])("rejects unsafe or replaced directory %s", async (path) => {
    const fake = fakeIo(); const loaded = await createSyntheticP0ScopeLoader(fake.io)();
    fake.dirs.get(path)!.kind = "other";
    await expect(loaded.scope.revalidate()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it("rejects a replaced fixed workspace even when its metadata is otherwise valid", async () => {
    const fake = fakeIo(); const loaded = await createSyntheticP0ScopeLoader(fake.io)();
    fake.dirs.get(cwd)!.ino = 999n;
    await expect(loaded.scope.revalidate()).rejects.toThrow("science-p0-scope-unavailable");
  });

  it("allows unrelated directory entries to change without revoking the fixed workspace", async () => {
    const fake = fakeIo(); const loaded = await createSyntheticP0ScopeLoader(fake.io)();
    fake.dirs.get("/home/example")!.nlink += 1;
    fake.dirs.get("/home/example")!.mtimeNs = 900n;
    await expect(loaded.scope.revalidate()).resolves.toBeUndefined();
  });

  it("bounds input, rejects malformed UTF8, and returns a fixed error without raw paths", async () => {
    const fake = fakeIo(); fake.files.get(checkpoint)!.stamp.size = 1025;
    await expect(createSyntheticP0ScopeLoader(fake.io)()).rejects.toThrow("science-p0-scope-unavailable");
    const invalid = fakeIo(); invalid.files.get(authority)!.data = new Uint8Array([255]); invalid.files.get(authority)!.stamp.size = 1;
    await expect(createSyntheticP0ScopeLoader(invalid.io)()).rejects.toThrow("science-p0-scope-unavailable");
    const missing = fakeIo(); missing.files.delete(authority);
    try { await createSyntheticP0ScopeLoader(missing.io)(); throw new Error("expected failure"); }
    catch (error) { expect(inspect(error)).not.toContain("private-fs-error"); expect(inspect(error)).not.toContain(authority); }
  });
});
