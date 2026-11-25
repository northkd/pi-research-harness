import path from 'node:path';
import os from 'node:os';
import { readTrustJson, normalizeMirrorConfig } from './index.mjs';
import { safePiTrustKey, mirrorDenyRules, isMirrorDenied, nearestRecordedEntry, coverSnapshot } from './upstream.mjs';

const ACTIVATION = Symbol.for('pi-research-host.project-trust-activation');
export function captureTrustActivation(env = process.env, holder = process, cwd = process.cwd()) {
  const enabled = env.PI_RESEARCH_HOST_TRUST_ACTIVATION === '1';
  delete env.PI_RESEARCH_HOST_TRUST_ACTIVATION;
  holder[ACTIVATION] ??= { managed: enabled, activationCwd: cwd };
  return holder[ACTIVATION];
}

function trustFile(agentDir) {
  try {
    const value = readTrustJson(path.join(agentDir, 'trust.json'), { privateMode: false });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unreadable' };
    const data = {};
    for (const [key, decision] of Object.entries(value)) {
      if (decision === null) continue;
      if (decision !== true && decision !== false) return { kind: 'unreadable' };
      data[key] = decision;
    }
    return { kind: 'ok', data };
  } catch (error) { return { kind: error.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
}

function snapshot(file) {
  const value = readTrustJson(file);
  if (value?.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.entries)) return null;
  const kinds = new Set(['worktreeInit', 'workflow', 'pinned', 'folderWorkspaces', 'accessGrants']);
  return { version: 1, generation: value.generation, entries: value.entries.filter(entry => entry && typeof entry.key === 'string'
    && path.isAbsolute(entry.key) && kinds.has(entry.sourceKind) && typeof entry.dev === 'string' && typeof entry.ino === 'string'
    && (entry.birthtimeMs === undefined || typeof entry.birthtimeMs === 'number')
    && (entry.configRoot === undefined || typeof entry.configRoot === 'string')
    && (entry.hookHash === undefined || typeof entry.hookHash === 'string')) };
}

/** Per-event reads, exact activation cwd, recorded Pi decisions always take precedence. */
export function decideProjectTrust({ eventCwd, activationCwd, managed = false, headless = false,
  home = os.homedir(), agentDir, mirrorConfig, snapshotFile, denyRules = mirrorDenyRules }) {
  try {
    const key = typeof eventCwd === 'string' ? safePiTrustKey(eventCwd, home) : null;
    if (!key) return { trusted: 'undecided' };
    const recorded = trustFile(agentDir);
    if (recorded.kind === 'unreadable' || recorded.kind === 'ok' && nearestRecordedEntry(recorded.data, key)) return { trusted: 'undecided' };
    const deny = () => denyRules({ homedir: home });
    if (managed && headless && safePiTrustKey(activationCwd, home) === key) {
      return isMirrorDenied(key, deny()) ? { trusted: 'undecided' } : { trusted: 'yes', remember: false };
    }
    const config = normalizeMirrorConfig(mirrorConfig);
    if (!config.enabled || !(managed && headless || config.coverInteractive)) return { trusted: 'undecided' };
    return coverSnapshot(snapshot(snapshotFile), key).covered ? { trusted: 'yes', remember: false } : { trusted: 'undecided' };
  } catch { return { trusted: 'undecided' }; }
}

/** Call synchronously from the globally installed native extension, before its first await. */
export function registerPiTrust(pi, { home = os.homedir(), stateDir = process.env.PI_RESEARCH_HOST_DIR ?? path.join(home, '.pi/research-host'),
  activationCwd, managed, headless = process.argv.some((value, index) => value === '--mode' && process.argv[index + 1] === 'rpc'),
  readConfiguration, ...options } = {}) {
  const activation = captureTrustActivation();
  activationCwd ??= activation.activationCwd;
  managed ??= activation.managed;
  if (!stateDir || !path.isAbsolute(stateDir)) return () => {};
  const readConfig = readConfiguration ?? (() => readTrustJson(path.join(stateDir, 'config.json'), { maxBytes: 65536 }));
  return pi.on('project_trust', (event, ctx) => {
    try {
      const config = readConfig();
      let eventCwd;
      try { eventCwd = typeof event?.cwd === 'string' ? event.cwd : typeof ctx?.cwd === 'string' ? ctx.cwd : undefined; }
      catch { return { trusted: 'undecided' }; }
      const overrideAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
      const selectedAgentDir = overrideAgentDir ?? config.agentDir ?? path.join(home, '.pi/agent');
      const agentDir = selectedAgentDir === '~' ? home : selectedAgentDir.startsWith('~/') ? path.join(home, selectedAgentDir.slice(2)) : selectedAgentDir;
      return decideProjectTrust({ ...options, eventCwd, activationCwd, managed, headless, home, agentDir,
        mirrorConfig: config.piTrustMirror, snapshotFile: config.piTrustMirrorSnapshotFile ?? path.join(stateDir, 'legacy/pi-trust-mirror.json') });
    } catch { return { trusted: 'undecided' }; }
  });
}
