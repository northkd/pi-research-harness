import { randomUUID as releaseFixtureRandomUUID } from 'node:crypto';
const fixtureCredential1 = releaseFixtureRandomUUID();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { supplementalConfigurationFromLegacy, createSupplementalStateMappings, inspectSupplementalState } from '../state-compat.mjs';
import { loadConfig } from '../host-paths.mjs';
import { withSupplementalEnvironment } from '../runtime-home.mjs';
import { getBillingReport } from '../billing/server/stats.js';

test('legacy config preserves active plugin namespaces and infinite question timeout without activating stale automation config', () => {
  const config = { automation: { maxRunAgeMs: 0 }, askUserPromptTimeoutSeconds: -1, plugins: { automation: { scanGlobalScope: false, maxRunAgeMs: 42 }, goal: { enabled: false }, bad: [] }, questions: { autoBrief: false, minBriefChars: 9999.5 } };
  const result = supplementalConfigurationFromLegacy(config);
  assert.deepEqual(result, { plugins: { automation: { scanGlobalScope: false, maxRunAgeMs: 42 }, goal: { enabled: false } }, questions: { autoBrief: false, minBriefChars: 4000 }, askUserPromptTimeoutSeconds: -1 });
  result.plugins.automation.maxRunAgeMs = 8;
  assert.equal(config.plugins.automation.maxRunAgeMs, 42);
  assert.deepEqual(supplementalConfigurationFromLegacy({ automation: { maxRunAgeMs: 0 } }), { plugins: {}, questions: { autoBrief: true, minBriefChars: 240 }, askUserPromptTimeoutSeconds: 300 });
});

test('state mappings retain every project KB and original prices while read-only inventory excludes content', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-supplemental-state-'));
  try {
    const homeDir = path.join(temporary, 'home');
    const legacy = path.join(homeDir, '.pi/dashboard');
    const project = path.join(temporary, 'project');
    await fs.mkdir(path.join(legacy, 'goals'), { recursive: true });
    await fs.mkdir(path.join(legacy, 'questions'), { recursive: true });
    await fs.mkdir(path.join(homeDir, '.pi/agent/sessions'), { recursive: true });
    await fs.mkdir(path.join(project, '.pi/dashboard/kb'), { recursive: true });
    const goalBytes = JSON.stringify({ schemaVersion: 1, goals: [{ objective: 'private-synthetic-objective', status: 'paused', sessionIds: ['private-session'], driverSessionId: 'private-session' }] });
    await fs.writeFile(path.join(legacy, 'goals/example.json'), goalBytes);
    await fs.writeFile(path.join(homeDir, '.pi/agent/models.json'), JSON.stringify({ providers: { synthetic: { apiKey: fixtureCredential1 } } }));
    await fs.writeFile(path.join(project, '.pi/dashboard/kb/index.db'), 'synthetic-index');
    const options = { homeDir, projectCwds: [project, project] };
    const mappings = createSupplementalStateMappings(options);
    assert.equal(mappings.copy.length, 5);
    assert.equal(mappings.retain.filter(record => record.source === path.join(project, '.pi/dashboard')).length, 1);
    assert.ok(mappings.retain.some(record => record.id === 'native-model-prices'));
    const inventory = inspectSupplementalState(options);
    assert.equal(inventory.goals.records, 1);
    assert.deepEqual(inventory.goals.schemaVersions, [1]);
    assert.equal(inventory.goals.statuses.paused, 1);
    assert.equal(inventory.goals.drivers, 1);
    assert.equal(inventory.goals.linkedSessions, 1);
    assert.ok(!JSON.stringify(inventory).includes('synthetic-secret'));
    assert.ok(!JSON.stringify(inventory).includes('private-synthetic'));
    assert.equal(await fs.readFile(path.join(legacy, 'goals/example.json'), 'utf8'), goalBytes);
    assert.equal((await fs.readdir(path.join(homeDir, '.pi'))).includes('research-host'), false);
    await fs.symlink(path.join(project, '.pi/dashboard/kb/index.db'), path.join(legacy, 'questions/linked'));
    assert.throws(() => inspectSupplementalState(options), /symlink-rejected/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('billing uses new sessionsDir and old piSessionsDir compatibility with an isolated home', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-supplemental-billing-'));
  try {
    const homeDir = path.join(temporary, 'home');
    const hostDir = path.join(temporary, 'state');
    const sessionsDir = path.join(temporary, 'custom-session-root');
    await fs.mkdir(path.join(homeDir, '.pi/agent'), { recursive: true });
    await fs.mkdir(hostDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, '.pi/agent/models.json'), JSON.stringify({ providers: { cliproxy: { models: [{ id: 'fixture', cost: { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 } }] } } }));
    const lines = [{ type: 'session', id: 'custom-root-session', cwd: temporary }, { type: 'message', id: 'synthetic-message', timestamp: '2026-02-01T00:00:10Z', message: { role: 'assistant', provider: 'cliproxy', model: 'fixture', timestamp: Date.parse('2026-02-01T00:00:00Z'), usage: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } } }];
    await fs.writeFile(path.join(sessionsDir, 'synthetic.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
    await fs.writeFile(path.join(hostDir, 'config.json'), JSON.stringify({ sessionsDir }));
    await withSupplementalEnvironment({ homeDir, hostDir }, async () => {
      assert.equal(loadConfig().piSessionsDir, sessionsDir);
      assert.deepEqual(loadConfig().acpAgents, []);
      const report = await getBillingReport('2026-02');
      assert.equal(report.sessions.length, 1);
      assert.ok(Math.abs(report.billing.sessionTotalCost - 0.012) < 1e-10);
      await fs.writeFile(path.join(hostDir, 'config.json'), JSON.stringify({ piSessionsDir: sessionsDir }));
      assert.equal(loadConfig().piSessionsDir, sessionsDir);
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
