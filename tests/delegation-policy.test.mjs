import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BULK_THRESHOLD,
  DELEGATION_NUDGE_TYPE,
  buildDelegationGuidance,
  buildDelegationNudge,
  delegationPolicyDisabled,
  detectDelegationRestrictions,
  detectDelegationTools,
  mergeDelegationRestrictions,
  registerDelegationPolicy,
} from '../extensions/research-loop/src/delegation-policy.mjs';

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

test('pi-subagents capability is detected only from the active subagent tool', () => {
  const caps = detectDelegationTools(['read', 'subagent']);
  assert.equal(caps.known, true);
  assert.equal(caps.available, true);
  assert.deepEqual(caps.families, ['pi-subagents']);
  assert.equal(caps.piSubagents, true);
  const text = buildDelegationGuidance({ selectedTools: ['read', 'subagent'] });
  assert.match(text, /subagent\(\{ agent: "research-literature", task: .*async: true, options: \{ context: "fresh" \} \}\)/);
  assert.match(text, /do not use the old `subagent\(agentName, prompt\)` form/);
  assert.doesNotMatch(text, /Agent\(\{ subagent_type/);
  assert.doesNotMatch(text, /SubagentWorkflow\(\{/);
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

test('explicit no-delegate suppresses guidance; read-only only adds no-write constraints', () => {
  assert.equal(detectDelegationRestrictions('Please do not delegate this task.').blocked, true);
  assert.equal(detectDelegationRestrictions("don't use subagents here").blocked, true);
  assert.equal(detectDelegationRestrictions('不要委派，直接分析这个文件').blocked, true);
  assert.equal(detectDelegationRestrictions('Use a subagent for the literature review').blocked, false);

  const noDelegate = detectDelegationRestrictions('do not delegate');
  assert.equal(buildDelegationGuidance({ selectedTools: ['subagent'], restrictions: noDelegate }), '');

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

test('forbidden export suppresses delegation; bare mention or positive authorization does not', () => {
  assert.equal(detectDelegationRestrictions('Do not send data to external models.').exportLimited, true);
  assert.equal(detectDelegationRestrictions('不要将数据外发给外部模型').blocked, true);
  assert.equal(detectDelegationRestrictions('不要外发数据').exportLimited, true);
  assert.equal(detectDelegationRestrictions('外部模型调用').exportLimited, false);
  assert.equal(detectDelegationRestrictions('可以使用外部模型调用').exportLimited, false);
  assert.equal(detectDelegationRestrictions('允许调用外部模型').exportLimited, false);
  const forbidden = detectDelegationRestrictions('不要外发数据到外部模型');
  assert.equal(buildDelegationGuidance({ selectedTools: ['subagent'], restrictions: forbidden }), '');
});

test('neutral follow-ups keep restrictions; only explicit resumption clears them', () => {
  let restrictions = mergeDelegationRestrictions(undefined, 'Please do not delegate this task.');
  assert.equal(restrictions.noDelegate, true);
  restrictions = mergeDelegationRestrictions(restrictions, '继续');
  assert.equal(restrictions.noDelegate, true);
  restrictions = mergeDelegationRestrictions(restrictions, '可以委派子代理继续分析');
  assert.equal(restrictions.noDelegate, false);
  assert.equal(mergeDelegationRestrictions(undefined, 'do not continue delegation').noDelegate, true);
  assert.equal(mergeDelegationRestrictions(undefined, '不要继续委派').noDelegate, true);

  let readOnly = mergeDelegationRestrictions(undefined, '只读模式，不要修改文件');
  assert.equal(readOnly.readOnly, true);
  readOnly = mergeDelegationRestrictions(readOnly, '继续');
  assert.equal(readOnly.readOnly, true);
  readOnly = mergeDelegationRestrictions(readOnly, '现在可以修改文件了');
  assert.equal(readOnly.readOnly, false);

  let exported = mergeDelegationRestrictions(undefined, '不要外发数据到外部模型');
  assert.equal(exported.exportLimited, true);
  exported = mergeDelegationRestrictions(exported, '继续');
  assert.equal(exported.exportLimited, true);
  exported = mergeDelegationRestrictions(exported, '外部模型调用');
  assert.equal(exported.exportLimited, true);
  exported = mergeDelegationRestrictions(exported, '允许调用外部模型');
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

test('a top-level session tool alone does not imply subordinate delegation is available', () => {
  assert.equal(detectDelegationTools(['read', 'research_session']).available, false);
  assert.equal(buildDelegationNudge(6, { selectedTools: ['read', 'research_session'] }), '');
});

test('child sessions and explicit env opt-outs disable guidance and nudges', () => {
  assert.equal(delegationPolicyDisabled({ PI_SUBAGENT_CHILD: '1' }), true);
  assert.equal(delegationPolicyDisabled({ PI_RESEARCH_DISABLE_DELEGATION: '1' }), true);
  assert.equal(delegationPolicyDisabled({ PI_RESEARCH_DELEGATION_POLICY: 'off' }), true);
  assert.equal(delegationPolicyDisabled({}), false);
  assert.equal(buildDelegationGuidance({ selectedTools: ['subagent'], env: { PI_SUBAGENT_CHILD: '1' } }), '');
});

test('repeated bulk reads trigger one nudge when delegation is active', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 3, env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Analyze this repository', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.equal(pi.emit('context', { messages: [] }), undefined);
  pi.emit('tool_execution_end', readEnd());
  const result = pi.emit('context', { messages: [{ role: 'user', content: 'go' }] });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].role, 'custom');
  assert.equal(result.messages[1].customType, DELEGATION_NUDGE_TYPE);
  assert.match(result.messages[1].content, /3 broad read\/search operations/);
  assert.equal(pi.emit('context', { messages: [] }), undefined);
});

test('small direct tasks and failed or nested reads do not nudge', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Check one file', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  for (let index = 0; index < DEFAULT_BULK_THRESHOLD + 2; index += 1) {
    pi.emit('tool_execution_end', readEnd({ isError: true }));
    pi.emit('tool_execution_end', readEnd({ parentToolCallId: 'parent' }));
  }
  assert.equal(pi.emit('context', { messages: [] }), undefined);
});

test('unknown selectedTools stays safe and never nudges', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 2, env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Analyze this repository', undefined));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.equal(pi.emit('context', { messages: [] }), undefined);
});

test('user opt-out prevents nudges even after repeated bulk reads', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 2, env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Do not delegate this analysis', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.equal(pi.emit('context', { messages: [] }), undefined);
});

test('child env guard prevents nudges after repeated bulk reads', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 2, env: { PI_SUBAGENT_CHILD: '1' }, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Analyze this repository', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.equal(pi.emit('context', { messages: [] }), undefined);
});

test('nudging fails closed without an isJoined predicate or when it is false/throwing', () => {
  for (const options of [{}, { isJoined: () => false }, { isJoined: () => { throw new Error('not joined'); } }]) {
    const pi = mockPi();
    registerDelegationPolicy(pi, { bulkThreshold: 2, env: {}, ...options });
    pi.emit('before_agent_start', startEvent('Analyze this repository', ['read', 'subagent']));
    pi.emit('tool_execution_end', readEnd());
    pi.emit('tool_execution_end', readEnd());
    assert.equal(pi.emit('context', { messages: [] }), undefined);
  }
  let seen;
  const ctx = { sessionManager: { getSessionId: () => 'session-joined-check' } };
  const pi = mockPi();
  registerDelegationPolicy(pi, { isJoined: value => { seen = value; return false; } });
  pi.emit('before_agent_start', startEvent('Analyze this repository', ['read', 'subagent']), ctx);
  assert.equal(seen, ctx);
});

test('read-only mode allows a nudge with explicit no-write constraints', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 2, env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Read-only mode: review only, do not modify.', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  const result = pi.emit('context', { messages: [] });
  assert.match(result.messages[0].content, /Read-only mode/);
  assert.match(result.messages[0].content, /must not edit or write files/);
  assert.match(result.messages[0].content, /state-changing commands/);
});

test('no-delegate survives a neutral 继续 turn and clears on explicit resumption', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 2, env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('Do not delegate this analysis', ['read', 'subagent']));
  pi.emit('before_agent_start', startEvent('继续', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.equal(pi.emit('context', { messages: [] }), undefined);

  pi.emit('before_agent_start', startEvent('可以委派子代理继续分析', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.match(pi.emit('context', { messages: [] }).messages[0].content, /Delegation nudge/);
});

test('export prohibition survives neutral follow-ups and bare external-model mention', () => {
  const pi = mockPi();
  registerDelegationPolicy(pi, { bulkThreshold: 2, env: {}, isJoined: joined });
  pi.emit('before_agent_start', startEvent('不要外发数据到外部模型', ['read', 'subagent']));
  pi.emit('before_agent_start', startEvent('继续', ['read', 'subagent']));
  pi.emit('before_agent_start', startEvent('外部模型调用', ['read', 'subagent']));
  pi.emit('tool_execution_end', readEnd());
  pi.emit('tool_execution_end', readEnd());
  assert.equal(pi.emit('context', { messages: [] }), undefined);
});

test('nudge builder requires an active delegation tool', () => {
  assert.equal(buildDelegationNudge(10, { selectedTools: ['read'] }), '');
  assert.match(buildDelegationNudge(10, { selectedTools: ['Agent'] }), /Delegation nudge/);
});
