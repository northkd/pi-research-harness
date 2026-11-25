import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeLocalHost, readLocalHostConfig } from '../extensions/research-host/config.mjs';
import { repositoryRoot } from './configure.mjs';

const root = repositoryRoot;
const install = path.join(root, '.runtime/pi');
const dependencies = path.join(install, 'node_modules');
const version = JSON.parse(fs.readFileSync(path.join(dependencies, '@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('pi-runtime-version-invalid');

const release = path.join(install, 'releases', version);
fs.mkdirSync(release, { recursive: true, mode: 0o700 });
const link = path.join(release, 'node_modules');
try { fs.symlinkSync(dependencies, link, 'dir'); }
catch (error) { if (error.code !== 'EEXIST' || fs.realpathSync(link) !== fs.realpathSync(dependencies)) throw error; }
const selected = path.join(install, 'current-version');
try { fs.writeFileSync(selected, version + '\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST' || fs.readFileSync(selected, 'utf8').trim() !== version) throw error; }

const agentDir = fs.realpathSync(process.env.PI_RESEARCH_AGENT_DIR ?? path.join(os.homedir(), '.local/share/pi-research-harness/agent'));
const stateDir = path.resolve(process.env.PI_RESEARCH_HOST_DIR ?? path.join(root, '.runtime/host'));
const port = Number(process.env.PI_RESEARCH_HOST_PORT ?? 18768);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('research-host-port-invalid');
const options = {
  port, agentDir, sessionsDir: path.join(agentDir, 'sessions'),
  piCommand: path.resolve(process.env.PI_RESEARCH_PI_BIN ?? path.join(dependencies, '.bin/pi')),
  managedInstallRoot: install,
  researchLoopRoot: path.join(root, 'extensions/research-loop'),
  mainlineCore: path.join(root, 'extensions/mainline-supervision/src/core.mjs'), enableMcp: true,
};
if (fs.existsSync(path.join(stateDir, 'config.json'))) {
  const existing = readLocalHostConfig(stateDir);
  if (Object.entries(options).some(([key, value]) => existing[key] !== value)) throw new Error('research-host-settings-conflict');
} else initializeLocalHost(stateDir, options);

console.log(JSON.stringify({ standaloneHost: stateDir, port }));
