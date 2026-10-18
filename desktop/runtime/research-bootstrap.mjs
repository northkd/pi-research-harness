import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const BUNDLE_SCHEMA = 'pi-research-desktop.bundle.v1';
export const PROFILE_SCHEMA = 'pi-research-desktop.profile.v1';
export const DEFAULT_PORT = 18400;
export const DEFAULT_PI_PORT = 18401;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function json(bytes, label) {
  try { return object(JSON.parse(bytes.toString('utf8')), label); }
  catch (error) { throw new Error(`Cannot read valid ${label}: ${error.message}`); }
}

function readOptional(file) {
  try {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refuse non-regular profile file: ${file}`);
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function checkDirectory(dir) {
  try {
    const info = fs.lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refuse non-directory or linked profile path: ${dir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Manifest paths are relative to Resources and may never escape that tree. */
function resource(root, relative, label) {
  if (typeof relative !== 'string' || !relative || /^[\\/]|^[a-z]:/i.test(relative)) {
    throw new Error(`Invalid relative resource path for ${label}`);
  }
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => part === '..' || part === '' || part === '.')) {
    throw new Error(`Invalid relative resource path for ${label}`);
  }
  const candidate = path.join(root, ...parts);
  let actual;
  try { actual = fs.realpathSync(candidate); }
  catch { throw new Error(`Missing bundled ${label}: ${relative}`); }
  if (!inside(root, actual)) throw new Error(`Bundled ${label} resolves outside Resources`);
  return candidate;
}

function portNumber(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${label}: expected an integer between 1 and 65535`);
  return value;
}

function sourceOf(entry) {
  return typeof entry === 'string' ? entry : entry?.source;
}

function replaceSource(entry, source) {
  return typeof entry === 'string' ? source : {...entry, source};
}

