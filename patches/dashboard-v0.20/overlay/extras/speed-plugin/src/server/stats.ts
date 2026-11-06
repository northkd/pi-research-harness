import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { resolvePiSessionsDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import { billingPeriod, inBillingPeriod } from "../billing-period.js";
import type {
  ActiveGeneration,
  BillingPeriod,
  BillingReport,
  BillingReportSession,
  BillingSummary,
  ModelRateInfo,
  ModelUsageSummary,
  SpeedRecord,
  SpeedStatsResponse,
  TurnCostBreakdown,
} from "../types.js";
import { deepseekMultiplier } from "./deepseek-pricing.js";

const activeGenerations = new Map<
  string,
  { startTime: number; monotonicStart: number; model?: string }
>();
export function markGenerationStart(sessionId: string, model?: string): void {
  activeGenerations.set(sessionId, {
    startTime: Date.now(),
    monotonicStart: performance.now(),
    model,
  });
}
export function markGenerationEnd(sessionId: string): void {
  activeGenerations.delete(sessionId);
}
export function getActiveGeneration(
  sessionId?: string,
): ActiveGeneration | null {
  const id = sessionId ?? activeGenerations.keys().next().value;
  const active = id ? activeGenerations.get(id) : undefined;
  return active && id
    ? {
        sessionId: id,
        startTime: active.startTime,
        elapsedSeconds: Math.max(0, (performance.now() - active.monotonicStart) / 1000),
        model: active.model,
      }
    : null;
}

const cleanModel = (model: string) =>
  model
    .replace(/\[\d+m\]/gi, "")
    .trim()
    .toLowerCase();
const rateKey = (provider: string, model: string) =>
  JSON.stringify([provider.toLowerCase(), cleanModel(model)]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const IMAGE_MODELS = new Set([
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
]);
// Explicit, provider-scoped historical aliases. Never use a different provider's same-name rate.
const HISTORICAL_ALIASES: Record<string, [string, string]> = {
  [rateKey("cliproxy", "gpt-6-astra(medium)")]: [
    "cliproxy",
    "gpt-6-astra(high)",
  ],
  [rateKey("cliproxy", "gpt-6-astra")]: ["cliproxy", "gpt-6-astra(high)"],
  [rateKey("openai-codex", "gpt-6-astra")]: ["cliproxy", "gpt-6-astra(high)"],
  [rateKey("deepseek", "deepseek-flash")]: [
    "cliproxy",
    "deepseek-v4-flash-vision-exp",
  ],
  [rateKey("deepseek", "deepseek-v4-flash")]: [
    "cliproxy",
    "deepseek-v4-flash-vision-exp",
  ],
  [rateKey("deepseek", "deepseek-v4-flash-vision-exp")]: [
    "cliproxy",
    "deepseek-v4-flash-vision-exp",
  ],
  [rateKey("deepseek", "deepseek-v4-pro")]: ["cliproxy", "deepseek-v4-pro"],
};

let modelCache:
  | { signature: string; rates: Map<string, ModelRateInfo>; revision: number }
  | undefined;
let loadingRates: Promise<NonNullable<typeof modelCache>> | undefined;
async function loadRates() {
  if (loadingRates !== undefined) return loadingRates;
  loadingRates = (async () => {
    const file = path.join(os.homedir(), ".pi/agent/models.json");
    try {
      const stat = await fs.stat(file);
      const signature = [
        file,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
      ].join(":");
      if (modelCache?.signature === signature) return modelCache;
      const json: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (!isObject(json) || !isObject(json.providers))
        throw new Error("Invalid model config");
      const rates = new Map<string, ModelRateInfo>();
      for (const [provider, definition] of Object.entries(json.providers)) {
        if (!isObject(definition) || !Array.isArray(definition.models))
          continue;
        for (const model of definition.models) {
          if (
            !isObject(model) ||
            typeof model.id !== "string" ||
            !isObject(model.cost)
          )
            continue;
          const cost = model.cost;
          // The approved 21-model table defines cliproxy's prices in CNY.
          const currency =
            cost.currency ??
            model.currency ??
            definition.currency ??
            (provider === "cliproxy" ? "CNY" : undefined);
          if (currency !== "CNY") continue;
          const values = ["input", "output", "cacheRead", "cacheWrite"].map(
            (k) => cost[k] ?? 0,
          );
          if (!values.every(nonnegative)) continue;
          const [input, output, cacheRead, cacheWrite] = values as number[];
          const fixed =
            provider === "cliproxy" && IMAGE_MODELS.has(cleanModel(model.id));
          rates.set(rateKey(provider, model.id), {
            input,
            output,
            cacheRead,
            cacheWrite,
            currency: "CNY",
            unit: fixed ? "request" : "tokens",
            request: fixed ? input : undefined,
          });
        }
      }
      modelCache = {
        signature,
        rates,
        revision: (modelCache?.revision ?? 0) + 1,
      };
      return modelCache;
    } catch {
      // A transient partial config write keeps the last validated prices; try again next poll.
      return (
        modelCache ?? {
          signature: "",
          rates: new Map<string, ModelRateInfo>(),
          revision: 0,
        }
      );
    }
  })();
  try {
    return await loadingRates;
  } finally {
    loadingRates = undefined;
  }
}
function getRate(
  rates: Map<string, ModelRateInfo>,
  provider: string,
  model: string,
) {
  const exact = rates.get(rateKey(provider, model));
  if (exact) return exact;
  const alias = HISTORICAL_ALIASES[rateKey(provider, model)];
  return alias ? rates.get(rateKey(...alias)) : undefined;
}

interface RawRecord extends Omit<SpeedRecord, "cost" | "costSource" | "rates"> {
  provider: string;
  recordedCost?: TurnCostBreakdown;
  pricingPeriod?: "peak" | "offPeak";
  failed: boolean;
}
interface StreamTiming {
  version: 1;
  source: "pi-stream";
  messageEntryId: string;
  messageTimestamp: number;
  provider: string;
  model: string;
  requestDurationMs: number | null;
  firstTokenMs: number | null;
  generationDurationMs: number | null;
  firstOutputKind: "text" | "thinking" | "toolcall" | null;
}
type TimingSlot = { timing: StreamTiming; fingerprint: string } | { invalid: true };
interface TimingEntry { id: string; slot: TimingSlot }
interface FileState {
  signature: string;
  identity: string;
  offset: number;
  pending: Buffer;
  pendingSince?: number;
  witness: Buffer;
  records: Map<string, RawRecord>;
  timings: Map<string, TimingSlot>;
  invalidTimestamps: number[];
  tailRecord?: RawRecord;
  tailTiming?: TimingEntry;
  invalidTailTimestamp?: number;
  header?: { id?: string; cwd?: string };
  name?: string;
}
const files = new Map<string, FileState>();
const fileLoads = new Map<string, Promise<FileState>>();
const trimCache = <T>(map: Map<string, T>, max: number) => {
  while (map.size > max) map.delete(map.keys().next().value!);
};

function sessionsBase() {
  return resolvePiSessionsDir({ piSessionsDir: loadConfig().piSessionsDir });
}

function captureMetadata(entry: unknown, state: FileState) {
  if (!isObject(entry)) return;
  if (entry.type === "session") {
    state.header = {
      id: typeof entry.id === "string" ? entry.id : undefined,
      cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    };
  } else if (entry.type === "session_info" && typeof entry.name === "string") {
    state.name = entry.name;
  }
}

/** Timing rows never become billable records or corrupt an otherwise valid bill. */
function parseTimingEntry(entry: unknown): TimingEntry | null {
  if (!isObject(entry) || entry.type !== "custom" || entry.customType !== "dashboard-speed-timing")
    return null;
  const data = entry.data;
  if (!isObject(data) || typeof data.messageEntryId !== "string" || !data.messageEntryId)
    return null;
  const id = data.messageEntryId;
  const invalid: TimingEntry = { id, slot: { invalid: true } };
  if (
    data.version !== 1 || data.source !== "pi-stream" || !nonnegative(data.messageTimestamp) ||
    typeof data.provider !== "string" || typeof data.model !== "string" ||
    ![data.requestDurationMs, data.firstTokenMs, data.generationDurationMs].every((v) => v === null || nonnegative(v)) ||
    ![null, "text", "thinking", "toolcall"].includes(data.firstOutputKind as string | null)
  ) return invalid;
  const timing: StreamTiming = {
    version: 1,
    source: "pi-stream",
    messageEntryId: id,
    messageTimestamp: data.messageTimestamp as number,
    provider: data.provider,
    model: data.model,
    requestDurationMs: data.requestDurationMs as number | null,
    firstTokenMs: data.firstTokenMs as number | null,
    generationDurationMs: data.generationDurationMs as number | null,
    firstOutputKind: data.firstOutputKind as StreamTiming["firstOutputKind"],
  };
  const { requestDurationMs: total, firstTokenMs: first, generationDurationMs: generation } = timing;
  if (
    (timing.firstOutputKind === null && (first !== null || generation !== null)) ||
    (total !== null && ((first !== null && first > total) || (generation !== null && generation > total))) ||
    // Individual rounded millisecond intervals can differ by one millisecond.
    (total !== null && first !== null && generation !== null && Math.abs(first + generation - total) > 2)
  ) return invalid;
  return { id, slot: { timing, fingerprint: JSON.stringify(timing) } };
}

function combineTimingSlots(previous: TimingSlot | undefined, next: TimingSlot): TimingSlot {
  if (!previous) return next;
  if ("invalid" in previous || "invalid" in next || previous.fingerprint !== next.fingerprint)
    return { invalid: true };
  return previous;
}

function requestTiming(message: Record<string, unknown>, endTime: number): Pick<SpeedRecord, "durationSeconds" | "timingSource" | "speedStatus"> {
  // Pi's native monotonic duration excludes extension processing and JSONL append delay.
  // An explicitly malformed duration is not silently replaced with an apparently valid estimate.
  if (message.durationMs !== undefined) {
    return nonnegative(message.durationMs)
      ? { durationSeconds: message.durationMs / 1000, timingSource: "sdk-duration" }
      : { durationSeconds: null, timingSource: "unavailable", speedStatus: "invalid-timing" };
  }
  if (message.timestamp === undefined)
    return { durationSeconds: null, timingSource: "unavailable", speedStatus: "missing-timing" };
  if (!nonnegative(message.timestamp) || endTime < message.timestamp)
    return { durationSeconds: null, timingSource: "unavailable", speedStatus: "invalid-timing" };
  return { durationSeconds: (endTime - message.timestamp) / 1000, timingSource: "legacy-timestamps" };
}

function withPerformance(raw: RawRecord, slot?: TimingSlot): RawRecord {
  const record: RawRecord = {
    ...raw,
    tps: null,
    estimatedTps: null,
    firstTokenSeconds: null,
    generationSeconds: null,
    firstOutputKind: null,
  };
  let generationMs: number | null = null;
  if (slot) {
    if (
      "invalid" in slot || slot.timing.messageTimestamp !== raw.startTime ||
      slot.timing.provider !== raw.provider || slot.timing.model !== raw.model
    ) return { ...record, durationSeconds: null, timingSource: "unavailable", speedStatus: raw.failed ? "failed" : "invalid-timing" };
    const timing = slot.timing;
    generationMs = timing.generationDurationMs;
    record.firstTokenSeconds = timing.firstTokenMs === null ? null : timing.firstTokenMs / 1000;
    record.generationSeconds = generationMs === null ? null : generationMs / 1000;
    record.firstOutputKind = timing.firstOutputKind;
    if (timing.requestDurationMs !== null) {
      record.durationSeconds = timing.requestDurationMs / 1000;
      record.timingSource = "pi-stream";
      record.speedStatus = undefined;
    }
  }
  if (raw.failed) return { ...record, speedStatus: "failed" };
  const reasoningNotObserved = record.reasoningTokens > 0 &&
    (record.firstOutputKind === "text" || record.firstOutputKind === "toolcall");
  // Reported hidden reasoning may precede the first visible text/tool output.
  // Its tokens cannot safely be divided by only that later observed window.
  if (reasoningNotObserved) record.speedCaveat = "reasoning-not-observed";
  // CC Switch uses minimum useful sample windows. Count provider tokens, not characters or chunks.
  if (!reasoningNotObserved && generationMs !== null && generationMs >= 100 && record.totalOutputTokens >= 100) {
    record.tps = record.totalOutputTokens / (generationMs / 1000);
    record.timingSource = "pi-stream";
    record.speedStatus = "measured";
    return record;
  }
  if (record.speedStatus === "invalid-timing") return record;
  if (record.durationSeconds !== null && record.durationSeconds >= 1 && record.totalOutputTokens >= 200) {
    record.estimatedTps = record.totalOutputTokens / record.durationSeconds;
    record.speedStatus = "estimated";
  } else if (record.totalOutputTokens < (generationMs === null || reasoningNotObserved ? 200 : 100)) {
    record.speedStatus = "insufficient-output";
  } else if ((!reasoningNotObserved && generationMs !== null && generationMs < 100) || (record.durationSeconds !== null && record.durationSeconds < 1)) {
    record.speedStatus = "too-short";
  } else {
    record.speedStatus = "missing-timing";
  }
  return record;
}

function parseRecord(
  entry: unknown,
  agentType: "main" | "subagent",
): RawRecord | null {
  if (
    !isObject(entry) ||
    entry.type !== "message" ||
    !isObject(entry.message) ||
    entry.message.role !== "assistant"
  )
    return null;
  const m = entry.message;
  if (!isObject(m.usage)) return null;
  const usage = m.usage;
  const counts = [
    "input",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
  ].map((k) => usage[k] ?? 0);
  if (!counts.every((n) => nonnegative(n) && Number.isSafeInteger(n)))
    throw new Error("Invalid token count");
  const [
    inputTokens,
    totalOutputTokens,
    reportedReasoning,
    cacheRead,
    cacheWrite,
  ] = counts as number[];
  if (reportedReasoning > totalOutputTokens)
    throw new Error("Reasoning exceeds output");
  const startTime = nonnegative(m.timestamp) ? m.timestamp : undefined;
  const endTime =
    typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(endTime)) throw new Error("Invalid timestamp");
  const timing = requestTiming(m, endTime);
  const totalTokens = inputTokens + totalOutputTokens + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(totalTokens)) throw new Error("Invalid token sum");
  let recordedCost: TurnCostBreakdown | undefined;
  const rawCost = usage.cost;
  if (
    isObject(rawCost) &&
    rawCost.currency === "CNY" &&
    nonnegative(rawCost.total) &&
    (rawCost.total > 0 || totalTokens === 0)
  ) {
    const fields = ["input", "output", "cacheRead", "cacheWrite", "total"].map(
      (k) => rawCost[k],
    );
    const [input, output, read, write, total] = fields as number[];
    if (
      fields.every(nonnegative) &&
      Math.abs(input + output + read + write - total) < 1e-8
    ) {
      recordedCost = {
        input,
        output,
        cacheRead: read,
        cacheWrite: write,
        total,
      };
    }
  }
  return {
    id: typeof entry.id === "string" ? entry.id : undefined,
    timestamp: endTime,
    startTime,
    ...timing,
    provider: typeof m.provider === "string" ? m.provider : "",
    model: typeof m.model === "string" ? m.model : "unknown",
    agentType,
    tps: null,
    contentTokens: totalOutputTokens - reportedReasoning,
    reasoningTokens: reportedReasoning,
    totalOutputTokens,
    inputTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    recordedCost,
    pricingPeriod:
      usage.pricingPeriod === "peak" || usage.pricingPeriod === "offPeak"
        ? usage.pricingPeriod
        : undefined,
    failed: m.stopReason === "error" || m.stopReason === "aborted",
  };
}

