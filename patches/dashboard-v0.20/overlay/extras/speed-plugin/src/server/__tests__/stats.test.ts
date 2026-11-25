import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let reader: typeof import("../stats.js");
const rate = { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 };
async function models(
  providers: Record<string, unknown> = {
    cliproxy: { models: [{ id: "gpt-6-astra(high)[1m]", cost: rate }] },
  },
) {
  await fs.writeFile(
    path.join(home, ".pi/agent/models.json"),
    JSON.stringify({ providers }),
  );
}
function turn(
  id: string,
  usage: Record<string, unknown> = {},
  model = "gpt-6-astra(high)[1m]",
  provider = "cliproxy",
) {
  return {
    type: "message",
    id,
    timestamp: "2026-01-01T00:00:10.000Z",
    message: {
      role: "assistant",
      timestamp: Date.parse("2026-01-01T00:00:00Z"),
      model,
      provider,
      usage: {
        input: 0,
        output: 1000,
        reasoning: 600,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1000,
        ...usage,
      },
    },
  };
}
async function save(rel: string, entries: unknown[], tail = "") {
  const file = path.join(home, ".pi/agent/sessions", rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    entries
      .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
      .join("\n") +
      "\n" +
      tail,
  );
  return file;
}
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "speed-test-"));
  await fs.mkdir(path.join(home, ".pi/agent/sessions"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-01-01T08:00:00+08:00"),
  );
  vi.resetModules();
  reader = await import("../stats.js");
  await models();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("TPS and billing", () => {
  it("defaults to the Beijing calendar month while keeping old TPS records", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-02-01T00:00:00+08:00"),
    );
    const old = turn("old");
    old.timestamp = "2026-01-31T15:59:59.999Z";
    const current = turn("current");
    current.timestamp = "2026-01-31T16:00:00.000Z";
    current.message.timestamp = Date.parse(current.timestamp) - 10000;
    await save("work/2026_main.jsonl", [old, current]);
    const s = await reader.getSpeedStats("main");
    expect(s.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(s.history).toHaveLength(2);
    expect(s.billingPeriod?.month).toBe("2026-02");
    expect(s.billingHistory?.map((r) => r.id)).toEqual(["current"]);
  });
  it("resets an unchanged session and child bill at a month boundary without deleting logs", async () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-01-31T15:59:59.999Z"));
    const file = await save("work/2026_main.jsonl", [turn("main")]);
    await save("work/2026_main/child/run-1/session.jsonl", [turn("child")]);
    const before = await fs.readFile(file, "utf8");
    expect(
      (await reader.getSpeedStats("main")).billing?.sessionTotalCost,
    ).toBeCloseTo(0.024, 10);
    clock.mockReturnValue(Date.parse("2026-01-31T16:00:00.000Z"));
    const fresh = await reader.getSpeedStats("main");
    expect(fresh.billing).toMatchObject({
      sessionTotalCost: 0,
      mainTotalCost: 0,
      subagentTotalCost: 0,
      complete: true,
    });
    expect(fresh.history).toHaveLength(2);
    expect(fresh.billingHistory).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("can read a previous month without contaminating the current month's cached bill", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-02-02T00:00:00+08:00"),
    );
    await save("work/2026_main.jsonl", [turn("old")]);
    expect((await reader.getSpeedStats("main")).billing?.sessionTotalCost).toBe(
      0,
    );
    expect(
      (await reader.getSpeedStats("main", undefined, "2026-01")).billing
        ?.sessionTotalCost,
    ).toBeCloseTo(0.012, 10);
    expect((await reader.getSpeedStats("main")).billing?.sessionTotalCost).toBe(
      0,
    );
    await expect(
      reader.getSpeedStats("main", undefined, "2026-13"),
    ).rejects.toThrow("Invalid billing month");
  });
  it("keeps unknown broken lines in their discovered month after new-month appends", async () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-01-31T23:00:00+08:00"));
    const file = await save("work/2026_main.jsonl", [turn("old"), "{broken"]);
    const oldTime = new Date("2026-01-31T23:00:00+08:00");
    await fs.utimes(file, oldTime, oldTime);
    expect((await reader.getSpeedStats("main")).billing?.invalidRecords).toBe(
      1,
    );
    clock.mockReturnValue(Date.parse("2026-02-01T01:00:00+08:00"));
    const fresh = turn("new");
    fresh.timestamp = "2026-01-31T17:00:00.000Z";
    await fs.appendFile(file, JSON.stringify(fresh) + "\n");
    const february = await reader.getSpeedStats("main");
    expect(february.billing).toMatchObject({
      complete: true,
      invalidRecords: 0,
    });
    expect(february.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
  });
  it("filters the full month before limiting billing histories and includes both agent types", async () => {
    const later = Array.from({ length: 40 }, (_, index) => {
      const entry = turn(`feb-${index}`);
      entry.timestamp = "2026-02-01T00:00:10.000Z";
      return entry;
    });
    await save("work/2026_main.jsonl", [turn("jan-main"), ...later]);
    await save("work/2026_main/child/run-1/session.jsonl", [turn("jan-child")]);
    const january = await reader.getSpeedStats("main", undefined, "2026-01");
    expect(
      january.history.every((record) => record.id?.startsWith("feb-")),
    ).toBe(true);
    expect(january.billingHistory?.map((record) => record.id)).toEqual([
      "jan-main",
      "jan-child",
    ]);
    expect(january.billingMainHistory?.map((record) => record.id)).toEqual([
      "jan-main",
    ]);
    expect(january.billingSubagentHistory?.map((record) => record.id)).toEqual([
      "jan-child",
    ]);
    expect(january.billing?.sessionTotalCost).toBeCloseTo(0.024, 10);
    expect(january.billing?.mainTotalCost).toBeCloseTo(0.012, 10);
    expect(january.billing?.subagentTotalCost).toBeCloseTo(0.012, 10);
  });
  it("assigns a line completed after midnight to its actual completion month", async () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-01-31T23:59:59+08:00"));
    const entry = turn("cross-month");
    entry.timestamp = "2026-01-31T16:00:01.000Z";
    entry.message.timestamp = Date.parse("2026-01-31T15:59:51.000Z");
    const line = JSON.stringify(entry) + "\n";
    const file = await save("work/2026_main.jsonl", [], line.slice(0, 30));
    const oldTime = new Date("2026-01-31T23:59:59+08:00");
    await fs.utimes(file, oldTime, oldTime);
    expect((await reader.getSpeedStats("main")).billing?.invalidRecords).toBe(
      1,
    );
    clock.mockReturnValue(Date.parse("2026-02-01T00:00:02+08:00"));
    await fs.appendFile(file, line.slice(30));
    const february = await reader.getSpeedStats("main");
    expect(february.billing).toMatchObject({
      complete: true,
      invalidRecords: 0,
    });
    expect(february.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(february.latest?.durationSeconds).toBe(10);
    expect(february.billingHistory?.map((record) => record.id)).toEqual([
      "cross-month",
    ]);
    expect(
      (await reader.getSpeedStats("main", undefined, "2026-01")).billing,
    ).toMatchObject({ complete: true, sessionTotalCost: 0, invalidRecords: 0 });
  });
  it("keeps an invalid complete tail in its timestamp month with or without a final LF", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-02-02T00:00:00+08:00"),
    );
    const bad = turn("bad-tail", { output: "invalid" });
    bad.timestamp = "2026-01-31T15:59:59.000Z";
    const file = await save("work/2026_main.jsonl", [], JSON.stringify(bad));
    const modified = new Date("2026-02-02T00:00:00+08:00");
    await fs.utimes(file, modified, modified);
    const check = async () => {
      expect((await reader.getSpeedStats("main")).billing).toMatchObject({
        complete: true,
        invalidRecords: 0,
      });
      expect(
        (await reader.getSpeedStats("main", undefined, "2026-01")).billing,
      ).toMatchObject({ complete: false, invalidRecords: 1 });
    };
    await check();
    await fs.appendFile(file, "\n");
    await check();
  });
  it("counts reasoning once and labels legacy elapsed time as a whole-request estimate", async () => {
    await save("work/2026_main.jsonl", [turn("one")]);
    const s = await reader.getSpeedStats("main");
    expect(s.latest).toMatchObject({
      contentTokens: 400,
      reasoningTokens: 600,
      totalOutputTokens: 1000,
      tps: null,
      estimatedTps: 100,
      timingSource: "legacy-timestamps",
      durationSeconds: 10,
    });
    expect(s.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
  });
  it("normalizes every token bucket and includes cache writes in category totals", async () => {
    await save("work/2026_main.jsonl", [
      turn("one", {
        input: 1e6,
        output: 1e6,
        reasoning: 0,
        cacheRead: 1e6,
        cacheWrite: 1e6,
      }),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.sessionTotalCost).toBeCloseTo(17.64, 10);
    expect(b.totalCacheWriteCost).toBe(3);
    expect(b.totalCacheSavings).toBeCloseTo(2.16, 10);
    expect(
      b.totalInputCost +
        b.totalOutputCost +
        b.totalCacheCost +
        b.totalCacheWriteCost +
        b.totalRequestCost,
    ).toBeCloseTo(b.sessionTotalCost, 10);
  });
  it("retains subagent history and bills grandchildren without substring contamination", async () => {
    await save(
      "work/2026_main.jsonl",
      Array.from({ length: 40 }, (_, i) => turn("m" + i)),
    );
    await save("work/2026_main/child/run-0/session.jsonl", [turn("c")]);
    await save("work/2026_main/child/run-0/session/grand/run-0/session.jsonl", [
      turn("g"),
    ]);
    await save("work/2026_main-other.jsonl", [turn("foreign")]);
    const s = await reader.getSpeedStats("main");
    expect(s.mainHistory).toHaveLength(25);
    expect(s.subagentHistory).toHaveLength(2);
    expect(s.history).toHaveLength(30);
    expect(s.billing?.sessionTotalCost).toBeCloseTo(42 * 0.012, 10);
  });
  it("indexes provider and normalizes only the context suffix", async () => {
    await models({
      cliproxy: { models: [{ id: "same[1m]", cost: rate }] },
      other: {
        currency: "CNY",
        models: [{ id: "same[1m]", cost: { ...rate, output: 99 } }],
      },
    });
    await save("work/2026_main.jsonl", [
      turn("a", {}, "same", "cliproxy"),
      turn("b", {}, "same[1m]", "other"),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.sessionTotalCost).toBeCloseTo(0.111, 10);
    expect(b.modelBreakdown).toHaveLength(2);
  });
  it("marks missing prices as incomplete and does not relabel an unknown USD charge", async () => {
    await save("work/2026_main.jsonl", [
      turn("one", { cost: { input: 3, total: 3 } }, "unknown", "other"),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.complete).toBe(false);
    expect(b.unpricedTurns).toBe(1);
    expect(b.sessionTotalCost).toBe(0);
  });
  it("maps historical Astra aliases but does not guess another provider's price", async () => {
    await save("work/2026_main.jsonl", [
      turn("a", {}, "gpt-6-astra(medium)[1m]"),
      turn("b", {}, "gpt-6-astra", "openai-codex"),
      turn("c", {}, "gpt-6-astra", "other"),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.sessionTotalCost).toBeCloseTo(0.024, 10);
    expect(b.unpricedTurns).toBe(1);
  });
  it("charges supported image calls per request, independent of token usage", async () => {
    await models({
      cliproxy: {
        models: [
          {
            id: "gpt-image-2.5[1m]",
            cost: { input: 0.05, output: 0.05, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
    await save("work/2026_main.jsonl", [
      turn("img", { output: 900000, reasoning: 0 }, "gpt-image-2.5[1m]"),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.sessionTotalCost).toBe(0.05);
    expect(b.totalRequestCost).toBe(0.05);
  });
  it("retains sub-cent usage until display formatting", async () => {
    await models({
      cliproxy: {
        models: [
          {
            id: "tiny",
            cost: { input: 0.48, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
    await save(
      "work/2026_main.jsonl",
      Array.from({ length: 1000 }, (_, i) =>
        turn("t" + i, { input: 1, output: 0, reasoning: 0 }, "tiny"),
      ),
    );
    expect(
      (await reader.getSpeedStats("main")).billing?.sessionTotalCost,
    ).toBeCloseTo(0.00048, 10);
  });
  it("uses a recent duration-weighted throughput", async () => {
    const old = turn("old", { output: 10, reasoning: 0 });
    old.timestamp = "2025-12-31T00:00:10.000Z";
    await save("work/2026_main.jsonl", [
      old,
      ...Array.from({ length: 30 }, (_, i) => turn("n" + i, { reasoning: 0 })),
    ]);
    const s = await reader.getSpeedStats("main");
    expect(s.recentCount).toBe(0);
    expect(s.estimatedCount).toBe(30);
    expect(s.averageTps).toBeNull();
    expect(s.averageEstimatedTps).toBe(100);
  });
  it("skips bad values and partial lines without poisoning valid costs", async () => {
    await save(
      "work/2026_main.jsonl",
      [turn("ok"), turn("bad", { input: "invalid" }), "{broken"],
      '{"type":"message"',
    );
    const s = await reader.getSpeedStats("main");
    expect(s.mainHistory).toHaveLength(1);
    expect(s.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(s.billing?.invalidRecords).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain('null,"mainTotalCost"');
  });
  it("rereads appended complete lines but keeps partial UTF-8 tails until completed", async () => {
    const file = await save("work/2026_main.jsonl", [turn("a")]);
    expect((await reader.getSpeedStats("main")).mainHistory).toHaveLength(1);
    const line = Buffer.from(
      JSON.stringify({ ...turn("b"), note: "中文" }) + "\n",
    );
    const split = line.indexOf(Buffer.from("中")) + 1;
    await fs.appendFile(file, line.subarray(0, split));
    expect((await reader.getSpeedStats("main")).mainHistory).toHaveLength(1);
    await fs.appendFile(file, line.subarray(split));
    expect((await reader.getSpeedStats("main")).mainHistory).toHaveLength(2);
  });
  it("hot reloads prices and survives a partially written model config", async () => {
    await save("work/2026_main.jsonl", [turn("a")]);
    expect(
      (await reader.getSpeedStats("main")).billing?.sessionTotalCost,
    ).toBeCloseTo(0.012, 10);
    await models({
      cliproxy: {
        models: [
          { id: "gpt-6-astra(high)[1m]", cost: { ...rate, output: 24 } },
        ],
      },
    });
    expect(
      (await reader.getSpeedStats("main")).billing?.sessionTotalCost,
    ).toBeCloseTo(0.024, 10);
    await fs.writeFile(
      path.join(home, ".pi/agent/models.json"),
      '{"providers":',
    );
    expect(
      (await reader.getSpeedStats("main")).billing?.sessionTotalCost,
    ).toBeCloseTo(0.024, 10);
  });
  it("does not read unchanged transcripts again", async () => {
    const file = await save("work/2026_main.jsonl", [turn("a")]);
    await reader.getSpeedStats("main");
    const handle = await fs.open(file, "r");
    const spy = vi.spyOn(Object.getPrototypeOf(handle), "read");
    await handle.close();
    await Promise.all([
      reader.getSpeedStats("main"),
      reader.getSpeedStats("main"),
    ]);
    expect(spy).not.toHaveBeenCalled();
  });
  it("accepts a complete last line without LF and deduplicates it when LF arrives", async () => {
    const file = await save("work/2026_main.jsonl", []);
    await fs.writeFile(file, JSON.stringify(turn("one")));
    expect((await reader.getSpeedStats("main")).mainHistory).toHaveLength(1);
    await fs.appendFile(file, "\n");
    expect((await reader.getSpeedStats("main")).mainHistory).toHaveLength(1);
  });
  it("never reuses a parent's subagent classification when querying the child", async () => {
    await save("work/2026_main.jsonl", [turn("parent")]);
    const child = await save("work/2026_main/child/run-0/session.jsonl", [
      { type: "session", id: "child-session" },
      turn("child"),
    ]);
    expect(
      (await reader.getSpeedStats("main")).billing?.subagentTotalCost,
    ).toBeCloseTo(0.012, 10);
    const b = (await reader.getSpeedStats("child-session", child)).billing!;
    expect(b.mainTotalCost).toBeCloseTo(0.012, 10);
    expect(b.subagentTotalCost).toBe(0);
  });
  it("shows multiple tariffs without presenting the first as the only tariff", async () => {
    await models({
      cliproxy: {
        models: [
          {
            id: "deepseek-v4-pro[1m]",
            cost: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 },
          },
        ],
      },
    });
    await save("work/2026_main.jsonl", [
      turn(
        "peak",
        { output: 1e6, reasoning: 0, pricingPeriod: "peak" },
        "deepseek-v4-pro[1m]",
      ),
      turn(
        "off",
        { output: 1e6, reasoning: 0, pricingPeriod: "offPeak" },
        "deepseek-v4-pro[1m]",
      ),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.sessionTotalCost).toBe(40.5);
    expect(b.modelBreakdown[0].rates).toBeUndefined();
  });
  it("does not charge an image request that failed with no usage", async () => {
    await models({
      cliproxy: {
        models: [
          {
            id: "gpt-image-2.5[1m]",
            cost: { input: 0.05, output: 0.05, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
    const failed = turn(
      "failed",
      { output: 0, reasoning: 0 },
      "gpt-image-2.5[1m]",
    ) as ReturnType<typeof turn> & { message: { stopReason: string } };
    failed.message.stopReason = "error";
    await save("work/2026_main.jsonl", [failed]);
    expect((await reader.getSpeedStats("main")).billing?.sessionTotalCost).toBe(
      0,
    );
  });

  it("keeps a main generation active when an unrelated role ends", async () => {
    const { default: register } = await import("../index.js");
    let listener: (id: string, event: unknown) => void = () => {};
    const context = {
      fastify: { get: () => {} },
      onEvent: (fn: typeof listener) => {
        listener = fn;
      },
      onSessionEnded: () => {},
      logger: { info: () => {} },
      sessionManager: { getSession: () => undefined },
    };
    await register(context as unknown as Parameters<typeof register>[0]);
    listener("main", {
      eventType: "message_start",
      data: { message: { role: "assistant", model: "gpt-6-astra" } },
    });
    listener("main", {
      eventType: "message_end",
      data: { message: { role: "user" } },
    });
    expect(reader.getActiveGeneration("main")).not.toBeNull();
    listener("main", {
      eventType: "message_end",
      data: { message: { role: "assistant" } },
    });
    expect(reader.getActiveGeneration("main")).toBeNull();
  });
  it("prices the official historical Flash alias using the automatic weekend tier", async () => {
    await models({
      cliproxy: {
        models: [
          {
            id: "deepseek-v4-flash-vision-exp[1m]",
            cost: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
          },
        ],
      },
    });
    const entry = turn(
      "legacy",
      { output: 1e6, reasoning: 0 },
      "deepseek-flash",
      "deepseek",
    );
    entry.timestamp = "2026-10-17T02:00:00.000Z";
    entry.message.timestamp = Date.parse(entry.timestamp) - 10000;
    await save("work/2026_main.jsonl", [entry]);
    const b = (await reader.getSpeedStats("main", undefined, "2026-10"))
      .billing!;
    expect(b.sessionTotalCost).toBe(4);
    expect(b.unpricedTurns).toBe(0);
  });
  it("does not trust a zero CNY cost attached to unpriced nonzero usage", async () => {
    await save("work/2026_main.jsonl", [
      turn(
        "unknown",
        {
          cost: {
            currency: "CNY",
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        "unconfigured",
      ),
    ]);
    const b = (await reader.getSpeedStats("main")).billing!;
    expect(b.complete).toBe(false);
    expect(b.unpricedTurns).toBe(1);
  });
  it("drops cached records after a file is truncated", async () => {
    const file = await save("work/2026_main.jsonl", [turn("old"), turn("new")]);
    expect((await reader.getSpeedStats("main")).mainHistory).toHaveLength(2);
    await fs.writeFile(file, JSON.stringify(turn("new")) + "\n");
    const history = (await reader.getSpeedStats("main")).mainHistory!;
    expect(history.map((r) => r.id)).toEqual(["new"]);
  });
});
