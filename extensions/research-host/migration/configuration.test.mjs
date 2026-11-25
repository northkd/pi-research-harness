import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { knownDashboardRegistrations, derivePiSettings, deriveMcpConfiguration, prepareHostConfiguration } from './configuration.mjs';
import { assertLegacyHostStopped, initializeLocalHost } from '../config.mjs';

const paths = { homeDir: '/synthetic/home', projectRoot: '/synthetic/project' };
const catalog = knownDashboardRegistrations(paths);

test('removes known Dashboard paths while preserving user packages, skills, model, options and custom maps', () => {
  const input = {
    packages: ['npm:pi-subagents@0.79.2', { source: catalog.sources[0], skills: ['explicit/**'] }, '/synthetic/project/integration',
      { source: 'npm:user-dashboard-helper@1.0', extensions: ['owned.ts'] }],
    extensions: ['-builtin:mcp', ...catalog.bridges.map(item => item.source), '/user/retained.ts'],
    skills: ['-excluded/SKILL.md', '/custom/skills'], defaultProvider: 'custom', defaultModel: 'custom/real-model',
    compaction: { reserveTokens: 12345 }, userExtra: { nested: [{ native: true }] },
    dashboardPluginBridges: { ...Object.fromEntries(catalog.bridges.map(item => [item.id, item.source])), userBridge: '/user/bridge.ts', 'dashboard-custom': '/user/other.ts' },
    _dashboardManagedPackages: { ...Object.fromEntries(catalog.bridges.map(item => [item.source, item.id])), '/user/managed.ts': 'user-managed' },
  };
  const original = structuredClone(input);
  const result = derivePiSettings(input, { catalog });
  assert.deepEqual(input, original);
  assert.equal(result.removed.length, 13);
  assert.deepEqual(result.settings.packages, [input.packages[0], input.packages[2], input.packages[3]]);
  assert.deepEqual(result.settings.extensions, ['-builtin:mcp', '/user/retained.ts']);
  for (const field of ['skills', 'defaultProvider', 'defaultModel', 'compaction', 'userExtra']) assert.deepEqual(result.settings[field], input[field]);
  assert.deepEqual(result.settings.dashboardPluginBridges, { userBridge: '/user/bridge.ts', 'dashboard-custom': '/user/other.ts' });
  assert.deepEqual(result.settings._dashboardManagedPackages, { '/user/managed.ts': 'user-managed' });
});

test('versioned known npm registrations and disabled old bridges are recognized exactly', () => {
  const input = { packages: ['npm:@blackbelt-technology/pi-agent-dashboard@0.10.0', 'npm:@blackbelt-technology/pi-dashboard-extension',
    'npm:@blackbelt-technology/pi-dashboard-unrelated@1.0', '/custom/dashboard'] , extensions: ['-' + catalog.bridges[0].source] };
  const { settings } = derivePiSettings(input, { catalog });
  assert.deepEqual(settings.packages, input.packages.slice(2));
  assert.deepEqual(settings.extensions, []);
});

test('optional standalone native extension is added once without a Dashboard source', () => {
  const nativeExtensionPath = '/synthetic/project/research-host/native-extension.mjs';
  const first = derivePiSettings({ extensions: ['-builtin:mcp'] }, { catalog, nativeExtensionPath }).settings;
  const second = derivePiSettings(first, { catalog, nativeExtensionPath }).settings;
  assert.deepEqual(first, second);
  assert.equal(first.extensions.at(-1), nativeExtensionPath);
  assert.throws(() => derivePiSettings({}, { catalog, nativeExtensionPath: catalog.bridges[0].source }), { code: 'configuration-new-extension-is-dashboard-source' });
});

test('prepared text has exact byte hashes and refuses a mismatching source snapshot', () => {
  const settings = { extensions: ['-builtin:mcp', catalog.bridges[0].source], skills: ['/user/skill'] };
  const sourceText = JSON.stringify(settings, null, 4) + '\n';
  const result = derivePiSettings(settings, { catalog, sourceText });
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.deepEqual(JSON.parse(result.text), result.settings);
  assert.equal(result.contentSha256, hash(result.text));
  assert.equal(result.sourceSha256, hash(sourceText));
  assert.throws(() => derivePiSettings(settings, { catalog, sourceText: '{}' }), { code: 'configuration-source-text-mismatch' });
});

test('unknown bridge sources retain their original settings even with a historical Dashboard key', () => {
  const input = { dashboardPluginBridges: { 'dashboard-goal': '/user/replacement-goal.ts' }, _dashboardManagedPackages: { '/user/replacement-goal.ts': 'dashboard-goal' } };
  assert.deepEqual(derivePiSettings(input, { catalog }).settings, input);
  assert.throws(() => derivePiSettings({ packages: {} }, { catalog }), { code: 'configuration-settings-resource-list-invalid' });
});