async function readRecords(
  source: string,
  agentType: "main" | "subagent",
  base: string,
): Promise<FileState> {
  const file = await fs.realpath(source);
  const relative = path.relative(base, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Outside session log root");
  const existingLoad = fileLoads.get(file);
  if (existingLoad) return existingLoad;
  const work = (async () => {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      const identity = [stat.dev, stat.ino].join(":");
      const signature = [identity, stat.size, stat.mtimeMs, stat.ctimeMs].join(
        ":",
      );
      let state = files.get(file);
      if (state?.signature === signature) return state;
      let append =
        !!state && state.identity === identity && stat.size > state.offset;
      if (append && state!.witness.length) {
        const witness = Buffer.alloc(state!.witness.length);
        await handle.read(
          witness,
          0,
          witness.length,
          state!.offset - witness.length,
        );
        append = witness.equals(state!.witness);
      }
      if (!append)
        state = {
          signature: "",
          identity,
          offset: 0,
          pending: Buffer.alloc(0),
          witness: Buffer.alloc(0),
          records: new Map(),
          timings: new Map(),
          invalidTimestamps: [],
        };
      const current = state!;
      const chunk = Buffer.alloc(64 * 1024);
      while (current.offset < stat.size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, stat.size - current.offset),
          current.offset,
        );
        if (!bytesRead) break;
        current.offset += bytesRead;
        const pendingLength = current.pending.length;
        const pendingSince = current.pendingSince ?? stat.mtimeMs;
        const data = Buffer.concat([
          current.pending,
          chunk.subarray(0, bytesRead),
        ]);
        let from = 0;
        for (
          let end = data.indexOf(10);
          end >= 0;
          end = data.indexOf(10, from)
        ) {
          const lineTime =
            from === 0 && pendingLength > 0 ? pendingSince : stat.mtimeMs;
          const line = data.subarray(from, end).toString("utf8").trim();
          from = end + 1;
          if (!line) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
            captureMetadata(entry, current);
            const timing = parseTimingEntry(entry);
            if (timing) current.timings.set(timing.id, combineTimingSlots(current.timings.get(timing.id), timing.slot));
            const record = parseRecord(entry, agentType);
            if (record)
              current.records.set(
                record.id ?? `${record.startTime}:${record.timestamp}`,
                record,
              );
          } catch {
            const timestamp =
              isObject(entry) && typeof entry.timestamp === "string"
                ? Date.parse(entry.timestamp)
                : NaN;
            current.invalidTimestamps.push(
              Number.isFinite(timestamp) ? timestamp : lineTime,
            );
          }
        }
        current.pending = Buffer.from(data.subarray(from));
        current.pendingSince = current.pending.length
          ? from === 0 && pendingLength > 0
            ? pendingSince
            : stat.mtimeMs
          : undefined;
      }
      current.witness = Buffer.alloc(Math.min(64, current.offset));
      current.tailRecord = undefined;
      current.tailTiming = undefined;
      current.invalidTailTimestamp = undefined;
      if (current.pending.toString("utf8").trim()) {
        let entry: unknown;
        try {
          entry = JSON.parse(current.pending.toString("utf8"));
          captureMetadata(entry, current);
          current.tailTiming = parseTimingEntry(entry) ?? undefined;
          current.tailRecord = parseRecord(entry, agentType) ?? undefined;
        } catch {
          const timestamp =
            isObject(entry) && typeof entry.timestamp === "string"
              ? Date.parse(entry.timestamp)
              : NaN;
          current.invalidTailTimestamp = Number.isFinite(timestamp)
            ? timestamp
            : (current.pendingSince ?? stat.mtimeMs);
        }
      }
      if (current.witness.length)
        await handle.read(
          current.witness,
          0,
          current.witness.length,
          current.offset - current.witness.length,
        );
      current.signature = signature;
      files.delete(file);
      files.set(file, current);
      // A report spans all root and child logs; keep a bounded working set above
      // the old 256-file limit so ordinary directories do not reread every log.
      trimCache(files, 1024);
      return current;
    } finally {
      await handle.close();
    }
  })();
  fileLoads.set(file, work);
  try {
    return await work;
  } finally {
    fileLoads.delete(file);
  }
}

