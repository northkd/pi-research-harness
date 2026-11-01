#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNativeTsLoader } from "@blackbelt-technology/pi-dashboard-shared/platform/ts-loader-select.mjs";

const entry = fileURLToPath(new URL("./science-host-main.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", resolveNativeTsLoader({ anchor: import.meta.url }), entry, ...process.argv.slice(2)], { stdio: ["ignore", "inherit", "pipe"] });
let reported = false;
child.stderr.on("data", () => { if (!reported) { reported = true; process.stderr.write("science-host-child-unavailable\n"); } });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { child.kill(signal); });
child.once("error", () => { process.stderr.write("science-host-launch-unavailable\n"); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
