import { randomUUID as releaseFixtureRandomUUID } from 'node:crypto';
const fixtureCredential1 = releaseFixtureRandomUUID();
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createAcpHost, buildAgentEnv, LineSplitter, createAcpConnection } from '../index.mjs';
import { readJson, sameProcess } from '../../../session-host/files.mjs';
import { connectWorker } from '../client.mjs';

const FAKE = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = check(); if (value) return value;
    if (Date.now() > deadline) throw new Error('Fixture condition timed out');
    await pause(10);
  }
}
function fixture(t, { durable = false, version = 1, env = {}, authorize } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-fixture-'));
  const stateDir = path.join(root, 'state'), cwd = path.join(root, 'work'), callLog = path.join(root, 'calls.jsonl');
  fs.mkdirSync(cwd);
  const messages = [];
  const options = { stateDir, agents: [{ id: 'fixture', name: 'Local Fixture', command: process.execPath,
    args: [FAKE, String(version)], env: { ACP_FAKE_LOG: callLog, ...env }, durable }], settings: { protocolV2: version === 2 },
    onMessage: message => messages.push(message), authorize };
  const host = createAcpHost(options);
  const hosts = [host];
  t.after(async () => { for (const item of hosts.reverse()) await item.dispose({ stopDurable: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = () => fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { host, options, root, cwd, messages, calls, hosts };
}
const settled = (messages, count = 1) => messages.filter(message => message.type === 'event_forward'
  && !message.replay && message.event.eventType === 'agent_settled').length >= count;

test('real stdio v1 handshake, exact bridge events and single user echo; no command/env leak', async t => {
  const f = fixture(t);
  assert.deepEqual(f.host.agents(), [{ id: 'fixture', name: 'Local Fixture' }]);
  const row = await f.host.start({ agent: 'fixture', cwd: f.cwd });
  assert.equal(row.driver, 'acp'); assert.equal(row.status, 'idle'); assert.equal(row.ready, true);
  assert.equal(f.host.getSession(row.id).model, 'acp:fixture/fake-model');
  await f.host.prompt(row.id, 'hello', { promptId: 'first' });
  await until(() => settled(f.messages));
  const init = f.calls().find(call => call.method === 'initialize');
  assert.equal(init.params.protocolVersion, 1);
  assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(f.calls().find(call => call.method === 'session/new').params, { cwd: f.cwd, mcpServers: [] });
  const events = f.messages.filter(message => message.type === 'event_forward').map(message => message.event);
  assert.equal(events.filter(event => event.eventType === 'message_end' && event.data.message.role === 'user').length, 1);
  assert.ok(events.some(event => event.eventType === 'message_end' && event.data.message.role === 'assistant'));
  assert.ok(events.some(event => event.eventType === 'tool_execution_end' && JSON.stringify(event.data).includes('artifact: result.txt')));
  assert.ok(f.messages.some(message => message.type === 'prompt_received' && message.promptId === 'first' && message.fresh));
  assert.equal(f.host.getSession(row.id).status, 'idle');
  const ended = await f.host.stop(row.id);
  assert.equal(ended.status, 'ended'); assert.equal(sameProcess(ended.process), false);
});

test('v2 exact ack/state behavior and model option changes', async t => {
  const f = fixture(t, { version: 2 });
  const row = await f.host.start({ agent: 'fixture', cwd: f.cwd });
  await f.host.send(row.id, { type: 'set_model', sessionId: row.id, provider: 'fixture', modelId: 'other-model' });
  await until(() => f.host.getSession(row.id).model === 'acp:fixture/other-model');
  await f.host.prompt(row.id, 'version-two', { promptId: 'v2' });
  await until(() => settled(f.messages));
  assert.ok(f.messages.some(message => message.type === 'prompt_received' && message.promptId === 'v2' && message.fresh));
  assert.equal(f.calls().find(call => call.method === 'initialize').params.protocolVersion, 2);
  assert.equal(f.host.getSession(row.id).status, 'idle');
});

test('busy prompt queue, duplicate receipts, conflicting ids and real cancel notification', async t => {
  const f = fixture(t);
  const row = await f.host.start({ agent: 'fixture', cwd: f.cwd });
  await f.host.prompt(row.id, 'hold', { promptId: 'hold' });
  await until(() => f.calls().some(call => call.method === 'session/prompt'));
  await f.host.prompt(row.id, 'queued', { promptId: 'next' });
  assert.equal(f.host.getSession(row.id).followUp.length, 1);
  assert.equal((await f.host.prompt(row.id, 'queued', { promptId: 'next' })).duplicate, true);
  await assert.rejects(f.host.prompt(row.id, 'changed', { promptId: 'next' }), { code: 'acp-prompt-id-conflict' });
  assert.equal(await f.host.cancel(row.id), true);
  await until(() => settled(f.messages, 2));
  assert.equal(f.calls().filter(call => call.method === 'session/prompt').length, 2);
  assert.equal(f.calls().filter(call => call.method === 'session/cancel').length, 1);
  assert.equal(f.host.getSession(row.id).followUp.length, 0);
});

test('permission waits for explicit response, maps option name to id and cancels on abort', async t => {
  const f = fixture(t);
  const row = await f.host.start({ agent: 'fixture', cwd: f.cwd });
  await f.host.prompt(row.id, 'permission', { promptId: 'permission-one' });
  const prompt = await until(() => f.messages.find(message => message.type === 'prompt_request'));
  assert.equal(f.host.getSession(row.id).status, 'waiting');
  assert.equal(f.calls().some(call => call.id >= 1001 && !call.method), false);
  await f.host.send(row.id, { type: 'prompt_response', sessionId: row.id, promptId: prompt.promptId, answer: 'Allow once' });
  await until(() => settled(f.messages));
  assert.deepEqual(f.calls().find(call => call.id === 1001 && !call.method).result.outcome, { outcome: 'selected', optionId: 'allow' });
  await f.host.prompt(row.id, 'permission', { promptId: 'permission-two' });
  await until(() => f.messages.filter(message => message.type === 'prompt_request').length === 2);
  await f.host.cancel(row.id);
  await until(() => settled(f.messages, 2));
  assert.deepEqual(f.calls().find(call => call.id === 1002 && !call.method).result.outcome, { outcome: 'cancelled' });
});

test('failed handshake is surfaced and ended, unsupported Pi controls refuse', async t => {
  const f = fixture(t, { env: { ACP_FAKE_START: 'invalid' } });
  const id = randomUUID();
  await assert.rejects(f.host.start({ agent: 'fixture', cwd: f.cwd, sessionId: id }), { code: 'acp-start-failed' });
  assert.equal(f.host.getSession(id).status, 'ended');
  assert.match(f.host.getSession(id).hostError, /unsupported ACP protocol version 99/);
  assert.equal(f.host.getSession(id).live, false);
  await assert.rejects(f.host.start({ agent: 'fixture', cwd: f.cwd, model: 'pi-model' }), { code: 'acp-pi-options-incompatible' });
});

test('durable worker survives host restart, replays genuine events, reuses receipts without resend', async t => {
  const f = fixture(t, { durable: true });
  const row = await f.host.start({ agent: 'fixture', cwd: f.cwd });
  await f.host.prompt(row.id, 'persist', { promptId: 'persistent' });
  await until(() => settled(f.messages));
  const initialPid = f.host.getSession(row.id).pid;
  await f.host.dispose();
  const messages = [];
  const second = createAcpHost({ ...f.options, onMessage: message => messages.push(message) });
  f.hosts.push(second);
  assert.equal(second.getSession(row.id).live, true);
  assert.equal(second.getSession(row.id).pid, initialPid);
  await second.reconnect(row.id);
  await until(() => messages.some(message => message.type === 'replay_complete'));
  assert.ok(messages.some(message => message.type === 'event_forward' && message.replay));
  assert.equal((await second.prompt(row.id, 'persist', { promptId: 'persistent' })).duplicate, true);
  assert.equal(f.calls().filter(call => call.method === 'session/prompt').length, 1);
  await second.prompt(row.id, 'after-restart', { promptId: 'after-restart' });
  await until(() => settled(messages));
  const ended = await second.stop(row.id);
  assert.equal(ended.live, false); assert.equal(sameProcess(ended.process), false);
});

test('durable private socket rejects a wrong capability; scoped local authorization is preserved', async t => {
  const f = fixture(t, { durable: true, authorize: (_action, _resource, principal) => principal === 'local' });
  await assert.rejects(f.host.start({ agent: 'fixture', cwd: f.cwd }, 'remote'), { code: 'acp-access-denied' });
  const row = await f.host.start({ agent: 'fixture', cwd: f.cwd }, 'local');
  const launch = readJson(path.join(f.options.stateDir, `${row.id}.launch.json`));
  await assert.rejects(connectWorker({ ...launch, capability: '0'.repeat(64) }));
  await assert.rejects(f.host.prompt(row.id, 'forbidden', { promptId: 'forbidden' }, 'remote'), { code: 'acp-access-denied' });
  assert.equal(f.calls().filter(call => call.method === 'session/prompt').length, 0);
  await f.host.stop(row.id, 'local');
});

test('ended legacy ACP sidecar restores without a fabricated Pi transcript or resume', async t => {
  const f = fixture(t);
  const id = randomUUID();
  fs.writeFileSync(path.join(f.options.stateDir, `${id}.meta.json`), JSON.stringify({ driver: 'acp', acpAgentId: 'old-agent', cwd: f.cwd, live: true, startedAt: 123 }), { mode: 0o600 });
  const row = f.host.getSession(id);
  assert.equal(row.driver, 'acp'); assert.equal(row.status, 'ended'); assert.equal(row.live, false);
  assert.equal(f.host.listSessions().length, 1);
  assert.equal(fs.existsSync(row.sessionFile), false);
  await f.host.updateSession(id, { archived: true });
  assert.equal((await f.host.deleteArchivedSession(id)).deleted, true);
  assert.equal(f.host.getSession(id), undefined);
  assert.equal((await f.host.deleteArchivedSession(id)).duplicate, true);
});

test('reserved environment isolation, bounded ACP line parser and unknown server request refusal', async () => {
  const env = buildAgentEnv({ PATH: '/bin', HOME: '/fixture', API_SECRET: 'not-forwarded', NODE_OPTIONS: '--inspect', PI_LOCAL_TOKEN: 'not-forwarded' },
    { API_KEY: fixtureCredential1, NODE_OPTIONS: '--inspect', PI_GATEWAY: 'reserved' });
  assert.deepEqual(env.env, { PATH: '/bin', HOME: '/fixture', API_KEY: fixtureCredential1 });
  assert.equal(env.warnings.length, 2);
  const splitter = new LineSplitter(8);
  assert.deepEqual(splitter.push(Buffer.from('123456789\nok\n')), ['ok']); assert.equal(splitter.discarded, 1);
  const input = new PassThrough(), output = new PassThrough();
  let reply = '';
  output.on('data', bytes => { reply += bytes; });
  const conn = createAcpConnection({ input, output, maxLineBytes: 10000, requestTimeoutMs: 100 });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: { path: '/private' } }) + '\n');
  await until(() => reply);
  assert.equal(JSON.parse(reply).error.code, -32601);
  conn.close(); input.destroy(); output.destroy();
});
