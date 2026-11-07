import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { ResWorkflowAgentGrant, ResWorkflowAgentBudgetChoice, ResWorkflowAgentBudgetUpdateRequest } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import type { FullHistoryAgentAttempt, FullHistoryAgentAttemptDraft, FullHistoryAgentAttemptIntent, FullHistoryAgentAttemptReceipt, FullHistoryAgentCheckpoint } from "./full-history-agent-contract.js";
import { readFullHistoryAgentBudgetAuthorization, validAgentBudgetChoice, type FullHistoryAgentBudgetRevision } from "./full-history-agent-budget.js";

const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
function fail(code: string): never { throw new Error(code); }
const safeName = (name: string) => /^[a-zA-Z0-9_.-]{1,160}$/.test(name);
const validReceipt = (r: FullHistoryAgentAttemptReceipt) => r.schema === "pi-full-agent-attempt-receipt.v2" && Object.keys(r).every(k => ["schema", "attemptId", "nodeId", "slot", "requestHash", "outcome", "sdkStopReason", "providerTerminalObserved", "usage", "errorCode", "raw", "rawHash"].includes(k)) && ["valid", "invalid-output", "invalid-source", "incomplete", "unknown"].includes(r.outcome) && ["stop", "length", "toolUse", "deferred", "error", "aborted", "none"].includes(r.sdkStopReason) && typeof r.providerTerminalObserved === "boolean" && (r.outcome !== "valid" || r.providerTerminalObserved && r.sdkStopReason === "stop" && typeof r.raw === "string" && !!r.raw) && (r.errorCode === undefined || ["analysis-full-output-invalid", "analysis-output-invalid-source", "analysis-full-output-incomplete", "analysis-full-result-unknown", "analysis-full-output-too-large"].includes(r.errorCode)) && (r.usage === undefined || !!r.usage && typeof r.usage === "object" && !Array.isArray(r.usage) && Object.entries(r.usage).every(([k, v]) => ["input", "output", "totalTokens", "cacheRead", "cacheWrite", "reasoning"].includes(k) && Number.isSafeInteger(v) && v! >= 0)) && (r.raw === undefined ? r.rawHash === undefined : typeof r.raw === "string" && Buffer.from(r.raw).toString("utf8") === r.raw && Buffer.byteLength(r.raw) <= 128 * 1024 && r.rawHash === hash(r.raw));
export interface FullHistoryAgentLease { epoch: string; assertCurrent(): Promise<void>; release(): Promise<void> }
interface GrantRecord { grant: ResWorkflowAgentGrant; modelFingerprint: string; requestId: string; requestHash: string; authorizedAt: string; expiresAt: string; nodeIds: string[]; promptSchemaHash: string; initialBudget?: ResWorkflowAgentBudgetChoice }

