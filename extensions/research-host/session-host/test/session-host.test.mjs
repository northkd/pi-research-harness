import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSessionHost } from '../index.mjs';
import { maybeJson, sameProcess, processIdentity } from '../files.mjs';
import { createSessionJournal, readSessionJournal } from '../journal.mjs';
import { extractSessionUpdates, extractNativeSessionUpdates } from '../event-status.mjs';
import { readTranscriptPage } from '../../transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { const value = await predicate(); if (value) return value; await pause(20); }
  assert.fail('Synthetic process did not reach expected state');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-host-test-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const options = { stateDir: path.join(root, 'host'), sessionsDir: path.join(root, 'history'),
    piCommand: process.execPath, piArgs: [path.join(HERE, 'fake-pi.mjs')], env: {}, pollMs: 20, startupTimeoutMs: 5000 };
  let host = createSessionHost(options);
  t.after(async () => {
    host.close();
    for (const row of host.listSessions()) {
      const status = maybeJson(path.join(options.stateDir, 'keepers', row.id, 'status.json'));
      if (status && sameProcess(status.keeper)) process.kill(status.keeper.pid, 'SIGTERM');
      await until(() => !status || !sameProcess(status.keeper));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, options, get host() { return host; }, restart() { host.close(); host = createSessionHost(options); return host; } };
}

test('a detached keeper preserves exact native identity and once-only prompt acceptance across host restart', async t => {
  const f = fixture(t);
  const started = await f.host.createSession({ cwd: f.cwd, sessionId: 'synthetic-child' });
  assert.equal(started.success, true);
  const firstPid = f.host.getSession(started.sessionId).pid;
  let accepted = 0;
  f.host.subscribeReceiptAcks((sessionId, promptId) => { if (sessionId === started.sessionId && promptId === 'synthetic-result') accepted++; });
  assert.equal(await f.host.notifyParent(started.sessionId, 'Synthetic result', 'synthetic-result'), true);
  await until(() => accepted === 1);
  const history = await f.host.command(started.sessionId, { type: 'get_messages' });
  assert.equal(history.data.messages.length, 1);
  const restarted = f.restart();
  assert.equal(restarted.getSession(started.sessionId).pid, firstPid);
  assert.equal(await restarted.notifyParent(started.sessionId, 'Synthetic result', 'synthetic-result'), true);
  assert.equal((await restarted.command(started.sessionId, { type: 'get_messages' })).data.messages.length, 1);
  const replay = restarted.readEvents(started.sessionId);
  assert.equal(replay.events.filter(item => item.event.type === 'prompt_received').length, 2);
  assert.ok(replay.events.every((entry, index) => index === 0 || entry.sequence > replay.events[index - 1].sequence));
  assert.equal(restarted.readEvents(started.sessionId, { after: replay.nextCursor }).events.length, 0);
  assert.equal((await restarted.createSession({ cwd: f.cwd, sessionId: started.sessionId })).duplicate, true);
  assert.equal(restarted.getSession(started.sessionId).pid, firstPid);
});

test('pending native dialogs survive client reconnect and resolve only after a matching response', async t => {
  const f = fixture(t);
  await f.host.createSession({ cwd: f.cwd, sessionId: 'synthetic-dialog' });
  await f.host.command('synthetic-dialog', { type: 'prompt', message: 'ask-ui' });
  await until(() => f.host.getSession('synthetic-dialog').pendingUIRequests.length === 1);
  const restarted = f.restart();
  assert.equal(restarted.getSession('synthetic-dialog').pendingUIRequests[0].id, 'fake-dialog');
  await assert.rejects(restarted.respondUI('synthetic-dialog', { type: 'extension_ui_response', id: 'wrong', confirmed: true }), /not-pending/);
  await restarted.respondUI('synthetic-dialog', { type: 'extension_ui_response', id: 'fake-dialog', confirmed: true });
  assert.equal(restarted.getSession('synthetic-dialog').pendingUIRequests.length, 0);
  const records = restarted.readEvents('synthetic-dialog');
  assert.equal(records.events.filter(item => item.event.type === 'extension_ui_resolved').length, 1);
  await until(() => restarted.getSession('synthetic-dialog').eventCursor >= records.nextCursor);
});

test('managed pending spawn preserves provenance and readOnly and registers before the initial task is accepted', async t => {
  const f = fixture(t), order = [];
  f.host.close();
  const host = createSessionHost({ ...f.options, onRegistered: (sessionId, registration, rawRef) => {
    assert.equal(rawRef.researchSession.readOnly, true);
    assert.equal(host.getSession(sessionId).researchSession.readOnly, true);
    assert.equal(fs.readFileSync(registration.sessionFile, 'utf8').trim().split('\n').length, 1);
    order.push('registered');
  } });
  t.after(() => host.close());
  host.pendingPluginRefRegistry.file('synthetic-token', { resWorkflow: { canonicalCwd: f.cwd, joinedAt: new Date().toISOString(), via: 'spawn' },
    researchSession: { readOnly: true, role: 'synthetic-worker', parentSessionId: 'synthetic-parent' } }, 'res-workflow');
  host.initialPrompts.enqueue(f.cwd, 'Synthetic bounded assignment', 'synthetic-token');
  const result = await host.spawn(f.cwd, { spawnToken: 'synthetic-token' });
  assert.equal(result.success, true); assert.deepEqual(order, ['registered']);
  const status = maybeJson(path.join(f.options.stateDir, 'keepers', result.sessionId, 'status.json'));
  t.after(async () => { if (sameProcess(status.keeper)) process.kill(status.keeper.pid, 'SIGTERM'); await until(() => !sameProcess(status.keeper)); });
  await until(async () => (await host.command(result.sessionId, { type: 'get_messages' })).data.messages.length === 1);
  const again = await host.spawn(f.cwd, { spawnToken: 'synthetic-token' });
  assert.equal(again.sessionId, result.sessionId);
  assert.equal(host.getSession(result.sessionId).researchSession.readOnly, true);
});

test('external interactive sessions retain durable messages until actual acknowledgement', async t => {
  const f = fixture(t), file = path.join(f.options.sessionsDir, 'external.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'synthetic-external', cwd: f.cwd }) + '\n');
  f.host.registerExternalSession({ sessionId: 'synthetic-external', cwd: f.cwd, sessionFile: file });
  assert.equal(await f.host.notifyParent('synthetic-external', 'Synthetic request', 'synthetic-external-request'), true);
  const restarted = f.restart();
  assert.equal(restarted.externalInbox('synthetic-external').length, 1);
  restarted.acknowledgeExternal('synthetic-external', 'synthetic-external-request');
  assert.equal(restarted.externalInbox('synthetic-external').length, 0);
  assert.equal(await restarted.notifyParent('synthetic-external', 'Synthetic request', 'synthetic-external-request'), true);
  assert.equal(restarted.externalInbox('synthetic-external').length, 0);
  restarted.updateSession('synthetic-external', { researchSession: { readOnly: true }, name: 'Synthetic' });
  restarted.updateSession('synthetic-external', { name: undefined });
  assert.equal(restarted.getSession('synthetic-external').name, undefined);
  assert.equal(restarted.getSession('synthetic-external').researchSession.readOnly, true);
  restarted.recordExternalEvent('synthetic-external', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'synthetic' } });
  restarted.emitEventToSession('synthetic-external', { eventId: 'synthetic-flow-event', eventType: 'flow:run', data: { requestId: 'synthetic' } });
  const again = f.restart();
  assert.equal(again.readEvents('synthetic-external').events[0].event.assistantMessageEvent.delta, 'synthetic');
  assert.equal(again.eventInbox('synthetic-external')[0].eventId, 'synthetic-flow-event');
  again.acknowledgeEvent('synthetic-external', 'synthetic-flow-event');
  assert.deepEqual(again.eventInbox('synthetic-external'), []);
});

