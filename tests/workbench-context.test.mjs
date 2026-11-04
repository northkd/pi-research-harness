import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  WORKBENCH_CONTEXT_SECTION,
  buildWorkbenchRecordProtocol,
  registerWorkbenchContext,
} from '../extensions/research-loop/src/workbench-context.mjs';
import { detectDelegationRestrictions } from '../extensions/research-loop/src/delegation-policy.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function joinedFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workbench-joined-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, '.pi', 'research-loop'), { recursive: true, mode: 0o700 });
  const sessionId = 'session-' + sha256(cwd).slice(0, 12);
  const sessionFile = path.join(cwd, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: sessionId, cwd, timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 });
  writeJson(path.join(cwd, `${sessionId}.meta.json`), {
    resWorkflow: { canonicalCwd: cwd, joinedAt: '2026-01-01T00:00:00.000Z', via: 'adoption' },
  });
  const charter = { revision: 1, objective: 'Synthetic joined objective', successCriteria: ['Synthetic joined criterion'] };
  writeJson(path.join(cwd, '.pi', 'research-loop', 'state.json'), { schema: 'pi-research-state.v1', stage: '1-idea', charter });
  const charterHash = 'sha256:' + sha256(JSON.stringify(charter));
  const ownerKey = JSON.stringify(['host', 'inert-operator']);
  const adoptionId = 'adopt-' + sha256(cwd).slice(0, 24);
  const confirmationHash = 'sha256:' + sha256('confirmation' + cwd);
  const privateDir = path.join(root, 'private');
  const scope = path.join(privateDir, sha256(ownerKey), sha256(cwd));
  writeJson(path.join(scope, 'adopted.json'), { confirmed: true, id: adoptionId, confirmationHash });
  writeJson(path.join(scope, adoptionId + '.json'), {
    schema: 'pi-res-workflow-operation.v1', ownerKey, cwd,
    adoption: { id: adoptionId, status: 'confirmed', cwd },
  });
  writeJson(path.join(cwd, '.pi', 'research-loop', 'adoptions', adoptionId, 'confirmation.json'), {
    schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash, autoRun: false,
  });
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
  return { cwd, privateDir, ctx };
}

const CONTEXT = {
  sessionId: 'session-1',
  adoptionId: 'adopt-' + 'a'.repeat(24),
  charterHash: 'sha256:' + 'b'.repeat(64),
  charterRevision: 1,
  stage: '1-idea',
  budget: { limits: { attempts: 3 }, used: { attempts: 0 }, attemptsEnforced: true, modelRequestsEnforced: false, scope: 'native-research-workflow' },
};

test('memory injected through context.memory is rendered when the second argument is omitted', () => {
  const context = {
    ...CONTEXT,
    memory: {
      objective: 'Synthetic memory objective',
      successCriteria: ['Synthetic memory criterion'],
      claimsCount: 2,
      acceptedClaims: ['Synthetic accepted claim'],
      recentFindings: '- [experiment] ran fixture (signal: positive)',
    },
  };
  const text = buildWorkbenchRecordProtocol(context);
  assert.match(text, /科研工作流深度记忆与上下文注入/);
  assert.match(text, /当前研究核心目标：Synthetic memory objective/);
  assert.match(text, /Synthetic memory criterion/);
  assert.match(text, /当前阶段已沉淀主张：2 条/);
  assert.match(text, /Synthetic accepted claim/);
  assert.match(text, /最新尝试记录与观测证据/);
  const explicitEmpty = buildWorkbenchRecordProtocol(context, {});
  assert.doesNotMatch(explicitEmpty, /当前研究核心目标：Synthetic memory objective/);
});

test('scientific, budget and publish gates are preserved', () => {
  const text = buildWorkbenchRecordProtocol(CONTEXT, {});
  assert.match(text, /research_loop action="log"/);
  assert.match(text, /expectedCharterHash/);
  assert.match(text, /action="stage"/);
  assert.match(text, /action="claim"/);
  assert.match(text, /review-gate/);
  assert.match(text, /claim-gate/);
  assert.match(text, /task-completed signal/);
  assert.match(text, /Budget used counts are scoped to the native research workflow/);
  assert.match(text, /If the budget is unavailable or modelRequestsEnforced is false, report that fact/);
  assert.match(text, /Only explicit user authorization permits action="publish"/);
  assert.match(text, /Internal acceptance does not authorize publication/);
  assert.doesNotMatch(text, /CRITICAL/);
});

