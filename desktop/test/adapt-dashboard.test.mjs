import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { adaptDashboardSource, adaptDashboardDirectory, explicitKnownPathAdaptations } from '../scripts/adapt-dashboard.mjs';

function evaluate(source, { env = {}, platformPath = path.posix, forbidHomeLookup = false, extraContext = {} } = {}) {
  const home = platformPath === path.win32 ? 'C:\\Users\\Personal User' : '/home/personal';
  const homedir = () => { if (forbidHomeLookup) throw new Error('Personal home lookup was not expected'); return home; };
  const context = { process: { env }, os: { homedir }, homedir, home, homeDir: home,
    path: platformPath, join: platformPath.join, resolve: platformPath.resolve, ...extraContext };
  return vm.runInNewContext(source, context);
}

test('all three isolated roots preserve file tails and original fallbacks', () => {
  const source = `[
    path.join(os.homedir(), '.pi', 'dashboard', 'config.json'),
    join(home, '.pi', 'agent', 'sessions', 'one.jsonl'),
    path.resolve(homeDir, '.pi-dashboard', 'node_modules'),
    join(homedir(), '.pi/dashboard'),
  ]`;
  const adapted = adaptDashboardSource(source);
  assert.equal(adapted.changes.length, 4);
  assert.equal(adapted.unresolved.length, 0);
  const env = { PI_RESEARCH_DASHBOARD_DIR: '/research/dashboard', PI_CODING_AGENT_DIR: '/research/agent', PI_RESEARCH_MANAGED_DIR: '/research/managed' };
  assert.deepEqual(Array.from(evaluate(adapted.source, { env })), [
    '/research/dashboard/config.json', '/research/agent/sessions/one.jsonl',
    '/research/managed/node_modules', '/research/dashboard',
  ]);
  assert.deepEqual(Array.from(evaluate(adapted.source)), Array.from(evaluate(source)));
  assert.equal(env.HOME, undefined);
});

test('Windows paths with spaces use the isolated directories without rewriting HOME', () => {
  const source = `path.join(os.homedir(), '.pi', 'agent', 'settings.json')`;
  const adapted = adaptDashboardSource(source);
  const env = { HOME: 'untouched', USERPROFILE: 'also untouched', PI_CODING_AGENT_DIR: 'C:\\Research Data\\agent' };
  assert.equal(evaluate(adapted.source, { env, platformPath: path.win32 }), 'C:\\Research Data\\agent\\settings.json');
  assert.equal(evaluate(adapted.source, { platformPath: path.win32 }), evaluate(source, { platformPath: path.win32 }));
  assert.equal(env.HOME, 'untouched');
  assert.equal(env.USERPROFILE, 'also untouched');
});

test('combined literal prefixes retain their suffix and do not match similarly named folders', () => {
  const source = `[path.join(os.homedir(), '.pi/agent/models.json'),
    resolve(home, '.pi/dashboard//logs/latest.log'),
    join(home, '.pi', 'agent/git', 'repo'),
    join(home, '.pi-dashboard/node/bin'),
    join(home, '.pi', 'agent-backup', 'settings.json')]`;
  const adapted = adaptDashboardSource(source);
  assert.equal(adapted.changes.length, 4);
  const env = { PI_CODING_AGENT_DIR: '/r/agent', PI_RESEARCH_DASHBOARD_DIR: '/r/dashboard', PI_RESEARCH_MANAGED_DIR: '/r/managed' };
  assert.deepEqual(Array.from(evaluate(adapted.source, { env })).slice(0, 4), [
    '/r/agent/models.json', '/r/dashboard/logs/latest.log', '/r/agent/git/repo', '/r/managed/node/bin',
  ]);
  assert.deepEqual(Array.from(evaluate(adapted.source)), Array.from(evaluate(source)));
  assert.ok(adapted.source.includes("join(home, '.pi', 'agent-backup', 'settings.json')"));
});

