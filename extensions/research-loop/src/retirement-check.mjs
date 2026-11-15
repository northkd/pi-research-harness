/** Readiness only: never shuts down, signals processes, reads caller-supplied paths,
 * or treats a model's final text as proof. binding/report/probe must come from
 * verified host records, not research_communication tool arguments.
 *
 * A complete probe covers ALL owned work, including detached/reload-surviving
 * work. backgroundTasks are native BgTaskSnapshots with verified owner sessionId
 * and processExited; subagents carry native process-terminal proofs. Inventories
 * of active formal children, requests, processes, locks and unknown effects must
 * be explicit arrays. Missing native adapters intentionally leave this blocked.
 */
import path from 'node:path';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ADOPTION = /^adopt-[a-f0-9]{24}$/;
const REPORT_TERMINAL = new Set(['completed', 'partial', 'failed', 'blocked']);
const BG_TERMINAL = new Set(['completed', 'failed', 'killed']);
const CHILD_TERMINAL = new Set(['complete', 'completed', 'failed', 'stopped']);
const BACKGROUND = new Set(['bg_run', 'bg_delegate', 'bg_run_pi', 'pi_research_fusion']);
const INVENTORIES = ['backgroundTasks', 'subagents', 'formalChildren', 'supervisorRequests', 'descendantProcesses', 'heldLocks', 'unknownTools'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validId = value => typeof value === 'string' && ID.test(value);
const result = reasons => ({ ready: reasons.size === 0, reasons: [...reasons] });

function scopeFor(ctx, binding) {
  const sessionId = ctx?.sessionManager?.getSessionId?.(), child = binding?.researchSession;
  if (!validId(sessionId) || binding?.sessionId !== sessionId || child?.origin !== 'research_session'
      || !validId(child.parentSessionId) || child.parentSessionId === sessionId
      || typeof binding.charterHash !== 'string' || !HASH.test(binding.charterHash)
      || typeof binding.adoptionId !== 'string' || !ADOPTION.test(binding.adoptionId)
      || typeof ctx?.cwd !== 'string' || !path.isAbsolute(ctx.cwd) || path.normalize(ctx.cwd) !== ctx.cwd) return null;
  return { sessionId, parentSessionId: child.parentSessionId, adoptionId: binding.adoptionId, charterHash: binding.charterHash, cwd: ctx.cwd };
}

function sameScope(value, scope, includeCwd = false) {
  return object(value) && ['sessionId', 'parentSessionId', 'adoptionId', 'charterHash', ...(includeCwd ? ['cwd'] : [])]
    .every(key => value[key] === scope[key]);
}

function nativeState(ctx, reasons) {
  if (typeof ctx?.isIdle !== 'function' || typeof ctx?.hasPendingMessages !== 'function') {
    reasons.add('native-state-unavailable'); return;
  }
  try {
    if (ctx.isIdle() !== true) reasons.add('agent-not-idle');
    if (ctx.hasPendingMessages() !== false) reasons.add('native-messages-pending');
  } catch { reasons.add('native-state-unavailable'); }
}

function readActivity(ctx) {
  const manager = ctx.sessionManager;
  const entries = typeof manager.getEntries === 'function' ? manager.getEntries() : manager.getBranch?.();
  if (!Array.isArray(entries) || entries.length > 50_000) throw new Error('unavailable');
  const calls = new Map(), replies = new Map(), toolNames = new Set();
  for (const entry of entries) {
    const message = entry?.type === 'message' ? entry.message : null;
    if (!message) continue;
    if (message.role === 'assistant' && Array.isArray(message.content)) for (const part of message.content) {
      if (part?.type !== 'toolCall') continue;
      toolNames.add(part.name);
      const args = part.arguments ?? {};
      const child = part.name === 'subagent' && (!args.action || args.action === 'spawn' || args.action === 'resume');
      if (BACKGROUND.has(part.name) || child) calls.set(part.id, { kind: child ? 'subagent' : 'background', toolName: part.name });
    }
    if (message.role === 'toolResult') replies.set(message.toolCallId, message);
  }
  const backgroundTaskIds = new Set(), subagentRunIds = new Set(), unknown = [];
  for (const [callId, call] of calls) {
    const reply = replies.get(callId);
    const id = call.kind === 'background' ? reply?.details?.task?.id : reply?.details?.runId;
    if (!validId(callId) || reply?.toolName !== call.toolName || !validId(id)) unknown.push(callId);
    else (call.kind === 'background' ? backgroundTaskIds : subagentRunIds).add(id);
  }
  return { backgroundTaskIds: [...backgroundTaskIds].sort(), subagentRunIds: [...subagentRunIds].sort(),
    unknownLaunches: unknown, toolNames: [...toolNames].sort(), entryCount: entries.length };
}

function validBackground(row, scope, now) {
  return object(row) && validId(row.id) && row.sessionId === scope.sessionId && row.cwd === scope.cwd
    && BG_TERMINAL.has(row.status) && row.processExited === true && finite(row.startTime)
    && finite(row.endTime) && row.endTime >= row.startTime && row.endTime <= now
    && (Number.isInteger(row.exitCode) || row.exitCode === null && typeof row.signal === 'string')
    && (row.notified === true || row.notifyOnCompletion === false);
}

function validChild(row, scope, now) {
  const proof = row?.processTerminal;
  if (!object(row) || !validId(row.runId) || row.sessionId !== scope.sessionId || !CHILD_TERMINAL.has(row.state)
      || proof?.version !== 1 || proof.state !== 'observed' || proof.runId !== row.runId
      || !validId(proof.runnerProcessInstanceId) || !finite(proof.observedAt) || proof.observedAt > now
      || !Array.isArray(proof.instances) || !proof.instances.length) return false;
  const seen = new Set();
  for (const instance of proof.instances) {
    if (!object(instance) || !validId(instance.processInstanceId) || seen.has(instance.processInstanceId)
        || !finite(instance.closeObservedAt) || instance.closeObservedAt > proof.observedAt
        || !(Number.isInteger(instance.exitCode) || instance.exitCode === null)
        || !(typeof instance.signal === 'string' || instance.signal === null)) return false;
    seen.add(instance.processInstanceId);
    if (instance.kind === 'runner') {
      if (instance.processInstanceId !== proof.runnerProcessInstanceId) return false;
    } else if (instance.kind === 'pi-writer') {
      const tree = instance.processTree;
      if (!Number.isInteger(instance.attempt) || instance.attempt < 0 || tree?.state !== 'observed'
          || tree.mechanism !== 'posix-process-group' || !Number.isInteger(tree.processGroupId) || tree.processGroupId <= 0
          || !finite(tree.verifiedAt) || tree.verifiedAt > proof.observedAt) return false;
    } else return false;
  }
  return proof.instances.some(instance => instance.kind === 'runner');
}

/** Check immediately before native ctx.shutdown() at agent_settled. A ready
 * result is a current observation, not a reusable shutdown grant. The caller
 * must not await other work between this result and its own shutdown request.
 */
export async function checkResearchRetirement(ctx, { settled, binding, report, probe, now = Date.now } = {}) {
  const reasons = new Set();
  if (settled !== true) reasons.add('agent-not-settled');
  let scope;
  try { scope = scopeFor(ctx, binding); } catch { /* no authority inferred */ }
  if (!scope) { reasons.add('not-formal-research-child'); return result(reasons); }
  const reportValid = () => sameScope(report, scope) && validId(report?.id)
    && report.persisted === true && REPORT_TERMINAL.has(report.status);
  if (!reportValid()) reasons.add('durable-report-unverified');
  nativeState(ctx, reasons);
  let activity;
  try { activity = readActivity(ctx); } catch { reasons.add('session-history-unavailable'); }
  if (activity?.unknownLaunches.length) reasons.add('launch-outcome-unknown');
  if (typeof probe !== 'function') reasons.add('retirement-probe-unavailable');
  if (reasons.size) return result(reasons);
  const identity = JSON.stringify(scope), history = JSON.stringify(activity);
  let snapshot;
  try { snapshot = await probe({ scope: Object.freeze({ ...scope }), activity: structuredClone(activity) }); }
  catch { reasons.add('retirement-probe-unavailable'); return result(reasons); }
  let checkedAt;
  try { checkedAt = now(); } catch { /* invalid clock refuses */ }
  if (!object(snapshot) || snapshot.complete !== true || INVENTORIES.some(key => !Array.isArray(snapshot[key]))) {
    reasons.add('retirement-probe-incomplete'); return result(reasons);
  }
  if (!sameScope(snapshot, scope, true)) reasons.add('retirement-probe-scope-mismatch');
  if (!finite(checkedAt) || !finite(snapshot.observedAt) || snapshot.observedAt > checkedAt || checkedAt - snapshot.observedAt > 5_000) reasons.add('retirement-probe-stale');
  for (const [key, reason] of [['formalChildren', 'formal-children-present'], ['supervisorRequests', 'supervisor-requests-pending'],
    ['descendantProcesses', 'descendant-processes-present'], ['heldLocks', 'locks-held'], ['unknownTools', 'unknown-tool-effects']]) {
    if (snapshot[key].length) reasons.add(reason);
  }
  const bgIds = new Set();
  for (const row of snapshot.backgroundTasks) {
    if (!validBackground(row, scope, checkedAt) || bgIds.has(row?.id)) reasons.add('background-task-unverified');
    bgIds.add(row?.id);
  }
  if (activity.backgroundTaskIds.some(id => !bgIds.has(id))) reasons.add('background-task-unaccounted');
  const childIds = new Set();
  for (const row of snapshot.subagents) {
    if (!validChild(row, scope, checkedAt) || childIds.has(row?.runId)) reasons.add('subagent-terminal-unverified');
    childIds.add(row?.runId);
  }
  if (activity.subagentRunIds.some(id => !childIds.has(id))) reasons.add('subagent-unaccounted');
  try {
    if (JSON.stringify(scopeFor(ctx, binding)) !== identity) reasons.add('native-session-changed');
    if (!reportValid()) reasons.add('durable-report-unverified');
    if (JSON.stringify(readActivity(ctx)) !== history) reasons.add('session-history-changed');
  } catch { reasons.add('native-session-changed'); }
  nativeState(ctx, reasons);
  return result(reasons);
}