function encoded(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

/** Rebase only recorded application paths; user removals and filters survive updates. */
function rebaseEntries(entries, previous, current) {
  if (!Array.isArray(entries)) return entries;
  const previousByPath = new Map(Object.entries(previous).map(([id, value]) => [value, id]));
  const currentByPath = new Map(Object.entries(current).map(([id, value]) => [value, id]));
  const result = [];
  for (const entry of entries) {
    const original = sourceOf(entry);
    const disabled = typeof original === 'string' && original.startsWith('-');
    const source = disabled ? original.slice(1) : original;
    const id = previousByPath.get(source) ?? currentByPath.get(source);
    if (id === undefined) { result.push(entry); continue; }
    // A package removed from the release may only be removed if this app owned it.
    if (!(id in current)) continue;
    result.push(replaceSource(entry, `${disabled ? '-' : ''}${current[id]}`));
  }
  return result;
}

function updatedBridgeSettings(settings, previous, current) {
  if (settings.dashboardPluginBridges && typeof settings.dashboardPluginBridges === 'object') {
    settings.dashboardPluginBridges = {...settings.dashboardPluginBridges};
    for (const [id, oldSource] of Object.entries(previous)) {
      if (settings.dashboardPluginBridges[id] !== oldSource) continue;
      if (current[id]) settings.dashboardPluginBridges[id] = current[id];
      else delete settings.dashboardPluginBridges[id];
    }
  }
  if (settings._dashboardManagedPackages && typeof settings._dashboardManagedPackages === 'object') {
    settings._dashboardManagedPackages = {...settings._dashboardManagedPackages};
    for (const [id, oldSource] of Object.entries(previous)) {
      if (settings._dashboardManagedPackages[oldSource] !== id) continue;
      delete settings._dashboardManagedPackages[oldSource];
      if (current[id]) settings._dashboardManagedPackages[current[id]] = id;
    }
  }
}

/** Write beside the destination; detect concurrent edits before replacing it. */
function commitFile(file, bytes, before) {
  const now = readOptional(file);
  if ((before === null) !== (now === null) || (before !== null && !before.equals(now))) {
    throw new Error(`Profile changed during initialization; retry: ${file}`);
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, {flag: 'wx', mode: 0o600});
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * Prepare this application's isolated research profile without installing packages.
 *
 * dataDir is <app.userData>/research, resourcesDir is Electron's Resources directory.
 * All Pi and extension dependencies must already be physically included in the bundle.
 * Explicit ports apply to this launch. Existing dashboard preferences remain untouched.
 * readOnly computes the same result without creating or modifying any files.
 */
export function initializeResearchProfile({dataDir, resourcesDir, port, piPort, readOnly = false} = {}) {
  if (!path.isAbsolute(dataDir ?? '') || !path.isAbsolute(resourcesDir ?? '')) {
    throw new Error('Use absolute dataDir and resourcesDir paths');
  }
  const profileRoot = path.resolve(dataDir);
  const resourcesRoot = fs.realpathSync(resourcesDir);
  if (inside(resourcesRoot, profileRoot) || inside(profileRoot, resourcesRoot)) {
    throw new Error('Keep the writable profile and application Resources in separate directories');
  }
  const agentDir = path.join(profileRoot, 'agent');
  const dashboardDir = path.join(profileRoot, 'dashboard');
  const agentsDir = path.join(agentDir, 'agents');
  for (const dir of [profileRoot, agentDir, dashboardDir, agentsDir]) checkDirectory(dir);

  const manifestPath = resource(resourcesRoot, 'research-bundle.json', 'bundle manifest');
  const manifest = json(fs.readFileSync(manifestPath), 'bundle manifest');
  if (manifest.schema !== BUNDLE_SCHEMA || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Unsupported research bundle manifest');
  }
  const harnessDir = resource(resourcesRoot, manifest.harnessPath ?? 'harness', 'research harness');
  const bridgeDir = resource(resourcesRoot, manifest.bridgePath ?? 'server/packages/extension', 'dashboard bridge');
  resource(resourcesRoot, `${manifest.bridgePath ?? 'server/packages/extension'}/package.json`, 'dashboard bridge manifest');
  const templatePath = path.join(harnessDir, 'config', 'settings.example.json');
  const template = json(fs.readFileSync(templatePath), 'research settings template');
  if (!Array.isArray(template.packages)) throw new Error('Research settings template has no packages array');
  const packageIndex = new Map();
  if (!Array.isArray(manifest.packages)) throw new Error('Bundle manifest has no packages array');
  for (const pkg of manifest.packages) {
    object(pkg, 'bundled package');
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || packageIndex.has(pkg.name)) {
      throw new Error('Invalid or duplicate bundled package identity');
    }
    const directory = resource(resourcesRoot, pkg.path, `package ${pkg.name}`);
    const actual = json(fs.readFileSync(path.join(directory, 'package.json')), `manifest for ${pkg.name}`);
    if (actual.name !== pkg.name || actual.version !== pkg.version) throw new Error(`Bundled package/version mismatch: ${pkg.name}`);
    packageIndex.set(pkg.name, {...pkg, directory});
  }

  const packagePaths = {};
  const defaultPackages = template.packages.map(entry => {
    const source = sourceOf(entry);
    const match = typeof source === 'string' && /^npm:((?:@[^/\s]+\/)?[^@\s]+)@([^@\s]+)$/.exec(source);
    if (!match) throw new Error('Research settings template requires exact npm package sources');
    const pkg = packageIndex.get(match[1]);
    if (!pkg || pkg.version !== match[2]) throw new Error(`Required released package is absent or mismatched: ${source}`);
    packagePaths[`npm:${pkg.name}`] = pkg.directory;
    return replaceSource(entry, pkg.directory);
  });
  packagePaths.harness = harnessDir;
  packagePaths.dashboard = bridgeDir;
  defaultPackages.push(harnessDir, bridgeDir);

  const pluginBridges = {};
  for (const [id, relative] of Object.entries(manifest.pluginBridges ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid dashboard plugin bridge id');
    pluginBridges[id] = resource(resourcesRoot, relative, `plugin bridge ${id}`);
    packagePaths[`bridge:${id}`] = pluginBridges[id];
    defaultPackages.push(pluginBridges[id]);
  }
  const skillPaths = {};
  for (const relative of ['vendor/skills/aris', 'vendor/skills/licensed']) {
    const candidate = path.join(harnessDir, relative);
    if (fs.existsSync(candidate)) skillPaths[relative] = resource(resourcesRoot, `${manifest.harnessPath ?? 'harness'}/${relative}`, relative);
  }
  for (const relative of ['vendor/skills/aris/paper-writing/SKILL.md', 'vendor/skills/aris/research-review/SKILL.md']) {
    if (fs.existsSync(path.join(harnessDir, relative))) {
      skillPaths[`exclude:${relative}`] = resource(resourcesRoot, `${manifest.harnessPath ?? 'harness'}/${relative}`, relative);
    }
  }
  const defaultSkills = Object.entries(skillPaths).map(([id, source]) => `${id.startsWith('exclude:') ? '-' : ''}${source}`);

  const settingsPath = path.join(agentDir, 'settings.json');
  const configPath = path.join(dashboardDir, 'config.json');
  const mcpPath = path.join(agentDir, 'mcp.json');
  const statePath = path.join(profileRoot, 'profile-state.json');
  const settingsBefore = readOptional(settingsPath);
  const configBefore = readOptional(configPath);
  const mcpBefore = readOptional(mcpPath);
  const stateBefore = readOptional(statePath);
  const previous = stateBefore ? json(stateBefore, 'research profile state') : null;
  if (previous && previous.schema !== PROFILE_SCHEMA) throw new Error('Unsupported research profile state');
  if (settingsBefore && !previous) {
    throw new Error('Existing research settings have no application ownership record; choose a new dedicated profile directory');
  }

  const config = configBefore ? json(configBefore, 'dashboard configuration') : {
    bindHost: '127.0.0.1', port: port ?? DEFAULT_PORT, piPort: piPort ?? DEFAULT_PI_PORT,
    tunnel: {enabled: false}, spawnStrategy: 'headless', autoStart: false,
  };
  const effectivePort = portNumber(port ?? config.port ?? DEFAULT_PORT, 'dashboard port');
  const effectivePiPort = portNumber(piPort ?? config.piPort ?? DEFAULT_PI_PORT, 'Pi gateway port');
  if (effectivePort === effectivePiPort) throw new Error('Dashboard and Pi gateway must use distinct ports');
  let settings;
  if (settingsBefore) {
    settings = json(settingsBefore, 'research settings');
    if (!Array.isArray(settings.packages)) throw new Error('Existing research settings require a packages array');
    settings.packages = rebaseEntries(settings.packages, previous.packages ?? {}, packagePaths);
    if (Array.isArray(settings.skills)) settings.skills = rebaseEntries(settings.skills, previous.skills ?? {}, skillPaths);
    updatedBridgeSettings(settings, previous.pluginBridges ?? {}, pluginBridges);
  } else {
    settings = {...template, packages: defaultPackages, extensions: ['-builtin:mcp']};
    if (defaultSkills.length) settings.skills = defaultSkills;
    if (Object.keys(pluginBridges).length) {
      settings.dashboardPluginBridges = pluginBridges;
      settings._dashboardManagedPackages = Object.fromEntries(Object.entries(pluginBridges).map(([id, source]) => [source, id]));
    }
  }

  const mcpUrl = `http://127.0.0.1:${effectivePort}/mcp`;
  const mcp = mcpBefore ? json(mcpBefore, 'research MCP configuration') : {mcpServers: {'pi-dashboard': {url: mcpUrl}}};
  let ownedMcpUrl = mcpBefore ? previous?.mcpUrl ?? null : mcpUrl;
  if (ownedMcpUrl && mcp.mcpServers?.['pi-dashboard']?.url === ownedMcpUrl) {
    mcp.mcpServers['pi-dashboard'].url = mcpUrl;
    ownedMcpUrl = mcpUrl;
  }
  const state = {schema: PROFILE_SCHEMA, version: manifest.version, packages: packagePaths, skills: skillPaths, pluginBridges, mcpUrl: ownedMcpUrl};
  const writes = [];
  const plan = (file, bytes, before = readOptional(file)) => {
    if (before === null || !before.equals(bytes)) writes.push({file, bytes, before});
  };
  // The first ownership record precedes settings, so interrupted initialization is recoverable.
  if (!previous) plan(statePath, encoded(state), stateBefore);
  plan(settingsPath, encoded(settings), settingsBefore);
  if (!configBefore) plan(configPath, encoded(config), null);
  plan(mcpPath, encoded(mcp), mcpBefore);
  for (const name of ['AGENTS.md', 'models.example.json']) {
    const target = path.join(agentDir, name);
    if (readOptional(target) === null) plan(target, fs.readFileSync(path.join(harnessDir, 'config', name)), null);
  }
  const roleRoot = path.join(harnessDir, 'agents');
  for (const entry of fs.readdirSync(roleRoot, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const target = path.join(agentsDir, entry.name);
    if (readOptional(target) === null) plan(target, fs.readFileSync(path.join(roleRoot, entry.name)), null);
  }
  if (previous) plan(statePath, encoded(state), stateBefore);

  const created = [];
  const updated = [];
  if (!readOnly) {
    for (const dir of [profileRoot, agentDir, dashboardDir, agentsDir]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    for (const write of writes) {
      commitFile(write.file, write.bytes, write.before);
      (write.before === null ? created : updated).push(write.file);
    }
  }
  return {
    dataDir: profileRoot, agentDir, dashboardDir, settingsPath, configPath, mcpPath,
    harnessDir, bridgeDir, config, port: effectivePort, piPort: effectivePiPort,
    created, updated, readOnly, pendingChanges: readOnly ? writes.map(write => write.file) : [],
    environment: {
      PI_RESEARCH_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_RESEARCH_DASHBOARD_DIR: dashboardDir,
      PI_RESEARCH_RESOURCE_ROOT: harnessDir,
      PI_DASHBOARD_HOST: '127.0.0.1',
      PI_DASHBOARD_PORT: String(effectivePort),
      PI_DASHBOARD_PI_PORT: String(effectivePiPort),
      PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_BG_DOCK_SHORTCUT: 'off',
    },
  };
}
