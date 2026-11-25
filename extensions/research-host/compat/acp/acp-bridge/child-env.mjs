import { spawn as nodeSpawn } from "../shared/platform/exec.mjs";
const ALLOWED = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "TZ",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "ComSpec",
  "PATHEXT"
]);
const FORBIDDEN_CONFIGURED = [/^PI_/, /^ELECTRON_/, /^NODE_OPTIONS$/];
const isAllowed = (key) => ALLOWED.has(key) || key.startsWith("LC_");
function buildAgentEnv(adapterEnv, configured = {}) {
  const env = {};
  for (const [k, v] of Object.entries(adapterEnv)) {
    if (v !== void 0 && isAllowed(k)) env[k] = v;
  }
  const warnings = [];
  for (const [k, v] of Object.entries(configured)) {
    if (FORBIDDEN_CONFIGURED.some((re) => re.test(k))) {
      warnings.push(`acp agent env key "${k}" is not passed to the agent (reserved)`);
    } else env[k] = v;
  }
  return { env, warnings };
}
function assertLaunchable(command, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    throw new Error(`ACP agent command "${command}" requires a shell (.cmd/.bat); configure the .exe instead`);
  }
}
function launchAgentProcess(o) {
  assertLaunchable(o.agent.command, o.platform);
  const { env, warnings } = buildAgentEnv(o.adapterEnv ?? process.env, o.agent.env);
  for (const w of warnings) o.warn?.(w);
  return (o.spawn ?? nodeSpawn)(o.agent.command, o.agent.args ?? [], {
    cwd: o.cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}
export {
  assertLaunchable,
  buildAgentEnv,
  launchAgentProcess
};
