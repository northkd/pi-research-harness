import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerNativeSettingsReload, RELOAD_COMMAND } from './index.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-settings-reload-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
  fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
  const settingsFile = path.join(agentDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: false } }));
  const receipts = [];
  let reloads = 0;
  let sourceChanged = false;
  let failAfterInitialization = false;
  function instance() {
    let stale = false;
    const commands = new Map(), hooks = new Map();
    const pi = {
      registerCommand: (name, value) => commands.set(name, value),
      on: (name, handler) => hooks.set(name, handler),
      getSettings: () => { assert.equal(stale, false); return JSON.parse(fs.readFileSync(settingsFile)); },
      getCommands: () => [...commands.keys()].map(name => ({ name })),
      appendEntry: (_type, data) => { assert.equal(stale, false); receipts.push(data.result); },
      sendUserMessage(message, options) {
        assert.deepEqual(options, { expandPromptTemplates: true });
        const [name, args] = message.slice(1).split(' ');
        assert.equal(name, RELOAD_COMMAND);
        commands.get(name).handler(args, ctx).catch(() => {});
      },
    };
    const ctx = { cwd, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => 'reload-session', getSessionFile: () => path.join(root, 'native.jsonl') },
      async reload() {
        reloads++; stale = true;
        const handoff = JSON.parse(fs.readFileSync(path.join(root, 'host', 'native-reload', 'reload-session', 'r-reload-request.json')));
        assert.equal(handoff.status, 'pending');
        if (sourceChanged) fs.writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: true } }));
        const next = instance();
        await next.hooks.get('session_start')({ reason: 'reload' }, next.ctx);
        if (failAfterInitialization) throw new Error('Synthetic post-initialization failure');
      },
    };
    const runtime = registerNativeSettingsReload(pi, { stateDir: path.join(root, 'host'), agentDir, timeoutMs: 150 });
    t.after(() => runtime.dispose());
    return { pi, ctx, hooks, runtime };
  }
  return { root, receipts, instance, reloads: () => reloads, changeDuringReload: () => { sourceChanged = true; },
    failAfterInitialization: () => { failAfterInitialization = true; },
    request: { sessionId: 'reload-session', requestId: 'reload-request', action: 'reload-settings' } };
}

test('only the fresh instance confirms native reload, and a repeated request cannot reload again', async t => {
  const f = fixture(t), first = f.instance();
  const result = await first.runtime.apply(f.request, first.ctx);
  assert.equal(result.state, 'reloaded');
  assert.equal(result.accepted, true);
  assert.notEqual(result.generation, result.previousGeneration);
  assert.equal(result.previousGeneration, first.runtime.generation);
  assert.equal(result.sessionFile, first.ctx.sessionManager.getSessionFile());
  assert.equal(result.process.pid, process.pid);
  assert.equal(f.reloads(), 1);
  const fresh = f.instance();
  assert.deepEqual(await fresh.runtime.apply(f.request, fresh.ctx), result);
  assert.equal(f.reloads(), 1);
});

test('ordinary external context dispatches only its registered command and never enters prompt/model handling', async t => {
  const f = fixture(t), first = f.instance();
  const { reload, ...ordinary } = first.ctx;
  const result = await first.runtime.apply(f.request, ordinary);
  assert.equal(result.state, 'reloaded');
  assert.equal(f.reloads(), 1);
  assert.equal(f.receipts.length, 1);
});

test('busy, queued and changed settings cannot produce a reload success receipt', async t => {
  const f = fixture(t), first = f.instance();
  await assert.rejects(first.runtime.apply(f.request, { ...first.ctx, isIdle: () => false }), /reload-busy/);
  await assert.rejects(first.runtime.apply(f.request, { ...first.ctx, hasPendingMessages: () => true }), /reload-busy/);
  assert.equal(f.reloads(), 0);
  assert.equal(fs.existsSync(path.join(f.root, 'host')), false);
  f.changeDuringReload();
  await assert.rejects(first.runtime.apply(f.request, first.ctx), /proof-mismatch/);
  assert.equal(f.receipts.length, 0);
});

test('a fresh initialization cannot confirm success before the actual reload call returns', async t => {
  const f = fixture(t), first = f.instance();
  f.failAfterInitialization();
  await assert.rejects(first.runtime.apply(f.request, first.ctx), /native-settings-reload-failed/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.receipts.length, 0);
});
