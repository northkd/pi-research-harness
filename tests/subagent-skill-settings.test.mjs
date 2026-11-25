import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configureSubagentSkills, normalizeSubagentSkillSettings} from '../scripts/configure-subagent-skills.mjs';

const script = fileURLToPath(new URL('../scripts/configure-subagent-skills.mjs', import.meta.url));
const policy = {inheritSkills: false, skills: [], defaultContext: 'fresh'};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function fixture(t, settings = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-skill-settings-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const agentDir = path.join(root, 'agent'), projectDir = path.join(root, 'project');
  fs.mkdirSync(agentDir); fs.mkdirSync(projectDir);
  const settingsFile = path.join(agentDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings) + '\n', {mode: 0o640});
  return {root, agentDir, projectDir, settingsFile,
    projectSettings(value) {
      const dir = path.join(projectDir, '.pi'); fs.mkdirSync(dir, {recursive: true});
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n');
      return file;
    }};
}

test('pure transform narrows only research-theory and preserves models, tools and parent resources', () => {
  const input = {
    apiKey: 'secret-sentinel', skills: ['global-library'], packages: ['npm:custom@1.0.0'],
    subagents: {defaultModel: 'provider/model', defaultThinking: 'max',
      agentOverrides: {
        'research-theory': {inheritSkills: true, skills: ['all-skills'], defaultContext: 'fork',
          model: 'provider/theory', thinking: 'high', tools: ['read', 'subagent'], systemPrompt: 'Custom role.'},
        'research-numerics': {inheritSkills: true, model: 'provider/numerics'},
      }},
  };
  const original = structuredClone(input);
  const result = normalizeSubagentSkillSettings(input);
  assert.deepEqual(input, original, 'does not mutate its input');
  assert.deepEqual(result.settings, {...original, subagents: {...original.subagents,
    agentOverrides: {...original.subagents.agentOverrides,
      'research-theory': {...original.subagents.agentOverrides['research-theory'], ...policy}}}});
  assert.deepEqual(result.changes, [{source: 'agentOverrides', fields: ['inheritSkills', 'skills', 'defaultContext']}]);
  assert.equal(normalizeSubagentSkillSettings(result.settings).changed, false);
});

test('provider-specific overrides cannot restore inherited skills or fork defaults', () => {
  const input = {subagents: {agentOverridesByProvider: {
    deepseek: {'research-theory': {model: 'deepseek-v4-pro', skills: ['proof'], inheritSkills: true}},
    openai: {'research-theory': {thinking: 'max', defaultContext: 'fork'}, reviewer: {skills: ['review']}},
    untouched: {reviewer: {inheritSkills: true}},
  }}};
  const result = normalizeSubagentSkillSettings(input);
  assert.deepEqual(result.settings.subagents.agentOverrides['research-theory'], policy);
  assert.deepEqual(result.settings.subagents.agentOverridesByProvider.deepseek['research-theory'], {...policy, model: 'deepseek-v4-pro'});
  assert.deepEqual(result.settings.subagents.agentOverridesByProvider.openai['research-theory'], {...policy, thinking: 'max'});
  assert.deepEqual(result.settings.subagents.agentOverridesByProvider.openai.reviewer, {skills: ['review']});
  assert.deepEqual(result.settings.subagents.agentOverridesByProvider.untouched, input.subagents.agentOverridesByProvider.untouched);
  assert.equal(result.changes.length, 3);
});

test('rejects malformed containers instead of dropping settings', () => {
  for (const input of [null, [], 'settings', new Date(), {subagents: null}, {subagents: []},
    {subagents: {agentOverrides: []}}, {subagents: {agentOverrides: {'research-theory': null}}},
    {subagents: {agentOverridesByProvider: []}}, {subagents: {agentOverridesByProvider: {deepseek: []}}},
    {subagents: {agentOverridesByProvider: {deepseek: {'research-theory': []}}}}]) {
    assert.throws(() => normalizeSubagentSkillSettings(input), /must be a JSON object/);
  }
});

