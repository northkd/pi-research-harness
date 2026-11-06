import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  WORKBENCH_CONTEXT_SECTION,
  WORKBENCH_MEMORY_MAX_BYTES,
  buildWorkbenchMemory,
  buildWorkbenchRecordProtocol,
  readWorkbenchRecordContext,
  registerWorkbenchContext,
} from '../extensions/research-loop/src/workbench-context.mjs';
import { detectDelegationRestrictions } from '../extensions/research-loop/src/delegation-policy.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function joinedFixture(t, input = {}) {
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
  const charter = { revision: 1, objective: 'Synthetic joined objective', successCriteria: ['Synthetic joined criterion'], ...input.charter };
  writeJson(path.join(cwd, '.pi', 'research-loop', 'state.json'), { schema: 'pi-research-state.v1', stage: '1-idea', charter, claims: input.claims ?? [] });
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
  return { cwd, privateDir, ctx, sessionId, sessionFile, charterHash, adoptionId };
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
  assert.match(text, /当前研究核心目标：\s*Synthetic memory objective/);
  assert.match(text, /Synthetic memory criterion/);
  assert.match(text, /已记录主张：2 条/);
  assert.match(text, /Synthetic accepted claim/);
  assert.match(text, /最新尝试记录与观测证据/);
  assert.equal(text.split('Synthetic memory objective').length - 1, 1, 'memory must not be serialized a second time in verified metadata');
  const record = JSON.parse(text.split('\n').find(line => line.startsWith('Verified current record context: ')).slice('Verified current record context: '.length));
  assert.equal(record.memory, undefined);
  const explicitEmpty = buildWorkbenchRecordProtocol(context, {});
  assert.doesNotMatch(explicitEmpty, /Synthetic memory objective/);
});

