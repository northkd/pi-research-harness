import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {BUNDLE_SCHEMA, DEFAULT_PI_PORT, DEFAULT_PORT, initializeResearchProfile} from '../runtime/research-bootstrap.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Compare fingerprints so a failed assertion can never print credential-bearing environment values.
const environmentFingerprint = () => createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex');
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function bundle(resourcesDir, {version = '0.1.0'} = {}) {
  write(path.join(resourcesDir, 'harness/config/settings.example.json'), {
    enableInstallTelemetry: false,
    defaultThinkingLevel: 'max',
    compaction: {enabled: true, reserveTokens: 16384},
    packages: [
      'npm:pi-subagents@0.76.1',
      {source: 'npm:@example/science@1.2.3', skills: ['skills/**', '!skills/private/**'], extensions: []},
    ],
  });
  write(path.join(resourcesDir, 'harness/config/AGENTS.md'), '# Research rules\n');
  write(path.join(resourcesDir, 'harness/config/models.example.json'), {providers: {}});
  write(path.join(resourcesDir, 'harness/agents/research-critic.md'), '# Critic\n');
  write(path.join(resourcesDir, 'harness/agents/research-worker.md'), '# Worker\n');
  write(path.join(resourcesDir, 'harness/vendor/skills/aris/paper-writing/SKILL.md'), '# Bundled wrapper exclusion\n');
  write(path.join(resourcesDir, 'harness/vendor/skills/aris/research-review/SKILL.md'), '# Review wrapper exclusion\n');
  write(path.join(resourcesDir, 'harness/vendor/skills/licensed/example/SKILL.md'), '# Licensed skill\n');
  write(path.join(resourcesDir, 'harness/package.json'), {name: 'pi-research-harness', version});
  const packages = [
    {name: 'pi-subagents', version: '0.76.1', path: 'harness/node_modules/pi-subagents'},
    {name: '@example/science', version: '1.2.3', path: 'harness/node_modules/@example/science'},
  ];
  for (const pkg of packages) write(path.join(resourcesDir, pkg.path, 'package.json'), {name: pkg.name, version: pkg.version});
  write(path.join(resourcesDir, 'server/packages/extension/package.json'), {name: '@blackbelt-technology/pi-dashboard-extension', version: '0.8.0'});
  write(path.join(resourcesDir, 'server/resources/plugins/goal-plugin/src/bridge/index.ts'), 'export default () => {};\n');
  write(path.join(resourcesDir, 'research-bundle.json'), {
    schema: BUNDLE_SCHEMA, version, harnessPath: 'harness', bridgePath: 'server/packages/extension', packages,
    pluginBridges: {'dashboard-goal': 'server/resources/plugins/goal-plugin/src/bridge/index.ts'},
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-profile-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const resourcesDir = path.join(root, 'Resources');
  const dataDir = path.join(root, 'userData', 'research');
  bundle(resourcesDir);
  return {root, resourcesDir, dataDir};
}

test('first launch uses packaged dependencies, preserves filters, and never changes process HOME', t => {
  const f = fixture(t);
  const processBefore = environmentFingerprint();
  const result = initializeResearchProfile(f);
  assert.equal(result.port, DEFAULT_PORT);
  assert.equal(result.piPort, DEFAULT_PI_PORT);
  assert.equal(environmentFingerprint(), processBefore);
  assert.equal('HOME' in result.environment, false);
  assert.equal('USERPROFILE' in result.environment, false);
  assert.equal(result.environment.PI_CODING_AGENT_DIR, path.join(f.dataDir, 'agent'));
  assert.equal(result.environment.PI_RESEARCH_DASHBOARD_DIR, path.join(f.dataDir, 'dashboard'));
  assert.equal(result.environment.PI_DASHBOARD_HOST, '127.0.0.1');
  assert.equal(result.environment.PI_TELEMETRY, '0');
  const settings = readJson(result.settingsPath);
  assert.equal(settings.packages[0], path.join(f.resourcesDir, 'harness/node_modules/pi-subagents'));
  assert.deepEqual(settings.packages[1], {
    source: path.join(f.resourcesDir, 'harness/node_modules/@example/science'),
    skills: ['skills/**', '!skills/private/**'], extensions: [],
  });
  assert.deepEqual(settings.extensions, ['-builtin:mcp']);
  assert.ok(settings.packages.includes(path.join(f.resourcesDir, 'harness')));
  assert.ok(settings.packages.includes(path.join(f.resourcesDir, 'server/packages/extension')));
  assert.equal(settings.skills.filter(entry => entry.startsWith('-')).length, 2);
  assert.equal(readJson(result.configPath).tunnel.enabled, false);
  assert.equal(readJson(result.mcpPath).mcpServers['pi-dashboard'].url, `http://127.0.0.1:${DEFAULT_PORT}/mcp`);
  assert.equal(fs.existsSync(path.join(result.agentDir, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(result.agentDir, 'models.json')), false);
  assert.equal(fs.readFileSync(path.join(result.agentDir, 'agents/research-critic.md'), 'utf8'), '# Critic\n');
});

test('a second launch makes zero changes and does not regenerate user-owned data', t => {
  const f = fixture(t);
  const initial = initializeResearchProfile(f);
  const authFile = path.join(initial.agentDir, 'auth.json');
  const modelFile = path.join(initial.agentDir, 'models.json');
  const roleFile = path.join(initial.agentDir, 'agents/research-worker.md');
  write(authFile, '{ "local-test-provider": { "type": "api_key", "key": "offline-test-placeholder" } }\n');
  write(modelFile, '{ "providers": { "local-model": { "baseUrl": "http://127.0.0.1:9" } } }\n');
  write(roleFile, '# My custom worker\n');
  const before = [authFile, modelFile, roleFile].map(file => fs.readFileSync(file));
  const again = initializeResearchProfile(f);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.updated, []);
  assert.deepEqual([authFile, modelFile, roleFile].map(file => fs.readFileSync(file)), before);
});

test('moving/upgrading the application rebases only its owned paths', t => {
  const f = fixture(t);
  const initial = initializeResearchProfile(f);
  const settings = readJson(initial.settingsPath);
  // A user removed one default extension and customized filters/model selection.
  settings.packages.shift();
  settings.packages[0].skills = ['skills/selected/**'];
  settings.packages.push('/my/custom-extension', 'npm:my-own-package@9.8.7');
  settings.defaultModel = 'my-provider/my-model';
  settings.extensions.push('/my/optional-extension.ts');
  settings.skills.push('/my/custom-skills');
  write(initial.settingsPath, settings);
  write(path.join(initial.agentDir, 'AGENTS.md'), '# My own project policy\n');
  const movedResources = path.join(f.root, 'New App', 'Resources');
  bundle(movedResources, {version: '0.2.0'});
  const upgraded = initializeResearchProfile({...f, resourcesDir: movedResources});
  const updated = readJson(upgraded.settingsPath);
  assert.equal(updated.packages[0].source, path.join(movedResources, 'harness/node_modules/@example/science'));
  assert.deepEqual(updated.packages[0].skills, ['skills/selected/**']);
  assert.equal(updated.packages.some(entry => String(typeof entry === 'string' ? entry : entry.source).endsWith('pi-subagents')), false);
  assert.ok(updated.packages.includes('/my/custom-extension'));
  assert.ok(updated.packages.includes('npm:my-own-package@9.8.7'));
  assert.equal(updated.defaultModel, 'my-provider/my-model');
  assert.ok(updated.extensions.includes('/my/optional-extension.ts'));
  assert.ok(updated.skills.includes('/my/custom-skills'));
  assert.equal(updated.dashboardPluginBridges['dashboard-goal'], path.join(movedResources, 'server/resources/plugins/goal-plugin/src/bridge/index.ts'));
  assert.equal(updated._dashboardManagedPackages[updated.dashboardPluginBridges['dashboard-goal']], 'dashboard-goal');
  assert.equal(fs.readFileSync(path.join(initial.agentDir, 'AGENTS.md'), 'utf8'), '# My own project policy\n');
  assert.equal(readJson(path.join(f.dataDir, 'profile-state.json')).version, '0.2.0');
});

test('disabled managed paths remain disabled after an application move', t => {
  const f = fixture(t);
  const initial = initializeResearchProfile(f);
  const settings = readJson(initial.settingsPath);
  settings.packages[0] = `-${settings.packages[0]}`;
  write(initial.settingsPath, settings);
  const moved = path.join(f.root, 'MovedResources');
  bundle(moved);
  initializeResearchProfile({...f, resourcesDir: moved});
  assert.equal(readJson(initial.settingsPath).packages[0], `-${path.join(moved, 'harness/node_modules/pi-subagents')}`);
  assert.equal(readJson(initial.settingsPath).skills.filter(entry => entry.startsWith('-')).length, 2);
});

test('saved ports are preferred; an explicit launch override leaves saved config intact', t => {
  const f = fixture(t);
  const first = initializeResearchProfile(f);
  const config = {...readJson(first.configPath), port: 19000, piPort: 19001, defaultModel: 'custom/provider'};
  write(first.configPath, config);
  const configBytes = fs.readFileSync(first.configPath);
  const saved = initializeResearchProfile(f);
  assert.equal(saved.port, 19000);
  assert.equal(saved.piPort, 19001);
  const active = initializeResearchProfile({...f, port: 19020, piPort: 19021});
  assert.equal(active.port, 19020);
  assert.equal(active.piPort, 19021);
  assert.deepEqual(fs.readFileSync(first.configPath), configBytes);
  assert.equal(readJson(first.mcpPath).mcpServers['pi-dashboard'].url, 'http://127.0.0.1:19020/mcp');
});

test('a user-configured MCP endpoint and independent servers survive startup', t => {
  const f = fixture(t);
  const first = initializeResearchProfile(f);
  const mcp = readJson(first.mcpPath);
  mcp.mcpServers['pi-dashboard'] = {url: 'http://127.0.0.1:20100/mcp', headers: {'X-Custom': 'test'}};
  mcp.mcpServers['my-tools'] = {command: '/my/tool', args: ['--local']};
  write(first.mcpPath, mcp);
  const before = fs.readFileSync(first.mcpPath);
  initializeResearchProfile({...f, port: 19000, piPort: 19001});
  assert.deepEqual(fs.readFileSync(first.mcpPath), before);
});

test('readOnly returns proposed paths and saved ports without creating directories', t => {
  const f = fixture(t);
  const result = initializeResearchProfile({...f, readOnly: true});
  assert.equal(result.port, DEFAULT_PORT);
  assert.ok(result.pendingChanges.length > 0);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.updated, []);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('invalid dependency identities fail before writing any profile files', t => {
  const f = fixture(t);
  write(path.join(f.resourcesDir, 'harness/node_modules/pi-subagents/package.json'), {name: 'pi-subagents', version: '0.76.2'});
  assert.throws(() => initializeResearchProfile(f), /package\/version mismatch/);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('manifest traversal is rejected before writing any profile files', t => {
  const f = fixture(t);
  const file = path.join(f.resourcesDir, 'research-bundle.json');
  const manifest = readJson(file);
  manifest.packages[0].path = '../outside';
  write(file, manifest);
  assert.throws(() => initializeResearchProfile(f), /Invalid relative resource path/);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('existing settings without ownership metadata are never overwritten', t => {
  const f = fixture(t);
  const settingsPath = path.join(f.dataDir, 'agent/settings.json');
  write(settingsPath, '{"packages":["npm:my-own-package@1.0.0"],"defaultModel":"my-provider/model"}\n');
  const before = fs.readFileSync(settingsPath);
  assert.throws(() => initializeResearchProfile(f), /no application ownership record/);
  assert.deepEqual(fs.readFileSync(settingsPath), before);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'profile-state.json')), false);
});

test('malformed existing settings abort without replacing configuration or auth', t => {
  const f = fixture(t);
  const initial = initializeResearchProfile(f);
  write(initial.settingsPath, '{broken-json');
  write(path.join(initial.agentDir, 'auth.json'), 'keep-this-byte-for-byte');
  assert.throws(() => initializeResearchProfile(f), /valid research settings/);
  assert.equal(fs.readFileSync(initial.settingsPath, 'utf8'), '{broken-json');
  assert.equal(fs.readFileSync(path.join(initial.agentDir, 'auth.json'), 'utf8'), 'keep-this-byte-for-byte');
});

test('invalid or colliding ports are rejected before writes', t => {
  const f = fixture(t);
  for (const port of [0, 65536, -1, 12.5, '19000']) {
    assert.throws(() => initializeResearchProfile({...f, port}), /Invalid dashboard port/);
  }
  assert.throws(() => initializeResearchProfile({...f, port: 19000, piPort: 19000}), /distinct ports/);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('a profile directory symlink cannot redirect writes into another Pi installation', {skip: process.platform === 'win32'}, t => {
  const f = fixture(t);
  const external = path.join(f.root, 'personal-agent');
  write(path.join(external, 'settings.json'), '{"packages":["personal"]}\n');
  fs.mkdirSync(f.dataDir, {recursive: true});
  fs.symlinkSync(external, path.join(f.dataDir, 'agent'), 'dir');
  assert.throws(() => initializeResearchProfile(f), /linked profile path/);
  assert.equal(fs.readFileSync(path.join(external, 'settings.json'), 'utf8'), '{"packages":["personal"]}\n');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'profile-state.json')), false);
});