test('updates both existing files, creates private exact-byte backups and does not touch auth or role files', t => {
  const f = fixture(t, {apiKey: 'must-not-appear', subagents: {agentOverrides: {'research-theory': {model: 'custom', thinking: 'max'}}}});
  const projectFile = f.projectSettings({skills: ['project-skill'], subagents: {agentOverridesByProvider: {
    custom: {'research-theory': {inheritSkills: true, skills: ['extra'], defaultContext: 'fork', tools: ['read']}},
  }}});
  const originals = new Map([f.settingsFile, projectFile].map(file => [file, fs.readFileSync(file)]));
  fs.writeFileSync(path.join(f.agentDir, 'auth.json'), 'auth-must-stay-byte-identical');
  fs.mkdirSync(path.join(f.agentDir, 'agents'));
  fs.writeFileSync(path.join(f.agentDir, 'agents/research-theory.md'), 'role-must-stay-byte-identical');
  const beforeMode = fs.statSync(f.settingsFile).mode & 0o777;
  const result = configureSubagentSkills(f.agentDir, {projectDir: f.projectDir});
  assert.equal(result.ok, true); assert.equal(result.updatedFiles, 2); assert.equal(result.needsUpdate, false);
  assert.deepEqual(result.policy, policy);
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear|auth-must|role-must/);
  for (const entry of result.files) {
    assert.deepEqual(fs.readFileSync(entry.backupPath), originals.get(entry.path));
    if (process.platform !== 'win32') assert.equal(fs.statSync(entry.backupPath).mode & 0o777, 0o600);
    assert.deepEqual(read(entry.path).subagents.agentOverrides['research-theory'],
      entry.path === f.settingsFile ? {...policy, model: 'custom', thinking: 'max'} : policy);
  }
  assert.deepEqual(read(projectFile).subagents.agentOverridesByProvider.custom['research-theory'], {...policy, tools: ['read']});
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'auth.json'), 'utf8'), 'auth-must-stay-byte-identical');
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'agents/research-theory.md'), 'utf8'), 'role-must-stay-byte-identical');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.settingsFile).mode & 0o777, beforeMode);
  const names = fs.readdirSync(f.agentDir).sort();
  const afterBytes = fs.readFileSync(f.settingsFile);
  assert.equal(configureSubagentSkills(f.agentDir, {projectDir: f.projectDir}).updatedFiles, 0);
  assert.deepEqual(fs.readdirSync(f.agentDir).sort(), names, 'idempotent run makes no backup');
  assert.deepEqual(fs.readFileSync(f.settingsFile), afterBytes);
  assert.equal(configureSubagentSkills(f.agentDir, {projectDir: f.projectDir, checkOnly: true}).ok, true);
});

test('dry-run and failed check-only report the policy without any writes or secrets', t => {
  const f = fixture(t, {password: 'output-secret-sentinel', subagents: {agentOverrides: {'research-theory': {skills: ['proof']}}}});
  const before = fs.readFileSync(f.settingsFile);
  for (const options of [{dryRun: true}, {checkOnly: true}]) {
    const result = configureSubagentSkills(f.agentDir, {...options, projectDir: f.projectDir});
    assert.equal(result.needsUpdate, true); assert.equal(result.updatedFiles, 0);
    assert.equal(result.ok, !options.checkOnly);
    assert.equal(result.files[1].exists, false);
    assert.doesNotMatch(JSON.stringify(result), /output-secret-sentinel/);
    assert.deepEqual(fs.readFileSync(f.settingsFile), before);
    assert.deepEqual(fs.readdirSync(f.agentDir), ['settings.json']);
    assert.deepEqual(fs.readdirSync(f.projectDir), []);
  }
  const result = configureSubagentSkills(f.agentDir, {projectDir: f.projectDir});
  assert.equal(result.updatedFiles, 1); assert.equal(result.files[1].exists, false);
  assert.deepEqual(fs.readdirSync(f.projectDir), [], 'absent project settings are not created');
});

test('invalid project JSON or objects cause no partial agent update and no backups', t => {
  const f = fixture(t, {subagents: {agentOverrides: {'research-theory': {inheritSkills: true}}}});
  const before = fs.readFileSync(f.settingsFile);
  for (const invalid of ['{"token":"do-not-leak-this-token", broken', {subagents: []},
    {subagents: {agentOverridesByProvider: {deepseek: null}}}]) {
    const projectFile = f.projectSettings(invalid);
    const projectBefore = fs.readFileSync(projectFile);
    assert.throws(() => configureSubagentSkills(f.agentDir, {projectDir: f.projectDir}), error => {
      assert.doesNotMatch(error.message, /do-not-leak-this-token/);
      return /Invalid JSON|must be a JSON object/.test(error.message);
    });
    assert.deepEqual(fs.readFileSync(f.settingsFile), before);
    assert.deepEqual(fs.readFileSync(projectFile), projectBefore);
    assert.deepEqual(fs.readdirSync(f.agentDir), ['settings.json']);
    assert.deepEqual(fs.readdirSync(path.dirname(projectFile)), ['settings.json']);
  }
});

