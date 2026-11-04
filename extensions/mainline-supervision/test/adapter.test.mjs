// All tests below are MOCK bus/UI/core tests. No provider/model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockStore } from './mock-core.mjs';
import { autoApproveStatePath, writeAutoApproveState } from '../src/auto-approve.mjs';
import { loadAdapter } from '../scripts/host-env.mjs';
const imported = await loadAdapter();
const { createMainlineAdapter, validReview, MODEL, REVIEW_SCHEMA } = imported.default?.createMainlineAdapter ? imported.default : imported;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const GOOD = { verdict: 'ON_TRACK', findings: [], coverage: 'Captured approved synthetic write and core step.', unverified: [] };
function harness(t, options = {}) {
  const cwd = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-adapter-test-'));
  const listeners = new Map(); const hooks = new Map(); const requests = []; const messages = []; const statuses = []; const confirms = []; const notices = [];
  const bus = { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); }, emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload); } };
  const parentFile = path.join(cwd, 'parent-session.jsonl');
  const info = { version: 1, capabilities: { asyncSpawn: true }, events: { asyncComplete: 'subagent:async-complete' }, session: { sessionId: 'parent-1', sessionFile: parentFile } };
  let tool; let command; let runs = 0;
  const ctx = { cwd, hasUI: options.hasUI ?? true, sessionManager: { getSessionId: () => 'parent-1', getSessionFile: () => parentFile }, ui: { confirm: async (title, text) => { confirms.push(title); if (title === '授权后台主线监督') { assert.ok(text.includes(MODEL)); assert.ok(text.includes('plan.md')); } return options.consent ?? true; }, setStatus: (key, text) => statuses.push({ key, text }), notify: (text, level) => notices.push({ text, level }) } };
  const pi = { events: bus, on: (name, fn) => hooks.set(name, fn), registerTool: v => tool = v, registerCommand: (name, v) => { assert.equal(name, 'mainline-supervision'); command = v; }, sendMessage: (m, config) => { assert.equal(config.triggerTurn, false); messages.push(m); } };
  if (!options.noRPC) bus.on('subagents:rpc:v1:request', async req => {
    requests.push(req);
    if (req.method === 'ping') { bus.emit('subagents:rpc:v1:reply:' + req.requestId, { version: 1, requestId: req.requestId, method: 'ping', success: true, data: info }); return; }
    if (req.method === 'spawn') {
      assert.ok(listeners.get('subagent:async-complete')?.size > 0, 'completion subscribed BEFORE dispatch');
      const id = 'run-' + (++runs); const dir = path.join(cwd, 'async', id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: id, sessionId: parentFile, state: 'running', steps: [] }));
      if (options.rejectSpawn) { bus.emit('subagents:rpc:v1:reply:' + req.requestId, { version: 1, requestId: req.requestId, method: 'spawn', success: false }); return; }
      if (options.earlyComplete) bus.emit('subagent:async-complete', { id, state: 'complete', success: true, toolCallId: 'rpc-spawn-' + req.requestId, results: [{ agent: 'research-mainline-supervisor', success: true, structuredOutput: GOOD }] });
      bus.emit('subagents:rpc:v1:reply:' + req.requestId, { version: 1, requestId: req.requestId, method: 'spawn', success: true, data: { details: { mode: 'single', runId: id, asyncId: id, asyncDir: dir, results: [] } } });
    }
  });
  if (options.prepare) options.prepare(cwd);
  createMainlineAdapter(pi, { Store: MockStore, env: options.env ?? {}, autoApprove: options.autoApprove });
  const fire = (name, event = {}) => hooks.get(name)?.(event, ctx);
  if (!options.skipSessionStart) fire('session_start');
  const act = p => tool.execute('call', p, null, null, ctx);
  const actAt = (customCtx, p) => tool.execute('call', p, null, null, customCtx);
  const configure = (authorized = true) => act({ action: 'configure', coreText: 'Synthetic frozen core: implement plan step.', approvedPaths: ['plan.md'], authorized });
  const complete = (overrides = {}) => { const a = new MockStore(cwd).getState().reviewActivity; bus.emit('subagent:async-complete', { id: a.runId, runId: a.runId, sessionId: 'parent-1', state: 'complete', success: true, toolCallId: 'rpc-spawn-' + a.requestId, results: [{ agent: 'research-mainline-supervisor', success: true, structuredOutput: GOOD }], ...overrides }); };
  t.after(() => { fire('session_shutdown'); if (!options.cwd) fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, ctx, hooks, fire, requests, bus, act, actAt, configure, complete, messages, statuses, confirms, notices, get: () => new MockStore(cwd).getState(), command };
}
test('MOCK authorized capture → detached spawn → exact completion → persistence; foreground end synchronous', async t => {
  const h = harness(t); await h.configure(); await flush(); h.complete(); await flush();
  h.fire('tool_call', { toolName: 'write', toolCallId: 'write-1', input: { path: 'plan.md', content: 'actual synthetic changed plan' } });
  h.fire('tool_result', { toolName: 'write', toolCallId: 'write-1', input: { path: 'plan.md' }, content: [{ type: 'text', text: 'saved' }], isError: false });
  await h.act({ action: 'checkpoint', stageId: 'method-A', kind: 'stage_complete' });
  const ended = h.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'stage complete' }] }] });
  assert.equal(ended, undefined, 'no promise holding foreground busy');
  h.fire('agent_settled'); await flush();
  const spawns = h.requests.filter(r => r.method === 'spawn'); assert.equal(spawns.length, 2);
  const p = spawns[1].params; assert.equal(p.model, MODEL); assert.equal(p.async, true); assert.equal(p.context, 'fresh'); assert.equal(p.output, false); assert.equal('outputMode' in p, false); assert.deepEqual(p.outputSchema, REVIEW_SCHEMA); assert.equal('timeoutMs' in p, false); assert.ok(p.task.includes('Do not interview')); assert.equal(p.skill, false);
  const a = h.get().reviewActivity; const packet = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'EVIDENCE.json')));
  assert.ok(packet.some(e => e.toolCallId === 'write-1' && e.type === 'tool_result')); assert.ok(packet.some(e => e.type === 'plan'));
  h.complete({ runId: 'unrelated', id: 'unrelated' }); await flush(); assert.equal(h.get().reviewActivity.state, 'reviewing');
  h.complete(); await flush(); assert.equal(h.get().lastVerdict, 'ON_TRACK'); assert.equal(h.get().blocked, false); assert.equal(h.get().reviewActivity.state, 'standby');
  assert.ok(h.statuses.some(s => s.key === 'mainline-supervision' && s.text.includes('reviewing')));
  assert.equal(h.messages.length, 0);
});
test('MOCK unauthorized/denied/noUI/unconfigured projects never spawn', async t => {
  for (const opts of [{ consent: false }, { hasUI: false }, {}]) { const h = harness(t, opts); if (opts.consent === false || opts.hasUI === false) await h.configure(); else await h.configure(false); h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 0); assert.equal(h.get().authorized, false); }
  const h = harness(t); h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 0);
});
test('MOCK duplicate boundaries and self/control/wake suppression', async t => {
  const h = harness(t); await h.configure(); await flush();
  h.fire('agent_settled'); h.fire('agent_settled'); await flush(); assert.equal(h.requests.filter(r => r.method === 'spawn').length, 1);
  h.complete(); await flush(); const rev = h.get().revision;
  h.fire('tool_call', { toolName: 'mainline_supervision', input: { action: 'status' } });
  h.fire('tool_result', { toolName: 'subagent', input: { agent: 'research-mainline-supervisor' } });
  for (const prompt of ['Subagent updates above.', 'Background task completed: **research-mainline-supervisor**']) {
    h.fire('before_agent_start', { prompt });
    h.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'background acknowledgement' }] }] }); await flush();
  }
  assert.equal(h.get().revision, rev); assert.equal(h.requests.filter(r => r.method === 'spawn').length, 1);
});
test('MOCK failed/malformed children fail closed, warn once; correction requires re-review', async t => {
  const h = harness(t); await h.configure(); await flush();
  h.complete({ success: false, state: 'failed' }); await flush(); assert.equal(h.get().blocked, false); assert.equal(h.messages.length, 1);
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.filter(r => r.method === 'spawn').length, 1, 'no silent retry');
  assert.equal((await h.fire('tool_call', { toolName: 'bash', input: { command: 'rm raw/input' } })).block, true);
  assert.equal(h.fire('tool_call', { toolName: 'read', input: { path: 'plan.md' } }), undefined);
  assert.ok(h.fire('before_agent_start', { prompt: 'continue' }).message.content.includes('不冻结'));
  await h.act({ action: 'correction', text: 'Disposition: fixed authorized plan', evidencePaths: ['plan.md'] }); assert.equal(h.get().blocked, false);
  h.fire('tool_result', { toolName: 'edit', toolCallId: 'repair-result', input: { path: 'plan.md' }, content: [], isError: false });
  await h.act({ action: 'checkpoint', stageId: 'repair-A', kind: 'stage_complete' });
  await h.act({ action: 'check' }); await flush(); h.complete({ results: [{ agent: 'research-mainline-supervisor', success: true, structuredOutput: { verdict: 'ON_TRACK' } }] }); await flush(); assert.equal(h.get().reviewActivity.state, 'failed');
});
test('MOCK pause/resume keeps consent and no automatic reopening launch', async t => {
  const h = harness(t); await h.configure(); await flush(); h.complete(); await flush(); await h.act({ action: 'pause' }); assert.equal(h.get().enabled, false); assert.equal(h.get().authorized, true);
  h.fire('tool_result', { toolName: 'write', input: { path: 'plan.md' } }); h.fire('agent_settled'); await flush(); assert.equal(h.requests.filter(r => r.method === 'spawn').length, 1);
  await h.act({ action: 'resume' }); await flush(); assert.equal(h.get().enabled, true);
});
test('MOCK reopen existing review observes exact status without relaunch', async t => {
  const h = harness(t); await h.configure(); await flush(); const a = h.get().reviewActivity;
  h.fire('session_shutdown');
  const reopened = harness(t, { cwd: h.cwd }); await flush(); assert.equal(reopened.requests.length, 0); assert.equal(reopened.get().reviewActivity.runId, a.runId);
  const receipt = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'ADAPTER_RECEIPT.json')));
  fs.writeFileSync(path.join(receipt.asyncDir, 'status.json'), JSON.stringify({ runId: a.runId, sessionId: receipt.ownerSessionFile, state: 'complete', steps: [{ agent: 'research-mainline-supervisor', status: 'complete', structuredOutput: GOOD }] }));
  await reopened.act({ action: 'check' }); await flush(); assert.equal(reopened.get().lastVerdict, 'ON_TRACK'); assert.equal(reopened.requests.length, 0);
});
test('MOCK readiness failure and rejected spawn persisted, no retry/fallback', async t => {
  for (const options of [{ noRPC: true }, { rejectSpawn: true }]) { const h = harness(t, options); await h.configure(); await flush(); assert.equal(h.get().reviewActivity.state, 'failed'); assert.equal(h.get().blocked, false); const n = h.requests.length; h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, n); }
});
test('MOCK early completion is correlated to spawn request before receipt', async t => {
  const h = harness(t, { earlyComplete: true }); await h.configure(); await flush(); assert.equal(h.get().lastVerdict, 'ON_TRACK'); assert.equal(h.get().reviewActivity.state, 'standby');
});
test('MOCK missing/malformed output and partial coverage never passed', async t => {
  const h = harness(t); await h.configure(); await flush(); h.complete({ results: [{ agent: 'research-mainline-supervisor', success: true }] }); await flush(); assert.equal(h.get().blocked, false);
  assert.equal(validReview({ ...GOOD, unverified: ['withheld artifact'] }), false); assert.equal(validReview({ ...GOOD, extra: true }), false);
  assert.equal(validReview({ ...GOOD, verdict: 'INSUFFICIENT_CONTEXT', unverified: ['withheld artifact'] }), true);
});
test('MOCK fixed-file fallback and symlink output fail-closed', async t => {
  const h = harness(t); await h.configure(); await flush(); const a = h.get().reviewActivity;
  fs.writeFileSync(path.join(a.packetDir, 'RAW_REVIEW.json'), JSON.stringify(GOOD));
  h.complete({ results: [{ agent: 'research-mainline-supervisor', success: true }] }); await flush(); assert.equal(h.get().lastVerdict, 'ON_TRACK');
  await h.act({ action: 'correction', text: 'new evidence', evidencePaths: ['plan.md'] });
  h.fire('tool_result', { toolName: 'edit', toolCallId: 'repair-next', input: { path: 'plan.md' }, content: [], isError: false });
  await h.act({ action: 'checkpoint', stageId: 'repair-B', kind: 'stage_complete' });
  await h.act({ action: 'check' }); await flush(); const next = h.get().reviewActivity;
  fs.symlinkSync(path.join(a.packetDir, 'RAW_REVIEW.json'), path.join(next.packetDir, 'RAW_REVIEW.json'));
  h.complete({ results: [{ agent: 'research-mainline-supervisor', success: true }] }); await flush(); assert.equal(h.get().reviewActivity.state, 'failed');
});
test('MOCK evidence during review remains pending until a genuine next checkpoint', async t => {
  const h = harness(t); await h.configure(); await flush(); const initial = h.get().revision;
  h.fire('tool_result', { toolName: 'write', toolCallId: 'new', input: { path: 'plan.md' }, content: [], isError: true });
  h.complete(); await flush(); assert.equal(h.get().reviewedRevision, initial); assert.ok(h.get().revision > initial);
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.filter(r => r.method === 'spawn').length, 1);
  await h.act({ action: 'checkpoint', stageId: 'new-method', kind: 'plan_change' });
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.filter(r => r.method === 'spawn').length, 2);
});
test('MOCK exact request/run/session completion association enforced', async t => {
  const h = harness(t); await h.configure(); await flush();
  h.complete({ toolCallId: 'rpc-spawn-unrelated' }); h.complete({ sessionId: 'another-parent' }); await flush(); assert.equal(h.get().reviewActivity.state, 'reviewing');
  h.complete(); await flush(); assert.equal(h.get().lastVerdict, 'ON_TRACK');
});
test('MOCK child environment registers no extension tools or triggers', () => {
  let registered = false; createMainlineAdapter({ registerTool() { registered = true; } }, { env: { PI_SUBAGENT_CHILD: '1' }, Store: MockStore }); assert.equal(registered, false);
});
const UNCERTAIN = { verdict: 'INSUFFICIENT_CONTEXT', findings: [], coverage: 'Synthetic uncertain direction', unverified: [] };
const GATE_TITLE = '确认本次执行权限（不是科学验收）';
const GATE_BASH = { toolName: 'bash', toolCallId: 'gate-bash', input: { command: 'opaque local command' } };
const makeLimited = async h => {
  await h.configure(); await flush();
  h.complete({ results: [{ agent: 'research-mainline-supervisor', success: true, structuredOutput: UNCERTAIN }] }); await flush();
};
test('MOCK auto-approve defaults on for the execution gate but never answers consent prompts', async t => {
  const h = harness(t); await makeLimited(h);
  assert.ok(h.confirms.includes('授权后台主线监督'), 'scientific/model consent is still asked');
  assert.equal(h.fire('tool_call', GATE_BASH), undefined);
  assert.equal(h.confirms.includes(GATE_TITLE), false, 'default-on skips only the execution gate');
  assert.ok(h.notices.some(n => n.text.includes('已自动放宽并批准执行')));
});
test('MOCK explicit false is not overridden by a stale on sidecar', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-explicit-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const h = harness(t, { cwd, autoApprove: false, prepare: dir => assert.equal(writeAutoApproveState(dir, true).persisted, true) });
  assert.equal((await h.act({ action: 'status' })).details.autoApprove, false);
  await makeLimited(h);
  assert.equal(await h.fire('tool_call', GATE_BASH), undefined);
  assert.ok(h.confirms.includes(GATE_TITLE), 'explicit false still asks the execution permission');
});
test('MOCK on/off choice reloads across recreated adapters for the same project only', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-persist-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-other-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  const h1 = harness(t, { cwd });
  assert.equal((await h1.act({ action: 'status' })).details.autoApprove, true);
  const off = await h1.act({ action: 'auto_approve', enabled: false });
  assert.deepEqual({ autoApprove: off.details.autoApprove, persisted: off.details.persisted }, { autoApprove: false, persisted: true });
  h1.fire('session_shutdown');
  const h2 = harness(t, { cwd });
  assert.equal((await h2.act({ action: 'status' })).details.autoApprove, false);
  const on = await h2.act({ action: 'auto_approve', enabled: true });
  assert.deepEqual({ autoApprove: on.details.autoApprove, persisted: on.details.persisted }, { autoApprove: true, persisted: true });
  h2.fire('session_shutdown');
  const h3 = harness(t, { cwd });
  assert.equal((await h3.act({ action: 'status' })).details.autoApprove, true);
  const hOther = harness(t, { cwd: other });
  assert.equal((await hOther.act({ action: 'status' })).details.autoApprove, true);
});
test('MOCK switching project inside one adapter does not leak the other cwd setting', async t => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-cwd-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-cwd-b-'));
  t.after(() => { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); });
  const h = harness(t, { cwd: a });
  await h.act({ action: 'auto_approve', enabled: false });
  const ctxB = { ...h.ctx, cwd: b };
  assert.equal((await h.actAt(ctxB, { action: 'status' })).details.autoApprove, true);
  assert.equal((await h.actAt(h.ctx, { action: 'status' })).details.autoApprove, false);
});
test('MOCK malformed or symlinked sidecars fall back to default with a visible warning', async t => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-bad-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-link-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-auto-target-'));
  t.after(() => { for (const dir of [bad, linkRoot, target]) fs.rmSync(dir, { recursive: true, force: true }); });
  const hBad = harness(t, { cwd: bad, prepare: dir => { const file = autoApproveStatePath(dir); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{bad'); } });
  assert.equal((await hBad.act({ action: 'status' })).details.autoApprove, true);
  assert.ok(hBad.notices.some(n => n.level === 'warning' && n.text.includes('无效')));
  const targetFile = path.join(target, 'auto-approve.json');
  fs.writeFileSync(targetFile, JSON.stringify({ schema: 'pi-mainline-auto-approve.v1', autoApprove: false }));
  const hLink = harness(t, { cwd: linkRoot, prepare: dir => { const file = autoApproveStatePath(dir); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(targetFile, file); } });
  assert.equal((await hLink.act({ action: 'status' })).details.autoApprove, true);
  assert.ok(hLink.notices.some(n => n.level === 'warning' && n.text.includes('不安全')));
  await makeLimited(hBad);
  await hBad.fire('tool_call', GATE_BASH);
  assert.equal(hBad.confirms.includes(GATE_TITLE), false);
});
test('MOCK hooks bind the actual project before execution or result capture', async t => {
  const a = harness(t);
  const b = harness(t);
  await makeLimited(a);
  await makeLimited(b);
  await b.act({ action: 'auto_approve', enabled: false });
  const revisionA = a.get().revision;
  await a.hooks.get('tool_call')(GATE_BASH, b.ctx);
  assert.ok(b.confirms.includes(GATE_TITLE), 'project B preference and UI are used without an intervening status tool');
  a.hooks.get('tool_result')({ toolName: 'write', toolCallId: 'project-b-write', input: { path: 'plan.md' }, content: [], isError: false }, b.ctx);
  assert.equal(a.get().revision, revisionA, 'project A never receives project B evidence');
  const confirmed = a.confirms.length;
  assert.equal(a.hooks.get('tool_call')(GATE_BASH, a.ctx), undefined);
  assert.equal(a.confirms.length, confirmed, 'project A keeps its own on preference');
});
test('MOCK argument-less slash toggle loads the destination preference first', async t => {
  const a = harness(t);
  const b = harness(t);
  await a.act({ action: 'auto_approve', enabled: false });
  await a.command.handler('auto-approve', b.ctx);
  assert.equal((await a.actAt(b.ctx, { action: 'status' })).details.autoApprove, false);
  assert.match(b.notices.at(-1).text, /已关闭/);
});
test('MOCK a custom completion event has no prompt and never crashes or creates review work', t => {
  const h = harness(t);
  assert.doesNotThrow(() => h.fire('before_agent_start', { messageType: 'custom', message: { customType: 'task-complete', content: 'completed' } }));
  assert.equal(h.requests.length, 0);
});
test('MOCK tool calls before session_start initialize safely while human input remains unconditional', t => {
  const h = harness(t, { skipSessionStart: true });
  assert.equal(h.fire('tool_call', { toolName: 'ask_user', input: {} }), undefined);
  assert.doesNotThrow(() => h.fire('tool_call', { toolName: 'read', input: { path: 'plan.md' } }));
  assert.equal(h.requests.length, 0);
});
test('MOCK failed toggle persistence is surfaced in the result and command notice', async t => {
  const h = harness(t);
  fs.mkdirSync(autoApproveStatePath(h.cwd), { recursive: true });
  const result = await h.act({ action: 'auto_approve', enabled: false });
  assert.equal(result.details.autoApprove, false);
  assert.equal(result.details.persisted, false);
  assert.ok(result.details.persistenceError);
  await h.command.handler('auto-approve on', h.ctx);
  const last = h.notices.at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.text, /未保存/);
});