test('all memory content, references and truncation notices fit one UTF-8 byte budget', () => {
  const memory = {
    objective: '目标😀'.repeat(4000),
    successCriteria: Array.from({ length: 40 }, (_, index) => `criterion-${index}: ${'验收🧪'.repeat(250)}`),
    constraints: Array.from({ length: 20 }, (_, index) => `constraint-${index}: ${'只读🔒'.repeat(250)}`),
    nonGoals: Array.from({ length: 10 }, (_, index) => `non-goal-${index}: ${'边界🌐'.repeat(250)}`),
    claimsCount: 500,
    acceptedClaims: ['unrelated historical claim '.repeat(5000)],
    recentFindings: 'unrelated historical ledger '.repeat(5000),
  };
  const block = buildWorkbenchMemory(CONTEXT, memory);
  assert.ok(Buffer.byteLength(block, 'utf8') <= WORKBENCH_MEMORY_MAX_BYTES);
  assert.match(block, /Memory block budget: 8192 UTF-8 bytes, including references\/notices/);
  assert.match(block, /fixed record and delegation guidance outside this block is separate/);
  assert.ok(block.includes(CONTEXT.charterHash));
  assert.match(block, /Authority: \.pi\/research-loop\/state\.json#\/charter/);
  for (const field of ['objective', 'successCriteria', 'constraints', 'nonGoals']) {
    assert.ok(block.includes(`.pi/research-loop/state.json#/charter/${field}`), `missing exact read reference for ${field}`);
  }
  assert.match(block, /list prefix only, 40 entries total/);
  assert.match(block, /list prefix only, 20 entries total/);
  assert.match(block, /list prefix only, 10 entries total/);
  assert.match(block, /read its exact source field before acting on its scope or claiming its criteria are met/);
  assert.match(block, /No omitted goal, criterion or constraint is waived/);
  assert.doesNotMatch(block, /\uFFFD/);
  assert.ok(block.includes('criterion-0') && block.includes('constraint-0') && block.includes('non-goal-0'), 'each charter field receives a preview even when the objective is very long');
  assert.doesNotMatch(block, /unrelated historical/, 'history must not displace charter essentials');
  const full = buildWorkbenchRecordProtocol({ ...CONTEXT, memory });
  assert.ok(Buffer.byteLength(full) < WORKBENCH_MEMORY_MAX_BYTES + 10 * 1024, 'no raw memory copy may escape the bounded block');
});

test('short goals, every criterion and constraints remain intact before any historical preview', () => {
  const memory = {
    objective: 'Measure the authorized baseline',
    successCriteria: ['Report median and p95 latency', 'Preserve the fixed validation split', 'Document unsuccessful cases'],
    constraints: ['Read-only access to the source dataset', 'Use only the agreed compute budget'],
    nonGoals: ['No external publication'],
    claimsCount: 1000,
    acceptedClaims: ['Long accepted claim '.repeat(4000)],
    recentFindings: 'Long historical record '.repeat(4000),
  };
  const block = buildWorkbenchMemory(CONTEXT, memory);
  for (const value of [memory.objective, ...memory.successCriteria, ...memory.constraints, ...memory.nonGoals]) assert.ok(block.includes(value));
  assert.ok(Buffer.byteLength(block) <= WORKBENCH_MEMORY_MAX_BYTES);
  const history = block.slice(block.indexOf('已记录主张：'), block.lastIndexOf('\n【Research Memory end】'));
  assert.ok(Buffer.byteLength(history) <= 1024, 'repeated historical text has its own smaller ceiling inside the total');
  assert.match(history, /truncated=true/);
  assert.match(history, /\.pi\/research-loop\/state\.json#\/claims \(statement, evidence, acceptance.verdict\)/);
  assert.match(history, /ledger.jsonl \(action, observed, lesson, signal\)/);
});

test('verified children retain charter and read-only scope without loading unrelated ledger or claims', t => {
  const fixture = joinedFixture(t, {
    charter: { constraints: ['No source writes'], nonGoals: ['No publication'] },
    claims: [{ statement: 'UNRELATED_ACCEPTED_CLAIM', acceptance: { verdict: 'accepted' } }],
  });
  const { cwd, privateDir, ctx, sessionId, sessionFile, charterHash, adoptionId } = fixture;
  const metaFile = sessionFile.slice(0, -6) + '.meta.json';
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.researchSession = { schema: 'pi-research-session.v1', workflowCwd: cwd, charterHash, adoptionId, parentSessionId: 'lead-session', role: 'research-coordinator', depth: 1, readOnly: true };
  writeJson(metaFile, meta);
  const ledgerFile = path.join(cwd, 'ledger.jsonl');
  fs.writeFileSync(ledgerFile, JSON.stringify({ action: 'UNRELATED_LEDGER_ACTION', observed: 'old evidence' }) + '\n');
  const open = fs.openSync;
  let ledgerOpens = 0;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === ledgerFile) ledgerOpens++;
    return open.call(this, file, ...args);
  });
  const context = readWorkbenchRecordContext(ctx, { privateDir });
  assert.equal(context.sessionId, sessionId);
  assert.equal(context.researchSession.readOnly, true);
  assert.deepEqual(context.memory.acceptedClaims, []);
  assert.equal(context.memory.recentFindings, '');
  assert.equal(ledgerOpens, 0, 'child context reads must not load unrelated history');
  const text = buildWorkbenchRecordProtocol(context);
  for (const value of ['Synthetic joined objective', 'Synthetic joined criterion', 'No source writes', 'No publication']) assert.ok(text.includes(value));
  assert.doesNotMatch(text, /UNRELATED_ACCEPTED_CLAIM|UNRELATED_LEDGER_ACTION/);
  assert.match(text, /History references only for this child/);
  assert.match(text, /ledger.jsonl/);
  assert.match(text, /"readOnly":true/);
  assert.ok(Buffer.byteLength(buildWorkbenchMemory(context)) <= WORKBENCH_MEMORY_MAX_BYTES);
  meta.researchSession.charterHash = 'sha256:' + 'f'.repeat(64);
  writeJson(metaFile, meta);
  assert.equal(readWorkbenchRecordContext(ctx, { privateDir }).researchSession, undefined, 'mismatched provenance must not be promoted into verified child scope');
});

