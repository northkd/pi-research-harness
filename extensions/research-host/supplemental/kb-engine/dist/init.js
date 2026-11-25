import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULTS, globalConfigPath, projectConfigPath, validateConfig } from "./config.js";
function buildInitConfig(sources = []) {
  return { ...DEFAULTS, sources };
}
function renderConfig(c) {
  return JSON.stringify(c, null, 2);
}
function ensureGitignore(dbPath, cwd) {
  const abs = isAbsolute(dbPath) ? dbPath : resolve(cwd, dbPath);
  if (!abs.startsWith(cwd)) return null;
  const rel = abs.slice(cwd.length + 1);
  const entry = `/${rel}`;
  const giPath = join(cwd, ".gitignore");
  let existing = "";
  if (existsSync(giPath)) existing = readFileSync(giPath, "utf8");
  if (existing.includes(entry)) return { path: giPath, added: "" };
  appendFileSync(giPath, (existing && !existing.endsWith("\n") ? "\n" : "") + `
# kb knowledge base index
${entry}
`);
  return { path: giPath, added: entry };
}
function kbInit(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.global ? globalConfigPath() : projectConfigPath(cwd);
  const sources = (opts.sources ?? []).map((ref) => ({ kind: "filesystem", ref }));
  const cfg = buildInitConfig(sources);
  validateConfig(cfg, opts.global ? "global" : "project");
  const dbPath = cfg.dbPath;
  const gitignorePath = opts.global ? null : join(cwd, ".gitignore");
  if (existsSync(configPath) && !opts.force) {
    if (opts.dryRun) {
      return { configPath, dbPath, gitignorePath, gitignoreAdded: null, sources, wrote: false };
    }
    throw new Error(`${configPath} already exists \u2014 pass --force to overwrite`);
  }
  if (opts.dryRun) {
    console.log(`# dry-run: would write ${configPath}`);
    console.log(renderConfig(cfg));
    return { configPath, dbPath, gitignorePath, gitignoreAdded: null, sources, wrote: false };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, renderConfig(cfg) + "\n", "utf8");
  let gitignoreAdded = null;
  if (!opts.global) {
    const gi = ensureGitignore(dbPath, cwd);
    if (gi) gitignoreAdded = gi.added || null;
  }
  return { configPath, dbPath, gitignorePath, gitignoreAdded, sources, wrote: true };
}
export {
  buildInitConfig,
  kbInit,
  renderConfig
};
