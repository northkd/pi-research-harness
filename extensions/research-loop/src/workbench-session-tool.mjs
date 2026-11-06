/**
 * Native `research_session` tool.
 *
 * This creates a real TOP-LEVEL Pi session joined to the same confirmed
 * res-workflow as the current session. It is intentionally not the bundled
 * `subagent` tool (pi-coding-agent agent/task/async runs a subordinate inside
 * the current session) and not Agent/SubagentWorkflow from the other installed
 * package. Both remain installed and unchanged.
 *
 * The tool takes only role/task/stage. Parent session id, cwd, owner, charter
 * and adoption are derived from the trusted tool context and re-verified by the
 * dashboard endpoint; no destination URL, project, model or tenant is accepted
 * from tool arguments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireWorkbenchRecordContext } from './workbench-context.mjs';
import { mergeDelegationRestrictions } from './delegation-policy.mjs';

export const RESEARCH_SESSION_TOOL_NAME = 'research_session';
export const RESEARCH_SESSION_STAGES = ['1-idea', '2-experiment', '3-review', '4-summary', '5-writing'];
export const RESEARCH_SESSION_LIMITS = Object.freeze({ maxTaskChars: 4000, maxRoleChars: 40 });
export const RESEARCH_DISPATCH_TASK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['id', 'role', 'task', 'stage'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    role: { type: 'string', minLength: 2, maxLength: 40, pattern: '^[a-z][a-z0-9-]{1,39}$' },
    task: { type: 'string', minLength: 1, maxLength: 4000 },
    stage: { type: 'string', enum: RESEARCH_SESSION_STAGES },
    dependsOn: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 128 } },
  },
};
const ROLE = /^[a-z][a-z0-9-]{1,39}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENDPOINT_PATH = '/api/res-workflow/participants/spawn';
const LOCAL_TOKEN_HEADER = 'x-pi-local-token';
const MAX_AUTH_BYTES = 4096;
const CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const loopback = value => value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';

/** Every component below HOME must be real; a symlinked ancestor can redirect credentials. */
function assertNoSymlinkAncestors(file, home) {
  const relative = path.relative(home, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('unsafe-dashboard-auth-path');
  let current = home;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error('unsafe-dashboard-auth-path');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('unsafe-dashboard-auth-path');
  }
}

function safeFile(file, home, maximum) {
  assertNoSymlinkAncestors(file, home);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('unsafe-dashboard-auth-file');
  return fs.readFileSync(file, 'utf8');
}

/** Read a small JSON response without letting an endpoint exhaust memory. */
export async function readBoundedJson(response, maximum = MAX_RESPONSE_BYTES) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error('response-too-large');
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > maximum) throw new Error('response-too-large');
    return JSON.parse(raw);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += bytes.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new Error('response-too-large');
      }
      chunks.push(bytes);
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* no-op */ }
  }
  return JSON.parse(Buffer.concat(chunks.map(bytes => Buffer.from(bytes)), total).toString('utf8'));
}

/**
 * Read the existing local credentials without exposing or copying them into
 * arguments, results or logs. Config/token are fixed paths under HOME.
 */
