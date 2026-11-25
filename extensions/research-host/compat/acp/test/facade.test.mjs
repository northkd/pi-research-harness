import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSessionHost } from '../../../session-host/index.mjs';
import { createAcpHost, createAcpSessionFacade } from '../index.mjs';
import { createAutomationSpawner } from '../../../supplemental/automation-spawn.mjs';

const fakeAcp = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const fakePi = fileURLToPath(new URL('../../../session-host/test/fake-pi.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await pause(20); }
  throw new Error('Synthetic facade condition timed out');
}

test('CI cutover: actual native keeper and ACP stdio share facade, dialogs, event cursors and Automation spawn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-facade-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const native = createSessionHost({ stateDir: path.join(root, 'native'), sessionsDir: path.join(root, 'history'),
    piCommand: process.execPath, piArgs: [fakePi], env: {}, pollMs: 20, startupTimeoutMs: 5000 });
  const acp = createAcpHost({ stateDir: path.join(root, 'acp'), agents: [{ id: 'fixture', name: 'Fixture',
    command: process.execPath, args: [fakeAcp, '1'], env: {}, durable: true }] });
  const sessions = createAcpSessionFacade({ native, acp });
  t.after(async () => {
    await acp.dispose({ stopDurable: true });
    for (const row of native.listSessions()) if (row.live) await native.terminate(row.id);
    native.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const nativeStarted = await sessions.createSession({ cwd, sessionId: 'native-control' });
  assert.equal(nativeStarted.success, true);
  const acpId = randomUUID();
  const acpStarted = await sessions.startAcp({ agent: 'fixture', cwd, sessionId: acpId, spawnToken: 'acp-user-token' });
  assert.equal(acpStarted.success, true); assert.equal(acpStarted.driver, 'acp');
  assert.equal(sessions.listSessions().length, 2);
  assert.equal((await sessions.command('native-control', { type: 'prompt', message: 'native-control-prompt' })).success, true);
  assert.equal((await sessions.command(acpId, { type: 'prompt', message: 'permission' })).success, true);
  const pending = await until(() => sessions.getSession(acpId).pendingUIRequests[0]);
  assert.equal(pending.method, 'select');
  assert.equal((await sessions.respondUi(acpId, { type: 'extension_ui_response', id: pending.id, value: 'Allow once' })).success, true);
  await until(() => sessions.getSession(acpId).status === 'idle');
  assert.equal(sessions.getSession(acpId).pendingUIRequests.length, 0);
  const journal = sessions.readEvents(acpId, { after: 0, limit: 200 });
  assert.ok(journal.events.some(entry => entry.event.type === 'event_forward' && entry.event.event.eventType === 'tool_execution_end'));
  assert.equal(sessions.readEvents(acpId, { after: journal.nextCursor, limit: 200 }).events.length, 0);
  assert.equal((await sessions.command(acpId, { type: 'get_messages' })).success, false);
  assert.equal((await sessions.command(acpId, { type: 'set_thinking_level', level: 'high' })).success, false);
  assert.equal((await sessions.abort(acpId)).success, true);

  const automation = createAutomationSpawner({ createSession: sessions.createSession, spawnAcp: sessions.startAcp,
    authorizeCwd: value => value === cwd });
  const request = { cwd, agent: 'fixture', spawnToken: 'automation-run-1', initialPrompt: 'Synthetic automation initial task',
    pluginRef: { automationRun: { runId: 'run-1' } }, lifecycle: { recover: false } };
  const spawned = await automation(request);
  assert.equal(spawned.success, true);
  assert.equal(sessions.getSession(spawned.sessionId).initialPromptStatus, 'accepted');
  assert.deepEqual(sessions.getSession(spawned.sessionId).automationRun, { runId: 'run-1' });
  const duplicate = await automation(request);
  assert.equal(duplicate.success, true); assert.equal(duplicate.duplicate, true);
  await until(() => sessions.getSession(spawned.sessionId).status === 'idle');
  const entries = sessions.readEvents(spawned.sessionId, { limit: 200 }).events;
  assert.equal(entries.filter(entry => entry.event.type === 'event_forward' && entry.event.event.eventType === 'message_end'
    && entry.event.event.data.message.role === 'user').length, 1);
  assert.equal((await sessions.terminate(acpId)).stopped, true);
  assert.equal((await sessions.terminate(spawned.sessionId)).stopped, true);
});