test('comments, quoted examples, templates, project paths and unrelated join methods stay intact', () => {
  const source = [
    '// join(homedir(), ".pi", "agent") is a comment.',
    'const example = "path.join(home, \\".pi\\", \\"dashboard\\")";',
    'const literal = `join(home, ".pi", "agent")`;',
    'const template = `${homedir()}/.pi/agent/settings.json`;',
    'const project = path.join(projectDir, ".pi", "dashboard");',
    'const local = join(cwd, ".pi", "agent");',
    'const unrelated = other.join(home, ".pi", "agent");',
    'const notHome = join(homebrew, ".pi", "agent");',
    'const changed = join(/* keep home note */ home, ".pi", /* prefix note */ "agent", "settings.json");',
  ].join('\n');
  const adapted = adaptDashboardSource(source);
  assert.equal(adapted.changes.length, 1);
  assert.equal(adapted.unresolved.length, 1);
  assert.match(adapted.unresolved[0].reason, /template/);
  for (const line of source.split('\n').slice(0, -1)) assert.ok(adapted.source.includes(line));
  assert.equal(adapted.source.split('/* keep home note */').length - 1, 1);
  assert.equal(adapted.source.split('/* prefix note */').length - 1, 1);
});

test('existing matching environment fallbacks remain untouched and repeated adaptation is idempotent', () => {
  const source = `[
    process.env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'),
    join(process.env['PI_CODING_AGENT_DIR'] ?? path.join(os.homedir(), '.pi', 'agent'), 'settings.json'),
    (process.env.PI_RESEARCH_DASHBOARD_DIR || otherOverride) || join(home, '.pi', 'dashboard'),
    process.env.MANAGED_DIR || path.join(home, '.pi-dashboard'),
    join(home, '.pi', 'dashboard', 'config.json'),
  ]`;
  const first = adaptDashboardSource(source);
  assert.equal(first.changes.length, 2);
  const second = adaptDashboardSource(first.source);
  assert.equal(second.changes.length, 0);
  assert.equal(second.source, first.source);
});

test('nested supported paths are both adapted without overlapping source edits', () => {
  const source = `join(home, '.pi', 'dashboard', path.join(home, '.pi', 'agent', 'file'))`;
  const first = adaptDashboardSource(source);
  assert.equal(first.changes.length, 2);
  assert.equal(adaptDashboardSource(first.source).source, first.source);
  assert.equal(evaluate(first.source), evaluate(source));
  assert.equal(evaluate(first.source, { env: { PI_CODING_AGENT_DIR: '/r/a', PI_RESEARCH_DASHBOARD_DIR: '/r/d' } }), '/r/d/r/a/file');
});

test('unhandled home roots and concatenated paths are audited without modification', () => {
  const source = `const root = path.join(os.homedir(), '.pi');
    const profiles = path.join(homeDir, '.pi', 'project-profiles');
    const legacy = path.join(home, '.pi' + '-dashboard');
    const template = home + '/.pi/agent/settings.json';`;
  const adapted = adaptDashboardSource(source);
  assert.equal(adapted.changes.length, 0);
  assert.equal(adapted.source, source);
  assert.equal(adapted.unresolved.length, 4);
  assert.ok(adapted.unresolved.every((item) => item.line > 0 && item.column > 0));
});

test('invalid source fails explicitly and test sources are excluded', () => {
  assert.throws(() => adaptDashboardSource('const p = join(home, ;'), /invalid source/);
  for (const fileName of ['a.test.ts', 'src/__tests__/a.ts', 'src/test-support/a.mjs', 'src/types.d.ts', 'AGENTS.md']) {
    const source = `join(home, '.pi', 'agent')`;
    const result = adaptDashboardSource(source, fileName);
    assert.equal(result.source, source);
    assert.equal(result.skipped, true);
  }
});

