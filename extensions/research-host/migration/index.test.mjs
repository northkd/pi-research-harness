import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MIGRATION_SCHEMA, createDefaultMigrationPlan, inspectMigration, prepareMigration, verifyMigration } from './index.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const quiescent = () => ({ ok: true, observedAt: new Date().toISOString(), evidence: ['synthetic writer stopped', 'synthetic new scheduler inactive'] });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-migration-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = path.join(directory, 'legacy');
  const sessions = path.join(directory, 'sessions');
  const project = path.join(directory, 'project');
  const owner = JSON.stringify(['urn:pi-dashboard:local-operator', 'local-operator']);
  const scope = path.join(legacy, 'res-workflow', digest(owner), digest(project));
  const put = (file, bytes, mode = 0o600) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode });
  };
  const adoption = 'adopt-' + 'a'.repeat(24);
  put(path.join(scope, 'adopted.json'), JSON.stringify({ id: adoption, confirmed: true }));
  put(path.join(scope, adoption + '.json'), JSON.stringify({ schema: 'pi-res-workflow-operation.v1', ownerKey: owner, cwd: project, adoption: { id: adoption, status: 'confirmed', cwd: project } }));
  put(path.join(legacy, 'res-workflow/dispatch/dispatch-' + 'c'.repeat(40) + '.json'), JSON.stringify({ schema: 'pi-research-dispatch.v1', id: 'dispatch-' + 'c'.repeat(40), tasks: [{ id: 'synthetic-task', status: 'queued' }] }));
  put(path.join(sessions, 'project/session.jsonl'), JSON.stringify({ type: 'session', id: 'synthetic-session', cwd: project }) + '\n');
  put(path.join(sessions, 'project/session.meta.json'), JSON.stringify({ principalOwner: { iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' }, resWorkflow: { canonicalCwd: project } }), 0o644);
  put(path.join(project, '.pi/dashboard/kb/index.db'), Buffer.from([0, 255, 127, 1]));
  put(path.join(legacy, 'config.json'), JSON.stringify({ port: 8000, token: 'synthetic-private-token' }));
  const plan = createDefaultMigrationPlan({ homeDir: directory, legacyDashboardDir: legacy, nativeSessionsDir: sessions, projectRoot: project });
  return { directory, legacy, sessions, project, scope, plan, put, destinationDir: path.join(directory, 'new-snapshot') };
}

test('copies exact schemas and binary bytes, records retained session metadata, and creates private destinations', async t => {
  const f = fixture(t);
  const inventory = inspectMigration({ plan: f.plan });
  assert.equal(inventory.copy.find(root => root.id === 'res-workflow').files, 3);
  assert.equal(inventory.retain.find(root => root.id === 'native-sessions').files, 2);
  assert.deepEqual(inventory.retain.find(root => root.id === 'native-sessions').fileModes, ['600', '644']);
  const result = await prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: quiescent });
  assert.equal(result.ok, true);
  assert.equal(result.files, 4);
  assert.equal(result.sourceVerified, true);
  assert.equal(result.requiredRuntimeRoots[0].source, path.join(f.legacy, 'res-workflow'));
  const relative = path.relative(f.legacy, path.join(f.scope, 'adopted.json'));
  assert.deepEqual(fs.readFileSync(path.join(f.destinationDir, 'data', relative)), fs.readFileSync(path.join(f.scope, 'adopted.json')));
  const config = path.join(f.destinationDir, 'data/legacy/config.json');
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(config)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.sessions, 'project/session.meta.json')).mode & 0o777, 0o644);
  const { directory: _directory, manifest: _manifest, ...verification } = result;
  assert.deepEqual(verifyMigration({ destinationDir: f.destinationDir }), { ...verification, sourceVerified: false });
});

test('requires orchestrator writer-quiescence evidence before creating the destination', async t => {
  const f = fixture(t);
  await assert.rejects(prepareMigration({ destinationDir: f.destinationDir, plan: f.plan }), { code: 'migration-writer-quiescence-required' });
  assert.equal(fs.existsSync(f.destinationDir), false);
  await assert.rejects(prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: () => ({ ok: false }) }), { code: 'migration-writer-quiescence-unconfirmed' });
  assert.equal(fs.existsSync(f.destinationDir), false);
});

