import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { supplementalConfigurationFromLegacy } from '../supplemental/state-compat.mjs';
import { localHostSettings } from '../config.mjs';

const DEFAULT_PORT = 18768;
const BRIDGES = Object.freeze([
  ['dashboard-automation', 'pi-dashboard-automation-plugin'],
  ['dashboard-flows', 'pi-dashboard-flows-plugin'],
  ['dashboard-goal', 'pi-dashboard-goal-plugin'],
  ['dashboard-flows-anthropic-bridge', 'pi-dashboard-flows-anthropic-bridge-plugin'],
]);
const PACKAGE_NAMES = new Set(['pi-agent-dashboard', 'pi-dashboard-extension', ...BRIDGES.map(([, packageName]) => packageName)]);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byteDigest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function preparedText(value, original, sourceText) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (sourceText !== undefined) {
    if (typeof sourceText !== 'string' || JSON.stringify(JSON.parse(sourceText)) !== JSON.stringify(original)) fail('configuration-source-text-mismatch');
  }
  return { text, contentSha256: byteDigest(text), ...(sourceText === undefined ? {} : { sourceSha256: byteDigest(sourceText) }) };
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value === '/') fail('configuration-path-invalid');
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function canonicalExisting(value, directory) {
  absolute(value);
  const info = fs.lstatSync(value);
  if (info.isSymbolicLink() || fs.realpathSync(value) !== value || (directory ? !info.isDirectory() : !info.isFile())) fail('configuration-existing-path-not-canonical');
  return value;
}

