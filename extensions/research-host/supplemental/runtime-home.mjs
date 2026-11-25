import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';

const runtime = new AsyncLocalStorage();

export function withSupplementalEnvironment(environment, operation) {
  if (!path.isAbsolute(environment.homeDir) || !path.isAbsolute(environment.hostDir)) throw new Error('supplemental-absolute-home-required');
  return runtime.run(environment, operation);
}

export function supplementalHomeDir() { return runtime.getStore()?.homeDir || os.homedir(); }
export function supplementalHostDir() { return runtime.getStore()?.hostDir || process.env.PI_RESEARCH_HOST_DIR || path.join(supplementalHomeDir(), '.pi', 'research-host'); }
