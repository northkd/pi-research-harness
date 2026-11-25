import { createHash } from 'node:crypto';
import {
  LOCAL_TRANSLATION_OWNER, readTranslationAuthorization, readTranslationRevision, translationModelFingerprint,
  writeTranslationAuthorization, writeTranslationRevocation,
} from '../../thinking-translator/shared/thinking-translation-auth.ts';
import {
  isThinkingTranslationFrame, THINKING_TRANSLATION_MIN_INTERVAL_MS, THINKING_TRANSLATION_TTL_MS,
} from '../../thinking-translator/shared/thinking-translation.ts';
import { fail, reply } from '../http.mjs';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SETTINGS_ROUTE = '/api/thinking-translation/settings';
const FRAME_ROUTE = '/internal/native/thinking-translation';
const sameOwner = (a, b) => a?.iss === b.iss && a?.sub === b.sub;
const selectedName = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !value.startsWith('@') && !/[\x00-\x1f]/.test(value);

export function createThinkingTranslationApi({ agentDir, sessions, authorizeSession, authenticate, resolveModel, broadcast, now = Date.now }) {
  const cursors = new Map();
  const readGrant = id => readTranslationAuthorization(id, agentDir);

  async function session(id, write) {
    const row = typeof id === 'string' && SESSION_ID.test(id) && sessions.getSession(id);
    if (!row || row.originDeviceId || row.origin?.deviceId || row.driver && row.driver !== 'pi'
        || row.principalOwner && !sameOwner(row.principalOwner, LOCAL_TRANSLATION_OWNER)
        || !await authorizeSession(row, write)) fail(404, 'translation-session-not-found');
    return row;
  }

  function status(id) {
    const grant = readGrant(id);
    const own = grant && sameOwner(grant.owner, LOCAL_TRANSLATION_OWNER);
    const cursor = cursors.get(id);
    return {
      success: true, sessionId: id, enabled: own ? grant.enabled : false, model: own ? grant.model : null,
      contentTypes: ['thinking'], targetLanguage: 'Simplified Chinese',
      runtime: cursor && cursor.revision === readTranslationRevision(id, agentDir) ? cursor.state : 'pending-safe-load',
    };
  }

  function forget(id) {
    const prior = cursors.get(id);
    cursors.delete(id);
    if (prior) broadcast(id, { type: 'thinking_translation', kind: 'clear', sessionId: id,
      runtimeId: prior.runtimeId, generation: prior.generation + 1, sequence: prior.sequence + 1,
      turnId: prior.turnId, expiresAt: now() });
  }

  async function receive(body, request) {
    if (!request || !authenticate(request)) fail(401, 'research-host-auth-required');
    const { frame, revision } = body ?? {};
    if (!isThinkingTranslationFrame(frame) || frame.sessionId !== body.sessionId) fail(400, 'translation-frame-invalid');
    const row = await session(body.sessionId, false);
    if (!row.live || row.cwd !== body.cwd || row.sessionFile !== body.sessionFile) fail(409, 'translation-session-changed');
    if (revision !== readTranslationRevision(row.id, agentDir)) return reply({ success: true, published: false });
    const grant = readGrant(row.id);
    const enabled = grant?.enabled === true && sameOwner(grant.owner, LOCAL_TRANSLATION_OWNER);
    if (frame.kind === 'snapshot' && !enabled || frame.kind === 'status' && frame.state === 'ready' && !enabled) {
      return reply({ success: true, published: false });
    }
    const previous = cursors.get(row.id), time = now();
    const sameRuntime = previous?.runtimeId === frame.runtimeId;
    const sameTurn = sameRuntime && previous.generation === frame.generation && previous.turnId === frame.turnId;
    if (sameRuntime && (frame.generation < previous.generation
        || frame.generation === previous.generation && frame.sequence <= previous.sequence)) return reply({ success: true, published: false });
    if (frame.kind === 'snapshot' && (frame.expiresAt <= time || frame.expiresAt > time + THINKING_TRANSLATION_TTL_MS + 1000)) {
      return reply({ success: true, published: false });
    }
    const digest = frame.kind === 'snapshot' ? createHash('sha256').update(JSON.stringify(frame.blocks)).digest('hex')
      : frame.kind === 'status' && sameTurn ? previous.digest : '';
    if (frame.kind === 'status' && sameTurn && previous.state === frame.state
        || frame.kind === 'snapshot' && sameTurn && (digest === previous.digest || time - previous.sentAt < THINKING_TRANSLATION_MIN_INTERVAL_MS)) {
      return reply({ success: true, published: false });
    }
    if (!cursors.has(row.id) && cursors.size >= 256) cursors.delete(cursors.keys().next().value);
    cursors.set(row.id, {
      runtimeId: frame.runtimeId, generation: frame.generation, sequence: frame.sequence, turnId: frame.turnId,
      sentAt: frame.kind === 'snapshot' ? time : sameTurn ? previous.sentAt : 0, digest, revision,
      state: frame.kind === 'status' ? frame.state : sameRuntime ? previous.state : 'pending-safe-load',
    });
    await broadcast(row.id, frame, () => revision === readTranslationRevision(row.id, agentDir));
    return reply({ success: true, published: true });
  }

  async function handle({ method, pathname, url, body, request }) {
    if (pathname === FRAME_ROUTE) {
      if (method !== 'POST') fail(405, 'method-not-allowed');
      return receive(body, request);
    }
    if (pathname !== SETTINGS_ROUTE) return null;
    if (!request || !authenticate(request)) fail(401, 'research-host-auth-required');
    if (method === 'GET') {
      if (url.searchParams.getAll('sessionId').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'sessionId')) {
        fail(400, 'translation-session-id-required');
      }
      return reply(status((await session(url.searchParams.get('sessionId'), false)).id));
    }
    if (method !== 'PUT') fail(405, 'method-not-allowed');
    if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => !['sessionId', 'enabled', 'model', 'consent'].includes(key))) {
      fail(400, 'translation-settings-invalid');
    }
    const row = await session(body.sessionId, true), prior = readGrant(row.id);
    if (prior && !sameOwner(prior.owner, LOCAL_TRANSLATION_OWNER)) fail(409, 'translation-authorization-owner-mismatch');
    if (!body.enabled) {
      try { writeTranslationRevocation(row.id, LOCAL_TRANSLATION_OWNER, agentDir); }
      catch { fail(409, 'translation-revocation-unconfirmed'); }
    } else {
      const { provider, id } = body.model ?? {};
      if (body.consent !== true || !selectedName(provider, 200) || provider.includes('/') || !selectedName(id, 400)) {
        fail(400, 'translation-explicit-model-consent-required');
      }
      const revision = readTranslationRevision(row.id, agentDir);
      let model;
      try { model = await resolveModel(provider, id); }
      catch { fail(409, 'translation-model-unavailable'); }
      if (!model || model.api === 'pi-virtual' || model.provider !== provider || model.id !== id) fail(409, 'translation-model-unavailable');
      await session(row.id, true);
      try {
        writeTranslationAuthorization({ version: 1, sessionId: row.id, enabled: true, model: { provider, id },
          modelFingerprint: translationModelFingerprint(model), contentTypes: ['thinking'], targetLanguage: 'Simplified Chinese',
          acceptedAt: new Date(now()).toISOString(), owner: LOCAL_TRANSLATION_OWNER }, agentDir, revision);
      } catch { fail(409, 'translation-authorization-conflict'); }
    }
    forget(row.id);
    return reply(status(row.id));
  }

  return { handle, forget };
}
