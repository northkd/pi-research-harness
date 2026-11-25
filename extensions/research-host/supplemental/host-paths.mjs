import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supplementalHomeDir, supplementalHostDir } from './runtime-home.mjs';

export function loadConfig() {
  const directory = supplementalHostDir();
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') config = {}; else throw error; }
  return {
    ...config,
    // The extracted billing implementation uses the original field name.
    piSessionsDir: config.sessionsDir ?? config.piSessionsDir,
    // The original full config loader supplied this empty-list default.
    acpAgents: Array.isArray(config.acpAgents) ? config.acpAgents : [],
  };
}

export function resolvePiSessionsDir(options = {}) {
  const home = options.homedir || supplementalHomeDir();
  const expand = value => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const result = value.trim();
    return result.startsWith('~/') ? path.join(home, result.slice(2)) : result;
  };
  const agent = expand(options.agentDirEnv ?? process.env.PI_CODING_AGENT_DIR);
  return expand(options.piSessionsDir)
    ?? expand(options.sessionDirEnv ?? process.env.PI_CODING_AGENT_SESSION_DIR)
    ?? (agent ? path.join(agent, 'sessions') : path.join(home, '.pi', 'agent', 'sessions'));
}