test('delegation guidance is dynamic and schema-accurate for each active family', () => {
  const pi = buildWorkbenchRecordProtocol(CONTEXT, {}, { selectedTools: ['read', 'subagent'] });
  assert.match(pi, /subagent\(\{ agent: "research-literature", task: .*async: true, options: \{ context: "fresh" \} \}\)/);
  assert.doesNotMatch(pi, /Agent\(\{ subagent_type/);
  assert.doesNotMatch(pi, /SubagentWorkflow\(\{/);
  assert.match(pi, /Only this lead session may delegate/);
  assert.match(pi, /never instruct a child to spawn more agents/);
  assert.match(pi, /do not import full child transcripts or dumps/);

  const tintin = buildWorkbenchRecordProtocol(CONTEXT, {}, { selectedTools: ['Agent', 'SubagentWorkflow'] });
  assert.match(tintin, /Agent\(\{ subagent_type: "Explore"/);
  assert.match(tintin, /SubagentWorkflow\(\{ scriptPath:/);
  assert.doesNotMatch(tintin, /subagent\(\{ agent:/);
});

test('no delegation tool means no schema claim, and user restrictions suppress guidance', () => {
  const none = buildWorkbenchRecordProtocol(CONTEXT, {}, { selectedTools: ['read', 'bash', 'edit', 'write'] });
  assert.doesNotMatch(none, /subagent\(\{ agent:/);
  assert.doesNotMatch(none, /subagent_type/);
  assert.doesNotMatch(none, /subagents_enable/);

  const unknown = buildWorkbenchRecordProtocol(CONTEXT, {}, { selectedTools: ['mystery_tool'] });
  assert.doesNotMatch(unknown, /subagent\(\{ agent:/);

  const optOut = buildWorkbenchRecordProtocol(CONTEXT, {}, {
    selectedTools: ['subagent'],
    restrictions: detectDelegationRestrictions('Do not delegate this task.'),
  });
  assert.doesNotMatch(optOut, /subagent\(\{ agent:/);

  const child = buildWorkbenchRecordProtocol(CONTEXT, {}, {
    selectedTools: ['subagent'],
    env: { PI_SUBAGENT_CHILD: '1' },
  });
  assert.doesNotMatch(child, /subagent\(\{ agent:/);
});

test('workbench opt-out survives a neutral 继续 turn and clears on explicit resumption', t => {
  const { cwd, privateDir, ctx } = joinedFixture(t);
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); return () => {}; } };
  registerWorkbenchContext(pi, { privateDir });
  const run = prompt => {
    const opts = { cwd, selectedTools: ['subagent'], sections: {} };
    handlers.get('before_agent_start')({ messageType: 'user', prompt, systemPromptOptions: opts }, ctx);
    const text = opts.sections[WORKBENCH_CONTEXT_SECTION];
    assert.equal(typeof text, 'string');
    return text;
  };
  const first = run('Please do not delegate this analysis');
  assert.match(first, /Synthetic joined objective/);
  assert.doesNotMatch(first, /subagent\(\{ agent:/);
  assert.doesNotMatch(run('继续'), /subagent\(\{ agent:/);
  assert.match(run('可以委派子代理继续分析'), /subagent\(\{ agent:/);
});

test('workbench read-only mode survives a neutral turn and keeps no-write constraints', t => {
  const { cwd, privateDir, ctx } = joinedFixture(t);
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); return () => {}; } };
  registerWorkbenchContext(pi, { privateDir });
  const run = prompt => {
    const opts = { cwd, selectedTools: ['subagent'], sections: {} };
    handlers.get('before_agent_start')({ messageType: 'user', prompt, systemPromptOptions: opts }, ctx);
    const text = opts.sections[WORKBENCH_CONTEXT_SECTION];
    assert.equal(typeof text, 'string');
    return text;
  };
  const first = run('Read-only mode: review only, do not modify.');
  assert.match(first, /READ-ONLY MODE/);
  assert.match(first, /do not edit or write files/);
  assert.match(first, /subagent\(\{ agent:/);
  const continued = run('继续');
  assert.match(continued, /READ-ONLY MODE/);
  const resumed = run('现在可以修改文件了');
  assert.doesNotMatch(resumed, /READ-ONLY MODE/);
  assert.match(resumed, /subagent\(\{ agent:/);
});

test('registered workbench context propagates child environment opt-out', t => {
  const { cwd, privateDir, ctx } = joinedFixture(t);
  const handlers = new Map();
  registerWorkbenchContext({ on(name, handler) { handlers.set(name, handler); } }, {
    privateDir, env: { PI_SUBAGENT_CHILD: '1' },
  });
  const opts = { cwd, selectedTools: ['subagent'], sections: {} };
  handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Review the project', systemPromptOptions: opts }, ctx);
  assert.match(opts.sections[WORKBENCH_CONTEXT_SECTION], /Synthetic joined objective/);
  assert.doesNotMatch(opts.sections[WORKBENCH_CONTEXT_SECTION], /Dynamic delegation policy|subagent\(\{ agent:/);
});

test('registerWorkbenchContext clears a stale section for an unjoined session', t => {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workbench-context-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };
  registerWorkbenchContext(pi);
  const opts = { cwd, selectedTools: ['subagent'], sections: { [WORKBENCH_CONTEXT_SECTION]: 'stale text' } };
  assert.doesNotThrow(() => handlers.get('before_agent_start')({
    messageType: 'user',
    prompt: 'continue',
    systemPromptOptions: opts,
  }, { cwd }));
  assert.equal(opts.sections[WORKBENCH_CONTEXT_SECTION], undefined);
});
