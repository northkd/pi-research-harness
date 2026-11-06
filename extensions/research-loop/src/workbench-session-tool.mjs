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
import { readWorkbenchRecordContext } from './workbench-context.mjs';

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

/** Build the exact first prompt the child receives; metadata only, no model call. */
export function buildResearchSessionPrompt(provenance) {
  if (!object(provenance)) throw new Error('research-session-provenance-invalid');
  return [
    `You are a research collaborator with a real parent session in the confirmed res-workflow at ${provenance.workflowCwd}.`,
    `Role: ${provenance.role}`,
    `Stage: ${provenance.stage}`,
    `Parent session: ${provenance.parentSessionId}`,
    `Frozen charter: ${provenance.charterHash} (adoption ${provenance.adoptionId})`,
    '',
    'Task:',
    provenance.task,
    '',
    'You run in a separate Pi process, but remain a child of the recorded parent. Keep the same workspace, owner, frozen charter, permission scope and shared task budget.',
    'First call research_dispatch status. Declared structured tasks are automatically scheduled by the server; coordinate their results instead of doing them locally. For several separable work items, submit a research_dispatch plan with dependencies before bulk work. For one indivisible item, use research_dispatch atomic with a concrete reason. Controlled child delegation is allowed within the shared limits; leaf roles cannot delegate.',
    'Use research_loop to record actual attempts and evidence. If status shows a dispatcher assignment, finish with research_dispatch report (completed, failed or blocked), a truthful summary and relative evidence paths. Wait for your own children before reporting completion. This assignment never expands the inherited permission scope, provider access, budget or workspace.',
  ].join('\n');
}

function blocked(error, extra = {}) {
  const result = { status: 'blocked', tool: RESEARCH_SESSION_TOOL_NAME, error, ...extra };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result, isError: true };
}

export function createResearchSessionTool(pi, options = {}) {
  const readContext = options.readContext ?? readWorkbenchRecordContext;
  const resolveAuth = options.resolveAuth ?? (() => readDashboardLocalAuth(options.authOptions));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestId = options.requestId ?? randomUUID;
  const maxPerParent = options.maxPerParent ?? 2;
  const maxTotal = options.maxTotal ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const inFlight = new Map();

  async function execute(_id, params, signal, _update, ctx) {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : undefined;
    // Session id and cwd come ONLY from the runtime context, never from params.
    if (typeof sessionId !== 'string' || !sessionId || !cwd) return blocked('research-session-context-unavailable');
    if (!ROLE.test(params?.role ?? '')) return blocked('research-session-role-invalid');
    if (!text(params?.task, RESEARCH_SESSION_LIMITS.maxTaskChars)) return blocked('research-session-task-invalid');
    if (!RESEARCH_SESSION_STAGES.includes(params?.stage)) return blocked('research-session-stage-invalid');

    let context;
    try {
      context = await readContext(ctx, options.contextOptions);
    } catch {
      return blocked('research-session-parent-not-joined');
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
        provenance: reply.provenance,
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
        task: { type: 'string', minLength: 1, maxLength: RESEARCH_SESSION_LIMITS.maxTaskChars, description: 'Concrete task for the collaborator; delivered once as its initial prompt.' },
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
