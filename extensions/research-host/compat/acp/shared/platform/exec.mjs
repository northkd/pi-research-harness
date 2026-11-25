import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  exec as nodeExec,
  execFile as nodeExecFile,
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn
} from "node:child_process";
function buildSafeArgv(cmd, args = [], platform = process.platform) {
  if (platform === "win32") {
    const isShim = /\.(cmd|bat)$/i.test(cmd);
    const hasExtension = /\.[A-Za-z0-9]+$/.test(cmd);
    if (isShim || !hasExtension) {
      return {
        argv: ["cmd.exe", "/d", "/s", "/c", cmd, ...args],
        spawnOptions: { shell: false, windowsHide: true }
      };
    }
  }
  return {
    argv: [cmd, ...args],
    spawnOptions: { shell: false, windowsHide: true }
  };
}
function withHide(opts) {
  const hide = opts?.windowsHide ?? true;
  return { ...opts ?? {}, windowsHide: hide };
}
function execSync(command, options) {
  return nodeExecSync(command, withHide(options));
}
function execFileSync(file, args, options) {
  return nodeExecFileSync(file, args ?? [], withHide(options));
}
function spawnSync(command, args, options) {
  return nodeSpawnSync(command, args ?? [], withHide(options));
}
function exec(command, optionsOrCallback, maybeCallback) {
  if (typeof optionsOrCallback === "function") {
    return nodeExec(command, withHide(void 0), optionsOrCallback);
  }
  return nodeExec(command, withHide(optionsOrCallback), maybeCallback);
}
function execFile(file, args, optionsOrCallback, maybeCallback) {
  if (typeof optionsOrCallback === "function") {
    return nodeExecFile(file, args ?? [], withHide(void 0), optionsOrCallback);
  }
  return nodeExecFile(file, args ?? [], withHide(optionsOrCallback), maybeCallback);
}
function spawn(command, args, options) {
  return nodeSpawn(command, args ?? [], withHide(options));
}
function settle(resolve, reject) {
  return (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr }));
    else resolve({ stdout, stderr });
  };
}
function execAsync(command, options) {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: "utf8", ...options }, settle(resolve, reject));
  });
}
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args ?? [], { encoding: "utf8", ...options }, settle(resolve, reject));
  });
}
export {
  buildSafeArgv,
  exec,
  execAsync,
  execFile,
  execFileAsync,
  execFileSync,
  execSync,
  spawn,
  spawnSync
};