function plannedPath(value) {
  absolute(value);
  let ancestor = value;
  for (;;) {
    try {
      const info = fs.lstatSync(ancestor);
      if (info.isSymbolicLink() || fs.realpathSync(ancestor) !== ancestor) fail('configuration-planned-path-not-canonical');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return value;
}

export function knownDashboardRegistrations({ homeDir = os.homedir(), projectRoot = path.join(homeDir, '.local/share/pi-research') } = {}) {
  absolute(homeDir); absolute(projectRoot);
  const modules = path.join(projectRoot, 'dashboard/node_modules/@blackbelt-technology');
  const sources = [path.join(modules, 'pi-agent-dashboard/packages/extension'), path.join(modules, 'pi-dashboard-extension')];
  const bridges = BRIDGES.map(([id, packageName]) => ({ id, source: packageName === 'pi-dashboard-goal-plugin'
    ? path.join(homeDir, '.pi/dashboard/plugins/goal/src/bridge/index.ts')
    : path.join(modules, packageName, 'src/bridge/index.ts') }));
  sources.push(...bridges.map(bridge => bridge.source));
  return { sources, bridges, packageNames: [...PACKAGE_NAMES] };
}

function knownSource(source, catalog) {
  if (typeof source !== 'string') return false;
  const value = source.startsWith('-') ? source.slice(1) : source;
  if (catalog.sources.includes(value)) return true;
  const npm = /^(?:npm:)?@blackbelt-technology\/([a-z0-9-]+)(?:@[^/\s]+)?$/.exec(value);
  return !!npm && catalog.packageNames.includes(npm[1]);
}

/** Remove exact old registrations while retaining custom resources and options. */
export function derivePiSettings(settings, { catalog = knownDashboardRegistrations(), nativeExtensionPath, sourceText } = {}) {
  if (!object(settings) || !Array.isArray(catalog.sources) || !Array.isArray(catalog.packageNames)) fail('configuration-settings-invalid');
  const next = copy(settings), removed = [];
  for (const section of ['packages', 'extensions']) {
    if (next[section] === undefined) continue;
    if (!Array.isArray(next[section])) fail('configuration-settings-resource-list-invalid');
    next[section] = next[section].filter(entry => {
      const source = typeof entry === 'string' ? entry : object(entry) ? entry.source : undefined;
      if (!knownSource(source, catalog)) return true;
      removed.push({ section, source });
      return false;
    });
  }
  if (next.dashboardPluginBridges !== undefined) {
    if (!object(next.dashboardPluginBridges)) fail('configuration-settings-bridge-map-invalid');
    for (const [id, source] of Object.entries(next.dashboardPluginBridges)) {
      if (knownSource(source, catalog)) { delete next.dashboardPluginBridges[id]; removed.push({ section: 'dashboardPluginBridges', id, source }); }
    }
    if (Object.keys(next.dashboardPluginBridges).length === 0) delete next.dashboardPluginBridges;
  }
  if (next._dashboardManagedPackages !== undefined) {
    if (!object(next._dashboardManagedPackages)) fail('configuration-settings-managed-map-invalid');
    for (const [source, id] of Object.entries(next._dashboardManagedPackages)) {
      if (knownSource(source, catalog)) { delete next._dashboardManagedPackages[source]; removed.push({ section: '_dashboardManagedPackages', id, source }); }
    }
    if (Object.keys(next._dashboardManagedPackages).length === 0) delete next._dashboardManagedPackages;
  }
  if (nativeExtensionPath !== undefined) {
    absolute(nativeExtensionPath);
    if (knownSource(nativeExtensionPath, catalog)) fail('configuration-new-extension-is-dashboard-source');
    next.extensions ??= [];
    if (!next.extensions.includes(nativeExtensionPath)) next.extensions.push(nativeExtensionPath);
  }
  return { settings: next, removed, inputSha256: digest(settings), outputSha256: digest(next), ...preparedText(next, settings, sourceText) };
}

function oldMcpUrl(value, expected) {
  if (typeof value !== 'string') return false;
  try {
    const candidate = new URL(value), reference = new URL(expected);
    return candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1' && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.href === reference.href;
  } catch { return false; }
}

/** Static old Dashboard MCP registration is optional; new per-session credentials are host-owned. */
export function deriveMcpConfiguration(configuration, { removeObsoleteDashboardEntry = false, legacyUrl = 'http://127.0.0.1:8000/mcp', sourceText } = {}) {
  if (!object(configuration) || configuration.mcpServers !== undefined && !object(configuration.mcpServers)) fail('configuration-mcp-invalid');
  const next = copy(configuration), entry = next.mcpServers?.['pi-dashboard'];
  let removed = false;
  if (removeObsoleteDashboardEntry && object(entry) && oldMcpUrl(entry.url, legacyUrl)) { delete next.mcpServers['pi-dashboard']; removed = true; }
  return { configuration: next, removed, inputSha256: digest(configuration), outputSha256: digest(next), ...preparedText(next, configuration, sourceText) };
}

export function prepareHostConfiguration({ legacyConfig, legacyPreferences, homeDir = os.homedir(), projectRoot = path.join(homeDir, '.local/share/pi-research'), hostRoot = path.join(projectRoot, 'research-host'), stateDir = path.join(homeDir, '.pi/research-host'), workbenchDir = path.join(homeDir, '.pi/dashboard/res-workflow'), researchLoopRoot = path.join(projectRoot, 'research-loop'), piCommand = path.join(homeDir, '.local/bin/pi'), port = DEFAULT_PORT, enableMcp = true, checkFilesystem = true } = {}) {
  if (!object(legacyConfig) || !object(legacyPreferences) || !Array.isArray(legacyPreferences.pinnedDirectories) || !legacyPreferences.pinnedDirectories.every(cwd => typeof cwd === 'string')) fail('configuration-legacy-input-invalid');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof enableMcp !== 'boolean') fail('configuration-host-options-invalid');
  for (const value of [homeDir, projectRoot, hostRoot, stateDir, workbenchDir, researchLoopRoot, piCommand]) absolute(value);
  const legacyCodeRoot = path.join(projectRoot, 'dashboard');
  if (inside(legacyCodeRoot, hostRoot) || inside(hostRoot, legacyCodeRoot) || inside(legacyCodeRoot, stateDir) || inside(legacyCodeRoot, researchLoopRoot)) fail('configuration-dashboard-code-dependency');
  const originalWorkbench = path.join(homeDir, '.pi/dashboard/res-workflow');
  if (workbenchDir !== originalWorkbench) fail('configuration-sealed-workbench-identity-changed');
  const sessionsDir = absolute(legacyConfig.piSessionsDir ?? path.join(homeDir, '.pi/agent/sessions'));
  const agentDir = path.join(homeDir, '.pi/agent');
  const mainlineCore = path.join(projectRoot, 'mainline-supervision/src/core.mjs');
  const knownCwds = [...new Set(legacyPreferences.pinnedDirectories.map(absolute))];
  const attachments = path.join(homeDir, '.pi/dashboard/attachments');
  const accessGrantsFile = path.join(homeDir, '.pi/dashboard/access-grants.json');
  const piTrustMirrorSnapshotFile = path.join(homeDir, '.pi/dashboard/pi-trust-mirror.json');
  const piTrustMirrorOverridesFile = path.join(homeDir, '.pi/dashboard/pi-trust-overrides.json');
  if (checkFilesystem) {
    canonicalExisting(workbenchDir, true); canonicalExisting(sessionsDir, true); canonicalExisting(agentDir, true);
    canonicalExisting(researchLoopRoot, true); canonicalExisting(mainlineCore, false);
    for (const cwd of knownCwds) canonicalExisting(cwd, true);
    plannedPath(hostRoot); plannedPath(stateDir);
    const resolvedCommand = fs.realpathSync(piCommand);
    canonicalExisting(resolvedCommand, false);
    if (inside(legacyCodeRoot, resolvedCommand)) fail('configuration-dashboard-code-dependency');
  }
  const config = localHostSettings({
    bindHost: '127.0.0.1', port, sessionsDir, piCommand, knownCwds,
    workbenchDir, researchLoopRoot, agentDir, mainlineCore, enableMcp,
    legacyAttachmentRoots: !checkFilesystem || fs.existsSync(attachments) ? [attachments] : [],
    legacyHostPidFile: path.join(homeDir, '.pi/dashboard/server.pid'),
    managedInstallRoot: path.join(agentDir, 'install'),
    ...(Array.isArray(legacyConfig.publicBaseUrls) ? {
      publicBaseUrls: legacyConfig.publicBaseUrls.filter(value => typeof value === 'string'),
    } : {}),
    ...(fs.existsSync(path.join(homeDir, '.pi/dashboard/remote-transcripts')) ? {
      legacyRetentionDir: path.join(homeDir, '.pi/dashboard/remote-transcripts'),
    } : {}),
    ...supplementalConfigurationFromLegacy(legacyConfig),
    ...(!checkFilesystem || fs.existsSync(accessGrantsFile) ? { accessGrantsFile } : {}),
    accessModeStoreDir: path.join(homeDir, '.pi/dashboard/research-access-modes'),
    taskPermissionStoreDir: path.join(homeDir, '.pi/dashboard/research-task-permissions'),
    ...(object(legacyConfig.agentPathGate) ? { agentPathGate: copy(legacyConfig.agentPathGate) } : {}),
    ...(object(legacyConfig.piTrustMirror) ? {
      piTrustMirror: copy(legacyConfig.piTrustMirror), piTrustMirrorSnapshotFile, piTrustMirrorOverridesFile,
    } : {}),
    ...(typeof legacyConfig.defaultModel === 'string' ? { defaultModel: legacyConfig.defaultModel } : {}),
    ...(typeof legacyConfig.defaultThinkingLevel === 'string' ? { defaultThinkingLevel: legacyConfig.defaultThinkingLevel } : {}),
    ...(object(legacyConfig.acp) ? { acp: copy(legacyConfig.acp) } : {}),
    ...(Array.isArray(legacyConfig.acpAgents) ? { acpAgents: copy(legacyConfig.acpAgents) } : {}),
  });
  const initOptions = copy(config);
  return { config, stateDir, hostRoot, initOptions, configSha256: digest(config), ...preparedText(config),
    credentialFiles: { config: path.join(stateDir, 'config.json'), token: path.join(stateDir, 'local/token') },
    nativeExtensionPath: path.join(hostRoot, 'native-extension.mjs'),
    preservedRuntimeRoots: [workbenchDir, sessionsDir],
    pendingChecks: [
      'Initialize fresh host credentials with initOptions and verify the complete config against the expected new-file hash.',
      'Verify deployed server/native-extension/flow-bridge files and their independent dependency paths.',
      'Verify CLI and subagent auth use the new host config/token and that host/client access-mode and task-permission stores agree.',
      'Run cold CLI resource loading and native session registration using the cleaned settings.',
      'Recheck old dispatch, sync and session writers are stopped, and confirm exact old PID identities remain ended.',
      'Validate old workbench connection and sealed history plans in the original canonical workbenchDir.',
      'Retest new UI chat, prompt receipts, exact confirmation IDs, cursor replay and service restart recovery.',
      'Switch Caddy upstream and credential injection together, then verify HTTPS and per-session MCP authorization.',
      'Check one active scheduler owns the shared workbench and preserve a verified rollback configuration before deleting old code.',
    ],
  };
}
