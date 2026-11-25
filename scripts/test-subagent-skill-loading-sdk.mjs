/**
 * Offline skill-prompt regression using the real pinned Pi SDK and native drivers.
 * Usage: node scripts/test-subagent-skill-loading-sdk.mjs PI_ROOT SUBAGENTS_ROOT [--baseline]
 * The provider is synthetic; no external model or credentials are used. --baseline
 * characterizes upstream 0.79.2's inherited fork catalog instead of requiring the fix.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const [piInput, subagentsInput, mode] = process.argv.slice(2);
if (!piInput || !subagentsInput || (mode !== undefined && mode !== '--baseline') || process.argv.length > 5) {
  throw new Error('Usage: node scripts/test-subagent-skill-loading-sdk.mjs PI_ROOT SUBAGENTS_ROOT [--baseline]');
}
const baseline = mode === '--baseline';
const piRoot = path.resolve(piInput), subagentsRoot = path.resolve(subagentsInput);
for (const [root, name, version] of [[piRoot, '@earendil-works/pi-coding-agent', '1.3.0'], [subagentsRoot, 'pi-subagents', '0.79.2']]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name); assert.equal(manifest.version, version);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-loading-sdk-'));
const agentDir = path.join(temp, 'agent'), cwd = path.join(temp, 'project');
const extensionSkillDir = path.join(temp, 'extension-skills');
const previousEnv = {PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE};
const previousFetch = globalThis.fetch;
const modelId = 'deepseek-v4-pro';
const checks = [], cases = [];
let networkAttempts = 0;
try {
  for (const dir of [agentDir, path.join(cwd, '.pi/agents'), extensionSkillDir]) fs.mkdirSync(dir, {recursive: true});
  const native = path.join(temp, 'native');
  fs.cpSync(subagentsRoot, native, {recursive: true, filter: file => path.basename(file) !== 'node_modules'});
  const deps = path.resolve(piRoot, '../..');
  fs.symlinkSync(deps, path.join(temp, 'node_modules'), 'dir');
  const allSkills = [];
  for (const [source, count, root] of [['global', 50, path.join(agentDir, 'skills')], ['project', 25, path.join(cwd, '.pi/skills')], ['extension', 25, extensionSkillDir]]) {
    for (let i = 0; i < count; i++) {
      const name = `qa-${source}-${String(i).padStart(3, '0')}`;
      const file = path.join(root, name, 'SKILL.md');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      const bodyMarker = `QA_SKILL_BODY_${name}`;
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: QA_SKILL_META_${name} Method-specific offline fixture for ${source} skill discovery and prompt selection. Read this file only when the task explicitly needs its procedure.\n---\n# ${name}\n${bodyMarker}\n${'Detailed method instructions are intentionally deferred until read.\n'.repeat(40)}`);
      allSkills.push({name, file, source, bodyMarker});
    }
  }
  const selectedGlobal = allSkills.find(skill => skill.source === 'global');
  const selectedProject = allSkills.find(skill => skill.source === 'project');
  fs.copyFileSync(path.join(repo, 'agents/research-theory.md'), path.join(cwd, '.pi/agents/research-theory.md'));
  fs.writeFileSync(path.join(cwd, '.pi/agents/qa-inheriting-agent.md'), '---\nname: qa-inheriting-agent\ndescription: Explicit inheritance control\ntools: read\ninheritSkills: true\ninheritProjectContext: false\ninheritGlobalContext: false\n---\nReturn a synthetic offline result.\n');
  const settings = {packages: [], extensions: [], defaultProvider: 'qa-offline', defaultModel: modelId,
    compaction: {enabled: false}, retry: {enabled: false}};
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({packages: [], extensions: []}));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  globalThis.fetch = async () => {networkAttempts++; throw new Error('offline test blocked network');};
  const load = file => import(pathToFileURL(file).href);
  const pi = await load(path.join(piRoot, 'dist/index.js'));
  const ai = await load(path.join(deps, '@earendil-works/pi-ai/dist/index.js'));
  const {createDefaultChildSessionFactory} = await load(path.join(native, 'src/runs/shared/child-session.js'));
  const {buildInProcessChildLaunch} = await load(path.join(native, 'src/runs/shared/child-launch.js'));
  const {runChildSession} = await load(path.join(native, 'src/runs/background/run-child-session.js'));
  const {buildEffectiveSystemPrompt} = await load(path.join(native, 'src/runs/shared/effective-system-prompt.js'));
  const {runSync} = await load(path.join(native, 'src/runs/foreground/execution.js'));
  const {discoverAgents} = await load(path.join(native, 'src/agents/agents.js'));
  const {resolveStepBehavior} = await load(path.join(native, 'src/runs/shared/child-launch-plan.js'));
  const {resolveSkillsWithFallback} = await load(path.join(native, 'src/agents/skills.js'));
  const fixtureResources = {name: 'qa-resources-discover', factory(api) {
    api.on('resources_discover', () => ({skillPaths: [extensionSkillDir]}));
  }};

  const discovery = () => discoverAgents(cwd, 'project', 'qa-offline', {projectTrusted: true, globalNpmRoot: path.join(temp, 'empty-global-node-modules')});
  function getAgent(name = 'research-theory') {
    const agent = discovery().agents.find(candidate => candidate.name === name);
    assert.ok(agent, `native agent discovery resolves ${name}`);
    return agent;
  }
  const defaultTheory = getAgent();
  assert.equal(defaultTheory.inheritSkills, false);
  assert.equal(defaultTheory.defaultContext, 'fresh');
  checks.push('research-theory resolved through native discovery with fresh context and no inherited skills');

  function inspectContext(context) {
    const system = context.messages.filter(message => message.role === 'system');
    const systemText = JSON.stringify(system);
    const fullText = JSON.stringify(context);
    const metadata = [...new Set([...fullText.matchAll(/QA_SKILL_META_(qa-[a-z]+-\d{3})/g)].map(match => match[1]))];
    const systemMetadata = [...new Set([...systemText.matchAll(/QA_SKILL_META_(qa-[a-z]+-\d{3})/g)].map(match => match[1]))];
    return {system, messages: context.messages, systemText, fullText, metadata, systemMetadata,
      systemChars: systemText.length, promptChars: fullText.length};
  }
  function record(name, call) {
    cases.push({name, systemSkillCount: call.systemMetadata.length, requestSkillCount: call.metadata.length,
      systemChars: call.systemChars, requestChars: call.promptChars});
  }
  async function runtimeFor(calls, {readSkill} = {}) {
    const runtime = await pi.ModelRuntime.create({authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(agentDir, 'catalog.json'), refreshOnCreate: false});
    runtime.registerProvider('qa-offline', {name: 'Offline fixture', baseUrl: 'http://invalid.test', apiKey: 'test-only', api: 'pi-messages',
      models: [{id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow: 1_000_000, maxTokens: 8_000,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
      streamSimple: (selected, context) => {
        calls.push(inspectContext(context));
        const stream = ai.createAssistantMessageEventStream();
        queueMicrotask(() => {
          const toolUse = readSkill && calls.length === 1;
          const content = toolUse
            ? [{type: 'toolCall', id: 'qa-read-selected-skill', name: 'read', arguments: {path: readSkill.file}}]
            : [{type: 'text', text: 'Synthetic offline result.'}];
          const response = {role: 'assistant', content, api: selected.api, provider: selected.provider, model: selected.id,
            usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
            stopReason: toolUse ? 'toolUse' : 'stop', timestamp: Date.now()};
          stream.push({type: 'start', partial: {...response, content: []}});
          stream.push({type: 'done', reason: response.stopReason, message: response});
        });
        return stream;
      }});
    await runtime.refresh({allowNetwork: false});
    return runtime;
  }
  async function runMain(name) {
    const calls = [], extensionErrors = [];
    const runtime = await runtimeFor(calls);
    const settingsManager = pi.SettingsManager.create(cwd, agentDir);
    const loader = new pi.DefaultResourceLoader({cwd, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, extensionFactories: [fixtureResources]});
    await loader.reload();
    const sessionManager = pi.SessionManager.create(cwd, path.join(temp, name));
    const {session} = await pi.createAgentSession({cwd, agentDir, modelRuntime: runtime,
      model: runtime.getModel('qa-offline', modelId), tools: ['read'], resourceLoader: loader, sessionManager, settingsManager});
    try {
      await session.bindExtensions({onError: error => extensionErrors.push(String(error.error)), mode: 'headless'});
      await session.prompt('QA_PARENT_HISTORY: Keep this derivation assumption in inherited history.');
      assert.deepEqual(extensionErrors, []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].metadata.length, 100);
      assert.doesNotMatch(calls[0].fullText, /QA_SKILL_BODY_/);
      record(name, calls[0]);
      return {file: sessionManager.getSessionFile(), id: sessionManager.getSessionId(), calls};
    } finally {await session.dispose();}
  }
  const parent = await runMain('main-before');
  const parentBytes = fs.readFileSync(parent.file, 'utf8');
  checks.push('main session sees all 100 global, project and resources_discover skill summaries, with no bodies');

  async function runCase(name, {agent = getAgent(), host = 'parent', context = 'fresh', skills, readSkill} = {}) {
    const calls = [], launches = [], extensionErrors = [];
    const runtime = await runtimeFor(calls, {readSkill});
    const registry = runtime.getModels().map(model => ({provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}`}));
    const realFactory = createDefaultChildSessionFactory({loadPiCodingAgent: async () => ({...pi, ModelRuntime: {create: async () => runtime}})});
    const factory = {dispose: () => realFactory.dispose(), create: async launch => {
      launches.push({noSkills: launch.noSkills, forkCacheKey: launch.forkCacheKey});
      return realFactory.create({...launch, hooks: [...launch.hooks, fixtureResources],
        onExtensionError: error => extensionErrors.push(`${error.event}: ${error.error}`)});
    }};
    const behavior = resolveStepBehavior(agent, skills === undefined ? {} : {skills});
    const selected = behavior.skills === false ? [] : behavior.skills;
    let sessionFile;
    if (context === 'fork') {
      // Pi identifies inherited messages using strict timestamp order. Wait only for
      // the next millisecond when the synthetic provider was faster than that clock.
      await new Promise(resolve => setTimeout(resolve, 2));
      sessionFile = pi.SessionManager.forkFrom(parent.file, cwd, path.join(temp, name)).getSessionFile();
    }
    let result;
    try {
      if (host === 'parent') {
        result = await runSync(cwd, [agent], agent.name, 'Return the offline derivation fixture result.', {
          runId: `qa-${name}`, childSessionFactory: factory, parentProviderRegistry: runtime, context,
          projectTrusted: true, share: false, artifactConfig: {enabled: false}, modelOverride: `qa-offline/${modelId}`,
          modelOrigin: 'explicit', availableModels: registry, timeoutMs: 10_000, skills: selected,
          sessionFile, ...(context === 'fork' ? {parentSessionId: parent.id, parentSessionFile: parent.file} : {}),
        });
      } else {
        const {resolved} = resolveSkillsWithFallback(selected, cwd, cwd, agent.skillPath, path.dirname(agent.filePath));
        const launch = buildInProcessChildLaunch({host: 'runner', cwd, model: `qa-offline/${modelId}`, projectTrusted: true,
          sessionEnabled: Boolean(sessionFile), sessionFile, tools: agent.tools, childAgentName: agent.name, childIndex: 0,
          inheritProjectContext: agent.inheritProjectContext, inheritGlobalContext: agent.inheritGlobalContext,
          inheritSkills: agent.inheritSkills, systemPromptMode: agent.systemPromptMode,
          systemPrompt: buildEffectiveSystemPrompt({agent, resolvedSkills: resolved, cwd}),
          ...(context === 'fork' ? {forkCacheKey: parent.id, parentSessionId: parent.id} : {}),
          requireReadTool: selected.length > 0});
        result = await runChildSession({factory, launch, prompt: 'Return the offline derivation fixture result.',
          appendChildEvent() {}, writeOutputLine() {}, expectedModelForVerification: `qa-offline/${modelId}`,
          modelVerificationRegistry: registry});
      }
      assert.equal(result.exitCode, 0, `${name}: ${result.error}`);
      assert.deepEqual(extensionErrors, [], `${name}: extension failures`);
      assert.ok(calls.length >= 1, `${name}: provider receives request`);
      assert.doesNotMatch(calls[0].fullText, /QA_SKILL_BODY_/, `${name}: no preloaded skill bodies`);
      assert.equal(fs.readFileSync(parent.file, 'utf8'), parentBytes, `${name}: parent history remains unchanged`);
      assert.equal(networkAttempts, 0);
      record(name, calls[0]);
      return {result, calls, launches, sessionFile};
    } finally {await factory.dispose();}
  }
  for (const host of ['parent', 'runner']) {
    const fresh = await runCase(`${host}-fresh-default`, {host});
    assert.equal(fresh.calls[0].metadata.length, 0);
    checks.push(`${host}: native fresh research-theory excludes all 100 ambient skill summaries`);
    const fork = await runCase(`${host}-fork-default`, {host, context: 'fork'});
    assert.equal(fork.calls[0].metadata.length, baseline ? 100 : 0);
    assert.match(fork.calls[0].fullText, /QA_PARENT_HISTORY/);
    assert.ok(fork.calls[0].system.some(message => Array.isArray(message.toolsAdded) && message.toolsAdded.some(tool => tool.name === 'read')));
    checks.push(`${host}: fork ${baseline ? 'reproduces inherited 100-skill catalog' : 'excludes inherited catalog while preserving conversation and parent tool declarations'}`);
  }
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({subagents: {agentOverrides: {'research-theory': {inheritSkills: true}}}}));
  const overridden = getAgent();
  assert.equal(overridden.inheritSkills, true);
  const inherited = await runCase('explicit-inherit-true', {agent: overridden});
  assert.equal(inherited.calls[0].metadata.length, 100);
  checks.push('explicit native inheritSkills:true override retains opt-in catalog inheritance');
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({packages: [], extensions: []}));
  for (const selected of [[selectedGlobal.name], [selectedGlobal.name, selectedProject.name]]) {
    const explicit = await runCase(`fresh-selected-${selected.length}`, {skills: selected});
    assert.deepEqual(explicit.calls[0].metadata.sort(), [...selected].sort());
    const fork = await runCase(`fork-selected-${selected.length}`, {context: 'fork', skills: selected});
    if (!baseline) assert.deepEqual(fork.calls[0].metadata.sort(), [...selected].sort());
  }
  const disabled = await runCase('explicit-skills-false', {agent: {...getAgent(), skills: [selectedGlobal.name]}, skills: false});
  assert.equal(disabled.calls[0].metadata.length, 0);
  checks.push('explicit selection injects only one/two summaries, and skills:false cancels configured selection');
  const onDemand = await runCase('selected-body-read-on-demand', {skills: [selectedGlobal.name], readSkill: selectedGlobal});
  assert.equal(onDemand.calls.length, 2);
  assert.match(onDemand.calls[1].fullText, new RegExp(selectedGlobal.bodyMarker));
  assert.doesNotMatch(onDemand.calls[1].systemText, /QA_SKILL_BODY_/);
  checks.push('selected SKILL.md body appears only after the actual read tool result, never in system prompt');
  const other = await runCase('other-agent-inheritance', {agent: getAgent('qa-inheriting-agent')});
  assert.equal(other.calls[0].metadata.length, 100);
  await runMain('main-after');
  checks.push('other agent and main session retain their skill catalogs; parent session file stays byte-identical');
  console.log(JSON.stringify({ok: true, baseline, versions: {pi: '1.3.0', subagents: '0.79.2'},
    fixtureSkills: {global: 50, project: 25, resources_discover: 25}, networkAttempts, cases, checks}, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(temp, {recursive: true, force: true});
}