test('native header identity wins over a legacy filename while parent lineage survives restart', async t => {
  const f = fixture(t);
  const parentFile = path.join(f.options.sessionsDir, '2026-01-01_filename-id.jsonl');
  const childFile = path.join(f.options.sessionsDir, '2026-01-01_child-file.jsonl');
  fs.writeFileSync(parentFile, JSON.stringify({ type: 'session', version: 3, id: 'native-header-parent', cwd: f.cwd }) + '\n');
  fs.writeFileSync(childFile, JSON.stringify({ type: 'session', version: 3, id: 'native-header-child', cwd: f.cwd }) + '\n');
  fs.writeFileSync(childFile.replace('.jsonl', '.meta.json'), JSON.stringify({ researchSession: { parentSessionId: 'native-header-parent', readOnly: true } }));
  f.host.refreshHistory();
  assert.equal(f.host.getSession('native-header-parent').sessionFile, parentFile);
  assert.equal(f.host.getSession('filename-id'), undefined);
  const restarted = f.restart();
  assert.equal(restarted.getSession('native-header-child').researchSession.parentSessionId, 'native-header-parent');
  assert.equal(restarted.getSession('native-header-child').researchSession.readOnly, true);
});

test('missing project directories preserve verified history and refuse resume without creating a directory', async t => {
  const f = fixture(t), sid = 'synthetic-missing-project';
  const cwd = path.join(f.root, 'removed-project'), file = path.join(f.options.sessionsDir, 'removed.jsonl');
  fs.writeFileSync(file, [
    { type: 'session', version: 3, id: sid, cwd },
    { type: 'message', id: 'retained-message', message: { role: 'user', content: 'Synthetic retained history' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const source = fs.readFileSync(file);
  f.host.refreshHistory();
  const restarted = f.restart(), row = restarted.getSession(sid);
  assert.equal(row.cwd, cwd); assert.equal(row.cwdMissing, true);
  assert.equal(row.resumeAvailable, false); assert.equal(row.live, false);
  const page = await readTranscriptPage(row, {}, { sessionsDir: f.options.sessionsDir });
  assert.equal(page.entries[0].id, 'retained-message');
  await assert.rejects(restarted.createSession({ cwd, sessionId: sid, resume: true }), /session-cwd-missing/);
  assert.equal(fs.existsSync(cwd), false); assert.deepEqual(fs.readFileSync(file), source);
  fs.mkdirSync(cwd);
  assert.equal(restarted.getSession(sid).cwdMissing, false);
});

test('verified legacy UUID links resolve one canonical session durably and control the same keeper', async t => {
  const f = fixture(t), sid = 'synthetic-canonical-native';
  const alias = '11111111-1111-4111-8111-111111111111';
  const file = path.join(f.options.sessionsDir, '2026-01-01T00-00-00-000Z_' + alias + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, cwd: f.cwd }) + '\n');
  fs.writeFileSync(file.replace('.jsonl', '.meta.json'), JSON.stringify({ legacySessionIds: ['unverified-alias'] }));
  f.host.refreshHistory();
  const source = fs.readFileSync(file), restarted = f.restart();
  assert.equal(restarted.resolveSessionId(alias), sid);
  assert.equal(restarted.getSession(alias).id, sid);
  assert.deepEqual(restarted.getSession(alias).legacySessionIds, [alias]);
  assert.equal(restarted.getSession('unverified-alias'), undefined);
  assert.equal(restarted.listSessions().length, 1);
  assert.deepEqual(fs.readFileSync(file), source);
  assert.deepEqual(maybeJson(path.join(f.options.stateDir, 'records', sid + '.json')).legacySessionIds, [alias]);
  const started = await restarted.createSession({ cwd: f.cwd, sessionId: alias, resume: true });
  assert.equal(started.sessionId, sid); assert.equal(started.sessionFile, file);
  await restarted.deliverPrompt(alias, { text: 'Synthetic alias delivery', promptId: 'alias-prompt' });
  assert.equal((await restarted.command(alias, { type: 'get_messages' })).data.messages.length, 1);
  assert.ok(restarted.readEvents(alias).events.length > 0);
  assert.equal((await restarted.terminate(alias)).stopped, true);
});

test('ambiguous legacy filename UUIDs never merge independent native files', t => {
  const f = fixture(t), alias = '22222222-2222-4222-8222-222222222222';
  for (let i = 0; i < 2; i++) {
    const file = path.join(f.options.sessionsDir, '2026-01-0' + (i + 1) + 'T00-00-00-000Z_' + alias + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'independent-native-' + i, cwd: f.cwd }) + '\n');
  }
  f.host.refreshHistory();
  assert.equal(f.host.listSessions().length, 2);
  assert.throws(() => f.host.getSession(alias), /alias-ambiguous/);
  for (const row of f.host.listSessions()) {
    assert.deepEqual(row.legacySessionIds, []); assert.deepEqual(row.legacyAliasConflicts, [alias]);
  }
});

