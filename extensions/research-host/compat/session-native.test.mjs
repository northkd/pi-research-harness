import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createSessionCompatibility } from './session.mjs';
import { createSessionHost } from '../session-host/index.mjs';
import { createWorkbench } from '../workbench/index.mjs';
import { maybeJson, sameProcess } from '../session-host/files.mjs';

const REPOSITORY = process.env.PI_RESEARCH_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const { configureResearch, charterHash } = await import(path.join(REPOSITORY, 'research-loop/src/adoption.mjs'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  for (let index = 0; index < 200; index++) { if (await predicate()) return; await wait(25); }
  assert.fail('Synthetic native session did not settle');
}
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
};

async function fixture(t, realm = ['host', 'inert-operator']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-native-api-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const privateDir = path.join(root, 'research-state'); fs.mkdirSync(privateDir);
  configureResearch(cwd, { objective: 'Synthetic legacy REST migration', successCriteria: ['Preserve exact scope and native receipts'] });
  const ownerKey = JSON.stringify(realm), adoptionId = 'adopt-0123456789abcdef01234567', confirmationHash = 'sha256:' + 'a'.repeat(64);
  const scope = path.join(privateDir, hash(ownerKey), hash(cwd));
  write(path.join(scope, 'adopted.json'), { confirmed: true, id: adoptionId, confirmationHash });
  write(path.join(scope, adoptionId + '.json'), { schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, adoption: { id: adoptionId, cwd, status: 'confirmed' } });
  write(path.join(cwd, '.pi/research-loop/adoptions', adoptionId, 'confirmation.json'), {
    schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash: charterHash(cwd), autoRun: false,
  });
  let workbench;
  const stateDir = path.join(root, 'session-host');
  const sessions = createSessionHost({ stateDir, sessionsDir: path.join(root, 'history'), piCommand: process.execPath,
    piArgs: [path.join(HERE, '../session-host/test/fake-pi.mjs')], env: {}, startupTimeoutMs: 5000, pollMs: 20,
    onRegistered: (id, registration, rawRef) => workbench.registerSpawn(id, registration, rawRef) });
  t.after(async () => {
    sessions.close();
    for (const row of sessions.listSessions()) {
      const status = maybeJson(path.join(stateDir, 'keepers', row.id, 'status.json'));
      if (status && sameProcess(status.keeper)) process.kill(status.keeper.pid, 'SIGTERM');
      await until(() => !status || !sameProcess(status.keeper));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const operator = Object.freeze({ iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' });
  workbench = await createWorkbench({ ...sessions, privateDir, researchLoopRoot: path.join(REPOSITORY, 'research-loop'),
    knownCwds: () => [cwd], localOperatorPrincipal: operator, isLocalOperator: value => value === operator });
  const handle = createSessionCompatibility({ sessions, workbench, localOperatorPrincipal: operator });
  return { cwd, sessions, workbench, operator, handle,
    post: (sessionId, action, body = {}) => handle({ method: 'POST', pathname: `/api/session/${sessionId}/${action}`, body }),
    spawn: body => handle({ method: 'POST', pathname: '/api/session/spawn', body: { cwd, ...body } }) };
}

test('legacy stage REST creates a verified ownerless member and accepts first prompt once in each historical local realm', async t => {
  for (const realm of [['host', 'inert-operator'], ['urn:pi-dashboard:local-operator', 'local-operator']]) {
    const f = await fixture(t, realm);
    const input = { initialPrompt: 'Synthetic initial work', joinResWorkflow: true, creationEntryPoint: 'research-stage', requestId: 'stable-stage-request' };
    const first = await f.spawn(input), sessionId = first.body.data.sessionId;
    assert.equal(first.body.transmitted, true);
    const row = f.sessions.getSession(sessionId);
    assert.equal(row.principalOwner, undefined);
    assert.equal(row.pluginRefs['res-workflow'].sessionCreation.entryPoint, 'research-stage');
    assert.equal((await f.workbench.verifyParent({ parent: row, principal: f.operator })).ownerKey, JSON.stringify(realm));
    const duplicate = await f.spawn(input);
    assert.equal(duplicate.body.data.duplicate, true);
    assert.equal(duplicate.body.data.sessionId, sessionId);
    const history = await f.sessions.command(sessionId, { type: 'get_messages' });
    assert.equal(history.data.messages.filter(message => message.content === input.initialPrompt).length, 1);
  }
});

test('legacy prompt and pending UI response work over the actual detached native protocol', async t => {
  const f = await fixture(t);
  const created = await f.spawn({}), sessionId = created.body.data.sessionId;
  const prompt = await f.post(sessionId, 'prompt', { text: 'ask-ui', promptId: 'stable-question' });
  assert.deepEqual(prompt.body, { success: true, transmitted: true, promptId: 'stable-question' });
  await until(() => f.sessions.getSession(sessionId).pendingUIRequests.length === 1);
  const response = await f.post(sessionId, 'extension-ui-response', { requestId: 'fake-dialog', result: false });
  assert.equal(response.body.success, true);
  await until(() => f.sessions.getSession(sessionId).pendingUIRequests.length === 0);
  const journal = f.sessions.readEvents(sessionId).events;
  assert.equal(journal.filter(record => record.event.type === 'prompt_received' && record.event.promptId === 'stable-question').length, 1);
  assert.equal(journal.filter(record => record.event.type === 'extension_ui_resolved' && record.event.id === 'fake-dialog').length, 1);
});

test('ordinary native fork, archive, unarchive and continue preserve source bytes and exact child identity', async t => {
  const f = await fixture(t);
  const created = await f.spawn({}), sourceId = created.body.data.sessionId;
  const sourceFile = f.sessions.getSession(sourceId).sessionFile;
  const sourceBefore = fs.readFileSync(sourceFile);
  const forked = await f.post(sourceId, 'resume', { mode: 'fork' });
  const forkId = forked.body.data.sessionId, forkFile = forked.body.data.sessionFile;
  assert.notEqual(forkId, sourceId);
  assert.equal(forked.body.data.parentSessionId, sourceId);
  assert.equal(f.sessions.getSession(forkId).parentSessionId, sourceId);
  assert.equal(JSON.parse(fs.readFileSync(forkFile, 'utf8').split('\n', 1)[0]).parentSession, sourceFile);
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore);
  const archived = await f.post(forkId, 'archive');
  assert.equal(archived.body.success, true);
  await until(() => f.sessions.getSession(forkId).archived === true);
  assert.equal(f.sessions.getSession(forkId).live, false);
  assert.equal(f.sessions.getSession(sourceId).live, true);
  await f.post(forkId, 'unarchive');
  const ended = f.sessions.getSession(forkId);
  assert.equal(ended.archived, false);
  assert.equal(ended.live, false);
  const resumed = await f.post(forkId, 'resume', { mode: 'continue' });
  assert.equal(resumed.body.data.sessionId, forkId);
  assert.equal(resumed.body.data.sessionFile, forkFile);
  assert.equal(f.sessions.getSession(forkId).parentSessionId, sourceId);
  assert.equal(f.sessions.getSession(forkId).closedReason, undefined);
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore);
  await f.post(forkId, 'archive');
  const deleted = await f.handle({ method: 'DELETE', pathname: `/api/sessions/archived/${forkId}`, body: {} });
  assert.equal(deleted.body.success, true);
  assert.equal(f.sessions.getSession(forkId), undefined);
  assert.equal(fs.existsSync(forkFile), false);
  assert.equal(f.sessions.getSession(sourceId).live, true);
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore);
});
