import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {protectChildModelSelection} from '../patches/subagents/support/research-model-selection.mjs';

const deepseek = {provider: 'cliproxy', id: 'deepseek-v4.1-flash[1m]', api: 'pi-messages'};
const sol = {provider: 'cliproxy', id: 'gpt-6.1-sol(max)[1m]', api: 'pi-messages'};
const auto = {provider: 'pi-auto-model', id: 'auto', api: 'pi-messages'};
function fixture(model = deepseek) {
  const calls = [], selections = [], thinking = [];
  const session = {
    model, thinkingLevel: 'high',
    agent: {streamFunction: (...args) => { calls.push(args); return 'stream'; }},
    async setModel(value, options) { this.model = value; selections.push({value, options}); },
    setThinkingLevel(value) { this.thinkingLevel = value; thinking.push(value); },
  };
  return {session, calls, selections, thinking};
}

test('a child restores its resolved model after ambient startup without persisting defaults', async () => {
  const f = fixture();
  const guard = protectChildModelSelection(f.session, deepseek);
  f.session.model = auto; f.session.thinkingLevel = 'low';
  await guard.restore();
  assert.equal(f.session.model, deepseek);
  assert.deepEqual(f.selections, [{value: deepseek, options: undefined}]);
  assert.deepEqual(f.thinking, ['high']);
  const context = {messages: []}, options = {signal: new AbortController().signal};
  assert.equal(f.session.agent.streamFunction(deepseek, context, options), 'stream');
  assert.deepEqual(f.calls, [[deepseek, context, options]]);
});

test('unchanged launch selection does not cause a new model selection or request', async () => {
  const f = fixture();
  await protectChildModelSelection(f.session, deepseek).restore();
  assert.deepEqual(f.selections, []);
  assert.deepEqual(f.calls, []);
});

test('later model drift blocks before the provider and cannot accept a different provider with the same id', async () => {
  const f = fixture();
  const guard = protectChildModelSelection(f.session, deepseek);
  await guard.restore();
  for (const candidate of [sol, {...deepseek, provider: 'another-provider'}, undefined]) {
    assert.throws(() => f.session.agent.streamFunction(candidate, {}, {}), error => {
      assert.equal(error.code, 'model_selection_changed');
      assert.equal(error.expectedModel, 'cliproxy/deepseek-v4.1-flash[1m]');
      assert.equal(guard.failure, error.message);
      return true;
    });
  }
  assert.equal(f.calls.length, 0);
  f.session.agent.streamFunction(deepseek, {}, {});
  assert.equal(guard.failure, undefined);
});

test('restore fails if a model_select hook refuses the launch model', async () => {
  const f = fixture();
  const guard = protectChildModelSelection(f.session, deepseek);
  f.session.model = auto;
  f.session.setModel = async () => { f.session.model = sol; };
  await assert.rejects(guard.restore(), {code: 'model_selection_changed'});
  assert.equal(f.calls.length, 0);
});

test('guards are session local and leave parent and sibling routing independent', async () => {
  const parent = fixture(auto), child = fixture(deepseek), sibling = fixture(sol);
  const originalParentStream = parent.session.agent.streamFunction;
  await protectChildModelSelection(child.session, deepseek).restore();
  await protectChildModelSelection(sibling.session, sol).restore();
  assert.equal(parent.session.agent.streamFunction, originalParentStream);
  child.session.agent.streamFunction(deepseek, {}, {});
  sibling.session.agent.streamFunction(sol, {}, {});
  parent.session.agent.streamFunction(auto, {}, {});
  assert.deepEqual([parent.calls.length, child.calls.length, sibling.calls.length], [1, 1, 1]);
});

test('native virtual routers remain supported; only the known legacy router is rejected before a request', async () => {
  const legacy = fixture(auto);
  assert.throws(() => protectChildModelSelection(legacy.session, auto), {code: 'model_router_verification_unsupported'});
  assert.equal(legacy.calls.length, 0);
  for (const virtual of [{provider: 'qa-router', id: 'auto', api: 'pi-virtual'}, {...auto, api: 'pi-virtual'}]) {
    const f = fixture(virtual);
    await protectChildModelSelection(f.session, virtual).restore();
    // Pi's prepareRequest routes the virtual selection before calling stream.
    f.session.agent.streamFunction(deepseek, {}, {});
    assert.equal(f.calls.length, 1);
    f.session.model = sol;
    assert.throws(() => f.session.agent.streamFunction(sol, {}, {}), {code: 'model_selection_changed'});
  }
});

test('missing stream enforcement fails before accepting an explicit selection', () => {
  assert.throws(() => protectChildModelSelection({model: deepseek, setModel() {}}, deepseek), /model_selection_guard_unavailable/);
});

test('the installed native helper has the same authenticated bytes as the tested source', () => {
  const metadata = JSON.parse(fs.readFileSync(new URL('../config/subagents-v020.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../patches/subagents/support/research-model-selection.mjs', import.meta.url));
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(metadata.files['src/runs/shared/research-model-selection.mjs'].afterSha256, hash);
  assert.equal(metadata.files['src/runs/shared/research-model-selection.mjs'].beforeSha256, null);
});
