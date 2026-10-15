// Resolve installed test/SDK dependencies without using an author's machine paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repositoryRoot = path.resolve(packageRoot, '../..');
export const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || process.env.PI_RESEARCH_AGENT_DIR || path.join(os.homedir(), '.local/share/pi-research-harness/agent'));
function packageAt(candidates, name) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const root = fs.realpathSync(candidate);
      if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === name) return root;
    } catch { /* Try the next explicit/standard install candidate, never download. */ }
  }
  throw new Error(`Missing ${name}; install the pinned runtime or set PI_RESEARCH_HOST_ROOT / PI_RESEARCH_SUBAGENTS_ROOT. No automatic install or model fallback.`);
}
export const host = packageAt([
  process.env.PI_RESEARCH_HOST_ROOT,
  path.join(repositoryRoot, '.runtime/pi/node_modules/@earendil-works/pi-coding-agent'),
], '@earendil-works/pi-coding-agent');
export const subagentsRoot = packageAt([
  process.env.PI_RESEARCH_SUBAGENTS_ROOT,
  path.join(agentDir, 'npm/node_modules/pi-subagents'),
], 'pi-subagents');
const jitiPath = packageAt([
  process.env.PI_RESEARCH_JITI_ROOT,
  path.join(subagentsRoot, 'node_modules/jiti'),
  path.join(path.dirname(subagentsRoot), 'jiti'),
], 'jiti');
const { createJiti } = await import(pathToFileURL(path.join(jitiPath, 'lib/jiti.mjs')).href);
const { resolveHostPeerAliases } = await import(pathToFileURL(path.join(subagentsRoot, 'src/runs/background/runner-aliases.js')).href);
const peer = resolveHostPeerAliases(host);
if (peer.missing.length) throw new Error('Installed Pi peer aliases missing: ' + peer.missing.join(', '));
export const hostLoader = createJiti(import.meta.url, { alias: peer.aliases, tryNative: false, interopDefault: false, moduleCache: false });
export const loadAdapter = () => hostLoader.import(path.join(packageRoot, 'src/index.ts'));
export const loadRpcBridge = () => hostLoader.import(path.join(subagentsRoot, 'src/extension/rpc.js'));