test('delivery mode and image submission are accepted once and exact worker stop waits for keeper exit', async t => {
  const f = fixture(t), sid = 'synthetic-delivery';
  await f.host.createSession({ cwd: f.cwd, sessionId: sid });
  const images = [{ type: 'image', mimeType: 'image/png', data: 'synthetic-base64' }];
  assert.equal((await f.host.deliverPrompt(sid, { text: 'Synthetic image request', images, delivery: 'followUp', promptId: 'synthetic-image' })).accepted, true);
  const message = (await f.host.command(sid, { type: 'get_messages' })).data.messages[0];
  assert.equal(message.streamingBehavior, 'followUp'); assert.deepEqual(message.images, images);
  assert.equal((await f.host.deliverPrompt(sid, { text: 'Synthetic image request', images, delivery: 'followUp', promptId: 'synthetic-image' })).duplicate, true);
  await assert.rejects(f.host.deliverPrompt(sid, { text: 'Synthetic image request', images, delivery: 'steer', promptId: 'synthetic-image' }), /idempotency-conflict/);
  const status = maybeJson(path.join(f.options.stateDir, 'keepers', sid, 'status.json'));
  assert.equal((await f.host.terminate(sid)).stopped, true);
  assert.equal(sameProcess(status.worker), false); assert.equal(sameProcess(status.keeper), false);
  assert.equal(f.host.getSession(sid).status, 'ended');
});