test('existing target content is preserved and never overwritten', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.destinationDir);
  const file = path.join(f.destinationDir, 'user-file');
  fs.writeFileSync(file, 'existing user bytes');
  await assert.rejects(prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: quiescent }), { code: 'migration-destination-exists' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing user bytes');
});

test('a source mutation during cutover leaves a failed copy and cannot produce a ready verification', async t => {
  const f = fixture(t);
  await assert.rejects(prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: quiescent,
    afterCopy: () => f.put(path.join(f.legacy, 'res-workflow/new-receipt.json'), '{"id":"late-receipt"}') }), { code: 'migration-source-changed' });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.destinationDir, 'migration-manifest.json')));
  assert.equal(manifest.status, 'failed');
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir }), { code: 'migration-manifest-not-ready' });
});

test('post-copy changes, extra files and relaxed permissions are detected', async t => {
  const f = fixture(t);
  await prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: quiescent });
  const config = path.join(f.destinationDir, 'data/legacy/config.json');
  fs.chmodSync(config, 0o644);
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir }), { code: 'migration-destination-not-private' });
  fs.chmodSync(config, 0o600);
  const extra = path.join(f.destinationDir, 'data/unexpected');
  fs.writeFileSync(extra, 'extra', { mode: 0o600 });
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir }), { code: 'migration-unexpected-destination-file' });
  fs.unlinkSync(extra);
  fs.writeFileSync(config, '{}');
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir }), { code: 'migration-destination-changed' });
});

test('symlinks, special files, hardlinks and overlapping roots cannot be copied', async t => {
  const f = fixture(t);
  const link = path.join(f.legacy, 'res-workflow/symlink');
  fs.symlinkSync(path.join(f.legacy, 'config.json'), link);
  assert.throws(() => inspectMigration({ plan: f.plan }), { code: 'migration-symlink-rejected' });
  fs.unlinkSync(link);
  fs.linkSync(path.join(f.legacy, 'config.json'), link);
  assert.throws(() => inspectMigration({ plan: f.plan }), { code: 'migration-hardlink-rejected' });
  fs.unlinkSync(link);
  assert.throws(() => inspectMigration({ plan: { schema: MIGRATION_SCHEMA, copy: [{ id: 'special', source: '/dev/null', target: 'special' }], retain: [] } }), { code: 'migration-special-file-rejected' });
  await assert.rejects(prepareMigration({ destinationDir: path.join(f.legacy, 'res-workflow/nested'), plan: f.plan, assertQuiescent: quiescent }), { code: 'migration-path-overlap' });
  const copy = [{ id: 'source', source: f.legacy, target: '../escape' }];
  assert.throws(() => inspectMigration({ plan: { schema: MIGRATION_SCHEMA, copy, retain: [] } }), { code: 'migration-target-invalid' });
});

test('retained native history stays in place and mutations invalidate the final cutover comparison', async t => {
  const f = fixture(t);
  const source = path.join(f.sessions, 'project/session.jsonl');
  const original = fs.readFileSync(source);
  await prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: quiescent });
  assert.equal(fs.existsSync(path.join(f.destinationDir, 'data/native-sessions')), false);
  assert.deepEqual(fs.readFileSync(source), original);
  fs.appendFileSync(source, '{"type":"message"}\n');
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir, verifySources: true }), { code: 'migration-source-changed' });
  assert.equal(verifyMigration({ destinationDir: f.destinationDir }).ok, true);
});

test('manifest modification and destination symbolic-link replacement fail verification', async t => {
  const f = fixture(t);
  await prepareMigration({ destinationDir: f.destinationDir, plan: f.plan, assertQuiescent: quiescent });
  const file = path.join(f.destinationDir, 'migration-manifest.json');
  const bytes = fs.readFileSync(file);
  const manifest = JSON.parse(bytes);
  manifest.quiescence.after.evidence = ['different'];
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir }), { code: 'migration-manifest-changed' });
  fs.writeFileSync(file, bytes);
  const data = path.join(f.destinationDir, 'data/legacy/config.json');
  fs.unlinkSync(data);
  fs.symlinkSync(path.join(f.legacy, 'config.json'), data);
  assert.throws(() => verifyMigration({ destinationDir: f.destinationDir }), { code: 'migration-symlink-rejected' });
});
