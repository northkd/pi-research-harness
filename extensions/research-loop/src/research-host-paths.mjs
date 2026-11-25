import os from 'node:os';
import path from 'node:path';

function absoluteDirectory(value, error) {
  if (value !== undefined && (!path.isAbsolute(value) || path.normalize(value) !== value || value === '/')) {
    throw new Error(error);
  }
  return value;
}

/** Stage the host independently. Existing Pi sessions use their current data
 * and credentials until an operator explicitly switches the launcher. */
export function researchHostPaths({ home = os.homedir(), env = process.env } = {}) {
  const configured = absoluteDirectory(env.PI_RESEARCH_HOST_DIR, 'invalid-research-host-directory');
  const stateDir = configured ?? path.join(home, '.pi', 'dashboard');
  const legacyWorkbench = configured === undefined ? undefined : absoluteDirectory(env.PI_RESEARCH_WORKBENCH_DIR, 'invalid-research-workbench-directory');
  const accessMode = configured === undefined ? undefined
    : absoluteDirectory(env.PI_RESEARCH_ACCESS_MODE_STORE_DIR, 'invalid-research-access-mode-directory');
  const taskPermission = configured === undefined ? undefined
    : absoluteDirectory(env.PI_RESEARCH_TASK_PERMISSION_STORE_DIR, 'invalid-research-task-permission-directory');
  return {
    stateDir,
    authBoundary: configured === undefined ? home : path.dirname(stateDir),
    configFile: path.join(stateDir, 'config.json'),
    tokenFile: path.join(stateDir, 'local', 'token'),
    workbenchDir: legacyWorkbench ?? path.join(stateDir, 'res-workflow'),
    accessModeStoreDir: accessMode ?? path.join(stateDir, 'research-access-modes'),
    taskPermissionStoreDir: taskPermission ?? path.join(stateDir, 'research-task-permissions'),
  };
}