test('directory check is read-only; apply covers first-party plugin source and skips tests and symlinks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-research-adapt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `export const p = path.join(os.homedir(), '.pi', 'dashboard', 'settings.json');\n`;
  const entries = [
    'packages/server/src/config.ts',
    'packages/a-plugin/src/server/config.mjs',
    'packages/server/src/__tests__/fixture.ts',
    'packages/server/src/test-support/fixture.ts',
    'packages/server/src/config.test.ts',
    'packages/server/eval/example.mjs',
    'packages/server/AGENTS.md',
  ];
  for (const entry of entries) {
    const destination = path.join(root, entry);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  try {
    await symlink(path.join(root, 'packages/server/src/config.ts'), path.join(root, 'packages/server/src/link.ts'));
  } catch (error) {
    // Windows users without Developer Mode may not have symlink privileges.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Symlink traversal case unavailable under this Windows account');
  }
  const check = await adaptDashboardDirectory(root, { check: true, requireKnownPaths: false });
  assert.equal(check.changedFiles, 2);
  assert.equal(check.changeCount, 2);
  assert.equal(check.scannedFiles, 2);
  assert.equal(await readFile(path.join(root, entries[0]), 'utf8'), source);
  const written = await adaptDashboardDirectory(root, { requireKnownPaths: false });
  assert.deepEqual(written.files.map((file) => file.path), ['packages/a-plugin/src/server/config.mjs', 'packages/server/src/config.ts']);
  for (const entry of entries.slice(2)) assert.equal(await readFile(path.join(root, entry), 'utf8'), source);
  const repeated = await adaptDashboardDirectory(root, { check: true, requireKnownPaths: false });
  assert.equal(repeated.needsChanges, false);
  assert.equal(repeated.changeCount, 0);
  assert.equal(repeated.unresolved.length, 0);
});

const KNOWN_FIXTURES = {
  'packages/kb/src/config.ts': `import { join } from "node:path";
const DEFAULTS = { sources: [], sourceCacheDir: "~/.pi/dashboard/kb/sources" };
DEFAULTS.sourceCacheDir;`,
  'packages/extension/src/project-init/profiles.ts': `function userProfilesDir() {
  return path.join(os.homedir(), ".pi", "project-profiles");
}
userProfilesDir();`,
  'packages/automation-plugin/src/server/index.ts': `const globalHome = os.homedir();
function createBase(scope, cwd) { return scope === "global" ? os.homedir() : cwd; }
function runNowBase(scope, cwd) { return scope === "global" ? os.homedir() : cwd; }
[globalHome, createBase("global", "/project"), createBase("folder", "/project"), runNowBase("global", "/project")];`,
  'packages/automation-plugin/src/server/routes.ts': `function scopeBaseFor(scope, cwd) {
  return scope === "global" ? os.homedir() : cwd;
}
const options = { homeDir: os.homedir(), scanGlobal: true };
[scopeBaseFor("global", "/project"), scopeBaseFor("folder", "/project"), options.homeDir];`,
  'packages/automation-plugin/src/server/engine.ts': `function engineBase(deps) {
  const homeDir = deps.homeDir ?? os.homedir();
  return homeDir;
}
[engineBase({}), engineBase({ homeDir: "/explicit-override" })];`,
  'packages/mcp-server-plugin/src/server/index.ts': `import path from "node:path";
function readInstalledAdapterVersion() {
  const candidates = [
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "package.json"),
    path.join(os.homedir(), ".pi", "agent", "node_modules", "pi-mcp-adapter", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const version = JSON.parse(fs.readFileSync(candidate, "utf8")).version;
      if (typeof version === "string") return version;
    } catch { /* Try the next installation location. */ }
  }
  return null;
}
readInstalledAdapterVersion();`,
};