test('indexed journal replay reads a small suffix of a high-volume journal and preserves cursors on writer restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-journal-volume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = createSessionJournal(directory), content = 'x'.repeat(1024);
  for (let sequence = 1; sequence <= 40_000; sequence++) journal.append({ type: 'message_update', content }, false);
  journal.close();
  assert.ok(fs.statSync(path.join(directory, 'events.jsonl')).size > 40 * 1024 * 1024);
  const page = readSessionJournal(directory, { after: 39_900, limit: 10 });
  assert.equal(page.events[0].sequence, 39_901); assert.equal(page.nextCursor, 39_910); assert.equal(page.lastSequence, 40_000);
  assert.ok(page.scannedBytes < 256 * 1024);
  const restarted = createSessionJournal(directory);
  assert.equal(restarted.append({ type: 'agent_settled' }).sequence, 40_001); restarted.close();
  const tail = readSessionJournal(directory, { after: 40_000, limit: 10 });
  assert.equal(tail.events.length, 1); assert.equal(tail.nextCursor, 40_001); assert.equal(tail.lastSequence, 40_001);
  assert.ok(tail.scannedBytes < 256 * 1024);
});

test('native status follows settled lifecycle and leaves supervision and nested tool events inert', () => {
  assert.equal(extractSessionUpdates({ eventType: 'mainline_supervision:updated', data: { enabled: true } }), null);
  assert.equal(extractNativeSessionUpdates({ type: 'agent_end' }), null);
  assert.deepEqual(extractNativeSessionUpdates({ type: 'agent_settled' }), { status: 'idle', currentTool: null });
  assert.equal(extractNativeSessionUpdates({ type: 'tool_execution_start', parentToolCallId: 'outer', toolName: 'bash' }), null);
});

test('automatic retirement retains adopted work and closes idle native stdin gracefully after exact revalidation', async t => {
  const f = fixture(t), sid = 'synthetic-retirement';
  const started = await f.host.createSession({ cwd: f.cwd, sessionId: sid });
  await f.host.deliverPrompt(sid, { text: 'hold-stream', promptId: 'synthetic-active-work' });
  const refused = await f.host.retireIfIdle(sid, { pid: started.pid, reportId: 'synthetic-report' });
  assert.equal(refused.committed, false); assert.equal(refused.reason, 'session-retirement-busy');
  assert.equal(f.host.getSession(sid).pid, started.pid);
  await f.host.abort(sid);
  const result = await f.host.retireIfIdle(sid, { pid: started.pid, reportId: 'synthetic-report' });
  assert.equal(result.retired, true); assert.equal(result.committed, true); assert.equal(result.workerExited, true);
  const ended = maybeJson(path.join(f.options.stateDir, 'keepers', sid, 'status.json'));
  assert.equal(ended.exitCode, 0); assert.equal(ended.signal, null);
  assert.equal((await f.host.retireIfIdle(sid, { pid: started.pid, reportId: 'synthetic-report' })).retired, true);
  assert.equal(f.host.readEvents(sid).events.filter(entry => entry.event.type === 'session_retirement_committed').length, 1);
});