let directoryIndex:
  | {
      base: string;
      expires: number;
      mains: { file: string; id: string; mtime: number }[];
      unreadable: number;
    }
  | undefined;
const indexLoads = new Map<
  string,
  Promise<NonNullable<typeof directoryIndex>>
>();
async function mainIndex(base: string) {
  if (directoryIndex?.base === base && directoryIndex.expires > Date.now())
    return directoryIndex;
  const existing = indexLoads.get(base);
  if (existing) return existing;
  const work = (async () => {
    const mains: NonNullable<typeof directoryIndex>["mains"] = [];
    let unreadable = 0;
    async function list(dir: string, workspaces: boolean) {
      const entries = await fs
        .readdir(dir, { withFileTypes: true })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") unreadable++;
          return [];
        });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && workspaces) await list(full, false);
        else if (e.isFile() && e.name.endsWith(".jsonl")) {
          const stem = e.name.slice(0, -6);
          const id = stem.includes("_")
            ? stem.slice(stem.lastIndexOf("_") + 1)
            : stem;
          try {
            mains.push({
              file: full,
              id,
              mtime: (await fs.stat(full)).mtimeMs,
            });
          } catch {
            /* A concurrent rotation must not fail the whole index. */
            unreadable++;
          }
        }
      }
    }
    await list(base, true);
    directoryIndex = { base, expires: Date.now() + 1000, mains, unreadable };
    return directoryIndex;
  })();
  indexLoads.set(base, work);
  try {
    return await work;
  } finally {
    if (indexLoads.get(base) === work) indexLoads.delete(base);
  }
}
const trees = new Map<
  string,
  { expires: number; files: string[]; unreadable: number }
