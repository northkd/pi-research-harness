import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createHostResourcesSampler, registerSystemRoutes } from "../routes/system-routes.js";

describe("host resources route", () => {
  it("samples valid host CPU and memory metrics", async () => {
    const sample = createHostResourcesSampler();
    const first = await sample();
    expect(first.cpuCount).toBeGreaterThanOrEqual(1);
    expect(first.memoryTotal).toBeGreaterThan(0);
    expect(first.memoryAvailable).toBeGreaterThanOrEqual(0);
    expect(first.memoryUsed).toBeGreaterThanOrEqual(0);
    expect(first.memoryUsedPercent).toBeGreaterThanOrEqual(0);
    expect(first.memoryUsedPercent).toBeLessThanOrEqual(100);
    expect(Number.isFinite(first.loadAvg1m)).toBe(true);
    expect(first.cpuUsedPercent === null || (first.cpuUsedPercent >= 0 && first.cpuUsedPercent <= 100)).toBe(true);
  });

  it("serves GET /api/host/resources through networkGuard with no-store cache headers", async () => {
    const app = Fastify();
    let guardRan = 0;
    registerSystemRoutes(app, {
      sessionManager: {} as never,
      preferencesStore: { flush: () => {} } as never,
      metaPersistence: { flushAll: () => {} } as never,
      config: { port: 8000, piPort: 9999, dev: false } as never,
      networkGuard: (async () => { guardRan += 1; }) as never,
    } as never);

    const res = await app.inject({ method: "GET", url: "/api/host/resources" });
    expect(res.statusCode).toBe(200);
    expect(guardRan).toBe(1);
    expect(res.headers["cache-control"]).toBe("no-store, private");

    const body = res.json() as {
      success: boolean;
      data: {
        sampledAt: string;
        cpuCount: number;
        cpuUsedPercent: number | null;
        memoryTotal: number;
        memoryAvailable: number;
        memoryUsedPercent: number;
      };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.sampledAt).toBe("string");
    expect(body.data.cpuCount).toBeGreaterThanOrEqual(1);
    expect(body.data.memoryTotal).toBeGreaterThan(0);
    expect(body.data.memoryAvailable).toBeGreaterThanOrEqual(0);
    expect(body.data.memoryUsedPercent).toBeGreaterThanOrEqual(0);
    expect(body.data.memoryUsedPercent).toBeLessThanOrEqual(100);

    await app.close();
  });
});
