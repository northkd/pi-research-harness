import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createSessionHost } from '../../session-host/index.mjs';
import { maybeJson, sameProcess } from '../../session-host/files.mjs';
import { createNativeControlClient } from '../native-control-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

for (const external of [false, true]) test(`installed Pi1.3 ${external ? 'ordinary external context' : 'managed RPC'} reloads exact live settings with fresh generation proof and no model work`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-settings-reload-real-'));
  const cwd = path.join(root, 'project'), agent = path.join(root, 'agent'), homeDir = path.join(root, 'home'), stateDir = path.join(root, 'host');
  for (const directory of [cwd, agent, homeDir]) fs.mkdirSync(directory);
  const settingsFile = path.join(agent, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: true }, steeringMode: 'one-at-a-time' }));
  const extension = path.join(root, 'extension.mjs');
  fs.writeFileSync(extension, `import {registerNativeSessionControls,CONTROL_RECORD} from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'native-controls.mjs')).href)};
export default function(pi) {
  const controls=registerNativeSessionControls(pi, ${external ? "{publish:(result)=>pi.appendEntry(CONTROL_RECORD,{status:'applied',result})}" : '{}'});
  let ordinary;
  pi.on('session_start',async(event,ctx)=>{
    ordinary=ctx;
    if (${external} && event.reason==='reload') {
      const pending=await controls.apply({sessionId:ctx.sessionManager.getSessionId(),requestId:'actual-native-reload',action:'reload-settings'},ctx);
      pi.appendEntry('fixture-reload-pending',{pending:pending.pending,accepted:pending.accepted});
    }
  });
  pi.registerCommand('__fixture_settings',{handler(){pi.appendEntry('fixture-settings',{settings:pi.getSettings()});}});
  pi.registerCommand('__fixture_external_reload',{async handler(args){return controls.apply(JSON.parse(Buffer.from(args,'base64url').toString('utf8')),ordinary);}});
}
`);
  const sessions = createSessionHost({ stateDir, sessionsDir: path.join(root, 'history'),
    piCommand: process.env.PI_RESEARCH_TEST_LAUNCHER ?? path.join(os.homedir(), '.local/bin/pi'),
    piArgs: ['--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve', '-e', extension],
    env: { HOME: homeDir, PI_CODING_AGENT_DIR: agent, PI_RESEARCH_HOST_DIR: stateDir,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' }, startupTimeoutMs: 20_000, pollMs: 25 });
  let started;
  t.after(async () => {
    if (started) await sessions.terminate(started.sessionId);
    sessions.close();
    for (const row of sessions.listSessions()) {
      const status = maybeJson(path.join(stateDir, 'keepers', row.id, 'status.json'));
      if (status && sameProcess(status.keeper)) process.kill(status.keeper.pid, 'SIGTERM');
      for (let attempt = 0; status && sameProcess(status.keeper) && attempt < 200; attempt++) await pause(25);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  started = await sessions.createSession({ cwd, sessionId: external ? 'native-external-reload-fixture' : 'native-managed-reload-fixture' });
  const before = sessions.getSession(started.sessionId);
  fs.writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: false }, steeringMode: 'all', followUpMode: 'all' }));
  const pendingCommands = [];
  const facade = external ? { ...sessions,
    getSession: id => ({ ...sessions.getSession(id), external: true }),
    emitEventToSession(id, event) {
      const command = sessions.command(id, { type: 'prompt', message: '/__fixture_external_reload ' + Buffer.from(JSON.stringify(event.data)).toString('base64url') });
      command.catch(() => {}); pendingCommands.push(command);
    },
  } : sessions;
  const row = facade.getSession(started.sessionId);
  const result = await createNativeControlClient({ sessions: facade, timeoutMs: 15_000 }).apply(row, 'reload-settings', { requestId: 'actual-native-reload' });
  await Promise.all(pendingCommands);
  assert.equal(result.state, 'reloaded');
  assert.equal(result.accepted, true);
  assert.notEqual(result.generation, result.previousGeneration);
  assert.equal(result.process.pid, before.pid);
  assert.equal(sessions.getSession(started.sessionId).pid, before.pid);
  assert.equal(result.sessionFile, before.sessionFile);
  assert.equal(sessions.getSession(started.sessionId).sessionFile, before.sessionFile);
  const state = await sessions.command(started.sessionId, { type: 'get_state' });
  assert.equal(state.data.steeringMode, 'all');
  assert.equal(state.data.followUpMode, 'all');
  await sessions.command(started.sessionId, { type: 'prompt', message: '/__fixture_settings' });
  const journal = sessions.readEvents(started.sessionId, { limit: 2000 }).events;
  const proof = journal.findLast(entry => entry.event.type === 'entry_appended' && entry.event.entry.customType === 'fixture-settings').event.entry.data;
  assert.equal(proof.settings.compaction.enabled, false);
  assert.equal(result.settingsHash, digest(proof.settings));
  assert.equal(journal.some(entry => entry.event.type === 'agent_start'), false);
  if (external) assert.equal(journal.some(entry => entry.event.type === 'entry_appended' && entry.event.entry.customType === 'fixture-reload-pending' && entry.event.entry.data.pending === true && entry.event.entry.data.accepted === false), true);
  const repeated = await createNativeControlClient({ sessions: facade, timeoutMs: 15_000 }).apply(facade.getSession(started.sessionId), 'reload-settings', { requestId: 'actual-native-reload' });
  assert.equal(repeated.generation, result.generation);
});