>();
async function sessionFiles(main: string) {
  const cached = trees.get(main);
  if (cached && cached.expires > Date.now()) return cached;
  const result = [main];
  let unreadable = 0;
  async function walk(dir: string) {
    for (const entry of await fs
      .readdir(dir, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") unreadable++;
        return [];
      })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        result.push(full);
    }
  }
  const subtree = main.slice(0, -6);
  const root = await fs.lstat(subtree).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") unreadable++;
    return null;
  });
  if (root?.isDirectory()) await walk(subtree);
  else if (root) unreadable++;
  const value = { expires: Date.now() + 1000, files: result, unreadable };
  trees.delete(main);
  trees.set(main, value);
  trimCache(trees, 32);
  return value;
}

function price(raw: RawRecord, rates: Map<string, ModelRateInfo>): SpeedRecord {
  const { recordedCost, pricingPeriod, failed, ...record } = raw;
  const multiplier = deepseekMultiplier(
    raw.provider,
    cleanModel(raw.model),
    raw.timestamp,
    pricingPeriod,
  );
  const baseRate =
    multiplier === undefined
      ? undefined
      : getRate(rates, raw.provider, raw.model);
  const rate =
    baseRate && multiplier !== undefined && multiplier !== 1
      ? {
          ...baseRate,
          input: baseRate.input * multiplier,
          output: baseRate.output * multiplier,
          cacheRead: baseRate.cacheRead * multiplier,
          cacheWrite: baseRate.cacheWrite * multiplier,
        }
      : baseRate;
  let cost: TurnCostBreakdown | undefined;
  if (rate) {
    const input = (raw.inputTokens * rate.input) / 1e6;
    const output = (raw.totalOutputTokens * rate.output) / 1e6;
    const cacheRead = (raw.cacheRead * rate.cacheRead) / 1e6;
    const cacheWrite = ((raw.cacheWrite ?? 0) * rate.cacheWrite) / 1e6;
    const requestCost =
      failed && raw.totalTokens === 0 ? 0 : (rate.request ?? 0);
    cost =
      rate.unit === "request"
        ? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            request: requestCost,
            total: requestCost,
          }
        : {
            input,
            output,
            cacheRead,
            cacheWrite,
            request: 0,
            total: input + output + cacheRead + cacheWrite,
          };
  } else if (recordedCost) cost = recordedCost;
  else if (raw.totalTokens === 0)
    cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  if (cost && !Object.values(cost).every(nonnegative)) cost = undefined;
  return {
    ...record,
    cost,
    rates: rate,
    costSource: rate ? "configured" : cost ? "recorded" : "unpriced",
  };
}

