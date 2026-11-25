import { constants, type Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { streamLocalHistory, type FullHistoryExtractionCoverage } from "./local-history-stream.js";

export const FULL_HISTORY_MATERIAL_LIMITS = Object.freeze({ textBytes: 32 * 1024 * 1024, sources: 50000, batchBytes: 128 * 1024, chunkBytes: 64 * 1024, batchSources: 128, summaryBytes: 8192, fanIn: 4, systemReserve: 4096, artifactBytes: 64 * 1024 * 1024, prepareMs: 180000, readMs: 15000 });
type Binding = { id?: string; cwd?: string; sessionFile?: string; originDeviceId?: string };
type Selected = { id: string; sessionId: string; kind: "local" | "retained" };
type Source = { id: string; kind: "file" | "artifact" | "session-message"; label: string; sessionId?: string; entryId?: string; path?: string; timestamp?: string; sha256: string; bytes: number; incomplete: boolean; unverified: true };
type Model = { provider: string; id: string; fingerprint: string; contextWindow: number; maxTokens: number };
type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; uid: number; mode: number; nlink: number };
type Artifact = { name: string; sha256: string; bytes: number; stamp: Stamp };
export interface FullHistoryMaterialNode { id: string; kind: "batch" | "merge" | "final"; inputNodeIds: string[]; sourceIds: string[]; historyId?: string; materialHash?: string; materialFile?: string; eligibleMessages?: number; eligibleBytes?: number; scope?: "history" | "directory-snapshot" }
type SourceRecord = { source: Source; historyId?: string; bodyFile: string; offsetBytes: number; chunks: { nodeId: string; offsetBytes: number; endOffsetBytes: number }[] };
export interface FullHistoryPrivatePlan {
  schema: "pi-full-history-material.v1"; planId: string; planHash: string; model: Model; maxRequests: number; nodes: FullHistoryMaterialNode[];
  scope: { cwd: string; privateDir: string; platform: string }; selectedHistories: Selected[]; historyProofs: unknown[]; sourceIndex: SourceRecord[]; artifacts: Artifact[];
  publicPlan: any; snapshotFingerprint?: string; outputTokenLimit?: number;
}
interface GateOptions { signal: AbortSignal; revalidate(): Promise<void>; /** Internal synthetic compatibility injection; never HTTP input. */ platform?: string }
/** Preparation counters only: these never imply that a provider has read the materials. */
export interface FullHistoryMaterialProgress {
  phase: "scanning" | "packing"; historiesScanned: number; historiesTotal: number;
  normalMessages: number; normalBytes: number; packedBatches: number;
}
export interface FullHistoryMaterialOptions extends GateOptions {
  cwd: string; selectedHistories: Selected[]; historyBindings: Binding[]; model: Model; privateDir: string;
  outputTokenLimit?: number;
  onProgress?(value: FullHistoryMaterialProgress, signal?: AbortSignal): void | Promise<void>;
  canReadHistory(binding: Binding): Promise<boolean>;
  readRetained?(sessionId: string, maxBytes: number): Promise<{ raw: string; retained: boolean; complete: boolean }>;
  snapshotSources?: Source[]; snapshotContent?: Record<string, string>; snapshotFingerprint?: string;
}
function fail(code: string): never { throw new Error(code); }
function normalizeOutputTokenLimit(modelMaxTokens: number, requested?: number): number {
  if (requested === undefined) return Math.min(modelMaxTokens, 8192);
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > Math.min(modelMaxTokens, 16384)) fail("history-full-output-token-limit-invalid");
  return requested;
}
const digest = (value: string | Buffer | unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const stamp = (s: Stats): Stamp => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, uid: s.uid, mode: s.mode, nlink: s.nlink });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sourceId = (source: Omit<Source, "id">) => "src-" + digest([source.kind, source.path, source.sessionId, source.entryId, source.sha256]).slice(0, 24);
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*(?:["']\s*)?[:=]\s*\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;
const safeLeaf = (name: string) => /^[a-z0-9][a-z0-9._-]{0,100}$/.test(name);
const validPlanId = (id: string) => /^hplan-[a-f0-9]{24}$/.test(id);
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
async function bounded<T>(value: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted) fail("cancelled");
  return new Promise<T>((resolve, reject) => {
    const abort = () => { clear(); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { clear(); reject(new Error("history-full-time-budget")); }, Math.max(1, deadline - Date.now()));
    const clear = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true }); value.then(result => { clear(); resolve(result); }, error => { clear(); reject(error); }); if (signal.aborted) abort();
  });
}
function gate(options: GateOptions, deadline = Date.now() + FULL_HISTORY_MATERIAL_LIMITS.readMs) {
  return async () => {
    if (options.signal.aborted) fail("cancelled");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clear(); reject(new Error("cancelled")); };
      const timer = setTimeout(() => { clear(); reject(new Error("history-full-time-budget")); }, Math.max(1, deadline - Date.now()));
      const clear = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); };
      options.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(options.revalidate).then(() => { clear(); resolve(); }, error => { clear(); reject(error); });
      if (options.signal.aborted) abort();
    });
    if (options.signal.aborted) fail("cancelled");
    if (Date.now() > deadline) fail("history-full-time-budget");
  };
}
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Linux directory-descriptor anchors: names may never redirect a leaf to another parent. */
class Anchor {
  readonly target: string;
  readonly chain: { name: string; handle: any; dev: number; ino: number }[];
  readonly check: () => Promise<void>;
  readonly platform: string;
  constructor(target: string, chain: { name: string; handle: any; dev: number; ino: number }[], check: () => Promise<void>, platform: string) { this.target = target; this.chain = chain; this.check = check; this.platform = platform; }
  get fd() { return this.chain.at(-1)!.handle.fd as number; }
  leaf(name: string) { if (!safeLeaf(name)) fail("history-full-artifact-name-invalid"); return this.platform === "linux" ? `/proc/self/fd/${this.fd}/${name}` : path.join(this.target, name); }
  async connected() {
    await this.check();
    for (const item of this.chain) { const [named, opened] = await Promise.all([fs.lstat(item.name), item.handle.stat()]); if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== item.dev || named.ino !== item.ino || opened.dev !== item.dev || opened.ino !== item.ino) fail("history-full-private-root-changed"); }
    const last = await this.chain.at(-1)!.handle.stat();
    if (last.uid !== process.getuid?.() || (last.mode & 0o777) !== 0o700 || await fs.realpath(this.target) !== this.target) fail("history-full-private-root-refused");
  }
  async close() { for (const item of [...this.chain].reverse()) await item.handle.close(); }
}
async function openAnchor(target: string, check: () => Promise<void>, platform: string = process.platform): Promise<Anchor> {
  if (!process.getuid || !path.isAbsolute(target) || path.resolve(target) !== target) fail("history-full-private-root-unavailable");
  const chain: Anchor["chain"] = [];
  try {
    let absolute = "/", handle = await fs.open("/", DIR_FLAGS), stat = await handle.stat(); chain.push({ name: "/", handle, dev: stat.dev, ino: stat.ino });
    for (const part of target.split("/").filter(Boolean)) { absolute = path.join(absolute, part); handle = await fs.open(platform === "linux" ? `/proc/self/fd/${handle.fd}/${part}` : absolute, DIR_FLAGS); stat = await handle.stat(); chain.push({ name: absolute, handle, dev: stat.dev, ino: stat.ino }); }
    const anchor = new Anchor(target, chain, check, platform); await anchor.connected(); return anchor;
  } catch (error) { for (const item of chain.reverse()) await item.handle.close(); throw error; }
}
async function createRoot(target: string, check: () => Promise<void>, platform: string) {
  try { return await openAnchor(target, check, platform); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await openAnchor(path.dirname(target), check, platform);
    try { await parent.connected(); await fs.mkdir(parent.leaf(path.basename(target)), { mode: 0o700 }); await parent.connected(); }
    finally { await parent.close(); }
    return openAnchor(target, check, platform);
  }
}
function regular(s: Stats) { if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1) fail("history-full-artifact-refused"); }
async function writeArtifact(anchor: Anchor, name: string, buffers: Iterable<Buffer>): Promise<Artifact> {
  await anchor.connected(); const handle = await fs.open(anchor.leaf(name), FILE_FLAGS | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600), hash = createHash("sha256"); let bytes = 0;
  try {
    const opened = await handle.stat(); regular(opened); await anchor.connected(); if (!same(stamp(opened), stamp(await fs.lstat(anchor.leaf(name))))) fail("history-full-private-root-changed");
    for (const buffer of buffers) for (let offset = 0; offset < buffer.length;) { await anchor.connected(); const end = Math.min(buffer.length, offset + 65536), chunk = buffer.subarray(offset, end); if (bytes + chunk.length > FULL_HISTORY_MATERIAL_LIMITS.artifactBytes) fail("history-full-artifact-budget"); const value = await handle.write(chunk, 0, chunk.length, null); if (!value.bytesWritten) fail("history-full-write-failed"); hash.update(chunk.subarray(0, value.bytesWritten)); bytes += value.bytesWritten; offset += value.bytesWritten; }
    await handle.sync(); const state = await handle.stat(); regular(state); await anchor.connected(); if (state.size !== bytes || !same(stamp(state), stamp(await fs.lstat(anchor.leaf(name))))) fail("history-full-write-failed"); return { name, bytes, sha256: hash.digest("hex"), stamp: stamp(state) };
  } finally { await handle.close(); }
}
async function readArtifact(anchor: Anchor, artifact: Artifact, range?: { offset: number; bytes: number; sha256: string }): Promise<Buffer> {
  await anchor.connected(); const handle = await fs.open(anchor.leaf(artifact.name), FILE_FLAGS | constants.O_RDONLY);
  try {
    const before = await handle.stat(); regular(before); if (!same(stamp(before), artifact.stamp) || before.size !== artifact.bytes || artifact.bytes > FULL_HISTORY_MATERIAL_LIMITS.artifactBytes) fail("history-full-material-changed");
    const offset = range?.offset ?? 0, bytes = range?.bytes ?? artifact.bytes;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0 || offset + bytes > artifact.bytes) fail("history-full-range-invalid");
    const parts: Buffer[] = []; let at = 0;
    while (at < bytes) { await anchor.connected(); const buffer = Buffer.alloc(Math.min(65536, bytes - at)), value = await handle.read(buffer, 0, buffer.length, offset + at); if (!value.bytesRead) fail("history-full-material-changed"); parts.push(buffer.subarray(0, value.bytesRead)); at += value.bytesRead; }
    await anchor.connected(); if (!same(stamp(await handle.stat()), artifact.stamp) || !same(stamp(await fs.lstat(anchor.leaf(artifact.name))), artifact.stamp)) fail("history-full-material-changed"); const result = Buffer.concat(parts, bytes); if (digest(result) !== (range?.sha256 ?? artifact.sha256)) fail("history-full-material-changed"); return result;
  } finally { await handle.close(); }
}
type Authority = { directory: string; seal: Stamp; planFile: Artifact };
const authorities = new WeakMap<FullHistoryPrivatePlan, Authority>();
function planDigest(planFile: Artifact, seal: Stamp, scope: string) { return digest({ sha256: planFile.sha256, stamp: planFile.stamp, seal, scope }); }
const publicHistory = (selected: Selected, proof?: FullHistoryExtractionCoverage, blockers: string[] = []) => ({ id: selected.id, sessionId: selected.sessionId, eligibleMessages: proof?.eligibleMessages ?? 0, eligibleBytes: proof?.eligibleBytes ?? 0, chunkCount: 0, normalMessages: proof?.normalMessages ?? 0, normalBytes: proof?.normalBytes ?? 0, sensitiveFilteredMessages: proof?.sensitiveFilteredMessages ?? 0, timestampUnknownMessages: proof?.timestampUnknownMessages ?? 0, filteredCounts: proof?.filteredCounts, blockers, ...(proof?.complete && proof.eligibleMessages === 0 ? { emptyReason: "no-normal-text-on-current-branch" } : {}) });

