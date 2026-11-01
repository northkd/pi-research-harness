import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScienceInstancesHost } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScienceInstancesRoutes } from "../routes/science-instances-routes.js";

const TASK = "si-00000000-0000-4000-8000-000000000001";
const ARTIFACT = "sa-00000000-0000-4000-8000-000000000002";
const principal = { iss: "fixture", sub: "alice" };
const content = Buffer.from("value\n1\n2\n3\n");
const artifact = { id: ARTIFACT, name: "values.csv", mediaType: "text/csv" as const, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
const summary = { id: TASK, status: "waiting-approval" as const, createdAt: 1000, lastObservedAt: 2000, stale: false };
const detail = { ...summary, modelIds: ["ark-sci-deepseek-v4.1-flash"], usage: null, cost: null, artifacts: [artifact] };
const apps: FastifyInstance[] = [];
const roots: string[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function setup(options: { configured?: boolean; foreign?: boolean; expired?: boolean } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "science-instances-fixture-")); roots.push(cwd);
  const app = Fastify(); apps.push(app);
  let known = [cwd];
  const host = {
    list: vi.fn(async () => ({ availability: "ready" as const, instances: [summary] })),
    detail: vi.fn(async () => ({ availability: "ready" as const, instance: detail })),
    readArtifact: vi.fn(async () => ({ availability: "ready" as const, artifact, content })),
  };
  app.addHook("onRequest", async request => {
    const authenticated = request as FastifyRequest & { principal: typeof principal; principalExpiresAt?: number };
    authenticated.principal = principal;
    if (options.expired) authenticated.principalExpiresAt = Date.now() - 1;
  });
  registerScienceInstancesRoutes(app, {
    networkGuard: async () => {}, knownCwds: () => known,
    history: () => [{ id: "fixture", cwd, principalOwner: options.foreign ? { iss: "fixture", sub: "bob" } : principal }],
    isResolverActive: () => true, host: options.configured === false ? undefined : host as ScienceInstancesHost,
  });
  const get = (suffix = "", query = "") => app.inject({ method: "GET", url: `/api/res-workflow/science/instances${suffix}?cwd=${encodeURIComponent(cwd)}${query}` });
  return { app, cwd, host, get, revoke: () => { known = []; } };
}