function summarize(
  records: SpeedRecord[],
  invalidRecords: number,
): BillingSummary {
  const b: BillingSummary = {
    currency: "CNY",
    complete: invalidRecords === 0,
    unpricedTurns: 0,
    invalidRecords,
    sessionTotalCost: 0,
    mainTotalCost: 0,
    subagentTotalCost: 0,
    totalInputCost: 0,
    totalOutputCost: 0,
    totalCacheCost: 0,
    totalCacheWriteCost: 0,
    totalRequestCost: 0,
    totalCacheSavings: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalTokens: 0,
    modelBreakdown: [],
  };
  const models = new Map<string, ModelUsageSummary>();
  for (const r of records) {
    const c = r.cost;
    if (!c) {
      b.unpricedTurns++;
      b.complete = false;
    }
    if (r.agentType === "subagent") b.subagentTotalCost += c?.total ?? 0;
    else b.mainTotalCost += c?.total ?? 0;
    b.totalInputCost += c?.input ?? 0;
    b.totalOutputCost += c?.output ?? 0;
    b.totalCacheCost += c?.cacheRead ?? 0;
    b.totalCacheWriteCost += c?.cacheWrite ?? 0;
    b.totalRequestCost += c?.request ?? 0;
    b.totalInputTokens += r.inputTokens;
    b.totalOutputTokens += r.totalOutputTokens;
    b.totalCacheRead += r.cacheRead;
    b.totalCacheWrite += r.cacheWrite ?? 0;
    b.totalTokens += r.totalTokens;
    if (r.rates?.unit !== "request" && r.rates) {
      b.totalCacheSavings +=
        (r.cacheRead * Math.max(0, r.rates.input - r.rates.cacheRead)) / 1e6;
    }
    const key = rateKey(r.provider ?? "", r.model);
    let m = models.get(key);
    if (!m) {
      m = {
        provider: r.provider,
        model: cleanModel(r.model),
        agentType: r.agentType ?? "main",
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        unpricedCalls: 0,
        rates: r.rates,
      };
      models.set(key, m);
    }
    if (m.agentType !== r.agentType) m.agentType = "mixed";
    if (JSON.stringify(m.rates) !== JSON.stringify(r.rates))
      m.rates = undefined;
    m.callCount++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.totalOutputTokens;
    m.cacheRead += r.cacheRead;
    m.cacheWrite += r.cacheWrite ?? 0;
    m.totalTokens += r.totalTokens;
    m.cost += c?.total ?? 0;
    if (!c) m.unpricedCalls++;
  }
  b.sessionTotalCost = b.mainTotalCost + b.subagentTotalCost;
  b.modelBreakdown = [...models.values()];
  return b;
}

