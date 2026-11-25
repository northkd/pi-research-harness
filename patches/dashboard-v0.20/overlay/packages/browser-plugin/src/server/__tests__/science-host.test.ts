import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDashboardConfigDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import { createScienceChrome } from "../science-host.js";

describe("public host-only Science browser seam", () => {
  it("resolves through the package's explicit public science-host export", () => {
    expect(createRequire(import.meta.url).resolve("@blackbelt-technology/pi-dashboard-browser-plugin/science-host")).toBe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../science-host.ts"));
  });
  it("injects a distinct private profile without starting Chrome or registering a generic relay", () => {
    const spawn = vi.fn();
    const chrome = createScienceChrome("/tmp/fixture-science-private", { resolveBinary: () => null, spawn });
    expect(chrome.dataDir).toBe("/tmp/fixture-science-private/agent-chrome");
    expect(chrome.downloadsDir).toBe("/tmp/fixture-science-private/agent-chrome-downloads");
    expect(spawn).not.toHaveBeenCalled();
    expect(() => createScienceChrome("relative", { resolveBinary: () => null })).toThrow("science-private-directory-required");
    expect(() => createScienceChrome(getDashboardConfigDir(), { resolveBinary: () => null })).toThrow("science-private-directory-required");
  });
});