test('known source-cache and project-profile defaults use isolated roots and retain legacy fallback', () => {
  const env = { PI_RESEARCH_DASHBOARD_DIR: '/research/dashboard', PI_RESEARCH_MANAGED_DIR: '/research/managed' };
  const cache = adaptDashboardSource(KNOWN_FIXTURES['packages/kb/src/config.ts'], 'packages/kb/src/config.ts');
  const executableCache = cache.source.replace('import { join } from "node:path";\n', '');
  assert.equal(evaluate(executableCache, { env, forbidHomeLookup: true }), '/research/dashboard/kb/sources');
  assert.equal(evaluate(executableCache), '~/.pi/dashboard/kb/sources');
  assert.equal(cache.unresolved.length, 0);
  const profiles = adaptDashboardSource(KNOWN_FIXTURES['packages/extension/src/project-init/profiles.ts'], 'packages/extension/src/project-init/profiles.ts');
  assert.equal(evaluate(profiles.source, { env, forbidHomeLookup: true }), '/research/managed/.pi/project-profiles');
  assert.equal(evaluate(profiles.source), '/home/personal/.pi/project-profiles');
  assert.equal(profiles.unresolved.length, 0);
});

test('every reviewed automation global base avoids personal-home discovery while folder scopes stay local', () => {
  const env = { PI_RESEARCH_MANAGED_DIR: '/research/managed', HOME: '/real/home', USERPROFILE: '/real/profile' };
  const expectations = {
    'packages/automation-plugin/src/server/index.ts': ['/research/managed', '/research/managed', '/project', '/research/managed'],
    'packages/automation-plugin/src/server/routes.ts': ['/research/managed', '/project', '/research/managed'],
    'packages/automation-plugin/src/server/engine.ts': ['/research/managed', '/explicit-override'],
  };
  for (const [fileName, expected] of Object.entries(expectations)) {
    const source = KNOWN_FIXTURES[fileName];
    const adapted = adaptDashboardSource(source, fileName);
    assert.deepEqual(Array.from(evaluate(adapted.source, { env, forbidHomeLookup: true })), expected);
    assert.deepEqual(Array.from(evaluate(adapted.source)), Array.from(evaluate(source)));
  }
  assert.equal(env.HOME, '/real/home');
  assert.equal(env.USERPROFILE, '/real/profile');
});

test('known target counts are asserted and remain stable on a second adaptation', () => {
  assert.equal(explicitKnownPathAdaptations.reduce((sum, rule) => sum + rule.expectedMatches, 0), 9);
  for (const rule of explicitKnownPathAdaptations) {
    const first = adaptDashboardSource(KNOWN_FIXTURES[rule.path], rule.path);
    const second = adaptDashboardSource(first.source, rule.path);
    assert.equal(first.knownAdaptations[0].matchedCount, rule.expectedMatches);
    assert.equal(first.knownAdaptations[0].appliedCount, rule.expectedMatches);
    assert.equal(second.knownAdaptations[0].matchedCount, rule.expectedMatches);
    assert.equal(second.knownAdaptations[0].appliedCount, 0);
    assert.equal(second.source, first.source);
    assert.equal(second.changes.length, 0);
    assert.throws(() => adaptDashboardSource('const removed = true;', rule.path), /requires the existing|pinned source drift/);
  }
  assert.throws(() => adaptDashboardSource(`${KNOWN_FIXTURES['packages/automation-plugin/src/server/engine.ts']}\nos.homedir();`,
    'packages/automation-plugin/src/server/engine.ts'), /expected 1 exact source target\(s\), found 2/);
  assert.throws(() => adaptDashboardSource(KNOWN_FIXTURES['packages/kb/src/config.ts'].replace('{ join }', '{ join as otherJoin }'),
    'packages/kb/src/config.ts'), /requires the existing named join import/);
});

