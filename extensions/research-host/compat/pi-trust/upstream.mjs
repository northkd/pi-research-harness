// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/access/pi-trust-mirror-service.ts
import * as fs4 from "node:fs";
import os5 from "node:os";
import path6 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/pi-trust-mirror.ts
import * as fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/forbidden-subjects.ts
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/paths.ts
function isDriveLetterForm(value) {
  return /^[A-Za-z]:(?![\\/])/.test(value);
}
function driveLetterPrefix(value) {
  const m = value.match(/^([A-Za-z]:)(?![\\/])/);
  return m ? m[1] : null;
}
function getRoot(p, platform) {
  if (platform === "win32") {
    const unc = p.match(/^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/);
    if (unc) return `\\\\${unc[1]}\\${unc[2]}\\`;
    const drive = p.match(/^([A-Za-z]:)[\\/]/);
    if (drive) return `${drive[1]}\\`;
    return "";
  }
  return p.startsWith("/") ? "/" : "";
}
function normalizeSegments(rest, sep) {
  const split = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  const out = [];
  for (const seg of split) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}
function normalizePath(p, platform = process.platform) {
  if (!p) return p;
  if (platform === "win32") {
    if (isDriveLetterForm(p)) {
      const prefix = driveLetterPrefix(p);
      const rest = p.slice(prefix.length);
      if (!rest) return prefix + "\\";
      return normalizePath(prefix + "\\" + rest, "win32");
    }
    const root2 = getRoot(p, "win32");
    if (root2) {
      const rest = p.slice(root2.length);
      const segments3 = normalizeSegments(rest, "\\");
      if (segments3.length === 0) return root2;
      return root2 + segments3.join("\\");
    }
    const segments2 = normalizeSegments(p, "\\");
    return segments2.join("\\");
  }
  const root = getRoot(p, platform);
  if (root) {
    const segments2 = normalizeSegments(p.slice(root.length), "/");
    if (segments2.length === 0) return root;
    return root + segments2.join("/");
  }
  const segments = normalizeSegments(p, "/");
  return segments.join("/");
}
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return a === b;
  const na = normalizePath(a, platform);
  const nb = normalizePath(b, platform);
  if (platform === "linux") return na === nb;
  return na.toLowerCase() === nb.toLowerCase();
}
function sunPathMax(platform = process.platform) {
  return platform === "darwin" ? 104 : 108;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/forbidden-subjects.ts
function realpathNearestAncestor(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathNearestAncestor(parent), path.basename(p));
  }
}
var POSIX_SYSTEM_DIRS = ["/etc", "/usr", "/var", "/Library", "/System", "/bin", "/sbin", "/opt"];
var WINDOWS_SYSTEM_DIRS = [
  ["SystemRoot", "C:\\Windows"],
  ["ProgramFiles", "C:\\Program Files"],
  ["ProgramFiles(x86)", "C:\\Program Files (x86)"],
  ["ProgramData", "C:\\ProgramData"]
];
function pathOps(env) {
  const platform = env?.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const hostIsWindows = process.platform === "win32";
  const canonical = (x) => {
    const resolved = p.resolve(x);
    return windows === hostIsWindows ? realpathNearestAncestor(resolved) : resolved;
  };
  const same = (a, b) => samePath(a, b, platform);
  return { platform, windows, p, canonical, same };
}
function forbiddenGrantSubjects(env) {
  const { windows, p, canonical } = pathOps(env);
  const vars = env?.env ?? process.env;
  const home = env?.homedir ?? os.homedir();
  const system = windows ? WINDOWS_SYSTEM_DIRS.map(([name, fallback]) => vars[name] || fallback) : POSIX_SYSTEM_DIRS;
  const root = windows ? p.parse(p.resolve(vars.SystemRoot || "C:\\")).root : "/";
  const whole = [root, home, ...system];
  const sensitive = [p.join(home, ".ssh"), p.join(home, ".pi")];
  return { whole: whole.map(canonical), sensitive: sensitive.map(canonical) };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/pi-trust-mirror.ts
function piTrustKey(input, opts) {
  let p = input;
  if (p === "~") p = opts.home;
  else if (p.startsWith("~/") || path2.sep === "\\" && p.startsWith("~\\")) p = path2.join(opts.home, p.slice(2));
  if (!path2.isAbsolute(p)) throw new Error(`piTrustKey: relative path rejected: ${JSON.stringify(input)}`);
  const resolved = path2.resolve(p);
  try {
    return fs2.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
function isCanonicalAbsolutePath(p) {
  return typeof p === "string" && p.length > 0 && !p.includes("\0") && path2.isAbsolute(p) && path2.normalize(p) === p && !p.split(/[\\/]/).includes("..");
}
function ancestorKeys(key) {
  const out = [];
  let cur = key;
  for (; ; ) {
    out.push(cur);
    const parent = path2.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}
var POSIX_BROAD_PARENTS = ["/Users", "/home", "/Volumes", "/private", "/var/tmp", "/mnt", "/media"];
function mirrorDenyRules(env = {}) {
  const home = env.homedir ?? os2.homedir();
  const platform = env.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path2.win32 : path2.posix;
  const canon = (x) => realpathNearestAncestor(p.resolve(x));
  const grant = forbiddenGrantSubjects({ homedir: home, platform, env: env.env });
  const realHome = canon(home);
  const exact = [...grant.whole];
  for (let cur = p.dirname(realHome); ; cur = p.dirname(cur)) {
    exact.push(cur);
    if (p.dirname(cur) === cur) break;
  }
  if (windows) {
    const vars = env.env ?? process.env;
    exact.push(p.join(vars.SystemDrive ? `${vars.SystemDrive}\\` : "C:\\", "Users"));
  } else {
    exact.push(...POSIX_BROAD_PARENTS.map(canon));
  }
  const tmpdirs = windows ? [os2.tmpdir()] : [os2.tmpdir(), "/tmp", "/private/tmp"];
  const subtree = [
    ...grant.sensitive,
    ...[".aws", ".gnupg", ".kube", ".docker", ".cache", "Downloads"].map((d) => canon(p.join(home, d))),
    ...tmpdirs.map(canon)
  ];
  return { exact: [...new Set(exact)], subtree: [...new Set(subtree)] };
}
function samePathStr(a, b, windows) {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function isMirrorDenied(key, rules, platform = process.platform) {
  const windows = platform === "win32";
  const p = windows ? path2.win32 : path2.posix;
  const real = realpathNearestAncestor(p.resolve(key));
  if (rules.exact.some((f) => samePathStr(real, f, windows))) return true;
  return rules.subtree.some((root) => {
    if (samePathStr(real, root, windows)) return true;
    const rel = p.relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
  });
}
function filterMirrorEntries(candidates, settings, facts) {
  const deny = facts.deny ?? mirrorDenyRules({ homedir: facts.home, platform: facts.platform });
  const counted = [];
  const ignored = [];
  for (const entry of candidates) {
    const reason = ignoreReason(entry, settings, facts, deny);
    if (reason) ignored.push({ entry, reason });
    else counted.push(entry);
  }
  return { counted, ignored };
}
function ignoreReason(entry, settings, facts, deny) {
  if (facts.installed?.[entry.sourceKind] === false) return "source-not-installed";
  if (!facts.choicesReadable) return "choice-unreadable";
  if (isMirrorDenied(entry.key, deny, facts.platform)) return "forbidden-folder";
  if (entry.hookState === "changed" || entry.hookState === "unreadable") return "hook-changed";
  if (entry.sourceKind === "accessGrants" && entry.projectRoot !== true) return "not-project-root";
  const sourceOn = settings.sources[entry.sourceKind] === true;
  const wanted = entry.choice === true || sourceOn && entry.choice !== false;
  return wanted ? null : "source-off";
}
function statFolderIdentity(dir) {
  if (!isCanonicalAbsolutePath(dir)) return null;
  try {
    const st = fs2.statSync(dir, { bigint: true });
    const identity = { dev: st.dev.toString(), ino: st.ino.toString() };
    const birth = Number(st.birthtimeMs);
    if (Number.isFinite(birth) && birth > 0 && st.birthtimeMs !== st.ctimeMs) identity.birthtimeMs = birth;
    return identity;
  } catch {
    return null;
  }
}
function identityMatches(entry, observed) {
  if (!observed) return false;
  if (entry.dev !== observed.dev || entry.ino !== observed.ino) return false;
  if (entry.birthtimeMs !== void 0 && entry.birthtimeMs !== observed.birthtimeMs) return false;
  return true;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/pi-trust-mirror-snapshot.ts
import * as fs3 from "node:fs";
import path5 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/dashboard-paths.ts
import os4 from "node:os";
import path4 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/managed-paths.ts
import path3 from "node:path";
import os3 from "node:os";
function getManagedDir(env) {
  return path3.join(env?.homedir ?? os3.homedir(), ".pi-dashboard");
}
function getManagedBin(env) {
  return path3.join(getManagedDir(env), "node_modules", ".bin");
}
function getPiSettingsPath(env) {
  return path3.join(env?.homedir ?? os3.homedir(), ".pi", "agent", "settings.json");
}
var MANAGED_DIR = getManagedDir();
var MANAGED_BIN = getManagedBin();
var PI_SETTINGS_PATH = getPiSettingsPath();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/dashboard-paths.ts
function getDashboardConfigDir(env) {
  return path4.join(env?.homedir ?? os4.homedir(), ".pi", "dashboard");
}
var SUN_PATH_MAX = sunPathMax();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/worktree-init-hook.ts
import { createHash } from "node:crypto";
function normalizeRun(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const run = raw;
  if (run.type === "script") {
    if (typeof run.command !== "string" || run.command.length === 0) return null;
    return { type: "script", command: run.command };
  }
  if (run.type === "agent") {
    if (typeof run.prompt !== "string" || run.prompt.length === 0) return null;
    const agent = { type: "agent", prompt: run.prompt };
    if (typeof run.model === "string") agent.model = run.model;
    if (run.settings !== void 0) agent.settings = run.settings;
    return agent;
  }
  return null;
}
function normalizeHook(hook) {
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return null;
  const h = hook;
  if (typeof h.gate !== "string" || h.gate.length === 0) return null;
  const run = normalizeRun(h.run);
  return run ? { gate: h.gate, run } : null;
}
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}
function hookDefHash(hook) {
  return createHash("sha256").update(canonicalize(hook)).digest("hex");
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/pi-trust-mirror-snapshot.ts
function piTrustMirrorSnapshotPath() {
  return path5.join(getDashboardConfigDir(), "pi-trust-mirror.json");
}
function piTrustOverridesPath() {
  return path5.join(getDashboardConfigDir(), "pi-trust-overrides.json");
}
var SOURCE_KINDS = /* @__PURE__ */ new Set(["worktreeInit", "workflow", "pinned", "folderWorkspaces", "accessGrants"]);
function validEntry(e) {
  if (!e || typeof e !== "object") return false;
  const x = e;
  return typeof x.key === "string" && path5.isAbsolute(x.key) && typeof x.sourceKind === "string" && SOURCE_KINDS.has(x.sourceKind) && typeof x.dev === "string" && typeof x.ino === "string" && (x.birthtimeMs === void 0 || typeof x.birthtimeMs === "number") && (x.configRoot === void 0 || typeof x.configRoot === "string") && (x.hookHash === void 0 || typeof x.hookHash === "string");
}
function readPiTrustMirrorSnapshot(file = piTrustMirrorSnapshotPath()) {
  try {
    const parsed = JSON.parse(fs3.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed;
    if (p.version !== 1 || typeof p.generation !== "number" || !Array.isArray(p.entries)) return null;
    return { version: 1, generation: p.generation, entries: p.entries.filter(validEntry) };
  } catch {
    return null;
  }
}
function readPiTrustFileLockless(agentDir) {
  const file = path5.join(agentDir, "trust.json");
  let raw;
  try {
    raw = fs3.readFileSync(file, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "unreadable" };
    const data = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null) continue;
      if (v !== true && v !== false) return { kind: "unreadable" };
      data[k] = v;
    }
    return { kind: "ok", data };
  } catch {
    return { kind: "unreadable" };
  }
}
function nearestRecordedEntry(data, cwdKey) {
  for (const k of ancestorKeys(cwdKey)) {
    const v = data[k];
    if (v === true || v === false) return { path: k, decision: v };
  }
  return null;
}
function currentHookHash(configRoot) {
  try {
    const parsed = JSON.parse(fs3.readFileSync(path5.join(configRoot, ".pi", "settings.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const hook = normalizeHook(parsed.worktreeInit);
    return hook ? hookDefHash(hook) : null;
  } catch {
    return null;
  }
}
function isProjectRoot(dir) {
  if (!isCanonicalAbsolutePath(dir)) return false;
  try {
    return fs3.existsSync(path5.join(dir, ".git")) || fs3.existsSync(path5.join(dir, ".pi"));
  } catch {
    return false;
  }
}
function coverSnapshot(snapshot, cwdKey, hooks = {}) {
  if (!snapshot || snapshot.entries.length === 0) return { covered: false };
  const byKey = groupByKey(snapshot.entries);
  const hashOf = hooks.currentHookHash ?? currentHookHash;
  let rejected;
  for (const k of ancestorKeys(cwdKey)) {
    const list = byKey.get(k);
    if (!list) continue;
    const identity = statFolderIdentity(k);
    for (const entry of list) {
      const reason = entryRejection(entry, k, identity, hashOf);
      if (!reason) return { covered: true, entry };
      rejected ??= reason;
    }
  }
  return { covered: false, ...rejected ? { reason: rejected } : {} };
}
function groupByKey(entries) {
  const byKey = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const list = byKey.get(e.key);
    if (list) list.push(e);
    else byKey.set(e.key, [e]);
  }
  return byKey;
}
function entryRejection(entry, folder, identity, hashOf) {
  if (!identityMatches(entry, identity)) return "identity-mismatch";
  if (entry.sourceKind === "worktreeInit" || entry.sourceKind === "workflow") {
    const current = entry.configRoot ? hashOf(entry.configRoot) : null;
    if (current === null || current !== entry.hookHash) return "hook-changed";
  }
  if (entry.sourceKind === "accessGrants" && !isProjectRoot(folder)) return "not-project-root";
  return null;
}
function safePiTrustKey(cwd, home) {
  try {
    return piTrustKey(cwd, { home });
  } catch {
    return null;
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/access/pi-trust-mirror-service.ts
var SNAPSHOT_WARN_ENTRIES = 5e3;
var choiceKey = (kind, key) => `${kind}\0${key}`;
function readChoicesFile(file) {
  let raw;
  try {
    raw = fs4.readFileSync(file, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? { readable: true, choices: {} } : { readable: false, choices: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    const c = parsed?.choices;
    if (!c || typeof c !== "object" || Array.isArray(c)) return { readable: false, choices: {} };
    const choices = {};
    for (const [k, v] of Object.entries(c)) if (typeof v === "boolean") choices[k] = v;
    return { readable: true, choices };
  } catch {
    return { readable: false, choices: {} };
  }
}
function worktreeCandidate(key, repoRoot, recordedHash, currentHash) {
  const hookState = currentHash === null ? "unreadable" : currentHash === recordedHash ? "current" : "changed";
  return { sourceKind: "worktreeInit", key, hookState, meta: { configRoot: repoRoot, hookHash: recordedHash } };
}
function buildCandidates(deps, choices, keyOf, hookHash) {
  const out = [];
  const push = (c) => {
    out.push({ ...c, choice: choices[choiceKey(c.sourceKind, c.key)] });
  };
  for (const dir of deps.listPinned()) {
    const key = keyOf(dir);
    if (key) push({ sourceKind: "pinned", key });
  }
  for (const dir of deps.listWorkspaceFolders()) {
    const key = keyOf(dir);
    if (key) push({ sourceKind: "folderWorkspaces", key });
  }
  for (const { repoRoot, hash } of deps.listWorktreeTrust()) {
    const key = keyOf(repoRoot);
    if (key) push(worktreeCandidate(key, repoRoot, hash, hookHash(repoRoot)));
  }
  for (const { subject } of deps.listPersistedGrants()) {
    const key = keyOf(subject);
    if (key) push({ sourceKind: "accessGrants", key, projectRoot: isProjectRootDir(key) });
  }
  return out;
}
function isProjectRootDir(dir) {
  try {
    return fs4.existsSync(path6.join(dir, ".git")) || fs4.existsSync(path6.join(dir, ".pi"));
  } catch {
    return false;
  }
}
function defaultWriteAtomic(file, content, mode) {
  fs4.mkdirSync(path6.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs4.writeFileSync(tmp, content, { mode });
    fs4.renameSync(tmp, file);
  } catch (err) {
    try {
      fs4.rmSync(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}
function createPiTrustMirrorService(deps) {
  const home = deps.home ?? os5.homedir();
  const snapshotFile = deps.snapshotPath ?? piTrustMirrorSnapshotPath();
  const overridesFile = deps.overridesPath ?? piTrustOverridesPath();
  const writeAtomic = deps.writeAtomic ?? defaultWriteAtomic;
  const hookHash = deps.hookHash ?? currentHookHash;
  const warn = deps.warn ?? ((m) => console.warn(`[pi-trust-mirror] ${m}`));
  const installed = { workflow: false, ...deps.installed };
  let lastGeneration = 0;
  const keyOf = (folder) => {
    try {
      return piTrustKey(folder, { home });
    } catch {
      return null;
    }
  };
  const readChoices = () => readChoicesFile(overridesFile);
  function writeChoices(choices) {
    writeAtomic(overridesFile, `${JSON.stringify({ version: 1, choices }, null, 2)}
`, 384);
  }
  const candidatesFor = (choices) => buildCandidates(deps, choices, keyOf, hookHash);
  function evaluate(opts) {
    const cfg = deps.getConfig();
    const { readable, choices } = readChoices();
    const excluded = new Set((opts?.exclude ?? []).map((e) => choiceKey(e.sourceKind, e.key)));
    const candidates = candidatesFor(choices).filter((c) => !excluded.has(choiceKey(c.sourceKind, c.key)));
    const filtered = filterMirrorEntries(candidates, { sources: cfg.sources }, {
      choicesReadable: readable,
      installed,
      deny: deps.denyRules ? deps.denyRules() : mirrorDenyRules({ homedir: home }),
      home
    });
    const counted = [];
    const ignored = [...filtered.ignored];
    for (const candidate of filtered.counted) {
      const identity = statFolderIdentity(candidate.key);
      if (!identity) {
        ignored.push({ entry: candidate, reason: "identity-mismatch" });
        continue;
      }
      const meta = candidate.meta;
      counted.push({
        candidate,
        snapshotEntry: {
          key: candidate.key,
          sourceKind: candidate.sourceKind,
          ...identity,
          ...meta?.configRoot ? { configRoot: meta.configRoot } : {},
          ...meta?.hookHash ? { hookHash: meta.hookHash } : {}
        }
      });
    }
    const sourcesNotInstalled = Object.keys(installed).filter((k) => installed[k] === false);
    return { counted, ignored, candidates, choicesReadable: readable, sourcesNotInstalled };
  }
  function rewriteSnapshot(opts) {
    if (deps.canWrite && !deps.canWrite()) throw new Error("pi-trust-mirror: this server does not hold the home lock");
    const evaluation = evaluate(opts);
    const onDisk = readPiTrustMirrorSnapshot(snapshotFile);
    const generation = Math.max(lastGeneration, onDisk?.generation ?? 0) + 1;
    const snapshot = {
      version: 1,
      generation,
      entries: evaluation.counted.map((c) => c.snapshotEntry)
    };
    writeAtomic(snapshotFile, `${JSON.stringify(snapshot)}
`, 384);
    lastGeneration = generation;
    if (snapshot.entries.length > SNAPSHOT_WARN_ENTRIES) {
      warn(`snapshot holds ${snapshot.entries.length} entries (> ${SNAPSHOT_WARN_ENTRIES}); consider unpinning unused folders`);
    }
    return generation;
  }
  function setChoice(kind, folder, choice) {
    const key = keyOf(folder);
    if (!key) throw new Error(`pi-trust-mirror: cannot key folder ${JSON.stringify(folder)}`);
    const { readable, choices } = readChoices();
    if (!readable) throw new Error("pi-trust-mirror: per-entry choices file is unreadable");
    const k = choiceKey(kind, key);
    if (choice === null) delete choices[k];
    else choices[k] = choice;
    writeChoices(choices);
  }
  function revokeMany(entries, writeSource) {
    const keyed = entries.flatMap((e) => {
      const key = keyOf(e.folder);
      return key ? [{ sourceKind: e.sourceKind, key, folder: e.folder }] : [];
    });
    if (keyed.length > 0) rewriteSnapshot({ exclude: keyed.map(({ sourceKind, key }) => ({ sourceKind, key })) });
    writeSource();
    for (const e of keyed) {
      try {
        setChoice(e.sourceKind, e.folder, null);
      } catch {
      }
    }
    try {
      rewriteSnapshot();
    } catch (err) {
      warn(`snapshot refresh after revoke failed: ${err?.message}`);
    }
  }
  return {
    evaluate,
    choiceFor(kind, key) {
      const { choices } = readChoices();
      return choices[choiceKey(kind, key)];
    },
    rewriteSnapshot,
    rebuildAtBoot: () => rewriteSnapshot(),
    setChoice,
    grant(kind, folder, choice, writeSource) {
      const key = keyOf(folder);
      if (!key) throw new Error(`pi-trust-mirror: cannot key folder ${JSON.stringify(folder)}`);
      const previous = readChoices();
      if (choice !== void 0) setChoice(kind, folder, choice);
      try {
        writeSource();
      } catch (err) {
        if (choice !== void 0) {
          try {
            writeChoices(previous.choices);
          } catch {
          }
        }
        throw err;
      }
      rewriteSnapshot();
    },
    revoke(kind, folder, writeSource) {
      revokeMany([{ sourceKind: kind, folder }], writeSource);
    },
    revokeMany,
    refresh() {
      try {
        rewriteSnapshot();
      } catch (err) {
        warn(`snapshot refresh failed: ${err?.message}`);
      }
    },
    readSnapshot: () => readPiTrustMirrorSnapshot(snapshotFile)
  };
}
export {
  coverSnapshot,
  createPiTrustMirrorService,
  isMirrorDenied,
  mirrorDenyRules,
  nearestRecordedEntry,
  piTrustKey,
  readPiTrustFileLockless,
  readPiTrustMirrorSnapshot,
  safePiTrustKey
};
