import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_PORT = 18768;
export const ROLLOUT_PAUSE_FILE = 'rollout-paused.json';

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || fs.realpathSync(directory) !== directory || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('research-host-private-directory-required');
  }
  return directory;
}

export function hostStateDir(env = process.env, home = os.homedir()) {
  const dir = env.PI_RESEARCH_HOST_DIR ?? path.join(home, '.pi', 'research-host');
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || dir === '/') {
    throw new Error('invalid-research-host-directory');
  }
  return dir;
}

function readPrivate(file, maxBytes, forbiddenMode = 0o077) {
  if (fs.realpathSync(file) !== file) throw new Error('unsafe-research-host-file');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & forbiddenMode) !== 0 || info.size > maxBytes || info.uid !== process.getuid?.()) {
      throw new Error('unsafe-research-host-file');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally { fs.closeSync(descriptor); }
}

export function readLocalHostConfig(stateDir = hostStateDir()) {
  const config = JSON.parse(readPrivate(path.join(stateDir, 'config.json'), 65_536));
  if (config?.bindHost !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      typeof config.sessionsDir !== 'string' || !path.isAbsolute(config.sessionsDir) ||
      typeof config.piCommand !== 'string' || !path.isAbsolute(config.piCommand) ||
      (config.knownCwds !== undefined && (!Array.isArray(config.knownCwds) || !config.knownCwds.every(dir => typeof dir === 'string' && path.isAbsolute(dir))))) {
    throw new Error('invalid-research-host-config');
  }
  const token = readPrivate(path.join(stateDir, 'local/token'), 4096).trim();
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new Error('invalid-research-host-token');
  return { ...config, stateDir, token };
}

export function assertLegacyHostStopped(pidFile) {
  if (pidFile === undefined) return;
  if (typeof pidFile !== 'string' || !path.isAbsolute(pidFile) || path.normalize(pidFile) !== pidFile) {
    throw new Error('legacy-research-host-pid-file-invalid');
  }
  let text;
  try { text = readPrivate(pidFile, 256, 0o022).trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const pid = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid < 2) throw new Error('legacy-research-host-pid-file-invalid');
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw new Error('legacy-research-host-still-writing');
}

export function localHostSettings(options = {}) {
  const config = {
    bindHost: '127.0.0.1',
    port: options.port ?? DEFAULT_PORT,
    sessionsDir: options.sessionsDir ?? path.join(os.homedir(), '.pi/agent/sessions'),
    piCommand: options.piCommand ?? path.join(os.homedir(), '.local/bin/pi'),
    ...(options.knownCwds ? { knownCwds: options.knownCwds } : {}),
  };
  for (const field of ['workbenchDir', 'agentDir', 'researchLoopRoot', 'mainlineCore', 'nativeRoots',
    'legacyAttachmentRoots', 'enableMcp', 'plugins', 'questions', 'askUserPromptTimeoutSeconds',
    'agentPathGate', 'accessModeStoreDir', 'taskPermissionStoreDir', 'accessGrantsFile', 'piTrustMirror', 'piTrustMirrorSnapshotFile',
    'piTrustMirrorOverridesFile', 'defaultModel', 'defaultThinkingLevel', 'legacyHostPidFile', 'legacyRetentionDir',
    'publicBaseUrls', 'managedInstallRoot', 'acp', 'acpAgents', 'pollMs']) {
    if (options[field] !== undefined) config[field] = options[field];
  }
  return config;
}

/** Initialize a standalone config. Existing settings and tokens keep their owner. */
export function initializeLocalHost(stateDir = hostStateDir(), options = {}) {
  privateDirectory(stateDir);
  privateDirectory(path.join(stateDir, 'local'));
  const config = localHostSettings(options);
  const configFile = path.join(stateDir, 'config.json');
  const tokenFile = path.join(stateDir, 'local/token');
  for (const [file, content] of [[configFile, JSON.stringify(config, null, 2)], [tokenFile, randomBytes(32).toString('base64url')]]) {
    try { fs.writeFileSync(file, content + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return readLocalHostConfig(stateDir);
}
