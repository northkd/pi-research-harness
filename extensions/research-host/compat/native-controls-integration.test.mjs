import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createSessionHost } from '../session-host/index.mjs';
import { maybeJson, sameProcess, processIdentity } from '../session-host/files.mjs';
import { createSessionCompatibility } from './session.mjs';
import { nativeControlReceipt } from './native-controls.mjs';
import { createNativeControlClient } from './native-control-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('installed Pi selects offline models, reads native thinking and abort state, and applies context without model work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-controls-'));
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), homeDir = path.join(root, 'home');
  for (const directory of [cwd, agent, homeDir]) fs.mkdirSync(directory);
  const stateDir = path.join(root, 'host');
  const sessions = createSessionHost({ stateDir, sessionsDir: path.join(root, 'history'),
    piCommand: process.env.PI_RESEARCH_TEST_LAUNCHER ?? path.join(os.homedir(), '.local/bin/pi'),
    piArgs: ['--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve',
      '-e', path.join(HERE, 'native-controls.mjs')],
    env: { HOME: homeDir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
    startupTimeoutMs: 20_000, pollMs: 25 });
  let handle;
  t.after(async () => {
    handle?.dispose(); sessions.close();
    for (const row of sessions.listSessions()) {
      const status = maybeJson(path.join(stateDir, 'keepers', row.id, 'status.json'));
      if (status && sameProcess(status.keeper)) process.kill(status.keeper.pid, 'SIGTERM');
      for (let attempt = 0; status && sameProcess(status.keeper) && attempt < 200; attempt++) await pause(25);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const started = await sessions.createSession({ cwd, sessionId: 'real-native-control-fixture' });
  const provider = 'offline-refresh-fixture', model = 'offline-refresh-model', reasoningModel = 'offline-thinking-model';
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
    baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'synthetic-test-value', models: [{
      id: model, name: model, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, { id: reasoningModel, name: reasoningModel, reasoning: true, input: ['text'], contextWindow: 8192, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });
  const refreshed = await createNativeControlClient({ sessions }).apply(sessions.getSession(started.sessionId), 'refresh-models', {});
  assert.equal(refreshed.state, 'refreshed');
  assert.equal(refreshed.allowNetwork, false);
  const available = await sessions.command(started.sessionId, { type: 'get_available_models' });
  assert.equal(available.success, true);
  assert.equal(available.data.models.some(candidate => candidate.provider === provider && candidate.id === model), true);
  const withModels = await createNativeControlClient({ sessions }).apply(sessions.getSession(started.sessionId), 'refresh-models', { includeModels: true });
  assert.equal(withModels.models.some(candidate => candidate.provider === provider && candidate.id === model), true);
  assert.equal(withModels.models.every(candidate => Object.keys(candidate).every(key => ['provider', 'id', 'name', 'reasoning', 'input', 'contextWindow', 'thinkingLevelMap'].includes(key))), true);
  assert.equal(JSON.stringify(withModels.models).includes('synthetic-test-value'), false);
  const native = createNativeControlClient({ sessions });
  const selected = await native.apply(sessions.getSession(started.sessionId), 'set-model', { provider, modelId: model });
  assert.equal(selected.provider, provider);
  assert.equal(selected.modelId, model);
  const clamped = await native.apply(sessions.getSession(started.sessionId), 'set-thinking-level', { level: 'high' });
  assert.equal(clamped.level, 'off');
  assert.equal(clamped.clamped, true);
  await native.apply(sessions.getSession(started.sessionId), 'set-model', { provider, modelId: reasoningModel });
  const thinking = await native.apply(sessions.getSession(started.sessionId), 'set-thinking-level', { level: 'high' });
  assert.equal(thinking.level, 'high');
  const state = await sessions.command(started.sessionId, { type: 'get_state' });
  assert.equal(state.data.model.provider, provider);
  assert.equal(state.data.model.id, reasoningModel);
  assert.equal(state.data.thinkingLevel, 'high');
  const aborted = await native.apply(sessions.getSession(started.sessionId), 'abort', {});
  assert.equal(aborted.idle, true);
  assert.equal(aborted.alreadyIdle, true);
  const commands = await native.apply(sessions.getSession(started.sessionId), 'list-commands', {});
  assert.equal(commands.commands.some(command => command.name === '__research_host_control' && command.source === 'extension'), true);
  await assert.rejects(native.apply(sessions.getSession(started.sessionId), 'set-model', { provider, modelId: 'missing-model' }), { code: 'native-model-not-found' });
  const workbench = { accessFor: async scopedCwd => ({ cwd: scopedCwd, canReadHistory: async () => true, revalidate: async () => {} }) };
  handle = createSessionCompatibility({ sessions, workbench, localOperatorPrincipal: { iss: 'synthetic', sub: 'operator' } });
  const post = (action, body) => handle({ method: 'POST', pathname: `/api/session/${started.sessionId}/${action}`, body });
  const attached = await post('attach-proposal', { changeName: 'real-native-proposal' });
  assert.equal(attached.body.data.contextState, 'applied');
  assert.equal(sessions.getSession(started.sessionId).attachedProposal, 'real-native-proposal');
  assert.equal(sessions.getSession(started.sessionId).name, 'real-native-proposal');
  const detached = await post('detach-proposal', {});
  assert.equal(detached.body.data.contextState, 'applied');
  assert.equal(sessions.getSession(started.sessionId).attachedProposal, null);
  const stopped = await post('lifecycle', { action: 'stop_after_turn', requestId: 'graceful-stop-fixture' });
  assert.equal(stopped.body.success, true);
  const journal = sessions.readEvents(started.sessionId, { limit: 2000 }).events;
  const receipts = journal.map(entry => nativeControlReceipt(entry.event)).filter(Boolean);
  assert.equal(receipts.filter(receipt => receipt.action === 'refresh-models').length, 2);
  assert.equal(receipts.filter(receipt => receipt.action === 'proposal-context' && receipt.accepted).length, 2);
  assert.equal(receipts.find(receipt => receipt.action === 'stop_after_turn')?.state, 'armed');
  assert.equal(journal.some(entry => entry.event.type === 'agent_start'), false);
  const normal = await sessions.createSession({ cwd, sessionId: 'real-native-graceful-shutdown' });
  const worker = processIdentity(normal.pid);
  assert.ok(worker);
  const requested = await native.apply(sessions.getSession(normal.sessionId), 'shutdown', {});
  assert.equal(requested.state, 'shutdown-requested');
  assert.equal('stopped' in requested, false);
  for (let attempt = 0; sameProcess(worker) && attempt < 200; attempt++) await pause(25);
  assert.equal(sameProcess(worker), false);
  for (let attempt = 0; sessions.getSession(normal.sessionId).live && attempt < 100; attempt++) await pause(25);
  assert.equal(sessions.getSession(normal.sessionId).live, false);
  const forced = await post('lifecycle', { action: 'force_kill' });
  assert.equal(forced.body.success, true);
  assert.equal(sessions.getSession(started.sessionId).live, false);
});
