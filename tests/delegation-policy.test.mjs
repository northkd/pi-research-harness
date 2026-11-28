import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildDelegationGuidance,
  delegationPolicyDisabled,
  detectDelegationRestrictions,
  detectDelegationTools,
  mergeDelegationRestrictions,
  registerDelegationPolicy,
} from '../extensions/research-loop/src/delegation-policy.mjs';
import { scheduleResearchSubagent } from '../extensions/research-loop/src/subagent-scheduling.mjs';

function mockPi() {
  const handlers = new Map();
  return {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {
        const list = handlers.get(name);
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(name, event, ctx = { sessionManager: { getSessionId: () => 'session-1' } }) {
      let result;
      for (const handler of handlers.get(name) ?? []) {
        const value = handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
  };
}

const startEvent = (prompt, selectedTools) => ({
  messageType: 'user',
  prompt,
  systemPromptOptions: { selectedTools },
});
const readEnd = (overrides = {}) => ({ toolName: 'read', isError: false, ...overrides });
const joined = () => true;
const modelPolicy = JSON.parse(readFileSync(new URL('../extensions/research-loop/model-policy.json', import.meta.url), 'utf8'));

test('pi-subagents capability is detected only from the active subagent tool', () => {
  const caps = detectDelegationTools(['read', 'subagent']);
  assert.equal(caps.known, true);
  assert.equal(caps.available, true);
  assert.deepEqual(caps.families, ['pi-subagents']);
  assert.equal(caps.piSubagents, true);
  const text = buildDelegationGuidance({ selectedTools: ['read', 'subagent'] });
  const primaryWorker = modelPolicy.tiers.worker.models[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(text, new RegExp(`subagent\\(\\{ agent: "scout", task: .*model: "${primaryWorker}", async: true, options: \\{ context: "fresh" \\} \\}\\)`));
  assert.match(text, /do not use the old `subagent\(agentName, prompt\)` form/);
  assert.match(text, /never wait for a bulk-read threshold/i);
  assert.doesNotMatch(text, /Agent\(\{ subagent_type/);
  assert.doesNotMatch(text, /SubagentWorkflow\(\{/);
});

test('rendered tier chains and utility example match the release model policy in both routing modes', () => {
  for (const selectedTools of [['subagent'], ['subagent', 'research_dispatch']]) {
    const text = buildDelegationGuidance({ selectedTools });
    for (const [tier, label] of [['worker', 'Worker'], ['commander', 'Commander'], ['intelligence', 'Intelligence']]) {
      const config = modelPolicy.tiers[tier];
      const order = [...config.models, ...(config.fallbackChain ?? [])].join(' -> ');
      const line = text.split('\n').find(value => value.startsWith(`- ${label} order: `));
      assert.ok(line.startsWith(`- ${label} order: ${order}. `), `${tier} must preserve every policy model in order`);
    }
    assert.ok(text.includes(`model: ${JSON.stringify(modelPolicy.tiers.worker.models[0])}, async: true`));
  }
});

test('standalone routing selects utility roles before bulk work and passes tier models dynamically', () => {
  const text = buildDelegationGuidance({ selectedTools: ['read', 'subagent'] });
  assert.match(text, /Standalone \/ non-research routing/);
  assert.match(text, /scout, researcher, reviewer, evidence-auditor, worker, oracle and delegate/);
  assert.match(text, /research-\* scientific roles only when explicitly requested/);
  assert.match(text, /unknown multi-directory or log searches go to parallel scout tasks/);
  assert.match(text, /post-edit diff\/compliance checks to reviewer/);
  assert.match(text, /isolated build\/fix work to worker/);
  assert.match(text, /Never hold back subagent calls/);
  assert.match(text, /explicit top-level model dynamically/);
  const worker = text.split('\n').find(line => line.startsWith('- Worker order:'));
  const ordered = [...modelPolicy.tiers.worker.models, ...(modelPolicy.tiers.worker.fallbackChain ?? [])];
  for (let index = 1; index < ordered.length; index++) assert.ok(worker.indexOf(ordered[index - 1]) < worker.indexOf(ordered[index]));
  const commander = text.split('\n').find(line => line.startsWith('- Commander order:'));
  const commanderOrder = modelPolicy.tiers.commander.models.join(' -> ');
  assert.ok(commander.includes(commanderOrder));
  assert.match(text, /gpt-6\.2-astra\(high\)\[1m\].*gpt-6\.2-astra\(xhigh\)\[1m\]/);
  assert.match(text, /confirmation of the exact model \+ effort before executing agy or agy-subagent/);
  assert.match(text, /contact_supervisor.*ask_user/);
});

test('either active research tool selects full catalog routing and never restricts subagents', () => {
  for (const tool of ['research_session', 'research_dispatch']) {
    const text = buildDelegationGuidance({ selectedTools: ['subagent', tool] });
    assert.match(text, /Joined res-workflow routing/);
    assert.match(text, /full catalog of research-\* roles, utility pi-subagents and agy-advisor/);
    assert.match(text, /scientific hypotheses, theory, literature synthesis and critic work/);
    assert.match(text, /research_dispatch action=plan when available/);
    assert.match(text, /Subagents .* are unrestricted across all harness modes/);
    assert.doesNotMatch(text, /Standalone \/ non-research routing/);
  }
});

test('@tintinweb Agent and SubagentWorkflow schemas are emitted only when active', () => {
  const text = buildDelegationGuidance({ selectedTools: ['Agent', 'SubagentWorkflow'] });
  assert.match(text, /Agent\(\{ subagent_type: "Explore", prompt: .*description: "Explore <area>", run_in_background: true \}\)/);
  assert.match(text, /SubagentWorkflow\(\{ scriptPath: "<existing-workflow>\.js", args: \{ target: "<path>" \} \}\)/);
  assert.doesNotMatch(text, /subagent\(\{ agent:/);
  const agentOnly = buildDelegationGuidance({ selectedTools: ['Agent'] });
  assert.doesNotMatch(agentOnly, /SubagentWorkflow\(\{/);
});

test('no delegation guidance is emitted for none, unknown or malformed selectedTools', () => {
  assert.equal(buildDelegationGuidance({ selectedTools: ['read', 'bash', 'edit', 'write'] }), '');
  assert.equal(buildDelegationGuidance({ selectedTools: ['mystery_tool'] }), '');
  assert.equal(buildDelegationGuidance({ selectedTools: 'subagent' }), '');
  assert.equal(buildDelegationGuidance({}), '');
  const unknown = detectDelegationTools(['mystery_tool']);
  assert.equal(unknown.known, true);
  assert.equal(unknown.available, false);
  assert.deepEqual(unknown.families, []);
  const malformed = detectDelegationTools([42, null, 'subagent']);
  assert.equal(malformed.piSubagents, true);
});

test('subagents_enable alone is described as inactive rather than guaranteed', () => {
  const text = buildDelegationGuidance({ selectedTools: ['subagents_enable'] });
  assert.match(text, /`subagents_enable` is active/);
  assert.match(text, /is not in the current tool list/);
  assert.doesNotMatch(text, /subagent\(\{ agent:/);
});

test('research_session is mentioned only when it is actually active', () => {
  const without = buildDelegationGuidance({ selectedTools: ['subagent'] });
  assert.doesNotMatch(without, /research_session/);
  const withSession = buildDelegationGuidance({ selectedTools: ['subagent', 'research_session'] });
  assert.match(withSession, /`research_session` is active/);
});

test('no-delegate and no-export suppress only research_dispatch/research_session guidance; subagent guidance stays active', () => {
  assert.equal(detectDelegationRestrictions('Please do not delegate this task.').blocked, true);
  assert.equal(detectDelegationRestrictions("don't use subagents here").blocked, true);
  assert.equal(detectDelegationRestrictions('不要委派，直接分析这个文件').blocked, true);
  assert.equal(detectDelegationRestrictions('Use a subagent for the literature review').blocked, false);

  const noDelegate = detectDelegationRestrictions('do not delegate');
  const subagentOnly = buildDelegationGuidance({ selectedTools: ['subagent', 'research_dispatch'], restrictions: noDelegate });
  assert.match(subagentOnly, /subagent\(\{ agent:/);
  assert.doesNotMatch(subagentOnly, /research_dispatch/);
  assert.equal(buildDelegationGuidance({ selectedTools: ['research_dispatch'], restrictions: noDelegate }), '');

  const readOnly = detectDelegationRestrictions('Read-only mode: review only, do not modify.');
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.blocked, false);
  const readonlyText = buildDelegationGuidance({ selectedTools: ['subagent'], restrictions: readOnly });
  assert.match(readonlyText, /READ-ONLY MODE/);
  assert.match(readonlyText, /do not edit or write files/);
  assert.match(readonlyText, /do not mutate state/);
  assert.match(readonlyText, /small read-only inspection/);
  assert.doesNotMatch(readonlyText, /small edit/);
  assert.match(readonlyText, /subagent\(\{ agent:/);
});

test('forbidden export restricts research_dispatch/research_session guidance while keeping subagent guidance available', () => {
  assert.equal(detectDelegationRestrictions('Do not send data to external models.').exportLimited, true);
  assert.equal(detectDelegationRestrictions('不要将数据外发给外部模型').blocked, true);
  assert.equal(detectDelegationRestrictions('不要外发数据').exportLimited, true);
  assert.equal(detectDelegationRestrictions('外部模型调用').exportLimited, false);
  assert.equal(detectDelegationRestrictions('可以使用外部模型调用').exportLimited, false);
  assert.equal(detectDelegationRestrictions('允许调用外部模型').exportLimited, false);
  const forbidden = detectDelegationRestrictions('不要外发数据到外部模型');
  assert.equal(buildDelegationGuidance({ selectedTools: ['research_session'], restrictions: forbidden }), '');
  assert.match(buildDelegationGuidance({ selectedTools: ['subagent', 'research_session'], restrictions: forbidden }), /subagent\(\{ agent:/);
});

test('neutral follow-ups keep restrictions; only explicit resumption clears them', () => {
  let restrictions = mergeDelegationRestrictions(undefined, 'Please do not delegate this task.');
  assert.equal(restrictions.noDelegate, true);
  restrictions = mergeDelegationRestrictions(restrictions, '继续');
  assert.equal(restrictions.noDelegate, true);
  restrictions = mergeDelegationRestrictions(restrictions, '可以委派子代理继续分析', { allowResume: true });
  assert.equal(restrictions.noDelegate, false);
  assert.equal(mergeDelegationRestrictions(undefined, 'do not continue delegation').noDelegate, true);
  assert.equal(mergeDelegationRestrictions(undefined, '不要继续委派').noDelegate, true);

  let readOnly = mergeDelegationRestrictions(undefined, '只读模式，不要修改文件');
  assert.equal(readOnly.readOnly, true);
  readOnly = mergeDelegationRestrictions(readOnly, '继续');
  assert.equal(readOnly.readOnly, true);
  readOnly = mergeDelegationRestrictions(readOnly, '允许修改文件', { allowResume: true });
  assert.equal(readOnly.readOnly, false);

  let exported = mergeDelegationRestrictions(undefined, '不要外发数据到外部模型');
  assert.equal(exported.exportLimited, true);
  exported = mergeDelegationRestrictions(exported, '继续');
  assert.equal(exported.exportLimited, true);
  exported = mergeDelegationRestrictions(exported, '外部模型调用');
  assert.equal(exported.exportLimited, true);
  exported = mergeDelegationRestrictions(exported, '允许调用外部模型', { allowResume: true });
  assert.equal(exported.exportLimited, false);
});

test('local exports and generic sends never clear an external-model restriction', () => {
  let restrictions = mergeDelegationRestrictions(undefined, '不要将数据外发给外部模型');
  for (const prompt of ['可以导出当前测试结果为表格', '可以发送本地通知', '允许上传到本地测试服务']) {
    restrictions = mergeDelegationRestrictions(restrictions, prompt);
    assert.equal(restrictions.exportLimited, true, prompt);
  }
  assert.equal(mergeDelegationRestrictions(restrictions, '允许发送给外部模型').exportLimited, false);
});

test('native session or task executor tools are still detected as active delegation tools', () => {
  for (const tool of ['research_session', 'research_dispatch']) {
    assert.equal(detectDelegationTools(['read', tool]).available, true);
  }
});

test('env disable flags only suppress research_dispatch/research_session guidance; subagent guidance is never suppressed', () => {
  assert.equal(delegationPolicyDisabled({ PI_SUBAGENT_CHILD: '1' }), false);
  assert.equal(delegationPolicyDisabled({ PI_RESEARCH_DISABLE_DELEGATION: '1' }), true);
  assert.equal(delegationPolicyDisabled({ PI_RESEARCH_DELEGATION_POLICY: 'off' }), true);
  assert.equal(delegationPolicyDisabled({}), false);
  assert.match(buildDelegationGuidance({ selectedTools: ['subagent'], env: { PI_SUBAGENT_CHILD: '1' } }), /delegat/i);
  assert.match(buildDelegationGuidance({ selectedTools: ['subagent'], env: { PI_RESEARCH_DISABLE_DELEGATION: '1' } }), /subagent\(\{ agent:/);
  assert.equal(buildDelegationGuidance({ selectedTools: ['research_dispatch'], env: { PI_RESEARCH_DISABLE_DELEGATION: '1' } }), '');
});

test('6-bulk-read threshold nudge is completely removed and never injects context messages', () => {
  const pi = mockPi();
  const cleanup = registerDelegationPolicy(pi, { env: {}, isJoined: joined });
  assert.equal(typeof cleanup, 'function');
  pi.emit('before_agent_start', startEvent('Analyze this repository', ['read', 'subagent']));
  for (let index = 0; index < 12; index += 1) {
    pi.emit('tool_execution_end', readEnd());
  }
  assert.equal(pi.emit('context', { messages: [{ role: 'user', content: 'go' }] }), undefined);
});

test('subagent scheduler never blocks or queues subagents when dashboard refuses, queues, or is unavailable', async () => {
  const makeChild = () => ({ sessionId: 'child-ok', modelId: 'test-model', dispose: async () => {} });
  const baseLaunch = { cwd: '/tmp/project', runtime: { parentSessionId: 'parent-1', agent: 'scout' } };

  // 1. Dashboard auth unavailable -> launches directly via create()
  let created = 0;
  const direct1 = await scheduleResearchSubagent(baseLaunch, async () => { created += 1; return makeChild(); }, {}, {
    resolveAuth: () => { throw new Error('no-auth'); },
  });
  assert.equal(created, 1);
  assert.equal(direct1.sessionId, 'child-ok');

  // 2. Dashboard returns queued (maxSubagents hit) -> cancels queue reservation and launches directly
  const actions = [];
  const direct2 = await scheduleResearchSubagent(baseLaunch, async () => { created += 1; return makeChild(); }, {}, {
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'tok' }),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      if (body.action === 'subagent-acquire') {
        return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'queued', position: 1, retryAfterMs: 1000 }) };
      }
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'released' }) };
    },
  });
  assert.equal(created, 2);
  assert.equal(direct2.sessionId, 'child-ok');
  assert.deepEqual(actions, ['subagent-acquire', 'subagent-release']);

  // 3. Dashboard returns HTTP 409 refusal -> launches directly
  const direct3 = await scheduleResearchSubagent(baseLaunch, async () => { created += 1; return makeChild(); }, {}, {
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'tok' }),
    fetchImpl: async () => ({ ok: false, status: 409, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'research-collaboration-historical-main' }) }),
  });
  assert.equal(created, 3);
  assert.equal(direct3.sessionId, 'child-ok');

  // 4. Explicit caller abort still cancels cleanly
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => scheduleResearchSubagent({ ...baseLaunch, signal: controller.signal }, async () => { created += 1; return makeChild(); }, {}),
    /research-subagent-launch-cancelled/,
  );
  assert.equal(created, 3);
});
