import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let reader: typeof import("../stats.js");
const epoch = Date.parse("2026-01-01T00:00:00Z");
const model = "test-model";
const provider = "cliproxy";
function turn(id = "one", output = 1000, ordinal = 0) {
  return {
    type: "message", id,
    timestamp: new Date(epoch + ordinal * 100_000 + 10_000).toISOString(),
    message: {
      role: "assistant", timestamp: epoch + ordinal * 100_000,
      model, provider, stopReason: "stop",
      usage: { input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: output },
    } as Record<string, unknown>,
  };
}
function timing(entry: ReturnType<typeof turn>, overrides: Record<string, unknown> = {}) {
  return {
    type: "custom", customType: "dashboard-speed-timing",
    data: {
      version: 1, source: "pi-stream", messageEntryId: entry.id,
      messageTimestamp: entry.message.timestamp,
      provider: entry.message.provider, model: entry.message.model,
      requestDurationMs: 10_000, firstTokenMs: 8000, generationDurationMs: 2000,
      firstOutputKind: "text",
      ...overrides,
    },
  };
}
async function save(entries: unknown[], rel = "work/2026_main.jsonl", trailingNewline = true) {
  const file = path.join(home, ".pi/agent/sessions", rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + (trailingNewline ? "\n" : ""));
  return file;
}
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "speed-performance-test-"));
  await fs.mkdir(path.join(home, ".pi/agent/sessions"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(Date, "now").mockReturnValue(epoch + 36_000_000);
  vi.resetModules();
  reader = await import("../stats.js");
  await fs.writeFile(path.join(home, ".pi/agent/models.json"), JSON.stringify({
    providers: { [provider]: { models: [{ id: model, cost: { input: 0, output: 12, cacheRead: 0, cacheWrite: 0 } }] } },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("request and first-output performance", () => {
  it("prefers exact persisted stream timing over SDK duration and a delayed JSONL append", async () => {
    const entry = turn();
    entry.timestamp = new Date(epoch + 90_000).toISOString();
    entry.message.durationMs = 12_000;
    (entry.message.usage as Record<string, unknown>).reasoning = 600;
    await save([entry, timing(entry, { firstOutputKind: "thinking" })]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest).toMatchObject({
      tps: 500, estimatedTps: null, durationSeconds: 10,
      firstTokenSeconds: 8, generationSeconds: 2,
      timingSource: "pi-stream", firstOutputKind: "thinking", speedStatus: "measured",
      contentTokens: 400, reasoningTokens: 600, totalOutputTokens: 1000,
    });
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(stats.recentCount).toBe(1);
    expect(stats.estimatedCount).toBe(0);
  });

  it("uses native monotonic duration when first-output telemetry is unavailable", async () => {
    const entry = turn();
    entry.message.durationMs = 2500;
    entry.timestamp = new Date(epoch + 900_000).toISOString();
    await save([entry]);
    expect((await reader.getSpeedStats("main")).latest).toMatchObject({
      tps: null, estimatedTps: 400, durationSeconds: 2.5,
      firstTokenSeconds: null, generationSeconds: null, timingSource: "sdk-duration", speedStatus: "estimated",
    });
  });

  it("labels old wall-timestamp records as whole-request estimates without inventing TTFT", async () => {
    await save([turn()]);
    expect((await reader.getSpeedStats("main")).latest).toMatchObject({
      tps: null, estimatedTps: 100, durationSeconds: 10,
      firstTokenSeconds: null, generationSeconds: null, timingSource: "legacy-timestamps", speedStatus: "estimated",
    });
  });

  it.each(["before", "after", "unterminated-tail"])("joins timing by persisted message ID when metadata is %s", async (order) => {
    const entry = turn();
    const meta = timing(entry);
    const file = await save(order === "before" ? [meta, entry] : [entry, meta], undefined, order !== "unterminated-tail");
    const assertStats = async () => {
      const stats = await reader.getSpeedStats("main");
      expect(stats.latest?.tps).toBe(500);
      expect(stats.history).toHaveLength(1);
      expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
      expect(stats.billing?.invalidRecords).toBe(0);
    };
    await assertStats();
    if (order === "unterminated-tail") {
      await fs.appendFile(file, "\n");
      await assertStats();
    }
  });

  it("accepts an identical metadata retry but rejects conflicting duplicates without changing bills", async () => {
    const entry = turn();
    entry.message.durationMs = 5000;
    const meta = timing(entry);
    const file = await save([entry, meta, meta]);
    expect((await reader.getSpeedStats("main")).latest?.tps).toBe(500);
    await fs.appendFile(file, JSON.stringify(timing(entry, { firstTokenMs: 7000, generationDurationMs: 3000 })));
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest).toMatchObject({ tps: null, estimatedTps: null, timingSource: "unavailable", speedStatus: "invalid-timing" });
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(stats.billing?.invalidRecords).toBe(0);
    await fs.appendFile(file, "\n");
    expect((await reader.getSpeedStats("main")).latest?.speedStatus).toBe("invalid-timing");
  });

  it.each([
    { messageTimestamp: epoch + 1 },
    { provider: "different-provider" },
    { model: "different-model" },
    { version: 2 },
    { source: "dashboard-replay" },
    { firstTokenMs: 11_000, generationDurationMs: 0 },
    { firstTokenMs: 5000, generationDurationMs: 2000 },
    { generationDurationMs: -1 },
    { firstOutputKind: null },
  ])("does not rescue malformed or mismatched explicit metadata through a legacy estimate: %j", async (override) => {
    const entry = turn();
    await save([entry, timing(entry, override)]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest).toMatchObject({ tps: null, estimatedTps: null, speedStatus: "invalid-timing" });
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(stats.billing?.complete).toBe(true);
  });

  it("does not attach another message's timing or charge custom metadata", async () => {
    const entry = turn();
    await save([timing(entry, { messageEntryId: "someone-else" }), entry]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest).toMatchObject({ tps: null, estimatedTps: 100, timingSource: "legacy-timestamps" });
    expect(stats.history).toHaveLength(1);
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
  });

  it("can measure the output window without a request-start hook and leaves TTFT unknown", async () => {
    const entry = turn();
    entry.message.durationMs = 3000;
    await save([entry, timing(entry, { requestDurationMs: null, firstTokenMs: null, generationDurationMs: 1000, firstOutputKind: "toolcall" })]);
    expect((await reader.getSpeedStats("main")).latest).toMatchObject({
      tps: 1000, estimatedTps: null, durationSeconds: 3, firstTokenSeconds: null,
      generationSeconds: 1, timingSource: "pi-stream", firstOutputKind: "toolcall",
    });
  });

  it("falls back to request throughput when no nonempty output delta was observed", async () => {
    const entry = turn();
    await save([entry, timing(entry, { firstTokenMs: null, generationDurationMs: null, firstOutputKind: null })]);
    expect((await reader.getSpeedStats("main")).latest).toMatchObject({
      tps: null, estimatedTps: 100, firstTokenSeconds: null, generationSeconds: null,
      timingSource: "pi-stream", speedStatus: "estimated",
    });
  });

  it.each(["text", "toolcall"])("does not divide hidden reasoning tokens by a later %s output window", async (kind) => {
    const entry = turn();
    (entry.message.usage as Record<string, unknown>).reasoning = 600;
    await save([entry, timing(entry, { firstOutputKind: kind })]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest).toMatchObject({
      tps: null, estimatedTps: 100, firstTokenSeconds: 8, generationSeconds: 2,
      speedStatus: "estimated", speedCaveat: "reasoning-not-observed",
    });
    expect(stats.averageTps).toBeNull();
    expect(stats.recentCount).toBe(0);
    expect(stats.averageEstimatedTps).toBe(100);
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
  });

  it("retains the hidden-reasoning caveat when the fallback sample is too small", async () => {
    const entry = turn("small-reasoning", 150);
    (entry.message.usage as Record<string, unknown>).reasoning = 100;
    await save([entry, timing(entry)]);
    expect((await reader.getSpeedStats("main")).latest).toMatchObject({
      tps: null, estimatedTps: null, speedStatus: "insufficient-output", speedCaveat: "reasoning-not-observed",
    });
  });

  it.each([
    { output: 99, generationMs: 100, expected: null },
    { output: 100, generationMs: 99, expected: null },
    { output: 100, generationMs: 100, expected: 1000 },
  ])("applies the measured sample gate at $output tokens / $generationMs ms", async ({ output, generationMs, expected }) => {
    const entry = turn("one", output);
    await save([entry, timing(entry, { firstTokenMs: 10_000 - generationMs, generationDurationMs: generationMs })]);
    expect((await reader.getSpeedStats("main")).latest?.tps).toBe(expected);
  });

  it.each([
    { output: 199, durationMs: 1000, expected: null },
    { output: 200, durationMs: 999, expected: null },
    { output: 200, durationMs: 1000, expected: 200 },
  ])("applies the whole-request fallback gate at $output tokens / $durationMs ms", async ({ output, durationMs, expected }) => {
    const entry = turn("one", output);
    entry.message.durationMs = durationMs;
    await save([entry]);
    const result = (await reader.getSpeedStats("main")).latest;
    expect(result?.tps).toBeNull();
    expect(result?.estimatedTps).toBe(expected);
  });

  it.each([null, -1, "1000", Number.NaN])("does not silently replace an invalid SDK duration (%j) with wall-clock data", async (durationMs) => {
    const entry = turn();
    entry.message.durationMs = durationMs;
    await save([entry]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest).toMatchObject({ tps: null, estimatedTps: null, durationSeconds: null, speedStatus: "invalid-timing" });
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
  });

  it("represents missing and backward legacy timestamps as unknown instead of zero speed", async () => {
    const missing = turn("missing");
    delete missing.message.timestamp;
    const backward = turn("backward", 1000, 1);
    backward.message.timestamp = Date.parse(backward.timestamp) + 1000;
    await save([missing, backward]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "missing", durationSeconds: null, tps: null, estimatedTps: null, speedStatus: "missing-timing" }),
      expect.objectContaining({ id: "backward", durationSeconds: null, tps: null, estimatedTps: null, speedStatus: "invalid-timing" }),
    ]));
    expect(stats.averageTps).toBeNull();
    expect(stats.averageEstimatedTps).toBeNull();
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.024, 10);
  });

  it("excludes failed and aborted responses from performance but retains their consumed tokens and costs", async () => {
    const error = turn("error"), aborted = turn("aborted", 1000, 1);
    error.message.stopReason = "error";
    aborted.message.stopReason = "aborted";
    aborted.message.durationMs = 5000;
    await save([error, timing(error), aborted]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.history.every((record) => record.tps === null && record.estimatedTps === null && record.speedStatus === "failed")).toBe(true);
    expect(stats.recentCount).toBe(0);
    expect(stats.estimatedCount).toBe(0);
    expect(stats.billing?.sessionTotalCost).toBeCloseTo(0.024, 10);
  });

  it("uses separate time-weighted cohorts matching the latest exact provider, model and agent type", async () => {
    const measuredA = turn("measured-a", 400, 0), measuredB = turn("measured-b", 800, 8);
    const estimatedA = turn("estimated-a", 400, 1), estimatedB = turn("estimated-b", 800, 2);
    estimatedA.message.durationMs = 2000;
    estimatedB.message.durationMs = 8000;
    const otherProvider = turn("other-provider", 20_000, 3);
    otherProvider.message.provider = "another-provider";
    const otherModel = turn("other-model", 20_000, 4);
    otherModel.message.model = "another-model";
    await save([
      measuredA, timing(measuredA), estimatedA, estimatedB,
      otherProvider, timing(otherProvider), otherModel, timing(otherModel),
      measuredB, timing(measuredB, { firstTokenMs: 2000, generationDurationMs: 8000 }),
    ]);
    const child = turn("child", 20_000, 7);
    await save([child, timing(child)], "work/2026_main/child/run-1/session.jsonl");
    const stats = await reader.getSpeedStats("main");
    expect(stats.latest?.id).toBe("measured-b");
    expect(stats.averageScope).toEqual({ provider, model, agentType: "main" });
    expect(stats.averageTps).toBe(120);
    expect(stats.averageEstimatedTps).toBe(120);
    expect(stats.recentCount).toBe(2);
    expect(stats.estimatedCount).toBe(2);
    expect(stats.latestSubagent?.id).toBe("child");
  });

  it("keeps active elapsed time monotonic when the wall clock changes", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    reader.markGenerationStart("main", model);
    const start = reader.getActiveGeneration("main")!.startTime;
    vi.mocked(Date.now).mockReturnValue(epoch - 1_000_000);
    clock.mockReturnValue(2500);
    expect(reader.getActiveGeneration("main")).toMatchObject({ startTime: start, elapsedSeconds: 1.5 });
    reader.markGenerationEnd("main");
    expect(reader.getActiveGeneration("main")).toBeNull();
  });

  it("retains positive slow measurements and weighted means without rounding them into zero", async () => {
    const observed = turn("slow-observed", 100);
    observed.timestamp = new Date(epoch + 5_000_000).toISOString();
    const estimated = turn("slow-estimated", 200, 60);
    estimated.message.durationMs = 10_000_000;
    await save([observed, timing(observed, {
      requestDurationMs: 5_000_000, firstTokenMs: 1_000_000, generationDurationMs: 4_000_000,
    }), estimated]);
    const stats = await reader.getSpeedStats("main");
    expect(stats.history.find((record) => record.id === observed.id)?.tps).toBe(0.025);
    expect(stats.history.find((record) => record.id === estimated.id)?.estimatedTps).toBe(0.02);
    expect(stats.averageTps).toBe(0.025);
    expect(stats.averageEstimatedTps).toBe(0.02);
  });
});