test('obsolete MCP removal is opt-in and exact, with all other user server settings preserved', () => {
  const input = { mcpServers: { 'pi-dashboard': { url: 'http://127.0.0.1:8000/mcp', protocolVersion: '2026-07-28' },
    'research-browser': { command: 'node', args: ['private-local-browser'], env: { RETAIN: 'yes' } }, other: { url: 'https://user.example/mcp' } }, customSetting: true };
  assert.deepEqual(deriveMcpConfiguration(input).configuration, input);
  const result = deriveMcpConfiguration(input, { removeObsoleteDashboardEntry: true });
  assert.equal(result.removed, true);
  assert.equal(Object.hasOwn(result.configuration.mcpServers, 'pi-dashboard'), false);
  assert.deepEqual(result.configuration.mcpServers['research-browser'], input.mcpServers['research-browser']);
  assert.equal(result.configuration.customSetting, true);
  const custom = { mcpServers: { 'pi-dashboard': { url: 'http://127.0.0.1:9090/user-mcp' } } };
  assert.deepEqual(deriveMcpConfiguration(custom, { removeObsoleteDashboardEntry: true }).configuration, custom);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-prepare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const homeDir = path.join(directory, 'home'), projectRoot = path.join(directory, 'project');
  const sessionsDir = path.join(homeDir, '.pi/agent/sessions'), workbenchDir = path.join(homeDir, '.pi/dashboard/res-workflow');
  const first = path.join(directory, 'first-project'), second = path.join(directory, 'second-project');
  for (const file of [sessionsDir, workbenchDir, path.join(projectRoot, 'research-loop'), path.join(projectRoot, 'mainline-supervision/src'), first, second]) fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projectRoot, 'mainline-supervision/src/core.mjs'), 'export class MainlineStore {}');
  const piCommand = path.join(homeDir, 'pi'); fs.writeFileSync(piCommand, '#!/bin/sh\n');
  const legacyConfig = { piSessionsDir: sessionsDir, bindHost: '0.0.0.0', port: 8000, automation: { maxRunAgeMs: 12345 }, unrelated: { private: 'never-copy-into-runtime' } };
  const legacyPreferences = { pinnedDirectories: [first, second, first], favoriteModels: ['preserved-in-preferences'] };
  return { directory, homeDir, projectRoot, piCommand, legacyConfig, legacyPreferences, sessionsDir, workbenchDir, first, second };
}

test('host config retains canonical legacy workbench and pinned cwd order using independent runtime paths', t => {
  const f = fixture(t), before = structuredClone(f.legacyConfig);
  const result = prepareHostConfiguration(f);
  assert.equal(result.config.bindHost, '127.0.0.1'); assert.equal(result.config.port, 18768);
  assert.equal(result.config.workbenchDir, f.workbenchDir); assert.equal(result.config.sessionsDir, f.sessionsDir);
  assert.deepEqual(result.config.knownCwds, [f.first, f.second]);
  assert.equal(result.config.researchLoopRoot, path.join(f.projectRoot, 'research-loop'));
  assert.equal(result.config.mainlineCore, path.join(f.projectRoot, 'mainline-supervision/src/core.mjs'));
  assert.equal(result.nativeExtensionPath, path.join(f.projectRoot, 'research-host/native-extension.mjs'));
  assert.deepEqual(result.config.plugins, {});
  assert.equal(result.config.askUserPromptTimeoutSeconds, 300);
  assert.equal(Object.hasOwn(result.config, 'automation'), false);
  assert.equal(Object.hasOwn(result.config, 'token'), false); assert.equal(Object.hasOwn(result.config, 'unrelated'), false);
  assert.deepEqual(f.legacyConfig, before);
  assert.equal(fs.existsSync(result.stateDir), false); assert.equal(fs.existsSync(result.hostRoot), false);
  assert.ok(result.pendingChecks.length > 0);
});

test('moving sealed workbench identity, using executable Dashboard paths and missing pinned roots are rejected', t => {
  const f = fixture(t);
  assert.throws(() => prepareHostConfiguration({ ...f, workbenchDir: path.join(f.directory, 'copied-workbench') }), { code: 'configuration-sealed-workbench-identity-changed' });
  assert.throws(() => prepareHostConfiguration({ ...f, hostRoot: path.join(f.projectRoot, 'dashboard/research-host') }), { code: 'configuration-dashboard-code-dependency' });
  assert.throws(() => prepareHostConfiguration({ ...f, legacyPreferences: { pinnedDirectories: [path.join(f.directory, 'missing')] } }), { code: 'ENOENT' });
  fs.mkdirSync(path.join(f.projectRoot, 'dashboard'));
  fs.writeFileSync(path.join(f.projectRoot, 'dashboard/pi'), 'synthetic');
  fs.unlinkSync(f.piCommand); fs.symlinkSync(path.join(f.projectRoot, 'dashboard/pi'), f.piCommand);
  assert.throws(() => prepareHostConfiguration(f), { code: 'configuration-dashboard-code-dependency' });
});

test('source read-only preparation permits an independent managed Pi launcher symlink', t => {
  const f = fixture(t), real = path.join(f.homeDir, '.pi/agent/pi-launcher');
  fs.writeFileSync(real, 'synthetic launcher'); fs.unlinkSync(f.piCommand); fs.symlinkSync(real, f.piCommand);
  assert.equal(prepareHostConfiguration(f).config.piCommand, f.piCommand);
});

test('initialization publishes the exact prepared config bytes and independently generates a token', t => {
  const f = fixture(t);
  const prepared = prepareHostConfiguration(f);
  const initialized = initializeLocalHost(prepared.stateDir, prepared.initOptions);
  assert.equal(fs.readFileSync(prepared.credentialFiles.config, 'utf8'), prepared.text);
  assert.match(initialized.token, /^[a-zA-Z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(JSON.parse(prepared.text), 'token'), false);
});

test('live legacy writer prevents opening the shared workbench', t => {
  const f = fixture(t);
  const pidFile = prepareHostConfiguration(f).config.legacyHostPidFile;
  assert.doesNotThrow(() => assertLegacyHostStopped(pidFile));
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o644 });
  assert.throws(() => assertLegacyHostStopped(pidFile), /legacy-research-host-still-writing/);
  fs.writeFileSync(pidFile, 'unconfirmed');
  assert.throws(() => assertLegacyHostStopped(pidFile), /legacy-research-host-pid-file-invalid/);
});