test('native child mode omits history, while a lead reads only a bounded tail', t => {
  const { cwd, privateDir, ctx } = joinedFixture(t, {
    claims: [{ statement: 'OLD_ACCEPTED_TEXT', acceptance: { verdict: 'accepted' } }],
  });
  const ledgerFile = path.join(cwd, 'ledger.jsonl');
  fs.writeFileSync(ledgerFile, JSON.stringify({ action: 'old-large-record', observed: 'x'.repeat(200_000) }) + '\n' + Array.from({ length: 3 }, (_, index) => JSON.stringify({ action: `latest-${index}`, observed: `observation-${index}` })).join('\n') + '\n');
  const read = fs.readSync;
  const positions = [];
  const open = fs.openSync;
  let ledgerFd;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    const fd = open.call(this, file, ...args);
    if (file === ledgerFile) ledgerFd = fd;
    return fd;
  });
  t.mock.method(fs, 'readSync', function(fd, buffer, offset, length, position) {
    if (fd === ledgerFd && Number.isInteger(position)) positions.push({ length, position });
    return read.call(this, fd, buffer, offset, length, position);
  });
  const lead = readWorkbenchRecordContext(ctx, { privateDir, env: {} });
  assert.match(lead.memory.recentFindings, /latest-0[\s\S]*latest-1[\s\S]*latest-2/);
  assert.doesNotMatch(lead.memory.recentFindings, /old-large-record/);
  assert.ok(positions.length > 0 && positions.every(entry => entry.position > 0 && entry.length <= 16 * 1024));
  positions.length = 0;
  ledgerFd = undefined;
  const child = readWorkbenchRecordContext(ctx, { privateDir, env: { PI_SUBAGENT_CHILD: '1' } });
  assert.deepEqual(child.memory.acceptedClaims, []);
  assert.equal(child.memory.recentFindings, '');
  assert.equal(ledgerFd, undefined);
  const text = buildWorkbenchRecordProtocol(child, child.memory, { env: { PI_SUBAGENT_CHILD: '1' } });
  assert.doesNotMatch(text, /OLD_ACCEPTED_TEXT|observation-[012]/);
});

test('each registered turn replaces its bounded memory and never appends prior history', t => {
  const { cwd, privateDir, ctx, charterHash } = joinedFixture(t, {
    charter: { objective: '研究😀'.repeat(1000), successCriteria: Array.from({ length: 30 }, (_, index) => `${index}: ${'验收'.repeat(500)}`), constraints: ['Read-only work'] },
  });
  const handlers = new Map();
  registerWorkbenchContext({ on(name, handler) { handlers.set(name, handler); } }, { privateDir });
  const opts = { cwd, selectedTools: [], sections: {} };
  const run = () => {
    handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Continue within scope', systemPromptOptions: opts }, ctx);
    return opts.sections[WORKBENCH_CONTEXT_SECTION];
  };
  const first = run();
  assert.equal(typeof first, 'string');
  assert.equal(run(), first);
  assert.equal(first.split('【Research Memory end】').length - 1, 1);
  assert.ok(first.includes(charterHash));
  const start = first.indexOf('【科研工作流深度记忆与上下文注入'), end = first.indexOf('【Research Memory end】') + '【Research Memory end】'.length;
  assert.ok(Buffer.byteLength(first.slice(start, end)) <= WORKBENCH_MEMORY_MAX_BYTES);
  assert.match(first, /\.pi\/research-loop\/state\.json#\/charter\/successCriteria/);
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
  assert.match(pi, /Collaborators may recursively delegate separable work/);
  assert.match(pi, /same owner, workspace, charter and permission scope/);
  assert.match(pi, /depth, role and shared task budgets/);
  assert.match(pi, /SSH, agy and supervisor roles remain leaves/);
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
  assert.match(child, /subagent\(\{ agent:/);
  assert.match(child, /Collaborators may recursively delegate/);
  const explicitlyDisabled = buildWorkbenchRecordProtocol(CONTEXT, {}, { selectedTools: ['subagent'], env: { PI_SUBAGENT_CHILD: '1', PI_RESEARCH_DISABLE_DELEGATION: '1' } });
  assert.doesNotMatch(explicitlyDisabled, /subagent\(\{ agent:/);
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

test('registered workbench context preserves controlled recursive guidance for children', t => {
  const { cwd, privateDir, ctx } = joinedFixture(t);
  const handlers = new Map();
  registerWorkbenchContext({ on(name, handler) { handlers.set(name, handler); } }, {
    privateDir, env: { PI_SUBAGENT_CHILD: '1' },
  });
  const opts = { cwd, selectedTools: ['subagent'], sections: {} };
  handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Review the project', systemPromptOptions: opts }, ctx);
  assert.match(opts.sections[WORKBENCH_CONTEXT_SECTION], /Synthetic joined objective/);
  assert.match(opts.sections[WORKBENCH_CONTEXT_SECTION], /Dynamic delegation policy/);
  assert.match(opts.sections[WORKBENCH_CONTEXT_SECTION], /subagent\(\{ agent:/);
  assert.match(opts.sections[WORKBENCH_CONTEXT_SECTION], /Managed collaborators must declare a plan or an indivisible-task reason/);
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