test('a later atomic rename failure restores earlier files without leaving partial settings', t => {
  const f = fixture(t, {subagents: {agentOverrides: {'research-theory': {inheritSkills: true}}}});
  const projectFile = f.projectSettings({subagents: {agentOverrides: {'research-theory': {skills: ['proof']}}}});
  const originalAgent = fs.readFileSync(f.settingsFile), originalProject = fs.readFileSync(projectFile);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === projectFile) throw new Error('simulated project rename failure');
    return rename(source, destination);
  });
  try {
    assert.throws(() => configureSubagentSkills(f.agentDir, {projectDir: f.projectDir}), /no configuration updates were retained/);
  } finally { mock.mock.restore(); }
  assert.deepEqual(fs.readFileSync(f.settingsFile), originalAgent);
  assert.deepEqual(fs.readFileSync(projectFile), originalProject);
  assert.deepEqual(fs.readdirSync(f.agentDir), ['settings.json']);
  assert.deepEqual(fs.readdirSync(path.dirname(projectFile)), ['settings.json']);
});

test('requires an existing agent settings file and explicit absolute paths', t => {
  const f = fixture(t);
  assert.throws(() => configureSubagentSkills('relative'), /absolute/);
  assert.throws(() => configureSubagentSkills(f.agentDir, {projectDir: 'relative'}), /absolute/);
  assert.throws(() => configureSubagentSkills(f.agentDir, {dryRun: true, checkOnly: true}), /Choose either/);
  fs.unlinkSync(f.settingsFile);
  assert.throws(() => configureSubagentSkills(f.agentDir), /Cannot inspect/);
  assert.deepEqual(fs.readdirSync(f.agentDir), []);
});

test('rejects settings symlinks and symlinked directories before any writes', {skip: process.platform === 'win32'}, t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.settingsFile);
  const real = path.join(f.root, 'real-settings.json'); fs.writeFileSync(real, original);
  fs.unlinkSync(f.settingsFile); fs.symlinkSync(real, f.settingsFile);
  assert.throws(() => configureSubagentSkills(f.agentDir), /Symlink rejected/);
  assert.deepEqual(fs.readFileSync(real), original);
  fs.unlinkSync(f.settingsFile); fs.writeFileSync(f.settingsFile, original);
  const alias = path.join(f.root, 'agent-link'); fs.symlinkSync(f.agentDir, alias, 'dir');
  assert.throws(() => configureSubagentSkills(alias, {dryRun: true}), /Symlink rejected/);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.projectDir, '.pi'), 'dir');
  assert.throws(() => configureSubagentSkills(f.agentDir, {projectDir: f.projectDir}), /Symlink rejected/);
  assert.deepEqual(fs.readFileSync(f.settingsFile), original);
  assert.deepEqual(fs.readdirSync(f.agentDir), ['settings.json']);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(f.projectDir, '.pi'));
  fs.mkdirSync(path.join(f.projectDir, '.pi'));
  fs.symlinkSync(path.join(f.root, 'missing.json'), path.join(f.projectDir, '.pi/settings.json'));
  assert.throws(() => configureSubagentSkills(f.agentDir, {projectDir: f.projectDir}), /Symlink rejected/);
  assert.deepEqual(fs.readFileSync(f.settingsFile), original);
});

test('deduplicates an agent directory that is the requested project .pi directory', t => {
  const f = fixture(t);
  const file = f.projectSettings({});
  const result = configureSubagentSkills(path.dirname(file), {projectDir: f.projectDir});
  assert.equal(result.updatedFiles, 1);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0].scopes, ['agent', 'project']);
});

test('CLI check-only uses a failing exit code until migration and never dumps settings', t => {
  const f = fixture(t, {apiKey: 'cli-secret-sentinel'});
  const run = args => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  const missing = run([f.agentDir, '--check-only']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).needsUpdate, true);
  const dry = run([f.agentDir, '--project-dir', f.projectDir, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(fs.readdirSync(f.agentDir), ['settings.json']);
  const applied = run([f.agentDir]); assert.equal(applied.status, 0, applied.stderr);
  const checked = run([f.agentDir, '--check-only']); assert.equal(checked.status, 0, checked.stderr);
  for (const result of [missing, dry, applied, checked]) {
    assert.doesNotMatch(result.stdout + result.stderr, /cli-secret-sentinel/);
  }
  assert.notEqual(run([f.agentDir, '--unexpected']).status, 0);
  assert.notEqual(run([f.agentDir, '--project-dir']).status, 0);
  assert.notEqual(run(['relative', '--dry-run']).status, 0);
});
