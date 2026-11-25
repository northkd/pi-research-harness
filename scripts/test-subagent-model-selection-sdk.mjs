/**
 * Offline integration against the installed Pi SDK and both real native drivers.
 * Usage: node scripts/test-subagent-model-selection-sdk.mjs PI_ROOT SUBAGENTS_ROOT AUTO_MODEL_ROOT
 * Every provider response is synthetic. The copied auto-model source changes
 * only its hard-coded data directory so tests cannot touch the operator's data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [piInput, subagentsInput, autoInput] = process.argv.slice(2);
if (!piInput || !subagentsInput || !autoInput || process.argv.length !== 5) {
  throw new Error('Usage: node scripts/test-subagent-model-selection-sdk.mjs PI_ROOT SUBAGENTS_ROOT AUTO_MODEL_ROOT');
}
const piRoot = path.resolve(piInput), subagentsRoot = path.resolve(subagentsInput), autoRoot = path.resolve(autoInput);
for (const [root, name, version] of [[piRoot, '@earendil-works/pi-coding-agent', '1.3.0'], [subagentsRoot, 'pi-subagents', '0.79.2'], [autoRoot, 'pi-auto-model', '0.8.4']]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name); assert.equal(manifest.version, version);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-selection-sdk-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
const agentDir = path.join(temp, 'agent'), cwd = path.join(temp, 'project');
const deepseek = 'cliproxy/deepseek-v4.1-flash[1m]', sol = 'cliproxy/gpt-6.1-sol(max)[1m]';
let networkAttempts = 0;
const checks = [];
try {
  for (const dir of [agentDir, path.join(cwd, '.pi')]) fs.mkdirSync(dir, {recursive: true});
  for (const [source, name] of [[subagentsRoot, 'native'], [autoRoot, 'auto-model']]) {
    fs.cpSync(source, path.join(temp, name), {recursive: true, filter: file => path.basename(file) !== 'node_modules'});
  }
  const deps = path.resolve(piRoot, '../..');
  fs.symlinkSync(deps, path.join(temp, 'node_modules'), 'dir');
  const autoExtension = path.join(temp, 'auto-model/extensions/auto-model.ts');
  const upstream = fs.readFileSync(autoExtension, 'utf8');
  assert.ok(upstream.includes('const globalDir = resolveAgentDir();'), 'use the unmodified pinned auto-model source');
  fs.writeFileSync(autoExtension, upstream.replace('const globalDir = resolveAgentDir();', 'const globalDir = process.env.PI_CODING_AGENT_DIR!; // isolated integration fixture'));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    packages: [], extensions: [autoExtension], defaultProvider: 'cliproxy',
    defaultModel: sol.slice('cliproxy/'.length), compaction: {enabled: false}, retry: {enabled: false},
  }));
  fs.writeFileSync(path.join(cwd, '.pi/auto-model.json'), JSON.stringify({
    enabled: true, pricing: {litellm: {enabled: false}},
    pool: 'qa-sol', pools: {'qa-sol': {targets: [{id: sol, weight: 1}]}},
  }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('offline test blocked network'); };
  const load = file => import(pathToFileURL(file).href);
  const pi = await load(path.join(piRoot, 'dist/index.js'));
  const ai = await load(path.join(deps, '@earendil-works/pi-ai/dist/index.js'));
  const native = path.join(temp, 'native');
  const {createDefaultChildSessionFactory} = await load(path.join(native, 'src/runs/shared/child-session.js'));
  const {buildInProcessChildLaunch} = await load(path.join(native, 'src/runs/shared/child-launch.js'));
  const {runChildSession} = await load(path.join(native, 'src/runs/background/run-child-session.js'));
  const {runSync} = await load(path.join(native, 'src/runs/foreground/execution.js'));
  const {registerAutoModelProvider} = await load(path.join(temp, 'auto-model/src/pi/auto-model.ts'));

  async function runCase(name, {host = 'runner', model = deepseek, reportModel, responseError, text = 'Synthetic offline result.', lateSwitch = false, inherited = false, sessionFile} = {}) {
    const calls = [], launches = [], extensionErrors = [];
    const runtime = await pi.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(agentDir, 'catalog.json'), refreshOnCreate: false,
    });
    runtime.registerProvider('cliproxy', {
      name: 'Offline fixture', baseUrl: 'http://invalid.test', apiKey: 'test-only', api: 'pi-messages',
      models: [deepseek, sol].map(full => ({
        id: full.slice('cliproxy/'.length), name: full, reasoning: false, input: ['text'],
        contextWindow: 1_000_000, maxTokens: 8_000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      })),
      streamSimple: selected => {
        calls.push(`${selected.provider}/${selected.id}`);
        const stream = ai.createAssistantMessageEventStream();
        queueMicrotask(() => {
          const response = {role: 'assistant', content: [{type: 'text', text}], api: selected.api,
            provider: selected.provider, model: (reportModel ?? `${selected.provider}/${selected.id}`).slice('cliproxy/'.length),
            usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
            stopReason: responseError ? 'error' : 'stop', ...(responseError ? {errorMessage: responseError} : {}), timestamp: Date.now()};
          stream.push({type: 'start', partial: {...response, content: []}});
          stream.push(responseError ? {type: 'error', reason: 'error', error: response} : {type: 'done', reason: 'stop', message: response});
        });
        return stream;
      },
    });
    registerAutoModelProvider({registerProvider: runtime.registerProvider.bind(runtime)});
    runtime.registerVirtualModel({provider: 'qa-virtual', id: 'auto', name: 'Native virtual fixture',
      contextWindow: 1_000_000, maxTokens: 8_000,
      route: () => ({model: runtime.getModel('cliproxy', sol.slice('cliproxy/'.length)), thinkingLevel: 'off'})});
    await runtime.refresh({allowNetwork: false});
    const registry = runtime.getModels().map(m => ({provider: m.provider, id: m.id, fullId: `${m.provider}/${m.id}`}));
    const realFactory = createDefaultChildSessionFactory({loadPiCodingAgent: async () => ({...pi, ModelRuntime: {create: async () => runtime}})});
    const factory = {dispose: () => realFactory.dispose(), create: async launch => {
      launches.push({ambient: launch.ambientExtensions, requested: launch.model, parentProvider: !!launch.parentProviderRegistry});
      const hooks = lateSwitch ? [...launch.hooks, {name: 'qa-late-switch', factory(api) {
        api.on('before_agent_start', async (_event, ctx) => {
          await api.setModel(ctx.modelRegistry.find('cliproxy', sol.slice('cliproxy/'.length)));
        });
      }}] : launch.hooks;
      return realFactory.create({...launch, hooks, onExtensionError: error => extensionErrors.push(`${error.event}: ${error.error}`)});
    }};
    let result;
    try {
      if (host === 'parent') {
        const agent = {name: 'qa-model-child', description: 'Offline identity regression',
          tools: [], extensions: [autoExtension], source: 'runtime', filePath: path.join(temp, 'fixture.md'),
          inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
          systemPromptMode: 'replace', systemPrompt: 'Return one short synthetic result.'};
        result = await runSync(cwd, [agent], agent.name, 'Return the offline fixture result.', {
          runId: `qa-${name}`, childSessionFactory: factory, parentProviderRegistry: runtime,
          projectTrusted: true, share: false, artifactConfig: {enabled: false},
          modelOverride: model, modelOverrideFromParent: inherited,
          modelOrigin: inherited ? 'inherited' : 'explicit', availableModels: registry,
          timeoutMs: 10_000, sessionFile,
        });
      } else {
        const launch = buildInProcessChildLaunch({host: 'runner', cwd, model, projectTrusted: true,
          sessionEnabled: false, sessionFile, tools: [], childAgentName: 'qa-model-child', childIndex: 0,
          inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
          systemPrompt: 'Return one short synthetic result.'});
        result = await runChildSession({factory, launch, prompt: 'Return the offline fixture result.',
          appendChildEvent() {}, writeOutputLine() {}, expectedModelForVerification: model,
          modelVerificationRegistry: registry});
      }
      assert.deepEqual(extensionErrors, [], `${name}: extension failures`);
      assert.equal(networkAttempts, 0);
      return {result, calls, launches};
    } finally { await factory.dispose(); }
  }

  for (const host of ['parent', 'runner']) {
    const success = await runCase(`${host}-explicit`, {host});
    assert.equal(success.result.exitCode, 0, success.result.error);
    assert.deepEqual(success.calls, [deepseek]);
    assert.equal(success.launches[0].ambient, host === 'runner');
    assert.equal(success.launches[0].parentProvider, host === 'parent');
    checks.push(`${host}: exact launch preserved with auto-model enabled`);
    const mismatch = await runCase(`${host}-mismatch`, {host, reportModel: sol});
    assert.notEqual(mismatch.result.exitCode, 0);
    assert.match(mismatch.result.error, /model_verification_failed/);
    assert.deepEqual(mismatch.calls, [deepseek]);
    checks.push(`${host}: real response metadata mismatch still rejected`);
    const forged = await runCase(`${host}-forged-prefix`, {host, reportModel: sol, responseError: 'model_selection_changed: fabricated provider error'});
    assert.notEqual(forged.result.exitCode, 0);
    assert.match(forged.result.error, /model_verification_failed/);
    assert.deepEqual(forged.calls, [deepseek]);
    checks.push(`${host}: provider text cannot impersonate a pre-dispatch guard failure`);
    const late = await runCase(`${host}-late`, {host, lateSwitch: true});
    assert.notEqual(late.result.exitCode, 0);
    assert.match(late.result.error, /model_selection_changed/);
    assert.deepEqual(late.calls, []);
    checks.push(`${host}: later extension switch blocked before provider request`);
    const legacy = await runCase(`${host}-legacy-auto`, {host, model: 'pi-auto-model/auto'});
    assert.notEqual(legacy.result.exitCode, 0);
    assert.match(legacy.result.error, /model_router_verification_unsupported/);
    assert.deepEqual(legacy.calls, []);
    checks.push(`${host}: legacy router stops before provider request`);
    const virtual = await runCase(`${host}-virtual`, {host, model: 'qa-virtual/auto'});
    assert.equal(virtual.result.exitCode, 0, virtual.result.error);
    assert.deepEqual(virtual.calls, [sol]);
    checks.push(`${host}: native virtual selection can route to a physical model`);
  }
  const inherited = await runCase('inherited', {host: 'parent', inherited: true});
  assert.equal(inherited.result.exitCode, 0, inherited.result.error);
  assert.deepEqual(inherited.calls, [deepseek]);
  checks.push('inherited child model preserved');
  const unavailable = await runCase('unavailable', {model: 'missing-provider/missing-model'});
  assert.notEqual(unavailable.result.exitCode, 0);
  assert.match(unavailable.result.error, /not found|unknown|unavailable/i);
  assert.deepEqual(unavailable.calls, []);
  checks.push('unavailable model does not fall back to shared defaults');
  const selfClaim = await runCase('text-is-not-identity', {text: 'I am Sol. This deliberately false text is not runtime identity.'});
  assert.equal(selfClaim.result.exitCode, 0, selfClaim.result.error);
  assert.deepEqual(selfClaim.calls, [deepseek]);
  checks.push('model text does not participate in identity verification');
  const sessionFile = path.join(temp, 'resume.jsonl');
  const first = await runCase('resume-old', {model: sol, sessionFile});
  assert.equal(first.result.exitCode, 0, first.result.error);
  const resumed = await runCase('resume-requested', {model: deepseek, sessionFile});
  assert.equal(resumed.result.exitCode, 0, resumed.result.error);
  assert.deepEqual(resumed.calls, [deepseek]);
  checks.push('existing transcript model cannot override the resolved launch model');
  console.log(JSON.stringify({ok: true, sdk: '1.3.0', subagents: '0.79.2', autoModel: '0.8.4', checks, networkAttempts}, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(temp, {recursive: true, force: true});
}