test('MCP adapter version lookup prefers the bundled package and retains both installation fallbacks', () => {
  const fileName = 'packages/mcp-server-plugin/src/server/index.ts';
  const original = KNOWN_FIXTURES[fileName];
  const adapted = adaptDashboardSource(original, fileName);
  const executable = adapted.source.replace('import path from "node:path";\n', '');
  const bundledRoot = '/Applications/Pi Research Harness.app/Contents/Resources/harness';
  const bundled = path.posix.join(bundledRoot, 'node_modules', 'pi-mcp-adapter', 'package.json');
  const npmFallback = '/research/agent/npm/node_modules/pi-mcp-adapter/package.json';
  const plainFallback = '/research/agent/node_modules/pi-mcp-adapter/package.json';
  function probe(env, packages) {
    const attempted = [];
    const fs = { readFileSync(candidate) {
      attempted.push(candidate);
      if (!packages.has(candidate)) throw new Error('Missing fixture package');
      return JSON.stringify({ version: packages.get(candidate) });
    } };
    const version = evaluate(executable, { env, forbidHomeLookup: true, extraContext: { fs } });
    return { version, attempted };
  }
  const env = { PI_CODING_AGENT_DIR: '/research/agent', PI_RESEARCH_RESOURCE_ROOT: bundledRoot };
  assert.deepEqual(probe(env, new Map([[bundled, '0.11.0'], [npmFallback, '0.10.0']])), {
    version: '0.11.0', attempted: [bundled],
  });
  assert.deepEqual(probe(env, new Map([[npmFallback, '0.10.0']])), {
    version: '0.10.0', attempted: [bundled, npmFallback],
  });
  assert.deepEqual(probe({ PI_CODING_AGENT_DIR: '/research/agent' }, new Map([[plainFallback, '0.9.0']])), {
    version: '0.9.0', attempted: [npmFallback, plainFallback],
  });
  assert.deepEqual(probe(env, new Map([[bundled, 42], [plainFallback, '0.9.0']])), {
    version: '0.9.0', attempted: [bundled, npmFallback, plainFallback],
  });
});

test('MCP candidate adaptation supports an earlier generic pass and rejects changed anchors or fallback packages', () => {
  const fileName = 'packages/mcp-server-plugin/src/server/index.ts';
  const original = KNOWN_FIXTURES[fileName];
  const generic = adaptDashboardSource(original).source;
  const adapted = adaptDashboardSource(generic, fileName);
  assert.equal(adapted.changes.length, 1);
  assert.equal(adapted.changes[0].id, 'mcp-adapter-bundled-version');
  assert.equal(adaptDashboardSource(adapted.source, fileName).source, adapted.source);
  assert.throws(() => adaptDashboardSource(original.replace('const candidates =', 'const candidatePaths ='), fileName), /expected 1 exact source target\(s\), found 0/);
  assert.throws(() => adaptDashboardSource(original.replace('"pi-mcp-adapter"', '"unrelated-adapter"'), fileName), /fallback candidates changed/);
  assert.throws(() => adaptDashboardSource(adapted.source.replace('"node_modules", "pi-mcp-adapter", "package.json"', '"other_modules", "pi-mcp-adapter", "package.json"'), fileName), /fallback candidates changed/);
});

test('intentional user-file allowlists and diagnostic labels remain visible as reviewed audit exceptions', () => {
  const source = 'path.join(os.homedir(), ".pi")';
  for (const fileName of ['packages/server/src/routes/file-routes.ts', 'packages/server/src/lib/resolve-file-mention.ts']) {
    const adapted = adaptDashboardSource(source, fileName);
    assert.equal(adapted.source, source);
    assert.equal(adapted.unresolved[0].blocking, false);
    assert.equal(adapted.unresolved[0].disposition, 'intentional-user-file-access');
  }
  assert.equal(adaptDashboardSource(source).unresolved[0].blocking, true);
});

test('known-source validation fails before any directory writes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-research-adapt-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const editable = path.join(root, 'packages/a-plugin/src/config.ts');
  const invalidKnown = path.join(root, 'packages/automation-plugin/src/server/engine.ts');
  await mkdir(path.dirname(editable), { recursive: true });
  await mkdir(path.dirname(invalidKnown), { recursive: true });
  const original = `join(home, '.pi', 'dashboard')`;
  await writeFile(editable, original);
  await writeFile(invalidKnown, 'const changedUpstream = true;');
  await assert.rejects(adaptDashboardDirectory(root), /pinned source drift/);
  assert.equal(await readFile(editable, 'utf8'), original);
  await rm(invalidKnown);
  await assert.rejects(adaptDashboardDirectory(root), /Missing pinned source files/);
  assert.equal(await readFile(editable, 'utf8'), original);
});
