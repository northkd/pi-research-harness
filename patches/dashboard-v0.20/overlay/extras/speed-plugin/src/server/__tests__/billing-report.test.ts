import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let reader: typeof import("../stats.js");
const rate = { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 };
function turn(
  id: string,
  timestamp = "2026-01-01T00:00:10.000Z",
  model = "test",
) {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      provider: "cliproxy",
      model,
      timestamp: Date.parse(timestamp) - 10000,
      usage: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 },
    },
  };
}
async function save(
  relative: string,
  id: string,
  cwd: string,
  entries: unknown[],
) {
  const file = path.join(home, ".pi/agent/sessions", relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [{ type: "session", id, cwd }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return file;
}
async function prices(output = 12) {
  await fs.writeFile(
    path.join(home, ".pi/agent/models.json"),
    JSON.stringify({
      providers: {
        cliproxy: { models: [{ id: "test", cost: { ...rate, output } }] },
      },
    }),
  );
}
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "billing-report-test-"));
  await fs.mkdir(path.join(home, ".pi/agent/sessions"), { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-02-02T00:00:00+08:00"),
  );
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  vi.resetModules();
  reader = await import("../stats.js");
  await prices();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe("monthly billing report", () => {
  it("includes unregistered historical sessions and full main/subagent usage", async () => {
    await save(
      "work/2026_main.jsonl",
      "main",
      "/project",
      Array.from({ length: 40 }, (_, i) => turn(`m${i}`)),
    );
    await save(
      "work/2026_main/child/run-1/session.jsonl",
      "child",
      "/project",
      [turn("sub")],
    );
    const report = await reader.getBillingReport("2026-01");
    expect(report.billingPeriod.month).toBe("2026-01");
    expect(report.availableMonths).toEqual(["2026-02", "2026-01"]);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      id: "main",
      cwd: "/project",
      turnCount: 41,
    });
    expect(report.billing.sessionTotalCost).toBeCloseTo(41 * 0.012, 10);
    expect(report.billing.subagentTotalCost).toBeCloseTo(0.012, 10);
    expect(report.directories[0].billing.sessionTotalCost).toBeCloseTo(
      report.billing.sessionTotalCost,
      10,
    );
    expect(report.billing.modelBreakdown[0].callCount).toBe(41);
  });
  it("keeps same-ID files in different directories separate and uses file-matched names", async () => {
    const first = await save("one/2026_same.jsonl", "same", "/one", [
      turn("a"),
    ]);
    const second = await save("two/2026_same.jsonl", "same", "/two", [
      turn("b"),
      turn("c"),
    ]);
    const report = await reader.getBillingReport("2026-01", [
      {
        id: "same",
        sessionFile: second,
        cwd: "/two",
        name: "Second",
        hidden: true,
        status: "ended",
      },
    ]);
    expect(report.sessions).toHaveLength(2);
    expect(new Set(report.sessions.map((session) => session.key)).size).toBe(2);
    expect(
      report.sessions.find((session) => session.key === first)?.name,
    ).not.toBe("Second");
    expect(
      report.sessions.find((session) => session.key === second)?.name,
    ).toBe("Second");
    expect(report.billing.sessionTotalCost).toBeCloseTo(0.036, 10);
    expect(report.directories).toHaveLength(2);
  });
  it("does not count a registered descendant as another root", async () => {
    const main = await save("work/2026_main.jsonl", "main", "/project", [
      turn("m"),
    ]);
    const child = await save(
      "work/2026_main/child/run-1/session.jsonl",
      "child",
      "/project",
      [turn("s")],
    );
    const report = await reader.getBillingReport("2026-01", [
      { id: "main", sessionFile: main, cwd: "/project" },
      { id: "child", sessionFile: child, cwd: "/project" },
    ]);
    expect(report.sessions).toHaveLength(1);
    expect(report.billing.sessionTotalCost).toBeCloseTo(0.024, 10);
  });
  it("keeps current and historical reports isolated and includes unpriced months", async () => {
    await save("work/2026_main.jsonl", "main", "/project", [
      turn("old"),
      turn("future", "2026-03-01T00:00:10.000Z", "missing"),
    ]);
    const current = await reader.getBillingReport();
    expect(current.billingPeriod.month).toBe("2026-02");
    expect(current.billing).toMatchObject({
      complete: true,
      sessionTotalCost: 0,
    });
    expect(current.availableMonths).toEqual(["2026-03", "2026-02", "2026-01"]);
    expect(
      (await reader.getBillingReport("2026-01")).billing.sessionTotalCost,
    ).toBeCloseTo(0.012, 10);
    expect((await reader.getBillingReport()).billing.sessionTotalCost).toBe(0);
    expect((await reader.getBillingReport("2026-03")).billing).toMatchObject({
      complete: false,
      unpricedTurns: 1,
    });
    await expect(reader.getBillingReport("2026-13")).rejects.toThrow(
      "Invalid billing month",
    );
  });
  it("marks remote logs unavailable without reading a matching local ID twice", async () => {
    const file = await save("work/2026_same.jsonl", "same", "/local", [
      turn("m"),
    ]);
    const report = await reader.getBillingReport("2026-01", [
      {
        id: "same",
        sessionFile: file,
        cwd: "/remote",
        name: "Remote",
        originDeviceId: "device",
      },
    ]);
    expect(report.billing).toMatchObject({ complete: false });
    expect(report.unavailableSessions).toBe(1);
    expect(report.billing.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(report.sessions[0].cwd).toBe("/local");
    expect(report.sessions[0].name).not.toBe("Remote");
  });
  it("uses the configured historical log directory", async () => {
    const file = await save("work/2026_main.jsonl", "main", "/project", [
      turn("m"),
    ]);
    const custom = path.join(home, "history");
    await fs.mkdir(custom);
    await fs.rename(file, path.join(custom, "main.jsonl"));
    await fs.mkdir(path.join(home, ".pi/dashboard"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".pi/dashboard/config.json"),
      JSON.stringify({ piSessionsDir: custom }),
    );
    expect(
      (await reader.getBillingReport("2026-01")).billing.sessionTotalCost,
    ).toBeCloseTo(0.012, 10);
  });
  it("hot reloads prices and shares concurrent reports", async () => {
    await save("work/2026_main.jsonl", "main", "/project", [turn("m")]);
    const [a, b] = await Promise.all([
      reader.getBillingReport("2026-01"),
      reader.getBillingReport("2026-01"),
    ]);
    expect(a).toBe(b);
    await prices(24);
    expect(
      (await reader.getBillingReport("2026-01")).billing.sessionTotalCost,
    ).toBeCloseTo(0.024, 10);
  });
  it.each([
    false,
    true,
  ])("discovers a historical month containing only invalid usage (tail=%s)", async (tail) => {
    const bad = turn("bad");
    (bad.message.usage.output as unknown) = "invalid";
    const file = await save(
      "work/2026_main.jsonl",
      "main",
      "/project",
      tail ? [] : [bad],
    );
    if (tail) await fs.appendFile(file, JSON.stringify(bad));
    expect((await reader.getBillingReport()).availableMonths).toContain(
      "2026-01",
    );
    expect((await reader.getBillingReport("2026-01")).billing).toMatchObject({
      complete: false,
      invalidRecords: 1,
    });
  });
  it("rejects a child-tree root that is a symlink outside the log directory", async () => {
    await save("work/2026_main.jsonl", "main", "/project", [turn("m")]);
    const outside = path.join(home, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(
      path.join(outside, "foreign.jsonl"),
      JSON.stringify(turn("foreign")) + "\n",
    );
    await fs.symlink(
      outside,
      path.join(home, ".pi/agent/sessions/work/2026_main"),
    );
    const report = await reader.getBillingReport("2026-01");
    expect(report.billing.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(report.billing.complete).toBe(false);
    expect(report.billing.invalidRecords).toBeGreaterThan(0);
  });
  it("canonicalizes an intentionally configured base symlink without duplicate bills", async () => {
    const file = await save("work/2026_main.jsonl", "main", "/project", [
      turn("m"),
    ]);
    const alias = path.join(home, "history-link");
    await fs.symlink(path.join(home, ".pi/agent/sessions"), alias);
    await fs.mkdir(path.join(home, ".pi/dashboard"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".pi/dashboard/config.json"),
      JSON.stringify({ piSessionsDir: alias }),
    );
    const [report, live] = await Promise.all([
      reader.getBillingReport("2026-01", [
        { id: "main", sessionFile: file, cwd: "/project" },
      ]),
      reader.getSpeedStats("main", file, "2026-01"),
    ]);
    expect(report.sessions).toHaveLength(1);
    expect(report.billing.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(live.billing?.sessionTotalCost).toBeCloseTo(0.012, 10);
  });
  it("marks a registered outside path unavailable without importing its costs", async () => {
    await save("work/2026_main.jsonl", "main", "/project", [turn("m")]);
    const outside = path.join(home, "foreign.jsonl");
    await fs.writeFile(outside, JSON.stringify(turn("foreign")) + "\n");
    const report = await reader.getBillingReport("2026-01", [
      { id: "foreign", sessionFile: outside, cwd: "/outside" },
    ]);
    expect(report.unavailableSessions).toBe(1);
    expect(report.billing.complete).toBe(false);
    expect(report.billing.sessionTotalCost).toBeCloseTo(0.012, 10);
    expect(report.sessions).toHaveLength(1);
  });
  it("does not reread every unchanged log when a report contains more than 256 files", async () => {
    for (let i = 0; i < 257; i++)
      await save(`work/2026_s${i}.jsonl`, `s${i}`, "/project", [turn(`m${i}`)]);
    await reader.getBillingReport("2026-01");
    const handle = await fs.open(
      path.join(home, ".pi/agent/sessions/work/2026_s0.jsonl"),
      "r",
    );
    const read = vi.spyOn(Object.getPrototypeOf(handle), "read");
    await handle.close();
    expect((await reader.getBillingReport("2026-01")).sessions).toHaveLength(
      257,
    );
    expect(read).not.toHaveBeenCalled();
  });
});