describe("directory-scoped Science instance and artifact reads", () => {
  it("reports an unconfigured host without fabricating an empty successful list", async () => {
    const f = await setup({ configured: false });
    expect((await f.get()).json()).toEqual({ availability: "unavailable", reason: "host-unconfigured" });
    expect(await fs.readdir(f.cwd)).toEqual([]);
  });

  it("rejects foreign, expired, malformed, and rider requests before host access", async () => {
    const f = await setup();
    for (const query of ["&ownerKey=bob", "&url=http://private", "&cwd=/other", "&path=../../secret"]) expect((await f.get("", query)).statusCode).toBe(400);
    expect((await f.get("/arbitrary-task")).statusCode).toBe(400);
    // The HTTP URL parser resolves dot segments to an invalid opaque task ID.
    expect((await f.get(`/${TASK}/artifacts/../../secret`)).statusCode).toBe(400);
    const foreign = await setup({ foreign: true }); expect((await foreign.get()).statusCode).toBe(404);
    const expired = await setup({ expired: true }); expect((await expired.get()).statusCode).toBe(403);
    expect(f.host.list).not.toHaveBeenCalled(); expect(foreign.host.list).not.toHaveBeenCalled(); expect(expired.host.list).not.toHaveBeenCalled();
    expect((await f.app.inject({ method: "POST", url: "/api/res-workflow/science/instances", payload: { cwd: f.cwd } })).statusCode).toBe(404);
  });

  it("passes only canonical trusted partitions and projects bounded safe fields", async () => {
    const f = await setup();
    f.host.list.mockResolvedValueOnce({ availability: "ready", instances: [{ ...summary, pageUrl: "http://private/?nonce=secret", prompt: "private text" }] } as never);
    const list = await f.get();
    expect(list.json()).toEqual({ availability: "ready", instances: [summary] });
    expect(f.host.list).toHaveBeenCalledWith({ ownerKey: JSON.stringify([principal.iss, principal.sub]), cwd: f.cwd });
    expect(list.headers["cache-control"]).toBe("private, no-store");
    f.host.detail.mockResolvedValueOnce({ availability: "ready", instance: { ...detail, pageUrl: "http://private", ownerKey: "bob" } } as never);
    const result = await f.get(`/${TASK}`);
    expect(result.json()).toEqual({ availability: "ready", instance: detail });
    expect(JSON.stringify(result.json())).not.toMatch(/private|pageUrl|ownerKey|prompt/);
  });

  it("revalidates ownership after an asynchronous host read before returning content", async () => {
    const f = await setup();
    f.host.list.mockImplementationOnce(async () => { f.revoke(); return { availability: "ready", instances: [summary] }; });
    const result = await f.get(); expect(result.statusCode).toBe(404); expect(result.body).not.toContain(TASK);
    const other = await setup();
    other.host.readArtifact.mockImplementationOnce(async () => { other.revoke(); return { availability: "ready", artifact, content }; });
    const bytes = await other.get(`/${TASK}/artifacts/${ARTIFACT}`); expect(bytes.statusCode).toBe(404); expect(bytes.body).not.toContain("value");
  });

  it("downloads only the requested registry artifact with verified length, SHA and inert headers", async () => {
    const f = await setup(); const result = await f.get(`/${TASK}/artifacts/${ARTIFACT}`);
    expect(result.statusCode).toBe(200); expect(result.rawPayload).toEqual(content);
    expect(f.host.readArtifact).toHaveBeenCalledWith({ ownerKey: JSON.stringify([principal.iss, principal.sub]), cwd: f.cwd }, TASK, ARTIFACT);
    expect(result.headers["content-type"]).toBe("text/csv");
    expect(result.headers["content-disposition"]).toContain("attachment;");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["content-security-policy"]).toContain("sandbox");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["x-science-artifact-sha256"]).toBe(artifact.sha256);
    expect(result.headers["access-control-expose-headers"]).toBe("X-Science-Artifact-Sha256");
    expect(await fs.readdir(f.cwd)).toEqual([]);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXOYAAAAASUVORK5CYII=", "base64");
    const image = { ...artifact, name: "plot.png", mediaType: "image/png" as const, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
    f.host.readArtifact.mockResolvedValueOnce({ availability: "ready", artifact: image, content: png } as never);
    const picture = await f.get(`/${TASK}/artifacts/${ARTIFACT}`); expect(picture.statusCode).toBe(200); expect(picture.rawPayload).toEqual(png); expect(picture.headers["content-type"]).toBe("image/png");
  });

  it("fails closed for malformed host data and integrity failures without forwarding raw errors", async () => {
    const f = await setup();
    f.host.list.mockResolvedValueOnce({ availability: "ready", instances: [{ ...summary, id: "http://private/?nonce=secret" }] } as never);
    expect((await f.get()).json()).toEqual({ availability: "unknown", reason: "invalid-host-response" });
    f.host.detail.mockResolvedValueOnce({ availability: "ready", instance: { ...detail, id: "si-00000000-0000-4000-8000-000000000099" } });
    expect((await f.get(`/${TASK}`)).json()).toEqual({ availability: "unknown", reason: "invalid-host-response" });
    for (const value of [
      { availability: "ready", artifact, content: Buffer.from("wrong") },
      { availability: "ready", artifact: { ...artifact, mediaType: "text/html" }, content },
      { availability: "ready", artifact: { ...artifact, mediaType: "image/png" }, content },
      { availability: "ready", artifact: { ...artifact, name: "../../secret" }, content },
      { availability: "ready", artifact: { ...artifact, bytes: 1024 * 1024 + 1 }, content: Buffer.alloc(1024 * 1024 + 1) },
    ]) { f.host.readArtifact.mockResolvedValueOnce(value as never); const result = await f.get(`/${TASK}/artifacts/${ARTIFACT}`); expect(result.statusCode).toBe(503); expect(result.body).not.toContain("secret"); }
    f.host.list.mockRejectedValueOnce(new Error("http://private/?nonce=secret"));
    const offline = await f.get(); expect(offline.json()).toEqual({ availability: "unknown", reason: "host-offline" }); expect(offline.body).not.toMatch(/private|nonce|secret/);
  });
});