function stateRows(state: FileState): RawRecord[] {
  const rows = new Map(state.records);
  if (state.tailRecord)
    rows.set(
      state.tailRecord.id ??
        `${state.tailRecord.startTime}:${state.tailRecord.timestamp}`,
      state.tailRecord,
    );
  return [...rows.values()].map((record) => {
    let slot = record.id ? state.timings.get(record.id) : undefined;
    if (record.id && state.tailTiming?.id === record.id)
      slot = combineTimingSlots(slot, state.tailTiming.slot);
    return withPerformance(record, slot);
  });
}

function invalidCount(state: FileState, period: BillingPeriod): number {
  return (
    state.invalidTimestamps.filter((timestamp) =>
      inBillingPeriod(timestamp, period),
    ).length +
    Number(
      state.invalidTailTimestamp !== undefined &&
        inBillingPeriod(state.invalidTailTimestamp, period),
    )
  );
}

const snapshots = new Map<
  string,
  { signature: string; value: SpeedStatsResponse }
>();
const pendingStats = new Map<string, Promise<SpeedStatsResponse>>();
function weightedTps(records: SpeedRecord[], duration: "generationSeconds" | "durationSeconds"): number | null {
  const seconds = records.reduce((sum, record) => sum + (record[duration] ?? 0), 0);
  return seconds > 0
    ? records.reduce((sum, record) => sum + record.totalOutputTokens, 0) / seconds
    : null;
}
async function buildStats(
  sessionId: string | undefined,
  registeredFile: string | undefined,
  period: BillingPeriod,
): Promise<SpeedStatsResponse> {
  const empty: SpeedStatsResponse = {
    sessionId,
    status: "idle",
    active: null,
    latest: null,
    latestMain: null,
    latestSubagent: null,
    averageTps: null,
    averageEstimatedTps: null,
    recentCount: 0,
    estimatedCount: 0,
    history: [],
    mainHistory: [],
    subagentHistory: [],
    subagentModels: [],
    billingPeriod: period,
    billingHistory: [],
    billingMainHistory: [],
    billingSubagentHistory: [],
  };
  const configuredBase = sessionsBase();
  const base = await fs
    .realpath(configuredBase)
    .catch(() => path.resolve(configuredBase));
  const index = await mainIndex(base);
  let main = sessionId
    ? index.mains.find((m) => m.id === sessionId)
    : [...index.mains].sort((a, b) => b.mtime - a.mtime)[0];
  if (!main && sessionId && registeredFile) {
    try {
      const real = await fs.realpath(registeredFile);
      const relative = path.relative(await fs.realpath(base), real);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        const h = await fs.open(real, "r");
        try {
          const buffer = Buffer.alloc(8192);
          const { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
          const header = JSON.parse(
            buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0],
          );
          if (header.type === "session" && header.id === sessionId)
            main = { file: real, id: sessionId, mtime: 0 };
        } finally {
          await h.close();
        }
      }
    } catch {
      /* The registered file may have been removed or live on another host. */
    }
  }
  if (!main) return empty;
  const rates = await loadRates();
  const tree = await sessionFiles(main.file);
  const paths = tree.files;
  const states: { file: string; state: FileState }[] = [];
  let unreadable = tree.unreadable;
  for (const file of paths) {
    try {
      states.push({
        file,
        state: await readRecords(
          file,
          file === main.file ? "main" : "subagent",
          base,
        ),
      });
    } catch {
      unreadable++;
    }
  }
  const signature = JSON.stringify([
    main.id,
    period.month,
    rates.revision,
    unreadable,
    paths,
    states.map((s) => s.state.signature),
  ]);
  const cached = snapshots.get(main.file);
  if (cached?.signature === signature) return cached.value;
  const records = states
    .flatMap(({ file, state }) => {
      return stateRows(state).map((r) =>
        price(
          { ...r, agentType: file === main.file ? "main" : "subagent" },
          rates.rates,
        ),
      );
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  const mains = records.filter((r) => r.agentType === "main");
  const subs = records.filter((r) => r.agentType === "subagent");
  const billed = records.filter((record) =>
    inBillingPeriod(record.timestamp, period),
  );
  const history = records.slice(-30);
  const latest = records.at(-1) ?? null;
  const averageScope = latest ? {
    provider: latest.provider ?? "",
    model: latest.model,
    agentType: latest.agentType ?? "main",
  } : undefined;
  // Never present another model/provider/agent's throughput as the latest model's speed.
  const comparable = records.filter((record) => averageScope &&
    (record.provider ?? "") === averageScope.provider && record.model === averageScope.model &&
    (record.agentType ?? "main") === averageScope.agentType);
  const measured = comparable.filter((record) => record.tps !== null && (record.generationSeconds ?? 0) > 0).slice(-30);
  const estimated = comparable.filter((record) => record.estimatedTps != null && (record.durationSeconds ?? 0) > 0).slice(-30);
  const value: SpeedStatsResponse = {
    ...empty,
    sessionId: main.id,
    latest,
    latestMain: mains.at(-1) ?? null,
    latestSubagent: subs.at(-1) ?? null,
    averageTps: weightedTps(measured, "generationSeconds"),
    averageEstimatedTps: weightedTps(estimated, "durationSeconds"),
    recentCount: measured.length,
    estimatedCount: estimated.length,
    averageScope,
    history,
    mainHistory: mains.slice(-25),
    subagentHistory: subs.slice(-25),
    subagentModels: [...new Set(subs.map((r) => r.model))],
    billingHistory: billed.slice(-30),
    billingMainHistory: billed
      .filter((record) => record.agentType === "main")
      .slice(-25),
    billingSubagentHistory: billed
      .filter((record) => record.agentType === "subagent")
      .slice(-25),
    billing: summarize(
      billed,
      unreadable +
        states.reduce((n, s) => n + invalidCount(s.state, period), 0),
    ),
  };
  snapshots.delete(main.file);
  snapshots.set(main.file, { signature, value });
  trimCache(snapshots, 32);
  return value;
}

/** Async, incremental reads; concurrent polls share work and never mix session identities. */
export async function getSpeedStats(
  sessionId?: string,
  registeredFile?: string,
  month?: string,
): Promise<SpeedStatsResponse> {
  if (
    sessionId !== undefined &&
    (!/^[\w.-]{1,200}$/.test(sessionId) ||
      sessionId === "." ||
      sessionId === "..")
  ) {
    throw new Error("Invalid sessionId");
  }
  const selected = sessionId ?? getActiveGeneration()?.sessionId;
  const period = billingPeriod(month);
  const key = JSON.stringify([
    os.homedir(),
    selected,
    registeredFile,
    period.month,
  ]);
  let pending = pendingStats.get(key);
  if (!pending) {
    pending = buildStats(selected, registeredFile, period);
    pendingStats.set(key, pending);
  }
  try {
    const value = await pending;
    const active = getActiveGeneration(value.sessionId ?? selected);
    return { ...value, active, status: active ? "streaming" : "idle" };
  } finally {
    if (pendingStats.get(key) === pending) pendingStats.delete(key);
  }
}

const pendingReports = new Map<string, Promise<BillingReport>>();

/** Read-only historical report. Physical root files own their entire child tree. */
export async function getBillingReport(
  month?: string,
  registeredSessions: unknown[] = [],
): Promise<BillingReport> {
  const period = billingPeriod(month);
  const base = sessionsBase();
  const metadata = registeredSessions.filter(isObject).map((session) => ({
    id: typeof session.id === "string" ? session.id : undefined,
    sessionFile:
      typeof session.sessionFile === "string" ? session.sessionFile : undefined,
    cwd: typeof session.cwd === "string" ? session.cwd : undefined,
    name: typeof session.name === "string" ? session.name : undefined,
    remote: !!session.originDeviceId,
  }));
  const key = JSON.stringify([base, period.month, metadata]);
  let pending = pendingReports.get(key);
  if (!pending) {
    pending = (async () => {
      const realBase = await fs.realpath(base).catch(() => path.resolve(base));
      const index = await mainIndex(realBase);
      const rates = await loadRates();
      const candidates = new Map(
        index.mains.map((main) => [path.resolve(main.file), main.id]),
      );
      const localMetadata = new Map<string, (typeof metadata)[number]>();
      let unavailableSessions = metadata.filter(
        (session) => session.remote,
      ).length;
      for (const session of metadata) {
        if (session.remote) continue;
        try {
          if (!session.sessionFile) throw new Error("Session log unavailable");
          const file = await fs.realpath(session.sessionFile);
          const relative = path.relative(realBase, file);
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            !file.endsWith(".jsonl")
          )
            throw new Error("Outside session log root");
          localMetadata.set(file, session);
          // Registered descendants are removed below when a parent owns their tree.
          candidates.set(file, session.id ?? path.basename(file, ".jsonl"));
        } catch {
          unavailableSessions++;
        }
      }
      const roots: [string, string][] = [];
      for (const candidate of [...candidates.entries()].sort(
        (a, b) => a[0].length - b[0].length,
      )) {
        if (
          !roots.some(([root]) =>
            candidate[0].startsWith(root.slice(0, -6) + path.sep),
          )
        )
          roots.push(candidate);
      }
      const availableMonths = new Set([billingPeriod().month, period.month]);
      const rememberMonth = (timestamp: number) => {
        const date = new Date(timestamp + 8 * 60 * 60 * 1000);
        if (!Number.isFinite(date.getTime())) return;
        const discovered = date.toISOString().slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(discovered)) availableMonths.add(discovered);
      };
      const sessions: BillingReportSession[] = [];
      const allRecords: SpeedRecord[] = [];
      let allInvalid = index.unreadable;
      const groups = new Map<
        string,
        { records: SpeedRecord[]; invalid: number; count: number }
      >();
      for (const [file, fallbackId] of roots) {
        const tree = await sessionFiles(file);
        const records: SpeedRecord[] = [];
        let invalid = tree.unreadable;
        let mainState: FileState | undefined;
        for (const child of tree.files) {
          try {
            const state = await readRecords(
              child,
              child === file ? "main" : "subagent",
              realBase,
            );
            if (child === file) mainState = state;
            invalid += invalidCount(state, period);
            for (const timestamp of state.invalidTimestamps)
              rememberMonth(timestamp);
            if (state.invalidTailTimestamp !== undefined)
              rememberMonth(state.invalidTailTimestamp);
            for (const raw of stateRows(state)) {
              rememberMonth(raw.timestamp);
              if (inBillingPeriod(raw.timestamp, period))
                records.push(
                  price(
                    { ...raw, agentType: child === file ? "main" : "subagent" },
                    rates.rates,
                  ),
                );
            }
          } catch {
            invalid++;
          }
        }
        const info = localMetadata.get(file);
        const cwd = mainState?.header?.cwd ?? info?.cwd ?? "";
        const id = mainState?.header?.id ?? info?.id ?? fallbackId;
        const group = groups.get(cwd) ?? { records: [], invalid: 0, count: 0 };
        for (const record of records) {
          group.records.push(record);
          allRecords.push(record);
        }
        group.invalid += invalid;
        allInvalid += invalid;
        if (records.length > 0 || invalid > 0) {
          group.count++;
          sessions.push({
            key: file,
            id,
            name: info?.name || mainState?.name || id,
            cwd,
            turnCount: records.length,
            lastActivity: records.length
              ? records.reduce(
                  (latest, record) => Math.max(latest, record.timestamp),
                  0,
                )
              : null,
            billing: summarize(records, invalid),
          });
        }
        groups.set(cwd, group);
      }
      const billing = summarize(allRecords, allInvalid);
      if (unavailableSessions > 0) billing.complete = false;
      return {
        billingPeriod: period,
        generatedAt: Date.now(),
        availableMonths: [...availableMonths].sort().reverse(),
        unavailableSessions,
        billing,
        directories: [...groups]
          .map(([cwd, group]) => ({
            cwd,
            sessionCount: group.count,
            billing: summarize(group.records, group.invalid),
          }))
          .sort(
            (a, b) =>
              b.billing.sessionTotalCost - a.billing.sessionTotalCost ||
              a.cwd.localeCompare(b.cwd),
          ),
        sessions: sessions.sort(
          (a, b) =>
            b.billing.sessionTotalCost - a.billing.sessionTotalCost ||
            a.key.localeCompare(b.key),
        ),
      };
    })();
    pendingReports.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    if (pendingReports.get(key) === pending) pendingReports.delete(key);
  }
}