test('automatic retirement refuses queued messages, compaction, UI and a changed native PID', async t => {
  const f = fixture(t), sid = 'synthetic-retirement-refusals';
  const started = await f.host.createSession({ cwd: f.cwd, sessionId: sid });
  const retire = () => f.host.retireIfIdle(sid, { pid: started.pid, reportId: 'synthetic-refusal-report' });
  await f.host.command(sid, { type: 'fake_control', pendingMessageCount: 1 });
  assert.equal((await retire()).reason, 'session-retirement-pending');
  await f.host.command(sid, { type: 'fake_control', pendingMessageCount: 0, compacting: true });
  assert.equal((await retire()).reason, 'session-retirement-compacting');
  await f.host.command(sid, { type: 'fake_control', compacting: false });
  await f.host.command(sid, { type: 'prompt', message: 'ask-ui' });
  await until(() => f.host.getSession(sid).pendingUIRequests.length === 1);
  await f.host.command(sid, { type: 'fake_control', streaming: false });
  assert.equal((await retire()).reason, 'session-retirement-ui-pending');
  const wrongPid = await f.host.retireIfIdle(sid, { pid: started.pid + 1, reportId: 'synthetic-refusal-report' });
  assert.equal(wrongPid.committed, false); assert.equal(wrongPid.reason, 'session-retirement-identity-mismatch');
});

test('a prompt queued during final retirement revalidation cannot activate after commit', async t => {
  const f = fixture(t), sid = 'synthetic-retirement-race';
  const started = await f.host.createSession({ cwd: f.cwd, sessionId: sid });
  await f.host.command(sid, { type: 'fake_control', stateDelayMs: 100 });
  const retirement = f.host.retireIfIdle(sid, { pid: started.pid, reportId: 'synthetic-race-report' });
  await pause(20);
  const delivery = f.host.deliverPrompt(sid, { text: 'Late synthetic task', promptId: 'synthetic-late-task' });
  const [retired, delivered] = await Promise.allSettled([retirement, delivery]);
  assert.equal(retired.status, 'fulfilled'); assert.equal(retired.value.retired, true);
  assert.equal(delivered.status, 'rejected');
  const history = fs.readFileSync(started.sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(history.filter(entry => entry.message?.role === 'user').length, 0);
  assert.equal(f.host.readEvents(sid).events.filter(entry => entry.event.type === 'prompt_received' && entry.event.promptId === 'synthetic-late-task').length, 0);
});

test('external prompt delivery waits exact native acknowledgement and retains timed-out requests for replay', async t => {
  const f = fixture(t), sid = 'synthetic-external-acceptance', file = path.join(f.options.sessionsDir, sid + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, cwd: f.cwd }) + '\n');
  f.host.registerExternalSession({ sessionId: sid, cwd: f.cwd, sessionFile: file });
  const images = [{ type: 'image', mimeType: 'image/png', data: 'synthetic-image' }];
  const prompt = { text: 'Synthetic interactive task', promptId: 'synthetic-interactive-request', images, delivery: 'followUp', acceptanceTimeoutMs: 1000 };
  let accepted = false;
  const waiting = f.host.deliverPrompt(sid, prompt).then(value => { accepted = true; return value; });
  await pause(20);
  assert.equal(accepted, false);
  assert.equal(f.host.externalInbox(sid)[0].delivery, 'followUp');
  assert.deepEqual(f.host.externalInbox(sid)[0].images, images);
  f.host.acknowledgeExternal(sid, prompt.promptId);
  assert.equal((await waiting).accepted, true);
  assert.equal((await f.host.deliverPrompt(sid, prompt)).duplicate, true);
  await assert.rejects(f.host.deliverPrompt(sid, { ...prompt, delivery: 'steer' }), /idempotency-conflict/);
  const unknown = { text: 'Synthetic deferred request', promptId: 'synthetic-deferred', acceptanceTimeoutMs: 25 };
  await assert.rejects(f.host.deliverPrompt(sid, unknown), error => error.code === 'session-prompt-acceptance-unconfirmed' && error.pending === true);
  const restarted = f.restart();
  assert.equal(restarted.externalInbox(sid).length, 1);
  await assert.rejects(restarted.deliverPrompt(sid, unknown), /acceptance-unconfirmed/);
  assert.equal(restarted.externalInbox(sid).length, 1);
});