export function readDashboardLocalAuth({ home = os.homedir() } = {}) {
  const configFile = path.join(home, '.pi', 'dashboard', 'config.json');
  const tokenFile = path.join(home, '.pi', 'dashboard', 'local', 'token');
  const config = JSON.parse(safeFile(configFile, home, CONFIG_BYTES));
  if (!object(config) || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('dashboard-config-invalid');
  assertNoSymlinkAncestors(tokenFile, home);
  const tokenInfo = fs.lstatSync(tokenFile);
  if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.size > MAX_AUTH_BYTES || (tokenInfo.mode & 0o077) !== 0) throw new Error('unsafe-dashboard-token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token || token.length > 1024 || /\s/.test(token)) throw new Error('dashboard-token-invalid');
  const configured = typeof config.bindHost === 'string' && config.bindHost ? config.bindHost : '127.0.0.1';
  const host = loopback(configured) ? (configured === '::1' || configured === '[::1]' ? '[::1]' : configured) : '127.0.0.1';
  return { baseUrl: `http://${host}:${config.port}`, token };
}

export const RESEARCH_SESSION_INITIAL_PROMPT_BYTES = 16 * 1024;
const promptBytes = value => new TextEncoder().encode(value).length;
function promptPrefix(value, maximum) {
  let used = 0, output = '';
  for (const character of value) {
    const bytes = promptBytes(character);
    if (used + bytes > maximum) break;
    output += character; used += bytes;
  }
  return output;
}

/** A fresh task brief, never a copy of the parent's transcript or dependency bodies. */
export function buildResearchSessionPrompt(provenance, taskContext) {
  if (!object(provenance)) throw new Error('research-session-provenance-invalid');
  const ids = [...new Set((taskContext?.prerequisiteResults ?? []).map(row => row?.id).filter(id => typeof id === 'string' && ID.test(id)))].slice(0, 12);
  const dispatchId = taskContext?.dispatchId ?? provenance.dispatchId;
  const taskId = taskContext?.taskId ?? provenance.taskId;
  const prefix = [
    'You are a research collaborator in a fresh Pi session joined to the confirmed research workbench. No parent conversation is copied into this task.',
    `Role: ${provenance.role}`,
    `Stage: ${provenance.stage}`,
    `Parent session: ${provenance.parentSessionId}`,
    `Frozen charter: ${provenance.charterHash} (adoption ${provenance.adoptionId})`,
    'Use the verified workbench context for the workspace, current charter and permission scope. This assignment expands none of them.',
    provenance.readOnly === true ? 'READ-ONLY assignment: preserve project files and external state. Do not edit, install, or run modifying experiments. Delegate only read-only work; coordination and result receipts remain available.' : '',
    provenance.role === 'research-coordinator'
      ? 'You are the execution coordinator: analyze the goal, decompose it into bounded tasks, schedule specialists, follow progress and blockers, arrange independent verification, and aggregate the evidence. Keep implementation and raw logs in worker contexts. Send the lead only decisions requiring attention and a short final aggregate receipt with evidence references.'
      : 'Complete only this assigned scope. Keep analysis and raw execution details in this worker context; return a short truthful result and evidence references.',
    '',
    'Task:',
  ].filter(Boolean).join('\n') + '\n';
  const suffix = [
    '',
    typeof dispatchId === 'string' && ID.test(dispatchId) ? `Dispatcher plan reference: ${dispatchId}` : '',
    typeof taskId === 'string' && ID.test(taskId) ? `Assignment task reference: ${taskId}` : '',
    ids.length ? `Direct dependency IDs: ${ids.join(', ')}` : '',
    'First call research_dispatch action="status". Retrieve dependency receipts with action="status", view="detail", taskId="<dependency-id>", offset=0; read further pages only as needed. Dependency summaries and evidence bodies are deliberately not copied into this prompt.',
    'Declared structured tasks are automatically scheduled. Coordinate their receipts instead of redoing the work. For several separable items submit a plan; for one indivisible item record atomic with a concrete reason. Leaf roles cannot delegate.',
    'Use research_loop to record actual evidence. Finish an assigned task with research_dispatch report (completed, failed or blocked), a short summary and relative evidence paths. Wait for your own children and independent checks before claiming completion. Publication, provider access and workspace limits remain unchanged.',
  ].filter(Boolean).join('\n');
  const task = String(provenance.task ?? '');
  const complete = prefix + task + '\n' + suffix;
  if (promptBytes(complete) < RESEARCH_SESSION_INITIAL_PROMPT_BYTES) return complete;
  const notice = '\n[Task brief truncated to fit the startup budget. The complete original task is preserved in the verified session record. Before ANY execution, call research_dispatch action="status", view="detail", taskId="self", offset=0 and read every task page. Apply all original goals and constraints; do not infer that omitted text grants permission.]';
  const available = RESEARCH_SESSION_INITIAL_PROMPT_BYTES - 1 - promptBytes(prefix + notice + '\n' + suffix);
  if (available < 0) throw new Error('research-session-prompt-metadata-too-large');
  return prefix + promptPrefix(task, available) + notice + '\n' + suffix;
}


function blocked(error, extra = {}) {
  const result = { status: 'blocked', tool: RESEARCH_SESSION_TOOL_NAME, error, ...extra };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result, isError: true };
}