/** Authoritative v2 records are immutable, private and fsynced independently of the operation projection. */
export function createFullHistoryAgentStore(binding: { root: string; jobId: string; ownerKey: string; cwd: string }) {
  const root = binding.root;
  const stamp = (s: { dev: number; ino: number; mode: number; uid: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number }) => JSON.stringify([s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
  const observations = new Map<string, string>();
  const rootIdentity = (s: { dev: number; ino: number; mode: number; uid: number }) => JSON.stringify([s.dev, s.ino, s.mode, s.uid]);
  let heldIndex: { epoch: string; rootIdentity: string; state: Awaited<ReturnType<typeof strictState>>; names: Set<string>; stamps: Map<string, string> } | undefined;
  let heldLease: FullHistoryAgentLease | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => { const result = queue.catch(() => {}).then(action); queue = result; return result; };
  async function parent() {
    if (!["linux", "darwin"].includes(process.platform) || !path.isAbsolute(root) || path.resolve(root) !== root) fail("analysis-agent-private-storage-unsafe");
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), first = await handle.stat();
    const check = async () => {
      const [current, named] = await Promise.all([handle.stat(), lstat(root)]), uid = process.getuid?.();
      if (!current.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || current.dev !== first.dev || current.ino !== first.ino || named.dev !== first.dev || named.ino !== first.ino || current.uid !== uid || named.uid !== uid || (current.mode & 0o777) !== 0o700 || (named.mode & 0o777) !== 0o700 || current.nlink < 1 || named.nlink !== current.nlink || await realpath(root) !== root) fail("analysis-agent-private-storage-unsafe");
    };
    try { await check(); return { handle, check, leaf: (name: string) => { if (!safeName(name)) fail("analysis-agent-record-invalid"); return process.platform === "linux" ? `/proc/self/fd/${handle.fd}/${name}` : path.join(root, name); } }; }
    catch (error) { await handle.close(); throw error; }
  }
  async function write(name: string, value: unknown) {
    const anchor = await parent();
    const pending = `pending-${randomUUID()}.json`;
    try {
      const file = await open(anchor.leaf(pending), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const first = await file.stat();
        let visible = false;
        const check = async () => { await anchor.check(); const [current, named] = await Promise.all([file.stat(), lstat(path.join(root, visible ? name : pending))]), uid = process.getuid?.(); if (!current.isFile() || !named.isFile() || named.isSymbolicLink() || current.dev !== first.dev || current.ino !== first.ino || named.dev !== first.dev || named.ino !== first.ino || current.nlink !== 1 || named.nlink !== 1 || current.uid !== uid || named.uid !== uid || (current.mode & 0o777) !== 0o600 || (named.mode & 0o777) !== 0o600) fail("analysis-agent-private-storage-unsafe"); };
        await check();
        await file.writeFile(JSON.stringify({ schema: "pi-full-agent-record.v2", jobId: binding.jobId, ownerKey: binding.ownerKey, cwd: binding.cwd, value }) + "\n", "utf8");
        await file.sync(); await check();
        // Link publishes complete bytes with exclusive target semantics; an existing intent is never overwritten.
        await link(anchor.leaf(pending), anchor.leaf(name)); await unlink(anchor.leaf(pending)); visible = true;
        await check(); await anchor.handle.sync(); await check();
        if (heldIndex) { const saved = await file.stat(); if (!saved.isFile() || saved.nlink !== 1 || saved.uid !== process.getuid?.() || (saved.mode & 0o777) !== 0o600) fail("analysis-agent-private-storage-unsafe"); heldIndex.names.add(name); heldIndex.stamps.set(name, stamp(saved)); }
      } finally { await file.close(); }
    } finally { await anchor.handle.close(); }
  }
  async function read<T>(name: string, waits = 0): Promise<T | null> {
    const anchor = await parent();
    try {
      let file;
      try { file = await open(anchor.leaf(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      try {
        const first = await file.stat(), uid = process.getuid?.();
        if (first.nlink === 2 && waits < 3) { await file.close(); file = undefined; await new Promise(resolve => setTimeout(resolve, 5)); return read<T>(name, waits + 1); }
        if (!first.isFile() || first.uid !== uid || first.nlink !== 1 || (first.mode & 0o777) !== 0o600 || first.size > 512 * 1024) fail("analysis-agent-record-invalid");
        const text = await file.readFile("utf8"), after = await file.stat(), named = await lstat(path.join(root, name)); await anchor.check();
        if (after.dev !== first.dev || after.ino !== first.ino || after.size !== first.size || after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs || after.mode !== first.mode || after.uid !== uid || after.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.dev !== first.dev || named.ino !== first.ino || named.mode !== after.mode || named.uid !== uid || named.nlink !== 1) fail("analysis-agent-record-invalid");
        const envelope = JSON.parse(text);
        if (!envelope || envelope.schema !== "pi-full-agent-record.v2" || envelope.jobId !== binding.jobId || envelope.ownerKey !== binding.ownerKey || envelope.cwd !== binding.cwd || !envelope.value || typeof envelope.value !== "object" || Array.isArray(envelope.value)) fail("analysis-agent-record-invalid");
        observations.set(name, stamp(after));
        return envelope.value as T;
      } finally { await file?.close(); }
    } finally { await anchor.handle.close(); }
  }
  const cancelled = async () => { if (await read("cancel.json")) fail("cancelled"); };
  const legacyBudgetFor = (authorization: GrantRecord) => readFullHistoryAgentBudgetAuthorization({ scopeDir: path.dirname(root), jobId: binding.jobId, ownerKey: binding.ownerKey, cwd: binding.cwd, grantHash: authorization.grant.grantHash, materialPlanHash: authorization.grant.materialPlanHash, modelFingerprint: authorization.modelFingerprint, promptSchemaHash: authorization.promptSchemaHash, authorizedAt: authorization.authorizedAt, expiresAt: authorization.expiresAt });
  function revisionRecord(auth: GrantRecord, choice: ResWorkflowAgentBudgetChoice, requestId: string, requestHash: string, revision: number, previousHash: string | null, usedRequests: number, authorizedAt: string): FullHistoryAgentBudgetRevision {
    return { schema: "pi-full-agent-budget-revision.v1", revision, previousHash, usedRequests, requestId, requestHash, ...structuredClone(choice), authorizedAt, expiresAt: auth.expiresAt, grantHash: auth.grant.grantHash, materialPlanHash: auth.grant.materialPlanHash, modelFingerprint: auth.modelFingerprint, promptSchemaHash: auth.promptSchemaHash };
  }
  const budgetProjection = (auth: GrantRecord, row: FullHistoryAgentBudgetRevision) => ({ ...(row.maxRequests === null ? { unlimited: true as const } : {}), maxRequests: row.maxRequests, revision: row.revision, authorizationHash: hash(row), authorizedAt: row.authorizedAt, expiresAt: auth.expiresAt, jobId: binding.jobId, grantHash: row.grantHash, materialPlanHash: row.materialPlanHash, modelFingerprint: row.modelFingerprint, promptSchemaHash: row.promptSchemaHash });
  async function budgetHistory(auth: GrantRecord | null, names: string[]) {
    const rows: FullHistoryAgentBudgetRevision[] = [];
    if (auth?.initialBudget !== undefined) {
      if (!validAgentBudgetChoice(auth.initialBudget)) fail("analysis-agent-budget-invalid");
      rows.push(revisionRecord(auth, auth.initialBudget, auth.requestId, auth.requestHash, 1, null, 0, auth.authorizedAt));
    }
    const legacy = auth ? await legacyBudgetFor(auth) : null;
    for (const name of names.filter(n => /^budget-\d{8,16}\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) {
      const row = await read<FullHistoryAgentBudgetRevision>(name), previous = rows.at(-1);
      if (!auth || !row || row.schema !== "pi-full-agent-budget-revision.v1" || name !== `budget-${String(row.revision).padStart(8, "0")}.json` || !Number.isSafeInteger(row.revision) || row.revision !== (previous?.revision ?? 0) + 1 || row.previousHash !== (previous ? hash(previous) : legacy?.authorizationHash ?? null) || !Number.isSafeInteger(row.usedRequests) || row.usedRequests < (previous?.usedRequests ?? 0) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.requestId) || !/^[a-f0-9]{64}$/.test(row.requestHash) || !validAgentBudgetChoice({ maxRequests: row.maxRequests, consent: row.consent }) || Object.keys(row).length !== 14 || row.grantHash !== auth.grant.grantHash || row.materialPlanHash !== auth.grant.materialPlanHash || row.modelFingerprint !== auth.modelFingerprint || row.promptSchemaHash !== auth.promptSchemaHash || row.expiresAt !== auth.expiresAt || !Number.isFinite(Date.parse(row.authorizedAt)) || new Date(row.authorizedAt).toISOString() !== row.authorizedAt || Date.parse(row.authorizedAt) < Date.parse(previous?.authorizedAt ?? auth.authorizedAt) || Date.parse(row.authorizedAt) >= Date.parse(auth.expiresAt) || Date.parse(row.authorizedAt) > Date.now()) fail("analysis-agent-budget-invalid");
      rows.push(row);
    }
    return { budgetRevisions: rows, legacyBudgetAuthorization: legacy, budgetAuthorization: auth && rows.length ? budgetProjection(auth, rows.at(-1)!) : legacy };
  }
  async function workerAlive() {
    let handle;
    try {
      const info = await lstat(path.join(root, "worker.lock"));
      if (!info.isDirectory() || info.isSymbolicLink()) return true;
      handle = await open(path.join(root, "worker.lock", "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await handle.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > 1024) return true;
      const value = JSON.parse(await handle.readFile("utf8")); if (!Number.isSafeInteger(value.pid) || value.pid < 1) return true;
      try { process.kill(value.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    finally { await handle?.close(); }
  }
  async function strictState() {
    const authorization = await read<GrantRecord>("grant.json"), names = await readdir(root);
    // Historical budget revisions remain readable evidence, never dispatch quotas.
    const budget = await budgetHistory(authorization, names);
    const attempts: FullHistoryAgentAttempt[] = [], attemptIds = new Set<string>();
    for (const name of names.filter(name => /^attempt-\d{3,16}\.intent\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) {
      const intent = await read<FullHistoryAgentAttemptIntent>(name);
      if (!authorization || !intent || intent.schema !== "pi-full-agent-attempt-intent.v2" || intent.jobId !== binding.jobId || intent.grantHash !== authorization.grant.grantHash || intent.materialPlanHash !== authorization.grant.materialPlanHash || intent.modelFingerprint !== authorization.modelFingerprint || name !== `attempt-${String(intent.slot).padStart(3, "0")}.intent.json` || !Number.isSafeInteger(intent.slot) || intent.slot < 1 || !Number.isSafeInteger(intent.nodeAttempt) || intent.nodeAttempt < 1 || attemptIds.has(intent.attemptId) || intent.slot !== attempts.length + 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(intent.nodeId) || !/^attempt-[a-f0-9-]{36}$/.test(intent.attemptId)) fail("analysis-agent-record-invalid");
      const receipt = await read<FullHistoryAgentAttemptReceipt>(`attempt-${String(intent.slot).padStart(3, "0")}.receipt.json`);
      if (receipt && (!validReceipt(receipt) || receipt.attemptId !== intent.attemptId || receipt.nodeId !== intent.nodeId || receipt.slot !== intent.slot || receipt.requestHash !== intent.requestHash)) fail("analysis-agent-record-invalid");
      attemptIds.add(intent.attemptId); attempts.push({ intent, ...(receipt ? { receipt } : {}) });
    }
    if (budget.budgetRevisions.some(r => r.usedRequests > attempts.length)) fail("analysis-agent-budget-invalid");
    if (authorization) {
      const g = authorization.grant;
      if (authorization.nodeIds.length !== g.baseRequests || new Set(authorization.nodeIds).size !== g.baseRequests || authorization.nodeIds.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id)) || !Number.isFinite(Date.parse(authorization.authorizedAt)) || Date.parse(authorization.expiresAt) - Date.parse(authorization.authorizedAt) !== 86400000) fail("analysis-agent-record-invalid");
      const byNode = new Map<string, FullHistoryAgentAttemptIntent[]>();
      for (const row of attempts) {
        const i = row.intent, prefix = byNode.get(i.nodeId) ?? [];
        if (!authorization.nodeIds.includes(i.nodeId) || i.promptSchemaHash !== authorization.promptSchemaHash || i.nodeAttempt !== prefix.length + 1 || i.bucket !== (prefix.length ? "reserve" : "base") || !Number.isSafeInteger(i.maxTokens) || i.maxTokens < 1 || i.maxTokens > g.policy.maxOutputTokens || !Number.isSafeInteger(i.requestBytes) || i.requestBytes < 1 || [i.baseInputHash, i.requestHash, i.promptSchemaHash].some(h => !/^[a-f0-9]{64}$/.test(h)) || prefix.some(p => p.baseInputHash !== i.baseInputHash || p.promptSchemaHash !== i.promptSchemaHash) || (prefix.length ? i.kind === "initial" || !["retry-length", "retry-unknown", "repair-json"].includes(i.kind) : i.kind !== "initial" || i.maxTokens !== g.policy.initialOutputTokens)) fail("analysis-agent-record-invalid");
        prefix.push(i); byNode.set(i.nodeId, prefix);
      }
      if (attempts.filter(r => r.intent.bucket === "base").length > g.baseRequests || names.some(name => /^attempt-\d{3,16}\.receipt\.json$/.test(name) && !attempts.some(row => name === `attempt-${String(row.intent.slot).padStart(3, "0")}.receipt.json`))) fail("analysis-agent-record-invalid");
    }
    return { authorization, attempts, cancelled: !!await read("cancel.json"), workerAlive: await workerAlive(), ...budget };
  }
  async function loadIndex(epoch: string) {
    const before = await lstat(root), namesBefore = (await readdir(root)).sort();
    observations.clear(); const value = await strictState(), names = (await readdir(root)).sort(), after = await lstat(root);
    if (stamp(before) !== stamp(after) || JSON.stringify(namesBefore) !== JSON.stringify(names)) fail("analysis-agent-record-changed");
    const stamps = new Map<string, string>();
    for (const name of names) {
      if (name === "worker.lock") continue;
      if (!/^(?:grant\.json|cancel\.json|budget-\d{8,16}\.json|attempt-\d{3,16}\.(?:intent|receipt)\.json|node-[A-Za-z0-9_-]{1,80}\.checkpoint\.json)$/.test(name)) fail("analysis-agent-record-invalid");
      const current = await lstat(path.join(root, name)), currentStamp = stamp(current);
      if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid?.() || (current.mode & 0o777) !== 0o600 || current.nlink !== 1 || observations.has(name) && observations.get(name) !== currentStamp) fail("analysis-agent-record-changed");
      stamps.set(name, currentStamp);
    }
    return { epoch, rootIdentity: rootIdentity(after), state: value, names: new Set(names), stamps };
  }
  async function assertIndex() {
    const index = heldIndex; if (!index) return;
    if (rootIdentity(await lstat(root)) !== index.rootIdentity) fail("analysis-agent-record-changed");
    const actual = (await readdir(root)).sort(), expected = [...index.names].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("analysis-agent-record-changed");
    const entries = [...index.stamps];
    // Metadata checks detect replacement/in-place edits without reopening and hashing all old JSON.
    for (let offset = 0; offset < entries.length; offset += 32) await Promise.all(entries.slice(offset, offset + 32).map(async ([name, expectedStamp]) => { if (stamp(await lstat(path.join(root, name))) !== expectedStamp) fail("analysis-agent-record-changed"); }));
  }
  async function state(options?: { strict?: boolean }) {
    if (!heldIndex || options?.strict) { if (heldIndex) await assertIndex(); return strictState(); }
    const cached = structuredClone(heldIndex.state), auth = cached.authorization;
    const legacy = auth ? await legacyBudgetFor(auth) : null;
    return { ...cached, cancelled: !!await read("cancel.json"), workerAlive: true, legacyBudgetAuthorization: legacy, budgetAuthorization: auth && cached.budgetRevisions.length ? budgetProjection(auth, cached.budgetRevisions.at(-1)!) : legacy };
  }
  async function acquire(): Promise<FullHistoryAgentLease> {
    await cancelled();
    const lock = path.join(root, "worker.lock"), token = randomUUID();
    const readOwner = async () => {
      const anchor = await parent(); let held, file;
      try {
        held = await open(anchor.leaf("worker.lock"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const info = await held.stat(), named = await lstat(lock);
        if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || !named.isDirectory() || named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino || named.mode !== info.mode || named.uid !== info.uid) fail("analysis-agent-worker-busy");
        file = await open(process.platform === "linux" ? `/proc/self/fd/${held.fd}/owner.json` : path.join(lock, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 1024 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) fail("analysis-agent-worker-busy");
        const text = await file.readFile("utf8"), after = await file.stat(), namedFile = await lstat(path.join(lock, "owner.json")), namedDir = await lstat(lock);
        await anchor.check();
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== 1 || !namedFile.isFile() || namedFile.isSymbolicLink() || namedFile.dev !== before.dev || namedFile.ino !== before.ino || namedFile.mode !== before.mode || namedFile.uid !== before.uid || namedFile.nlink !== 1 || !namedDir.isDirectory() || namedDir.isSymbolicLink() || namedDir.dev !== info.dev || namedDir.ino !== info.ino || namedDir.mode !== info.mode || namedDir.uid !== info.uid) fail("analysis-agent-worker-busy");
        return { info, text };
      } finally { await file?.close(); await held?.close(); await anchor.handle.close(); }
    };
    const opening = await parent();
    try {
    try { await mkdir(opening.leaf("worker.lock"), { mode: 0o700 }); await opening.check(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let old; try { old = await readOwner(); const owner = JSON.parse(old.text); if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail("analysis-agent-worker-busy"); try { process.kill(owner.pid, 0); fail("analysis-agent-worker-busy"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fail("analysis-agent-worker-busy"); } } catch { fail("analysis-agent-worker-busy"); }
      const takeover = path.join(root, "takeover.lock");
      try { await opening.check(); await mkdir(opening.leaf("takeover.lock"), { mode: 0o700 }); await opening.check(); } catch { fail("analysis-agent-worker-busy"); }
      try { const current = await readOwner(); if (current.info.dev !== old.info.dev || current.info.ino !== old.info.ino || current.text !== old.text) fail("analysis-agent-worker-busy"); await unlink(path.join(lock, "owner.json")); await rmdir(lock); await mkdir(lock, { mode: 0o700 }); }
      finally { await rmdir(takeover); }
    }
    const locked = await open(opening.leaf("worker.lock"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const first = await locked.stat();
      const connected = async () => { await opening.check(); const named = await lstat(lock), current = await locked.stat(); if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== first.dev || named.ino !== first.ino || current.dev !== first.dev || current.ino !== first.ino || named.uid !== process.getuid?.() || current.uid !== named.uid || (named.mode & 0o777) !== 0o700 || (current.mode & 0o777) !== 0o700) fail("analysis-agent-worker-busy"); };
      const owner = await open(process.platform === "linux" ? `/proc/self/fd/${locked.fd}/owner.json` : path.join(lock, "owner.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { const info = await owner.stat(); await connected(); const named = await lstat(path.join(lock, "owner.json")); if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || named.dev !== info.dev || named.ino !== info.ino || named.uid !== info.uid || named.nlink !== 1 || named.mode !== info.mode) fail("analysis-agent-worker-busy"); await owner.writeFile(JSON.stringify({ pid: process.pid, token })); await owner.sync(); await connected(); await locked.sync(); }
      finally { await owner.close(); }
    } finally { await locked.close(); }
    const anchor = await parent(); try { await anchor.handle.sync(); await anchor.check(); } finally { await anchor.handle.close(); }
    const lease = { epoch: token, assertCurrent: async () => { await cancelled(); const current = JSON.parse((await readOwner()).text); if (current.pid !== process.pid || current.token !== token) fail("analysis-agent-worker-compromised"); }, release: async () => { try { const current = JSON.parse((await readOwner()).text); if (current.pid !== process.pid || current.token !== token) fail("analysis-agent-worker-compromised"); await unlink(path.join(lock, "owner.json")); await rmdir(lock); } finally { if (heldIndex?.epoch === token) { heldIndex = undefined; heldLease = undefined; } } } };
    await lease.assertCurrent(); try { heldIndex = await loadIndex(token); heldLease = lease; } catch (error) { await lease.release(); throw error; } return lease;
    } finally { await opening.handle.close(); }
  }
  return {
    acquire: () => serial(async () => { const lease = await acquire(); return { ...lease, release: () => serial(() => lease.release()) }; }),
    state: (options?: { strict?: boolean }) => serial(() => state(options)),
    async getBudgetAuthorization() { return serial(async () => { await assertIndex(); return (await state()).budgetAuthorization; }); },
    async updateBudget(request: Omit<ResWorkflowAgentBudgetUpdateRequest, "cwd"> & { requestHash: string }) { return serial(async () => {
      if (!validAgentBudgetChoice({ maxRequests: request.maxRequests, consent: request.consent }) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.requestId) || !/^[a-f0-9]{64}$/.test(request.requestHash)) fail("analysis-agent-budget-invalid");
      // Reuse this store's live worker index. A separate store/process must acquire the
      // same worker lease, so it cannot race an active worker's intent publication.
      const ownLease = heldIndex ? undefined : await acquire();
      try {
        await heldLease?.assertCurrent(); await cancelled(); await assertIndex(); const s = await state(), auth = s.authorization;
        if (!auth || auth.grant.grantHash !== request.grantHash) fail("analysis-agent-budget-grant-mismatch");
        if (Date.now() >= Date.parse(auth.expiresAt)) fail("analysis-full-agent-authorization-expired");
        const prior = s.budgetRevisions.find(r => r.requestId === request.requestId);
        if (prior) { if (prior.requestHash !== request.requestHash) fail("request-id-conflict"); return s.budgetAuthorization; }
        if (request.expectedRevision !== (s.budgetRevisions.at(-1)?.revision ?? 0)) fail("analysis-agent-budget-revision-conflict");
        const previous = s.budgetRevisions.at(-1), revision = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) fail("analysis-agent-budget-invalid");
        const row = revisionRecord(auth, { maxRequests: request.maxRequests, consent: request.consent }, request.requestId, request.requestHash, revision, previous ? hash(previous) : s.legacyBudgetAuthorization?.authorizationHash ?? null, s.attempts.length, new Date().toISOString());
        await write(`budget-${String(revision).padStart(8, "0")}.json`, row);
        if (heldIndex) { heldIndex.state.budgetRevisions.push(structuredClone(row)); heldIndex.state.budgetAuthorization = budgetProjection(auth, row); }
        return budgetProjection(auth, row);
      } finally { await ownLease?.release(); }
    }); },
    async authorization() {
      await cancelled();
      if (!heldIndex) return read<GrantRecord>("grant.json");
      const expected = heldIndex.stamps.get("grant.json");
      if (expected && stamp(await lstat(path.join(root, "grant.json"))) !== expected) fail("analysis-agent-record-changed");
      return structuredClone(heldIndex.state.authorization);
    },
    async verifyAttempt(row: FullHistoryAgentAttempt) {
      const prefix = `attempt-${String(row.intent.slot).padStart(3, "0")}`;
      const [intent, receipt] = await Promise.all([read<FullHistoryAgentAttemptIntent>(`${prefix}.intent.json`), read<FullHistoryAgentAttemptReceipt>(`${prefix}.receipt.json`)]);
      if (hash(intent) !== hash(row.intent) || hash(receipt ?? null) !== hash(row.receipt ?? null)) fail("analysis-agent-record-invalid");
      return row;
    },
    async authorize(record: GrantRecord) { return serial(async () => { await cancelled(); await assertIndex(); const old = await read<GrantRecord>("grant.json"); if (old) { if (hash(old) !== hash(record)) fail("analysis-agent-grant-conflict"); return; } const g = record.grant, p = g.policy; if (record.initialBudget !== undefined && !validAgentBudgetChoice(record.initialBudget) || g.analysisMode !== "full-history-agent-v2" || !Number.isSafeInteger(g.baseRequests) || g.baseRequests < 1 || !Number.isSafeInteger(g.retryReserve) || g.retryReserve < 0 || !Number.isSafeInteger(g.maxRequests) || g.maxRequests !== g.baseRequests + g.retryReserve || p.id !== "bounded-intake-v2" || p.maxNodeAttempts !== 3 || p.maxJsonRepairsPerNode !== 1 || p.maxUnknownRetriesPerNode !== 1 || p.maxLengthEscalationsPerNode !== 1 || p.unknownRetryMayBillAgain !== true || p.grantLifetimeMs !== 86400000 || !Number.isSafeInteger(p.initialOutputTokens) || !Number.isSafeInteger(p.maxOutputTokens) || p.initialOutputTokens < 1 || p.maxOutputTokens < p.initialOutputTokens || p.maxOutputTokens > 16384 || !/^[a-f0-9]{64}$/.test(record.promptSchemaHash) || record.nodeIds.length !== g.baseRequests || new Set(record.nodeIds).size !== g.baseRequests || !Number.isFinite(Date.parse(record.authorizedAt)) || Date.parse(record.expiresAt) - Date.parse(record.authorizedAt) !== 86400000) fail("analysis-agent-grant-invalid"); await write("grant.json", record); if (heldIndex) { heldIndex.state.authorization = structuredClone(record); if (record.initialBudget) { const row = revisionRecord(record, record.initialBudget, record.requestId, record.requestHash, 1, null, 0, record.authorizedAt); heldIndex.state.budgetRevisions.push(row); heldIndex.state.budgetAuthorization = budgetProjection(record, row); } } }); },
    async attempts(nodeId: string) { return (await state()).attempts.filter(row => row.intent.nodeId === nodeId); },
    async beforeSend(draft: FullHistoryAgentAttemptDraft, lease: FullHistoryAgentLease) { return serial(async () => {
      await lease.assertCurrent(); await assertIndex(); const s = await state(), auth = s.authorization; if (!auth) fail("analysis-agent-grant-required"); const g = auth.grant, rows = s.attempts.filter(row => row.intent.nodeId === draft.nodeId);
      if (Date.now() >= Date.parse(auth.expiresAt)) fail("analysis-full-agent-authorization-expired");
      if (Object.keys(draft).some(k => !["nodeId", "nodeAttempt", "kind", "baseInputHash", "requestHash", "promptSchemaHash", "modelFingerprint", "requestBytes", "maxTokens"].includes(k)) || !auth.nodeIds.includes(draft.nodeId) || !/^[A-Za-z0-9_-]{1,80}$/.test(draft.nodeId) || !Number.isSafeInteger(draft.nodeAttempt) || draft.nodeAttempt < 1 || draft.nodeAttempt !== rows.length + 1 || draft.modelFingerprint !== auth.modelFingerprint || draft.promptSchemaHash !== auth.promptSchemaHash || !Number.isSafeInteger(draft.maxTokens) || draft.maxTokens < 1 || draft.maxTokens > g.policy.maxOutputTokens || !Number.isSafeInteger(draft.requestBytes) || draft.requestBytes < 1 || [draft.baseInputHash, draft.requestHash, draft.promptSchemaHash].some(h => !/^[a-f0-9]{64}$/.test(h)) || rows.some(row => row.intent.baseInputHash !== draft.baseInputHash || row.intent.promptSchemaHash !== draft.promptSchemaHash)) fail("analysis-agent-attempt-conflict");
      if (draft.kind === "initial" ? rows.length !== 0 || draft.maxTokens !== g.policy.initialOutputTokens : !rows.length || !["retry-length", "retry-unknown", "repair-json"].includes(draft.kind)) fail("analysis-agent-retry-policy");
      const previous = rows.at(-1), previousTokens = previous?.intent.maxTokens ?? g.policy.initialOutputTokens;
      if (draft.kind === "retry-length" && (previous?.receipt?.sdkStopReason !== "length" || !previous.receipt.providerTerminalObserved || draft.maxTokens !== g.policy.maxOutputTokens) || draft.kind === "retry-unknown" && previous?.receipt?.outcome !== "unknown" && previous?.receipt !== undefined || draft.kind === "repair-json" && !(previous?.receipt?.providerTerminalObserved && (["invalid-output", "invalid-source"].includes(previous.receipt.outcome) && previous.receipt.sdkStopReason === "stop" || previous.receipt.outcome === "incomplete" && ["toolUse", "stop"].includes(previous.receipt.sdkStopReason))) || draft.kind !== "initial" && draft.kind !== "retry-length" && draft.maxTokens !== previousTokens) fail("analysis-agent-retry-policy");
      const bucket = rows.length ? "reserve" : "base";
      if (!Number.isSafeInteger(s.attempts.length + 1)) fail("analysis-agent-record-invalid");
      const intent: FullHistoryAgentAttemptIntent = { ...draft, schema: "pi-full-agent-attempt-intent.v2", jobId: binding.jobId, workerEpoch: lease.epoch, grantHash: g.grantHash, materialPlanHash: g.materialPlanHash, attemptId: `attempt-${randomUUID()}`, slot: s.attempts.length + 1, bucket };
      await lease.assertCurrent(); await write(`attempt-${String(intent.slot).padStart(3, "0")}.intent.json`, intent); if (heldIndex) heldIndex.state.attempts.push({ intent: structuredClone(intent) }); await lease.assertCurrent(); return intent;
    }); },
    async receipt(receipt: FullHistoryAgentAttemptReceipt) { return serial(async () => { await assertIndex(); const row = (await state()).attempts.find(row => row.intent.attemptId === receipt.attemptId); if (!validReceipt(receipt) || !row || row.receipt || row.intent.slot !== receipt.slot || row.intent.nodeId !== receipt.nodeId || row.intent.requestHash !== receipt.requestHash || receipt.raw !== undefined && (Buffer.byteLength(receipt.raw) > 128 * 1024 || hash(receipt.raw) !== receipt.rawHash) || receipt.usage && Object.values(receipt.usage).some(v => !Number.isSafeInteger(v) || v! < 0)) fail("analysis-agent-receipt-invalid"); await write(`attempt-${String(receipt.slot).padStart(3, "0")}.receipt.json`, receipt); const cached = heldIndex?.state.attempts.find(row => row.intent.attemptId === receipt.attemptId); if (cached) cached.receipt = structuredClone(receipt); return { receiptHash: hash(receipt) }; }); },
    async checkpoint(value: FullHistoryAgentCheckpoint) { return serial(async () => { await cancelled(); await assertIndex(); const row = (await state()).attempts.find(row => row.intent.attemptId === value.acceptedAttemptId); if (value.schema !== "pi-full-agent-node-checkpoint.v2" || value.terminal !== "stop" || value.validation !== "valid" || !Array.isArray(value.sourceIds) || new Set(value.sourceIds).size !== value.sourceIds.length || value.sourceIds.some(id => !/^src-[A-Za-z0-9_-]{1,80}$/.test(id)) || !row?.receipt || row.receipt.outcome !== "valid" || row.receipt.sdkStopReason !== "stop" || !row.receipt.providerTerminalObserved || hash(row.receipt) !== value.receiptHash || value.jobId !== binding.jobId || row.intent.materialPlanHash !== value.materialPlanHash || row.intent.nodeId !== value.nodeId || row.intent.baseInputHash !== value.baseInputHash || row.intent.requestHash !== value.requestHash || row.intent.modelFingerprint !== value.modelFingerprint || row.intent.promptSchemaHash !== value.promptSchemaHash || row.receipt.raw !== value.raw || value.rawHash !== hash(value.raw)) fail("analysis-agent-checkpoint-invalid"); await write(`node-${value.nodeId}.checkpoint.json`, value); }); },
    async readCheckpoint(nodeId: string, knownAttempts?: FullHistoryAgentAttempt[]) { await assertIndex(); if (!/^[A-Za-z0-9_-]{1,80}$/.test(nodeId)) fail("analysis-agent-checkpoint-invalid"); const value = await read<FullHistoryAgentCheckpoint>(`node-${nodeId}.checkpoint.json`); if (value) { const row = (knownAttempts ?? (await state()).attempts).find(row => row.intent.attemptId === value.acceptedAttemptId); if (row && knownAttempts) { const prefix = `attempt-${String(row.intent.slot).padStart(3, "0")}`, intent = await read(`${prefix}.intent.json`), receipt = await read(`${prefix}.receipt.json`); if (hash(intent) !== hash(row.intent) || hash(receipt) !== hash(row.receipt)) fail("analysis-agent-record-invalid"); } if (value.schema !== "pi-full-agent-node-checkpoint.v2" || value.terminal !== "stop" || value.validation !== "valid" || !Array.isArray(value.sourceIds) || new Set(value.sourceIds).size !== value.sourceIds.length || value.sourceIds.some(id => !/^src-[A-Za-z0-9_-]{1,80}$/.test(id)) || !row?.receipt || row.receipt.outcome !== "valid" || hash(row.receipt) !== value.receiptHash || row.receipt.raw !== value.raw || hash(value.raw) !== value.rawHash || row.intent.nodeId !== nodeId || value.jobId !== binding.jobId || row.intent.materialPlanHash !== value.materialPlanHash || row.intent.requestHash !== value.requestHash || row.intent.baseInputHash !== value.baseInputHash || row.intent.modelFingerprint !== value.modelFingerprint || row.intent.promptSchemaHash !== value.promptSchemaHash) fail("analysis-agent-checkpoint-invalid"); } return value; },
    async cancel() { return serial(async () => { if (!await read("cancel.json")) await write("cancel.json", { schema: "pi-full-agent-cancel.v2", cancelled: true }); }); },
  };
}
