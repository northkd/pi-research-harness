import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveInstalledResearchLoopRoot } from "../res-workflow/adoption-service.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

it("loads the exact backend selected by the portable launcher", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "research-backend-")));
  temporary.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pi-research-loop-local" }));
  vi.stubEnv("PI_RESEARCH_LOOP_ROOT", root);
  expect(await resolveInstalledResearchLoopRoot()).toBe(root);
});

it("rejects a relative path, another package, or a linked backend without fallback", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "research-backend-")));
  temporary.push(root);
  const linked = path.join(root, "linked"), target = path.join(root, "target");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "pi-research-loop-local" }));
  await fs.symlink(target, linked);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "unrelated-package" }));
  for (const candidate of ["relative/research-loop", root, linked, path.join(root, "missing")]) {
    vi.stubEnv("PI_RESEARCH_LOOP_ROOT", candidate);
    await expect(resolveInstalledResearchLoopRoot()).rejects.toMatchObject({ code: "research-backend-unavailable", statusCode: 503 });
  }
});
