import { run, unwrap } from "./runner.js";
const NPM_TIMEOUT_FAST = 1e4;
const NPM_TIMEOUT_INSTALL = 12e4;
const NPM_ROOT_GLOBAL = {
  argv: () => ["npm", "root", "-g"],
  parse: (out) => out.trim(),
  timeout: NPM_TIMEOUT_FAST
};
const NPM_OUTDATED = {
  argv: ({ pkg }) => pkg === void 0 ? ["npm", "outdated", "--json"] : ["npm", "outdated", pkg, "--json"],
  parse: (out) => {
    const trimmed = out.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  },
  timeout: NPM_TIMEOUT_FAST,
  tolerate: [1]
};
const NPM_OUTDATED_GLOBAL = {
  argv: ({ pkg }) => pkg === void 0 ? ["npm", "outdated", "-g", "--json"] : ["npm", "outdated", "-g", pkg, "--json"],
  parse: (out) => {
    const trimmed = out.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  },
  timeout: NPM_TIMEOUT_FAST,
  tolerate: [1]
};
const NPM_INSTALL = {
  argv: ({ pkg, version }) => ["npm", "install", version ? `${pkg}@${version}` : pkg],
  parse: (out) => out,
  timeout: NPM_TIMEOUT_INSTALL
};
const NPM_INSTALL_GLOBAL = {
  argv: ({ pkg, version }) => ["npm", "install", "-g", version ? `${pkg}@${version}` : pkg],
  parse: (out) => out,
  timeout: NPM_TIMEOUT_INSTALL
};
const NPM_VIEW_VERSION = {
  argv: ({ pkg }) => ["npm", "view", pkg, "version"],
  parse: (out) => out.trim(),
  timeout: NPM_TIMEOUT_FAST
};
const NPM_RECIPES = {
  NPM_ROOT_GLOBAL,
  NPM_OUTDATED,
  NPM_OUTDATED_GLOBAL,
  NPM_INSTALL,
  NPM_INSTALL_GLOBAL,
  NPM_VIEW_VERSION
};
function rootGlobal() {
  return run(NPM_ROOT_GLOBAL, {}, {});
}
function _resetNpmRootCache() {
}
function outdated(input) {
  return run(NPM_OUTDATED, input, { cwd: input.cwd });
}
function outdatedGlobal(input = {}) {
  return run(NPM_OUTDATED_GLOBAL, input, {});
}
function install(input) {
  return run(NPM_INSTALL, input, { cwd: input.cwd });
}
function installGlobal(input) {
  return run(NPM_INSTALL_GLOBAL, input, {});
}
function viewVersion(input) {
  return run(NPM_VIEW_VERSION, input, {});
}
function rootGlobalOr(fallback = "") {
  return unwrap(rootGlobal(), fallback);
}
function outdatedOr(input, fallback = null) {
  return unwrap(outdated(input), fallback);
}
function outdatedGlobalOr(input = {}, fallback = null) {
  return unwrap(outdatedGlobal(input), fallback);
}
function viewVersionOr(input, fallback = "") {
  return unwrap(viewVersion(input), fallback);
}
export {
  NPM_INSTALL,
  NPM_INSTALL_GLOBAL,
  NPM_OUTDATED,
  NPM_OUTDATED_GLOBAL,
  NPM_RECIPES,
  NPM_ROOT_GLOBAL,
  NPM_VIEW_VERSION,
  _resetNpmRootCache,
  install,
  installGlobal,
  outdated,
  outdatedGlobal,
  outdatedGlobalOr,
  outdatedOr,
  rootGlobal,
  rootGlobalOr,
  viewVersion,
  viewVersionOr
};
