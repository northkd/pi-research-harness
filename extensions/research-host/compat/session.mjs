import { createHash, randomUUID } from 'node:crypto';
import { fail, reply } from '../http.mjs';
import { createNativeSessionFork } from './native-fork.mjs';
import { createNativeControlClient } from './native-control-client.mjs';
import { createProposalCompatibility } from './open-spec/index.mjs';

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const PROMPT_IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MAX_INITIAL_PROMPT_BYTES = 16 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function only(body, fields) {
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key))) fail(400, 'invalid-session-request');
}

function identifier(value, pattern = IDENTIFIER) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(400, 'invalid-session-id');
  return value;
}

function text(value, maximum = 128 * 1024) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= maximum;
}

function imageArray(value) {
  return Array.isArray(value) && value.every(image => object(image) && image.type === 'image' &&
    typeof image.data === 'string' && typeof image.mimeType === 'string');
}

function successful(value, code = 'native-command-rejected') {
  if (value?.success !== true) fail(409, code);
  return value;
}

function spawnIdentity(cwd, owner, requestId) {
  if (!requestId) return randomUUID();
  identifier(requestId);
  const hex = createHash('sha256').update(JSON.stringify([cwd, owner?.iss, owner?.sub, requestId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Stable REST operations used by the former frontend. The caller has already
 * authenticated to the local host; body fields never establish an owner. */
export function createSessionCompatibility({ sessions, workbench, localOperatorPrincipal, beforeLaunch, loadSessionManager, nativeControls = createNativeControlClient({ sessions }) }) {
  const operator = { principal: localOperatorPrincipal, expiresAt: null, write: true };
  const pendingResumes = new Set();
  const archiveSettlements = new Map();
  const update = sessions.updateSession ?? sessions.updateSessionMeta;
  const forkSession = createNativeSessionFork({ sessions, loadSessionManager });
  const proposals = createProposalCompatibility({ sessions, nativeControls });
  const get = sessionId => {
    const row = sessions.getSession(identifier(sessionId));
    if (!row || row.originDeviceId) fail(404, 'session-not-found');
    return row;
  };
  async function access(row) {
    const context = await workbench.accessFor(row.cwd, operator);
    if (context.canReadHistory && !await context.canReadHistory(row)) fail(404, 'session-not-found');
    await context.revalidate?.();
    return context;
  }
  const command = async (id, value) => successful(await sessions.command(id, value));
  const mark = (id, patch) => {
    if (typeof update !== 'function') fail(501, 'session-metadata-update-unavailable');
    return update(id, patch);
  };

  async function spawnAcp(body, initialPrompt) {
    if (typeof sessions.startAcp !== 'function' || typeof sessions.acpAgents !== 'function') fail(501, 'session-acp-driver-unavailable');
    const agents = await sessions.acpAgents();
    if (!agents.length) return reply({ success: false, error: 'No ACP agents are configured' }, 400);
    if (typeof body.agent !== 'string') return reply({ success: false, error: 'agent must be a string' }, 400);
    if (!agents.some(agent => agent.id === body.agent)) return reply({ success: false, error: `Unknown ACP agent "${body.agent}"` }, 400);
    if (initialPrompt !== undefined) return reply({ success: false, error: 'initialPrompt is not supported for ACP agent sessions', code: 'INITIAL_PROMPT_UNSUPPORTED_ACP' }, 400);
    if (body.joinResWorkflow === true) return reply({ success: false, error: 'joinResWorkflow is not supported for ACP agent sessions', code: 'JOIN_RES_WORKFLOW_UNSUPPORTED_ACP' }, 400);
    if (body.model !== undefined) fail(400, 'acp-model-on-spawn-unsupported');
    const context = await workbench.accessFor(body.cwd, operator);
    await context.revalidate?.();
    const sessionId = spawnIdentity(context.cwd, localOperatorPrincipal, body.requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ cwd: context.cwd, agent: body.agent, name: body.name })).digest('hex');
    const previous = sessions.getSession(sessionId);
    if (previous) {
      if (previous.driver !== 'acp' || previous.cwd !== context.cwd || previous.compatSpawn?.fingerprint !== fingerprint) fail(409, 'session-spawn-request-conflict');
      if (!previous.live || !previous.nativeRegistrationConfirmed) fail(503, 'session-spawn-unconfirmed');
      return reply({ success: true, data: { message: 'session already started', sessionId, sessionFile: previous.sessionFile, duplicate: true, driver: 'acp' } });
    }
    await beforeLaunch?.({ parent: { cwd: context.cwd }, verified: { cwd: context.cwd, ownerKey: context.ownerKey } });
    await context.revalidate?.();
    const result = await sessions.startAcp({ agent: body.agent, cwd: context.cwd, sessionId,
      spawnToken: randomUUID(), name: body.name,
      metadata: { compatSpawn: { schema: 'pi-research-rest-spawn.v1', requestId: body.requestId ?? null, fingerprint } } });
    if (result?.success !== true) return reply({ success: false, error: result?.message ?? 'session-spawn-unconfirmed',
      code: result?.code ?? 'session-spawn-unconfirmed', ...(result?.sessionId ? { sessionId: result.sessionId } : {}) }, 503);
    if (result.sessionId !== sessionId) fail(503, 'session-spawn-unconfirmed');
    const row = get(sessionId);
    if (row.driver !== 'acp' || !row.nativeRegistrationConfirmed) fail(503, 'session-spawn-unconfirmed');
    return reply({ success: true, data: { message: 'session started', sessionId, sessionFile: row.sessionFile, driver: 'acp' } });
  }

  async function spawn(body) {
    only(body, ['cwd', 'agent', 'initialPrompt', 'joinResWorkflow', 'creationEntryPoint', 'model', 'name', 'requestId']);
    if (!text(body.cwd, 4096)) fail(400, 'session-cwd-required');
    if (body.initialPrompt !== undefined && typeof body.initialPrompt !== 'string') fail(400, 'invalid-initial-prompt');
    const initialPrompt = body.initialPrompt || undefined;
    if (initialPrompt !== undefined && !text(initialPrompt, MAX_INITIAL_PROMPT_BYTES)) fail(400, 'invalid-initial-prompt');
    if (body.joinResWorkflow !== undefined && body.joinResWorkflow !== true) fail(400, 'invalid-join-res-workflow');
    if (body.creationEntryPoint !== undefined && (body.creationEntryPoint !== 'research-stage' || body.joinResWorkflow !== true)) fail(400, 'invalid-session-creation-entry-point');
    if (body.model !== undefined && !text(body.model, 4096) || body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 4096 || body.name.includes('\0'))) fail(400, 'invalid-session-spawn-options');
    if (body.agent !== undefined) return spawnAcp(body, initialPrompt);
    const context = await workbench.accessFor(body.cwd, operator);
    await context.revalidate?.();
    let rawRef;
    if (body.joinResWorkflow) {
      if (typeof workbench.prepareSpawn !== 'function' || typeof workbench.verifyParent !== 'function') fail(503, 'res-workflow-unavailable');
      rawRef = await workbench.prepareSpawn(context.cwd, operator);
      if (rawRef?.resWorkflow?.canonicalCwd !== context.cwd) fail(503, 'session-spawn-binding-unconfirmed');
      if (body.creationEntryPoint === 'research-stage') rawRef = { ...rawRef, sessionCreation: {
        schema: 'pi-session-creation.v1', kind: 'user', entryPoint: 'research-stage', cwd: context.cwd, createdAt: new Date().toISOString(),
      } };
    }
    const sessionId = spawnIdentity(context.cwd, localOperatorPrincipal, body.requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ cwd: context.cwd, initialPrompt, joinResWorkflow: body.joinResWorkflow,
      creationEntryPoint: body.creationEntryPoint, model: body.model, name: body.name })).digest('hex');
    const previous = sessions.getSession(sessionId);
    if (previous && (previous.cwd !== context.cwd || previous.compatSpawn?.fingerprint !== fingerprint)) fail(409, 'session-spawn-request-conflict');
    if (previous) {
      if (!previous.nativeRegistrationConfirmed || initialPrompt && previous.initialPromptStatus !== 'accepted') fail(503, 'session-spawn-unconfirmed');
      if (body.joinResWorkflow) await workbench.verifyParent({ parent: previous, principal: localOperatorPrincipal, expiresAt: null });
      return reply({ success: true, data: { message: 'session already started', sessionId, sessionFile: previous.sessionFile,
        duplicate: true, status: previous.status }, ...(initialPrompt ? { transmitted: true, promptId: `initial-${sessionId}` } : {}) });
    }
    await beforeLaunch?.({ parent: { cwd: context.cwd }, verified: { cwd: context.cwd, ownerKey: context.ownerKey } });
    await context.revalidate?.();
    const result = await sessions.createSession({ cwd: context.cwd, sessionId, rawRef,
      prompt: initialPrompt, model: body.model, name: body.name,
      metadata: { compatSpawn: { schema: 'pi-research-rest-spawn.v1', requestId: body.requestId ?? null, fingerprint } } });
    if (result?.success !== true || result.sessionId !== sessionId) fail(503, 'session-spawn-unconfirmed');
    const row = get(sessionId);
    if (!row.nativeRegistrationConfirmed || initialPrompt && row.initialPromptStatus !== 'accepted') fail(503, 'session-spawn-unconfirmed');
    if (body.joinResWorkflow) await workbench.verifyParent({ parent: row, principal: localOperatorPrincipal, expiresAt: null });
    return reply({ success: true, data: { message: 'session started', sessionId, sessionFile: row.sessionFile },
      ...(initialPrompt ? { transmitted: true, promptId: `initial-${sessionId}` } : {}) });
  }

  async function prompt(row, body) {
    only(body, ['text', 'images', 'promptId']);
    if (typeof body.text !== 'string' || !body.text.length || body.text.length > 128 * 1024) fail(400, 'session-prompt-text-required');
    if (body.images !== undefined && !imageArray(body.images)) fail(400, 'session-prompt-images-invalid');
    const promptId = body.promptId === undefined ? randomUUID() : identifier(body.promptId, PROMPT_IDENTIFIER);
    if (typeof sessions.deliverPrompt === 'function') {
      const result = await sessions.deliverPrompt(row.id, { text: body.text, images: body.images, promptId });
      if (result?.accepted !== true) fail(502, 'session-prompt-not-accepted');
    } else if (!row.external && (!body.images || !body.images.length) && typeof sessions.notifyParent === 'function') {
      if (await sessions.notifyParent(row.id, body.text, promptId) !== true) fail(502, 'session-prompt-not-accepted');
    } else {
      // `notifyParent` can enqueue an external TUI inbox before native receipt.
      // Exact prompt transmission needs the keeper's accepted RPC response.
      if (row.external || body.promptId !== undefined) fail(503, 'session-prompt-receipts-unavailable');
      await command(row.id, { type: 'prompt', message: body.text, ...(body.images ? { images: body.images } : {}), streamingBehavior: 'steer' });
    }
    return reply({ success: true, transmitted: true, promptId });
  }

  async function resume(row, body) {
    only(body, ['mode']);
    if (body.mode !== 'continue' && body.mode !== 'fork') fail(400, 'invalid-session-resume-mode');
    if (row.archived === true) fail(404, 'session-is-archived');
    if (!row.sessionFile) fail(409, 'session-history-unavailable');
    if (row.driver && row.driver !== 'pi') fail(409, 'session-driver-resume-unsupported');
    if (pendingResumes.has(row.id)) fail(409, 'session-resume-in-progress');
    if (body.mode === 'continue' && row.live) fail(409, 'session-already-active');
    if (body.mode === 'fork' && (row.researchSession || row.pluginRefs?.['res-workflow']?.researchSession || row.hostInheritedReadOnly)) fail(409, 'research-session-fork-assignment-required');
    const other = sessions.listSessions().find(candidate => candidate.id !== row.id && candidate.sessionFile === row.sessionFile && candidate.live);
    if (body.mode === 'continue' && other) fail(409, 'session-history-already-active');
    pendingResumes.add(row.id);
    try {
      await beforeLaunch?.({ parent: row });
      const result = body.mode === 'fork' ? await forkSession(row)
        : await sessions.createSession({ cwd: row.cwd, sessionId: row.id, sessionFile: row.sessionFile, resume: true, name: row.name, model: row.model });
      if (result?.success !== true) fail(503, 'session-resume-unconfirmed');
      if (body.mode === 'continue' && (result.sessionId !== row.id || result.sessionFile !== row.sessionFile)) fail(503, 'session-resume-identity-unconfirmed');
      const current = get(result.sessionId);
      if (!current.nativeRegistrationConfirmed) fail(503, 'session-resume-registration-unconfirmed');
      if (body.mode === 'continue' && typeof update === 'function') await mark(row.id, { closedReason: undefined });
      return reply({ success: true, data: { message: result.degradedToNew ? 'Started a fresh session because the source had no persisted history to fork from.' : 'session resumed',
        sessionId: result.sessionId, sessionFile: result.sessionFile,
        ...(result.parentSessionId ? { parentSessionId: result.parentSessionId, parentSessionFile: result.parentSessionFile } : {}) },
        ...(result.degradedToNew ? { code: 'FORK_DEGRADED_TO_NEW' } : {}) });
    } finally { pendingResumes.delete(row.id); }
  }

  async function uiResponse(row, body) {
    only(body, ['requestId', 'result', 'cancelled']);
    if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 256 || /[\x00-\x1f]/.test(body.requestId)) fail(400, 'native-ui-request-id-required');
    if (body.cancelled !== undefined && typeof body.cancelled !== 'boolean') fail(400, 'native-ui-response-invalid');
    const pending = row.pendingUIRequests?.find(request => request.id === body.requestId || request.requestId === body.requestId);
    if (!pending) fail(409, 'native-ui-request-not-pending');
    const response = { type: 'extension_ui_response', id: body.requestId };
    if (body.cancelled) response.cancelled = true;
    else if (pending.method === 'confirm') {
      if (typeof body.result !== 'boolean') fail(400, 'native-ui-confirmation-required');
      response.confirmed = body.result;
    } else if (['select', 'input', 'editor'].includes(pending.method)) {
      if (typeof body.result !== 'string' || pending.method === 'select' && !pending.options?.includes(body.result)) fail(400, 'native-ui-value-invalid');
      response.value = body.result;
    } else fail(501, 'native-ui-method-unavailable');
    const respond = sessions.respondUI ?? sessions.respondUi;
    if (typeof respond !== 'function') fail(501, 'native-ui-response-unavailable');
    const result = await respond(row.id, response);
    if (result?.accepted !== true && result?.success !== true) fail(502, 'native-ui-response-unconfirmed');
    return reply({ success: true });
  }

  function finishArchive(sessionId) {
    if (archiveSettlements.has(sessionId)) return archiveSettlements.get(sessionId);
    const row = sessions.getSession(sessionId);
    if (!row?.archiveRequestedAt || row.status !== 'ended' || row.live) return Promise.resolve(false);
    let resolve, reject;
    const completion = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
    archiveSettlements.set(sessionId, completion);
    (async () => {
      try { await mark(sessionId, { archived: true, archivedAt: Date.now(), archiveRequestedAt: undefined }); resolve(true); }
      catch (error) { reject(error); }
      finally { archiveSettlements.delete(sessionId); }
    })();
    return completion;
  }

  const settleArchive = sessionId => { finishArchive(sessionId).catch(() => { /* The durable intent remains available to retry. */ }); };
  const unsubscribeArchive = sessions.subscribeEvents?.(settleArchive);
  for (const row of sessions.listSessions()) if (row.archiveRequestedAt) settleArchive(row.id);

  async function archive(row, body) {
    only(body, []);
    if (row.archived === true) fail(404, 'session-already-archived');
    if (typeof update !== 'function') fail(501, 'session-metadata-update-unavailable');
    if (row.status === 'streaming' || row.compacting) fail(409, 'session-is-running');
    if (row.status === 'unknown' || row.status === 'interrupted') fail(409, 'session-live-outcome-unknown');
    await mark(row.id, { archiveRequestedAt: row.archiveRequestedAt ?? Date.now(), closedReason: 'manual' });
    if (await finishArchive(row.id)) return reply({ success: true });
    const result = await sessions.terminate(row.id);
    if (result?.stopped !== true && result?.requested !== true && result?.success !== true) {
      if (result?.state === 'stopping') return reply({ success: true, pending: true }, 202);
      fail(502, 'session-archive-shutdown-unconfirmed');
    }
    const complete = sessions.getSession(row.id)?.archived === true || await finishArchive(row.id);
    return reply(complete ? { success: true } : { success: true, pending: true });
  }

  async function unarchive(row, body) {
    only(body, []);
    if (row.archived !== true) fail(404, 'session-not-archived');
    if (row.live) fail(409, 'session-archive-live-conflict');
    await mark(row.id, { archived: false, archivedAt: undefined, archiveRequestedAt: undefined, restoredAt: Date.now(), hidden: false });
    return reply({ success: true });
  }

  async function archiveList(url) {
    const allowed = ['cwd', 'limit', 'cursor', 'q'];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) fail(400, 'invalid-session-archive-query');
    const requestedCwd = url.searchParams.get('cwd');
    let canonicalCwd;
    if (requestedCwd !== null) canonicalCwd = (await workbench.accessFor(requestedCwd, { ...operator, write: false })).cwd;
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(400, 'invalid-session-archive-limit');
    let cursor;
    if (url.searchParams.get('cursor')) {
      const encoded = url.searchParams.get('cursor');
      try {
        if (encoded.length > 512) throw new Error('cursor too large');
        cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isFinite(cursor[0]) || !IDENTIFIER.test(cursor[1])) throw new Error('invalid cursor');
      } catch { fail(400, 'invalid-session-archive-cursor'); }
    }
    const query = url.searchParams.get('q')?.toLocaleLowerCase();
    if (query && query.length < 3) return reply({ success: true, data: { items: [] } });
    const candidates = sessions.listSessions().filter(row => row.archived === true && !row.originDeviceId && (!canonicalCwd || row.cwd === canonicalCwd))
      .filter(row => !query || [row.id, row.name, row.firstMessage, row.cwd].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)))
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id));
    const visible = [];
    for (const row of candidates) {
      if (cursor && ((row.archivedAt ?? 0) > cursor[0] || (row.archivedAt ?? 0) === cursor[0] && row.id.localeCompare(cursor[1]) <= 0)) continue;
      try { await access(row); }
      catch (error) { if ([403, 404].includes(error.statusCode)) continue; throw error; }
      visible.push(row);
      if (visible.length > limit) break;
    }
    const items = visible.slice(0, limit);
    const last = items.at(-1);
    return reply({ success: true, data: { items,
      ...(visible.length > limit ? { nextCursor: Buffer.from(JSON.stringify([last.archivedAt ?? 0, last.id])).toString('base64url') } : {}) } });
  }

  async function handle({ method, pathname, url, body }) {
    if (pathname === '/api/sessions' && method === 'GET') {
      return reply({ success: true, data: sessions.listSessions().filter(row => row.archived !== true) });
    }
    if (pathname === '/api/sessions/archived' && method === 'GET') return archiveList(url);
    const archived = /^\/api\/sessions\/archived\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
    if (archived && (method === 'GET' || method === 'DELETE')) {
      const row = get(archived[1]);
      await access(row);
      if (row.archived !== true) fail(404, 'session-not-archived');
      if (method === 'GET') return reply({ success: true, data: { item: row } });
      if (typeof sessions.deleteArchivedSession !== 'function') fail(501, 'session-archive-delete-unavailable');
      const result = await sessions.deleteArchivedSession(row.id);
      if (result?.success !== true && result?.ok !== true) fail(503, 'session-archive-delete-unconfirmed');
      return reply({ success: true });
    }
    if (method !== 'POST' || !pathname.startsWith('/api/session/')) return null;
    if (pathname === '/api/session/spawn') return spawn(body);
    const parts = pathname.slice('/api/session/'.length).split('/');
    if (parts.length !== 2 || !IDENTIFIER.test(parts[0])) return null;
    const [sessionId, action] = parts;
    const known = ['prompt', 'resume', 'rename', 'abort', 'shutdown', 'model', 'thinking-level', 'extension-ui-response', 'flow-control', 'lifecycle', 'archive', 'unarchive', 'attach-proposal', 'detach-proposal'];
    if (!known.includes(action)) return null;
    const row = get(sessionId);
    if (action === 'resume' && row.cwdMissing === true) fail(409, 'session-cwd-missing');
    await access(row);
    if (action === 'prompt') return prompt(row, body);
    if (action === 'resume') return resume(row, body);
    if (action === 'extension-ui-response') return uiResponse(row, body);
    if (action === 'archive') return archive(row, body);
    if (action === 'unarchive') return unarchive(row, body);
    if (action === 'attach-proposal') return proposals.attach(row, body);
    if (action === 'detach-proposal') return proposals.detach(row, body);
    if (action === 'rename') {
      only(body, ['name']);
      if (typeof body.name !== 'string' || body.name.length > 4096 || body.name.includes('\0')) fail(400, 'session-name-required');
      if (typeof update !== 'function') fail(501, 'session-metadata-update-unavailable');
      if (row.live) {
        if ((!row.driver || row.driver === 'pi') && (row.external || !body.name)) await nativeControls.apply(row, 'set-name', { name: body.name });
        else await command(sessionId, { type: 'set_session_name', name: body.name });
      }
      await mark(sessionId, { name: body.name || undefined, nameSource: 'user', nameSourceFor: undefined });
      return reply({ success: true });
    }
    if (action === 'model') {
      only(body, ['provider', 'modelId']);
      if (!text(body.provider, 1024) || !text(body.modelId, 4096)) fail(400, 'session-model-required');
      const result = await command(sessionId, { type: 'set_model', provider: body.provider, modelId: body.modelId });
      const provider = result?.data?.provider ?? body.provider;
      const modelId = result?.data?.modelId ?? result?.data?.id ?? body.modelId;
      const thinkingLevel = result?.data?.thinkingLevel;
      if (typeof update === 'function') await mark(sessionId, { model: provider + '/' + modelId,
        ...(typeof thinkingLevel === 'string' ? { thinkingLevel } : {}) });
      return reply({ success: true, data: { provider, modelId, ...(typeof thinkingLevel === 'string' ? { thinkingLevel } : {}) } });
    }
    if (action === 'thinking-level') {
      only(body, ['level']);
      if (!THINKING_LEVELS.has(body.level)) fail(400, 'session-thinking-level-invalid');
      const result = await command(sessionId, { type: 'set_thinking_level', level: body.level });
      const level = result?.data?.level ?? result?.data?.thinkingLevel ?? body.level;
      if (typeof update === 'function') await mark(sessionId, { thinkingLevel: level });
      return reply({ success: true, data: { level, requestedLevel: body.level, clamped: level !== body.level } });
    }
    if (action === 'abort') {
      only(body, []);
      successful(await sessions.abort(sessionId), 'session-abort-unconfirmed');
      return reply({ success: true });
    }
    if (action === 'shutdown') {
      only(body, []);
      const result = await sessions.terminate(sessionId);
      if (result?.stopped !== true && result?.requested !== true && result?.success !== true) fail(502, 'session-shutdown-unconfirmed');
      if (typeof update === 'function') await mark(sessionId, { closedReason: 'manual' });
      return reply({ success: true, pending: sessions.getSession(sessionId)?.live === true });
    }
    if (action === 'flow-control') {
      only(body, ['action']);
      if (body.action !== 'abort' && body.action !== 'toggle_autonomous') fail(400, 'session-flow-control-invalid');
      if (body.action === 'toggle_autonomous') {
        if (typeof sessions.flowControl !== 'function') fail(501, 'session-autonomous-toggle-unavailable');
        const result = await sessions.flowControl(sessionId, body.action);
        if (result?.success !== true && result?.accepted !== true) fail(502, 'session-autonomous-toggle-unconfirmed');
        return reply({ success: true });
      }
      successful(await sessions.abort(sessionId), 'session-abort-unconfirmed');
      return reply({ success: true });
    }
    if (action === 'lifecycle') {
      only(body, ['action', 'pgid', 'requestId']);
      if (!['stop_after_turn', 'retry', 'force_kill', 'kill_process'].includes(body.action)) fail(400, 'session-lifecycle-invalid');
      if (body.action === 'kill_process' && (!Number.isSafeInteger(body.pgid) || body.pgid < 2)) fail(400, 'native-process-group-invalid');
      if (typeof sessions.lifecycle === 'function') {
        const result = await sessions.lifecycle(sessionId, body.action, body.pgid === undefined ? {} : { pgid: body.pgid });
        if (result?.delivered !== true && result?.success !== true) fail(502, 'session-lifecycle-unconfirmed');
      } else if (body.action === 'force_kill') {
        if (row.live === false && row.status === 'ended') return reply({ success: true });
        if (typeof update !== 'function') fail(501, 'session-metadata-update-unavailable');
        await mark(sessionId, { closedReason: 'manual' });
        const stopped = await sessions.terminate(sessionId);
        if (stopped?.stopped !== true || sessions.getSession(sessionId)?.live) fail(503, 'session-force-kill-unconfirmed');
      } else {
        await nativeControls.apply(row, body.action, {
          ...(body.pgid === undefined ? {} : { pgid: body.pgid }), ...(body.requestId ? { requestId: body.requestId } : {}),
        });
      }
      return reply({ success: true });
    }
    return null;
  }
  handle.dispose = () => { unsubscribeArchive?.(); };
  return handle;
}