test('archive deletion requires ended native identity and remains consistent after host restart', async t => {
  const f = fixture(t), sid = 'synthetic-archive-delete';
  const started = await f.host.createSession({ cwd: f.cwd, sessionId: sid });
  f.host.updateSession(sid, { archived: true });
  assert.throws(() => f.host.deleteArchivedSession(sid), /not-safe/);
  await f.host.terminate(sid);
  assert.equal(f.host.deleteArchivedSession(sid).deleted, true);
  assert.equal(fs.existsSync(started.sessionFile), false);
  assert.equal(fs.existsSync(started.sessionFile.replace('.jsonl', '.meta.json')), false);
  assert.equal(f.host.getSession(sid), undefined);
  assert.equal(f.restart().getSession(sid), undefined);
  await assert.rejects(f.host.createSession({ cwd: f.cwd, sessionId: sid }), /was-deleted/);
});

test('an interrupted archive deletion finishes its exact sidecar and host record before loading history', t => {
  const f = fixture(t), sid = 'synthetic-partial-delete', file = path.join(f.options.sessionsDir, 'legacy-file.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, cwd: f.cwd }) + '\n');
  const meta = file.replace('.jsonl', '.meta.json');
  fs.writeFileSync(meta, JSON.stringify({ id: sid, cwd: f.cwd, archived: true, status: 'ended' }));
  f.host.importSession(file);
  const witness = target => { const stat = fs.statSync(target); return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }; };
  const deletion = { schema: 'pi-research-session-deletion.v1', sessionId: sid, cwd: f.cwd, sessionFile: file,
    source: witness(file), meta: witness(meta), complete: false };
  fs.writeFileSync(path.join(f.options.stateDir, 'deletions', sid + '.json'), JSON.stringify(deletion), { mode: 0o600 });
  fs.unlinkSync(file);
  const restarted = f.restart();
  assert.equal(restarted.getSession(sid), undefined);
  assert.equal(fs.existsSync(meta), false);
  assert.equal(fs.existsSync(path.join(f.options.stateDir, 'records', sid + '.json')), false);
});

test('native event rejection preserves exact payload proof across restart and never becomes an acceptance', t => {
  const f = fixture(t), sid = 'synthetic-rejected-event', file = path.join(f.options.sessionsDir, sid + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, cwd: f.cwd }) + '\n');
  f.host.registerExternalSession({ sessionId: sid, cwd: f.cwd, sessionFile: file });
  const event = { eventId: 'synthetic-flow-request', eventType: 'flow:run', data: { flowId: 'synthetic-flow' } };
  assert.equal(f.host.emitEventToSession(sid, event).queued, true);
  assert.deepEqual(f.host.rejectEvent(sid, event.eventId, 'native-flow-receiver-unavailable'), {
    rejected: true, reason: 'native-flow-receiver-unavailable',
  });
  assert.deepEqual(f.host.eventInbox(sid), []);
  const restarted = f.restart();
  const replay = restarted.emitEventToSession(sid, event);
  assert.equal(replay.rejected, true); assert.equal(replay.accepted, false); assert.equal(replay.queued, false);
  assert.equal(replay.reason, 'native-flow-receiver-unavailable');
  assert.deepEqual(restarted.eventInbox(sid), []);
  assert.throws(() => restarted.emitEventToSession(sid, { ...event, data: { flowId: 'changed-flow' } }), /idempotency-conflict/);
  assert.throws(() => restarted.acknowledgeEvent(sid, event.eventId), /was-rejected/);
  assert.equal(restarted.rejectEvent(sid, event.eventId, 'native-flow-receiver-unavailable').duplicate, true);
  assert.throws(() => restarted.rejectEvent(sid, event.eventId, 'different-reason'), /rejection-conflict/);
});