export function createResearchSessionTool(pi, options = {}) {
  const readContext = options.readContext ?? ((ctx, contextOptions) => requireWorkbenchRecordContext(ctx, contextOptions, 'research-session-parent-not-joined'));
  const resolveAuth = options.resolveAuth ?? (() => readDashboardLocalAuth(options.authOptions));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestId = options.requestId ?? randomUUID;
  const maxPerParent = options.maxPerParent ?? 2;
  const maxTotal = options.maxTotal ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const inFlight = new Map();
  const restrictions = new Map();
  const rememberRestrictions = (event, ctx, input = false) => {
    if (input ? event?.source !== 'user' : event?.messageType === 'custom') return;
    const id = ctx?.sessionManager?.getSessionId?.(), text = input ? event?.text : event?.prompt;
    if (!id || typeof text !== 'string') return;
    if (!restrictions.has(id) && restrictions.size >= 128) restrictions.delete(restrictions.keys().next().value);
    restrictions.set(id, mergeDelegationRestrictions(restrictions.get(id), text));
  };
  if (typeof pi?.on === 'function') {
    pi.on('before_agent_start', (event, ctx) => rememberRestrictions(event, ctx));
    pi.on('input', (event, ctx) => rememberRestrictions(event, ctx, true));
    pi.on('session_shutdown', () => restrictions.clear());
  }

  async function execute(_id, params, signal, _update, ctx) {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : undefined;
    // Session id and cwd come ONLY from the runtime context, never from params.
    if (typeof sessionId !== 'string' || !sessionId || !cwd) return blocked('research-session-context-unavailable');
    if (!ROLE.test(params?.role ?? '')) return blocked('research-session-role-invalid');
    if (!text(params?.task, RESEARCH_SESSION_LIMITS.maxTaskChars)) return blocked('research-session-task-invalid');
    if (!RESEARCH_SESSION_STAGES.includes(params?.stage)) return blocked('research-session-stage-invalid');
    if (params?.readOnly !== undefined && params.readOnly !== true) return blocked('research-session-readonly-invalid');

    let context;
    try {
      context = await readContext(ctx, options.contextOptions);
    } catch (error) {
      return blocked(/^research-workbench-[a-z-]+$/.test(error?.message ?? '') ? error.message : 'research-session-parent-not-joined');
    }
    if (!context || context.sessionId !== sessionId || typeof context.charterHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(context.charterHash)) {
      return blocked('research-session-parent-not-joined');
    }
    if (signal?.aborted) return blocked('research-session-cancelled');

    const parentCount = inFlight.get(sessionId) ?? 0;
    if (parentCount >= maxPerParent) return blocked('research-session-concurrency-limit');
    if ([...inFlight.values()].reduce((sum, count) => sum + count, 0) >= maxTotal) return blocked('research-session-capacity-limit');
    inFlight.set(sessionId, parentCount + 1);
    try {
      let auth;
      try { auth = await resolveAuth(); }
      catch { return blocked('research-session-dashboard-auth-unavailable'); }
      if (!auth || typeof auth.baseUrl !== 'string' || typeof auth.token !== 'string' || !/^https?:\/\//.test(auth.baseUrl)) {
        return blocked('research-session-dashboard-auth-unavailable');
      }
      const target = new URL(ENDPOINT_PATH, auth.baseUrl);
      if (!loopback(target.hostname)) return blocked('research-session-destination-not-loopback');
      const body = {
        parentSessionId: sessionId,
        role: params.role,
        task: params.task,
        stage: params.stage,
        requestId: requestId(),
        ...(params.tasks === undefined ? {} : { tasks: params.tasks }),
        ...((params.readOnly === true || context.researchSession?.readOnly === true || restrictions.get(sessionId)?.readOnly === true) ? { readOnly: true } : {}),
      };
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [LOCAL_TOKEN_HEADER]: auth.token },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'error',
      });
      let reply = null;
      try { reply = await readBoundedJson(response); }
      catch (error) { if (error?.message === 'response-too-large') throw error; /* fixed error below */ }
      if (!response.ok || !object(reply) || reply.status !== 'spawned') {
        const code = object(reply) && typeof reply.code === 'string' && /^[a-z0-9-]{1,100}$/.test(reply.code)
          ? reply.code
          : 'research-session-spawn-refused';
        return blocked(code);
      }
      const result = {
        status: 'spawned',
        tool: RESEARCH_SESSION_TOOL_NAME,
        parentSessionId: sessionId,
        requestId: body.requestId,
        spawnToken: reply.spawnToken,
        role: reply.role,
        stage: reply.stage,
        workflowCwd: reply.workflowCwd,
        registration: reply.registration ?? 'pending',
        initialPromptQueued: reply.initialPromptQueued === true,
        ...(ID.test(reply.rootSessionId ?? '') ? { rootSessionId: reply.rootSessionId } : {}),
        ...(ID.test(reply.sessionId ?? '') ? { sessionId: reply.sessionId } : {}),
        ...(Number.isSafeInteger(reply.depth) && reply.depth >= 1 && reply.depth <= 3 ? { depth: reply.depth } : {}),
        ...(reply.readOnly === true ? { readOnly: true } : {}),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result };
    } catch (error) {
      if (signal?.aborted) return blocked('research-session-cancelled');
      if (error?.message === 'response-too-large') return blocked('research-session-response-too-large');
      return blocked(error?.name === 'TimeoutError' ? 'research-session-timeout' : 'research-session-unavailable');
    } finally {
      const remaining = (inFlight.get(sessionId) ?? 1) - 1;
      if (remaining > 0) inFlight.set(sessionId, remaining);
      else inFlight.delete(sessionId);
    }
  }

  return {
    name: RESEARCH_SESSION_TOOL_NAME,
    label: 'Research session (linked collaborator)',
    description: 'Create a real top-level Pi session collaborator joined to the current confirmed res-workflow, with a specific role, task and stage. This is NOT the bundled subagent tool (agent/task/async) and NOT the separately installed Agent/SubagentWorkflow package: both start subordinate runs that return to the current session. Use research_session only from the joined res-workflow. For a coordinator receiving several jobs, include a structured tasks array: the server automatically schedules its child tasks after registration, preserving real parent links. The runtime supplies the parent session, workspace, owner, charter and adoption; role/task/stage cannot redirect them.',
    promptSnippet: 'Create a top-level res-workflow collaborator (role+task+stage), distinct from a subordinate subagent.',
    promptGuidelines: [
      'Call research_session only from a session already joined to the confirmed res-workflow.',
      'Include tasks for multiple separable assignments so the server actually dispatches them, instead of asking a coordinator to do every assignment locally.',
      'The tool derives the workspace, owner and charter from this session. Do not try to pass a project, model, URL or session id.',
    ],
    parameters: {
      type: 'object', additionalProperties: false, required: ['role', 'task', 'stage'],
      properties: {
        role: { type: 'string', minLength: 2, maxLength: RESEARCH_SESSION_LIMITS.maxRoleChars, pattern: '^[a-z][a-z0-9-]{1,39}$', description: 'Bounded collaborator role, for example literature or experiment.' },
        task: { type: 'string', minLength: 1, maxLength: RESEARCH_SESSION_LIMITS.maxTaskChars, description: 'Concrete task stored unchanged in verified metadata. Startup uses a bounded brief; if truncated, the worker must retrieve the complete task with research_dispatch status detail/self before execution.' },
        readOnly: { type: 'boolean', const: true, description: 'Narrow this assignment to read-only work. Inherited user/parent read-only restrictions are always preserved and cannot be cleared by tool arguments.' },
        stage: { type: 'string', enum: RESEARCH_SESSION_STAGES, description: 'Current res-workflow stage for this collaborator.' },
        tasks: { type: 'array', minItems: 2, maxItems: 12, items: RESEARCH_DISPATCH_TASK_SCHEMA, description: 'Optional declared jobs for this coordinator. Automatically dispatched after its real session registers; dependsOn declares prerequisite task ids.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    execute,
  };
}

/** Register the tool. Kept separate so the parent can compose extension order. */
export function registerWorkbenchSessionTool(pi, options = {}) {
  const tool = createResearchSessionTool(pi, options);
  pi.registerTool(tool);
  return tool;
}
