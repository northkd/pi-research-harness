import path from "node:path";
import { getDashboardConfigDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import { DedicatedChrome, type DedicatedChromeDeps } from "./dedicated/chrome-process.js";

/** Separate profile/pipe; never register this Chrome with the generic relay manager. */
export function createScienceChrome(privateDir: string, deps: Omit<DedicatedChromeDeps, "getDashboardConfigDir">): DedicatedChrome {
  if (!path.isAbsolute(privateDir) || privateDir.includes("\0") || path.resolve(privateDir) === path.resolve(getDashboardConfigDir())) throw new Error("science-private-directory-required");
  return new DedicatedChrome({ ...deps, getDashboardConfigDir: () => privateDir });
}
export type { DedicatedChromeDeps } from "./dedicated/chrome-process.js";