export async function prepareFullHistoryMaterial(options: FullHistoryMaterialOptions): Promise<{ publicPlan: any; privatePlan: FullHistoryPrivatePlan }> {
  const limits = FULL_HISTORY_MATERIAL_LIMITS, deadline = Date.now() + limits.prepareMs, check = gate(options, deadline), model = { ...options.model }, selected = options.selectedHistories.map(s => ({ id: s.id, sessionId: s.sessionId, kind: s.kind })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!selected.length || selected.length > 40 || new Set(selected.map(s => s.id)).size !== selected.length || !Number.isSafeInteger(model.contextWindow) || !Number.isSafeInteger(model.maxTokens) || model.contextWindow <= 0 || model.maxTokens <= 0 || !model.fingerprint || model.provider.startsWith("@") || model.id.startsWith("@")) fail("history-full-options-invalid");
  const requestedOutputTokenLimit = options.outputTokenLimit, outputTokenLimit = normalizeOutputTokenLimit(model.maxTokens, requestedOutputTokenLimit);
  const inputBudget = Math.floor(model.contextWindow * 0.8) - outputTokenLimit - limits.systemReserve;
  // The SDK embeds prompt JSON in a JSON string. A summary can therefore cost up to twice its raw JSON byte limit.
  const fanIn = Math.min(limits.fanIn, Math.floor((inputBudget - 256) / (2 * limits.summaryBytes))), batchBudget = limits.batchBytes;
  if (fanIn < 1 || inputBudget < 1024) fail("history-full-model-budget-too-small");
  const groups: { id?: string; scope: "history" | "directory-snapshot"; sources: { source: Source; content: string; role?: string }[] }[] = [], histories: any[] = [], historyProofs: unknown[] = [], blockers: string[] = [];
  let eligibleBytes = 0, eligibleMessages = 0, materialBytes = 0;
  const progress: FullHistoryMaterialProgress = { phase: "scanning", historiesScanned: 0, historiesTotal: selected.length, normalMessages: 0, normalBytes: 0, packedBatches: 0 };
  const notify = async (phase: FullHistoryMaterialProgress["phase"]) => {
    if (!options.onProgress) return;
    progress.phase = phase; await check();
    try { await bounded(Promise.resolve().then(() => options.onProgress!({ ...progress }, options.signal)), options.signal, deadline); }
    catch { if (options.signal.aborted) fail("cancelled"); if (Date.now() >= deadline) fail("history-full-time-budget"); fail("history-full-progress-unavailable"); }
    await check();
  };
  await notify("scanning");
  for (const item of selected) {
    await check(); const matches = options.historyBindings.filter(b => b.id === item.sessionId && !!b.originDeviceId === (item.kind === "retained"));
    if (matches.length !== 1) fail("history-full-binding-unavailable"); let binding = matches[0];
    const owned = async () => { await check(); if ((await bounded(options.canReadHistory(binding), options.signal, deadline)) !== true) fail("history-owner-unavailable"); };
    await owned();
    let retainedRaw: string | undefined;
    if (item.kind === "retained") { if (!options.readRetained) { histories.push(publicHistory(item, undefined, ["history-full-retained-unavailable"])); blockers.push("history-full-retained-unavailable"); await notify("scanning"); continue; } const retained = await bounded(options.readRetained(item.sessionId, 64 * 1024 * 1024), options.signal, deadline); await owned(); if (!retained.retained || !retained.complete || typeof retained.raw !== "string" || Buffer.byteLength(retained.raw) > 64 * 1024 * 1024) { histories.push(publicHistory(item, undefined, ["history-full-retained-incomplete"])); blockers.push("history-full-retained-incomplete"); await notify("scanning"); continue; } retainedRaw = retained.raw; }
    if (item.kind === "local" && (!binding.sessionFile || !path.isAbsolute(binding.sessionFile))) fail("history-full-binding-unavailable");
    const result = await streamLocalHistory({ file: binding.sessionFile ?? "retained-immutable", cwd: options.cwd, expectedId: item.sessionId, retainedRaw, mode: "full", signal: options.signal, deadline, revalidate: owned, onHeader: async header => { binding = { ...binding, id: header.id, cwd: header.cwd }; await owned(); }, acceptText: text => !SECRET.test(text), maxTextBytes: Math.max(0, limits.textBytes - materialBytes), maxSources: limits.sources - eligibleMessages, maxMessageBytes: limits.textBytes });
    const proof = result.full!; histories.push(publicHistory(item, proof, proof.blockers)); historyProofs.push({ historyId: item.id, kind: item.kind, binding: { id: binding.id, cwd: binding.cwd, sessionFile: binding.sessionFile, originDeviceId: binding.originDeviceId }, proof });
    eligibleBytes += proof.eligibleBytes; eligibleMessages += proof.eligibleMessages;
    progress.historiesScanned++; progress.normalMessages += proof.normalMessages; progress.normalBytes += proof.normalBytes; await notify("scanning");
    if (!proof.complete) { blockers.push(...proof.blockers); continue; }
    const sources = result.messages.map(message => { const bare: Omit<Source, "id"> = { kind: "session-message", label: `Pi ${item.sessionId} · ${message.entryId}`, sessionId: item.sessionId, entryId: message.entryId, ...(message.timestamp ? { timestamp: new Date(message.timestamp).toISOString() } : {}), sha256: digest(message.text), bytes: Buffer.byteLength(message.text), incomplete: false, unverified: true }; return { source: { ...bare, id: sourceId(bare) }, content: message.text, role: message.role }; });
    materialBytes += sources.reduce((n, s) => n + s.source.bytes, 0); groups.push({ id: item.id, scope: "history", sources });
  }
  const directorySources = (options.snapshotSources ?? []).filter(s => s.kind === "file" || s.kind === "artifact").map(source => { const content = options.snapshotContent?.[source.id]; if (typeof content !== "string" || Buffer.from(content).toString("utf8") !== content || digest(content) !== source.sha256 || Buffer.byteLength(content) !== source.bytes) fail("history-full-directory-snapshot-invalid"); return { source: { ...source }, content }; });
  if (directorySources.length && !options.snapshotFingerprint) fail("history-full-directory-snapshot-invalid");
  materialBytes += directorySources.reduce((n, s) => n + s.source.bytes, 0);
  if (materialBytes > limits.textBytes || eligibleMessages + directorySources.length > limits.sources) blockers.push("history-full-text-or-source-budget");
  if (!eligibleMessages && !blockers.length) blockers.push("no-authorized-normal-history-materials");
  if (directorySources.length) groups.push({ scope: "directory-snapshot", sources: directorySources });
  await notify("packing");
  const privateDir = path.resolve(options.privateDir), platform = options.platform ?? process.platform, root = await createRoot(privateDir, check, platform), planId = "hplan-" + randomBytes(12).toString("hex"); let directory: Anchor | undefined;
  const artifacts: Artifact[] = [], sourceIndex: SourceRecord[] = [], sourceRecords = new Map<string, SourceRecord>(), nodes: FullHistoryMaterialNode[] = [];
  try {
    await root.connected(); await fs.mkdir(root.leaf(planId), { mode: 0o700 }); directory = await openAnchor(path.join(privateDir, planId), check, platform); await root.connected();
    if (!blockers.length) {
      const ids = new Set<string>(); let groupNumber = 0;
      for (const group of groups) {
        if (!group.sources.length) continue; groupNumber++; const bodyName = `body-${String(groupNumber).padStart(4, "0")}.utf8`; let offset = 0;
        for (const item of group.sources) { if (ids.has(item.source.id)) fail("history-full-source-duplicate"); ids.add(item.source.id); const record = { source: item.source, historyId: group.id, bodyFile: bodyName, offsetBytes: offset, chunks: [] }; sourceIndex.push(record); sourceRecords.set(item.source.id, record); offset += item.source.bytes; }
        artifacts.push(await writeArtifact(directory, bodyName, (function* () { for (const item of group.sources) yield Buffer.from(item.content); })()));
        let chunks: any[] = [];
        const payload = (records: any[]) => ({ kind: "batch", scope: group.scope, ...(group.id ? { historyId: group.id } : {}), sources: records });
        const fits = (records: any[]) => { const prompt = JSON.stringify(payload(records)); return Buffer.byteLength(prompt) <= batchBudget && Buffer.byteLength(JSON.stringify(prompt)) <= inputBudget; };
        const flush = async () => {
          if (!chunks.length) return;
          const id = `node-${String(nodes.length + 1).padStart(4, "0")}`, prompt = JSON.stringify(payload(chunks)); if (!fits(chunks)) fail("history-full-batch-budget");
          const material = await writeArtifact(directory!, `batch-${String(nodes.length + 1).padStart(4, "0")}.json`, [Buffer.from(prompt)]); artifacts.push(material);
          const unique = [...new Set(chunks.map(chunk => chunk.id))] as string[];
          nodes.push({ id, kind: "batch", inputNodeIds: [], sourceIds: unique, historyId: group.id, scope: group.scope, materialHash: material.sha256, materialFile: material.name, eligibleMessages: group.scope === "history" ? chunks.filter(c => c.endOffsetBytes === c.totalBytes).length : 0, eligibleBytes: group.scope === "history" ? chunks.reduce((n, c) => n + c.endOffsetBytes - c.offsetBytes, 0) : 0 });
          for (const chunk of chunks) sourceRecords.get(chunk.id)!.chunks.push({ nodeId: id, offsetBytes: chunk.offsetBytes, endOffsetBytes: chunk.endOffsetBytes });
          progress.packedBatches++; await notify("packing");
          chunks = [];
        };
        for (const item of group.sources) {
          const bytes = Buffer.from(item.content); let at = 0;
          while (at < bytes.length || !bytes.length && !sourceRecords.get(item.source.id)!.chunks.length && !chunks.some(c => c.id === item.source.id)) {
            await check(); if (chunks.length >= limits.batchSources) await flush();
            let end = Math.min(bytes.length, at + limits.chunkBytes); while (end > at && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
            const record = (to: number) => ({ id: item.source.id, kind: item.source.kind, ...(group.scope === "directory-snapshot" ? { label: item.source.label, path: item.source.path } : {}), ...(item.role ? { role: item.role } : {}), ...(item.source.timestamp ? { timestamp: item.source.timestamp } : {}), offsetBytes: at, endOffsetBytes: to, totalBytes: bytes.length, sha256: digest(bytes.subarray(at, to)), text: bytes.subarray(at, to).toString("utf8") });
            if (!bytes.length) { if (!fits([...chunks, record(0)])) { if (chunks.length) { await flush(); continue; } fail("history-full-batch-budget"); } chunks.push(record(0)); break; }
            let low = at, high = end;
            while (low < high) { let middle = Math.ceil((low + high) / 2); while (middle > at && middle < bytes.length && (bytes[middle] & 0xc0) === 0x80) middle--; if (middle <= low) { let next = low + 1; while (next < end && (bytes[next] & 0xc0) === 0x80) next++; if (next > high) { high = low; break; } middle = next; } if (fits([...chunks, record(middle)])) low = middle; else high = middle - 1; }
            end = low; while (end > at && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
            if (end <= at) { if (chunks.length) { await flush(); continue; } fail("history-full-batch-budget"); }
            chunks.push(record(end)); at = end;
          }
        }
        await flush();
      }
      let level = [...nodes];
      if (level.length > 1 && fanIn < 2) fail("history-full-model-budget-too-small");
      while (level.length > fanIn) {
        const next: FullHistoryMaterialNode[] = [];
        for (let at = 0; at < level.length; at += fanIn) { const children = level.slice(at, at + fanIn); if (children.length === 1) { next.push(children[0]); continue; } const node: FullHistoryMaterialNode = { id: `node-${String(nodes.length + 1).padStart(4, "0")}`, kind: "merge", inputNodeIds: children.map(n => n.id), sourceIds: [...new Set(children.flatMap(n => n.sourceIds))] }; nodes.push(node); next.push(node); }
        level = next;
      }
      if (!level.length) fail("no-authorized-materials");
      nodes.push({ id: `node-${String(nodes.length + 1).padStart(4, "0")}`, kind: "final", inputNodeIds: level.map(n => n.id), sourceIds: [...new Set(level.flatMap(n => n.sourceIds))] });
    }
    for (const row of histories) row.chunkCount = nodes.filter(n => n.kind === "batch" && n.historyId === row.id).length;
    const batchCount = nodes.filter(n => n.kind === "batch").length, publicCore = { planId, model: { provider: model.provider, id: model.id }, contextWindow: model.contextWindow, maxTokens: outputTokenLimit, maxRequests: nodes.length, batchCount, mergeCallCount: nodes.filter(n => n.kind !== "batch").length, eligibleMessages, eligibleBytes, histories, blockers: [...new Set(blockers)], directorySnapshot: { sourceCount: directorySources.length, bytes: directorySources.reduce((n, s) => n + s.source.bytes, 0), batchCount: nodes.filter(n => n.kind === "batch" && n.scope === "directory-snapshot").length, metadataOnlyArtifacts: directorySources.filter(s => s.source.kind === "artifact").length, bounded: true } };
    const core = { schema: "pi-full-history-material.v1" as const, planId, model, maxRequests: nodes.length, nodes, scope: { cwd: options.cwd, privateDir, platform }, selectedHistories: selected, historyProofs, sourceIndex, artifacts, publicPlan: publicCore, ...(requestedOutputTokenLimit !== undefined ? { outputTokenLimit } : {}), ...(options.snapshotFingerprint ? { snapshotFingerprint: options.snapshotFingerprint } : {}) };
    const planFile = await writeArtifact(directory, "plan.json", [Buffer.from(JSON.stringify(core))]), seal = stamp(await directory.chain.at(-1)!.handle.stat()); const planHash = planDigest(planFile, seal, privateDir); const privatePlan = freeze({ ...core, planHash, publicPlan: { ...publicCore, planHash } }) as FullHistoryPrivatePlan;
    authorities.set(privatePlan, { directory: directory.target, seal, planFile }); await directory.connected(); await root.connected(); return { publicPlan: privatePlan.publicPlan, privatePlan };
  } finally { await directory?.close(); await root.close(); }
}

export async function readFullHistoryPlan(options: GateOptions & { privateDir: string; planId: string; expectedPlanHash: string }): Promise<FullHistoryPrivatePlan> {
  if (!validPlanId(options.planId) || !/^[a-f0-9]{64}$/.test(options.expectedPlanHash)) fail("history-full-plan-invalid");
  const privateDir = path.resolve(options.privateDir), platform = options.platform ?? process.platform, anchor = await openAnchor(path.join(privateDir, options.planId), gate(options), platform);
  try {
    const handle = await fs.open(anchor.leaf("plan.json"), FILE_FLAGS | constants.O_RDONLY); let descriptor: Artifact;
    try { const s = await handle.stat(); regular(s); if (s.size > FULL_HISTORY_MATERIAL_LIMITS.artifactBytes) fail("history-full-plan-invalid"); descriptor = { name: "plan.json", bytes: s.size, sha256: "", stamp: stamp(s) }; } finally { await handle.close(); }
    // Read and hash before JSON.parse; only a plan sealed into the approved hash may allocate metadata objects.
    const expectedStamp = descriptor.stamp, rawHandle = await fs.open(anchor.leaf("plan.json"), FILE_FLAGS | constants.O_RDONLY), parts: Buffer[] = []; let at = 0;
    try { const opened = await rawHandle.stat(); regular(opened); if (!same(stamp(opened), expectedStamp)) fail("history-full-plan-changed"); while (at < descriptor.bytes) { await anchor.connected(); const buffer = Buffer.alloc(Math.min(65536, descriptor.bytes - at)), value = await rawHandle.read(buffer, 0, buffer.length, at); if (!value.bytesRead) fail("history-full-plan-changed"); parts.push(buffer.subarray(0, value.bytesRead)); at += value.bytesRead; } if (!same(stamp(await rawHandle.stat()), expectedStamp) || !same(stamp(await fs.lstat(anchor.leaf("plan.json"))), expectedStamp)) fail("history-full-plan-changed"); } finally { await rawHandle.close(); }
    const raw = Buffer.concat(parts, descriptor.bytes); descriptor.sha256 = digest(raw); const seal = stamp(await anchor.chain.at(-1)!.handle.stat()); if (planDigest(descriptor, seal, privateDir) !== options.expectedPlanHash) fail("history-full-plan-changed");
    let core: any; try { core = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { fail("history-full-plan-invalid"); }
    if (core.schema !== "pi-full-history-material.v1" || core.planId !== options.planId || core.scope?.privateDir !== privateDir || core.scope?.platform !== platform || !Array.isArray(core.nodes) || core.nodes.length !== core.maxRequests || !Number.isSafeInteger(core.maxRequests) || core.maxRequests < 0 || !Array.isArray(core.sourceIndex) || core.sourceIndex.length > 50000 || !Array.isArray(core.artifacts)) fail("history-full-plan-invalid");
    if (!Number.isSafeInteger(core.model?.maxTokens) || core.model.maxTokens <= 0 || core.publicPlan?.maxTokens !== normalizeOutputTokenLimit(core.model.maxTokens, core.outputTokenLimit)) fail("history-full-plan-invalid");
    const plan = freeze({ ...core, planHash: options.expectedPlanHash, publicPlan: { ...core.publicPlan, planHash: options.expectedPlanHash } }) as FullHistoryPrivatePlan; authorities.set(plan, { directory: anchor.target, seal, planFile: descriptor }); await anchor.connected(); return plan;
  } finally { await anchor.close(); }
}
async function withPlan<T>(options: GateOptions & { privateDir: string; plan: FullHistoryPrivatePlan }, run: (anchor: Anchor) => Promise<T>) {
  const authority = authorities.get(options.plan); if (!authority || path.resolve(options.privateDir) !== options.plan.scope.privateDir || (options.platform ?? process.platform) !== options.plan.scope.platform) fail("history-full-plan-not-verified"); const anchor = await openAnchor(authority.directory, gate(options), options.plan.scope.platform);
  try { if (!same(stamp(await anchor.chain.at(-1)!.handle.stat()), authority.seal) || !same(stamp(await fs.lstat(anchor.leaf("plan.json"))), authority.planFile.stamp)) fail("history-full-plan-changed"); const result = await run(anchor); await anchor.connected(); if (!same(stamp(await anchor.chain.at(-1)!.handle.stat()), authority.seal) || !same(stamp(await fs.lstat(anchor.leaf("plan.json"))), authority.planFile.stamp)) fail("history-full-plan-changed"); return result; } finally { await anchor.close(); }
}
export async function readFullHistoryBatch(options: GateOptions & { privateDir: string; plan: FullHistoryPrivatePlan; nodeId: string }): Promise<{ prompt: string; sources: Source[] }> {
  return withPlan(options, async anchor => { const node = options.plan.nodes.find(n => n.id === options.nodeId); if (!node || node.kind !== "batch") fail("history-full-node-invalid"); const artifact = options.plan.artifacts.find(a => a.name === node.materialFile); if (!artifact || artifact.sha256 !== node.materialHash || artifact.bytes > FULL_HISTORY_MATERIAL_LIMITS.batchBytes) fail("history-full-material-changed"); const prompt = new TextDecoder("utf-8", { fatal: true }).decode(await readArtifact(anchor, artifact)); const body = JSON.parse(prompt); if (body.kind !== "batch" || !Array.isArray(body.sources) || !body.sources.length || body.sources.length > 128 || body.sources.some((chunk: any) => !node.sourceIds.includes(chunk.id) || Buffer.byteLength(chunk.text) !== chunk.endOffsetBytes - chunk.offsetBytes || digest(chunk.text) !== chunk.sha256)) fail("history-full-material-changed"); const sources = node.sourceIds.map(id => options.plan.sourceIndex.find(s => s.source.id === id)?.source ?? fail("history-full-source-unavailable")); return { prompt, sources }; });
}
export async function readFullHistorySource(options: GateOptions & { privateDir: string; plan: FullHistoryPrivatePlan; sourceId: string }): Promise<{ source: Source; content: string }> {
  return withPlan(options, async anchor => { const record = options.plan.sourceIndex.find(s => s.source.id === options.sourceId); if (!record) fail("history-full-source-unavailable"); const artifact = options.plan.artifacts.find(a => a.name === record.bodyFile) ?? fail("history-full-material-changed"); const buffer = await readArtifact(anchor, artifact, { offset: record.offsetBytes, bytes: record.source.bytes, sha256: record.source.sha256 }); return { source: record.source, content: new TextDecoder("utf-8", { fatal: true }).decode(buffer) }; });
}
