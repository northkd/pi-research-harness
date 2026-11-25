import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hostStateDir, readLocalHostConfig } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const management = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);

if (args[0] === 'host') {
  const { runCli } = await import('./cli/main.mjs');
  process.exitCode = await runCli(args.slice(1));
} else {
  const config = readLocalHostConfig();
  const environment = {
    ...process.env,
    PI_CODING_AGENT_DIR: config.agentDir ?? path.join(os.homedir(), '.pi/agent'),
    PI_RESEARCH_LOOP_ROOT: config.researchLoopRoot ?? path.resolve(here, '../research-loop'),
    PI_RESEARCH_HOST_DIR: hostStateDir(),
    PI_RESEARCH_WORKBENCH_DIR: config.workbenchDir ?? path.join(config.stateDir, 'res-workflow'),
    PI_RESEARCH_ACCESS_MODE_STORE_DIR: config.accessModeStoreDir ?? path.join(config.stateDir, 'research-access-modes'),
    PI_RESEARCH_TASK_PERMISSION_STORE_DIR: config.taskPermissionStoreDir ?? path.join(config.stateDir, 'research-task-permissions'),
    ...(config.enableMcp === true ? { PI_RESEARCH_HOST_MCP: '1' } : {}),
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_BG_DOCK_SHORTCUT: process.env.PI_BG_DOCK_SHORTCUT ?? 'off',
  };
  const nativeArgs = management.has(args[0]) ? args : ['-e', path.join(here, 'native-extension.mjs'), ...args];
  process.execve(config.piCommand, [config.piCommand, ...nativeArgs], environment);
}