test('parallel native tool identities persist across reconnect and only matching witnessed ends clear them', async t => {
  const f = fixture(t), sid = 'synthetic-active-tools';
  await f.host.createSession({ cwd: f.cwd, sessionId: sid });
  const emit = event => f.host.command(sid, { type: 'fake_event', event });
  await emit({ type: 'tool_execution_start', toolCallId: 'read-call', toolName: 'read' });
  await emit({ type: 'tool_execution_start', toolCallId: 'bash-call', toolName: 'bash' });
  assert.equal(f.host.getSession(sid).currentTool, 'bash');
  assert.deepEqual(f.host.getSession(sid).activeToolCalls.map(call => call.toolCallId), ['read-call', 'bash-call']);
  await emit({ type: 'tool_execution_end', toolCallId: 'unknown-call' });
  assert.equal(f.host.getSession(sid).currentTool, 'bash');
  assert.equal(f.host.getSession(sid).activeToolCalls.length, 2);
  f.restart();
  assert.equal(f.host.getSession(sid).activeToolCalls.length, 2);
  await emit({ type: 'tool_execution_start', toolCallId: 'read-call/nested', parentToolCallId: 'read-call', toolName: 'nested-tool' });
  assert.equal(f.host.getSession(sid).currentTool, 'bash');
  await emit({ type: 'tool_execution_end', toolCallId: 'read-call' });
  assert.deepEqual(f.host.getSession(sid).activeToolCalls.map(call => call.toolCallId), ['bash-call', 'read-call/nested']);
  await emit({ type: 'tool_execution_end', toolCallId: 'bash-call' });
  await emit({ type: 'agent_settled' });
  const unresolved = f.host.getSession(sid);
  assert.equal(unresolved.currentTool, null);
  assert.deepEqual(unresolved.activeToolCalls.map(call => [call.toolCallId, call.phase]), [['read-call/nested', 'unknown']]);
  const retirement = await f.host.retireIfIdle(sid, { pid: unresolved.pid, reportId: 'synthetic-unresolved-tool' });
  assert.equal(retirement.committed, false); assert.equal(retirement.reason, 'session-retirement-tools-unresolved');
  await emit({ type: 'tool_execution_end', toolCallId: 'read-call/nested' });
  assert.deepEqual(f.host.getSession(sid).activeToolCalls, []);
});

test('external native process observation verifies identity and observes exit without signalling caller-supplied PIDs', async t => {
  const f = fixture(t), sid = 'synthetic-external-process', file = path.join(f.options.sessionsDir, sid + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, cwd: f.cwd }) + '\n');
  const children = [1, 2].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
      if (child.exitCode === null && !child.signalCode) await new Promise(resolve => child.once('exit', resolve));
    }
  });
  const first = await until(() => processIdentity(children[0].pid));
  const second = await until(() => processIdentity(children[1].pid));
  const input = { sessionId: sid, cwd: f.cwd, sessionFile: file, status: 'idle', process: first };
  assert.throws(() => f.host.registerExternalSession({ ...input, process: { ...first, startTime: '0' } }), /unverified/);
  assert.equal(f.host.getSession(sid), undefined);
  const row = f.host.registerExternalSession(input);
  assert.equal(row.live, true); assert.equal(row.pid, first.pid); assert.deepEqual(row.nativeExternalProcess, first);
  assert.equal(f.host.registerExternalSession(input).pid, first.pid);
  assert.throws(() => f.host.registerExternalSession({ ...input, process: second }), /process-conflict/);
  assert.equal(sameProcess(first), true); assert.equal(sameProcess(second), true);
  children[0].kill('SIGTERM'); await new Promise(resolve => children[0].once('exit', resolve));
  assert.equal(f.host.getSession(sid).live, false); assert.equal(f.host.getSession(sid).status, 'ended');
  assert.equal(f.host.getSession(sid).pid, undefined);
  const rebound = f.host.registerExternalSession({ ...input, process: second });
  assert.equal(rebound.pid, second.pid); assert.equal(rebound.live, true);
});
