import { fail, reply, sameRequestOrigin } from '../../http.mjs';
import path from 'node:path';
import { normalizeMirrorConfig, readTrustJson, SOURCE_KINDS } from '../pi-trust/index.mjs';

const grantScopes = new Set(['project', 'session']);
const text = (value, maximum = 4096) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !value.includes('\0');

export function createBrowserGrantRoutes({ grants, workspaceDirectories, authenticate, trust, mirrorConfig, agentDir }) {
  function authenticated(request) {
    if (!request || !authenticate(request) || !sameRequestOrigin(request)) fail(403, 'access-grant-request-refused');
  }
  return async function handle({ method, pathname, body, request }) {
    if (method === 'GET' && pathname === '/api/access/pi-trust') {
      authenticated(request);
      let piEntries = [];
      try {
        const entries = readTrustJson(path.join(agentDir, 'trust.json'), { privateMode: false });
        piEntries = Object.entries(entries).filter(([, decision]) => typeof decision === 'boolean')
          .map(([folder, decision]) => ({ folder, decision }));
      } catch { /* No verified native project-trust records. */ }
      const evaluated = trust?.evaluate();
      const applied = new Set(trust?.readSnapshot()?.entries.map(entry => entry.sourceKind + '\u0000' + entry.key));
      const counted = new Set(evaluated?.counted.map(({ candidate }) => candidate.sourceKind + '\u0000' + candidate.key));
      const reasons = new Map(evaluated?.ignored.map(({ entry, reason }) => [entry.sourceKind + '\u0000' + entry.key, reason]));
      const entries = evaluated?.candidates.map(entry => {
        const key = entry.sourceKind + '\u0000' + entry.key;
        return { sourceKind: entry.sourceKind, folder: entry.key, choice: entry.choice ?? null,
          byDefault: entry.choice === undefined, confers: counted.has(key) && applied.has(key), reason: reasons.get(key) };
      }) ?? [];
      return reply({ success: true, data: {
        available: !!trust, config: normalizeMirrorConfig(mirrorConfig), agentDir, piEntries, entries,
        effective: entries.filter(entry => entry.confers).map(entry => ({ ...entry, coversSubfolders: true })),
        ignored: entries.filter(entry => !entry.confers), sourcesNotInstalled: evaluated?.sourcesNotInstalled ?? [],
        choicesReadable: evaluated?.choicesReadable ?? false,
      } });
    }
    if (method === 'PUT' && pathname === '/api/access/pi-trust/choice') {
      authenticated(request);
      if (!body || !SOURCE_KINDS.includes(body.sourceKind) || !text(body.folder)
          || body.choice !== null && typeof body.choice !== 'boolean') fail(400, 'pi-trust-choice-invalid');
      if (!trust) fail(503, 'pi-trust-mirror-unavailable');
      if (!trust.evaluate().candidates.some(entry => entry.sourceKind === body.sourceKind && entry.key === body.folder)) {
        fail(404, 'pi-trust-choice-not-found');
      }
      trust.setChoice(body.sourceKind, body.folder, body.choice);
      trust.rewriteSnapshot();
      return reply({ success: true });
    }
    if (pathname === '/api/access/pinned-directory' && method === 'DELETE') {
      authenticated(request);
      if (!text(body?.subject) || Object.keys(body).length !== 1) fail(400, 'access-directory-subject-required');
      workspaceDirectories.update({ action: 'unpin', path: body.subject }, request);
      return reply({ success: true });
    }
    if (pathname !== '/api/access/grants') return null;
    authenticated(request);
    if (method === 'GET') {
      return reply({ success: true, data: {
        pathGrants: grants.list().map(row => ({ ...row, grantedAt: new Date(row.grantedAt).toISOString() })),
        pinnedDirectories: workspaceDirectories.pinned(),
      } });
    }
    if (!text(body?.subject) || body.scope !== undefined && !grantScopes.has(body.scope)) fail(400, 'access-grant-subject-invalid');
    if (method === 'DELETE') {
      if (Object.keys(body).some(key => !['subject', 'scope'].includes(key))) fail(400, 'access-grant-revoke-invalid');
      let removed = false;
      const remove = () => { removed = grants.revoke(body.subject, body.scope); };
      if (trust && body.scope !== 'session') trust.revoke('accessGrants', body.subject, remove);
      else remove();
      if (!removed) fail(404, 'access-grant-not-found');
      return reply({ success: true });
    }
    if (method !== 'POST') fail(405, 'method-not-allowed');
    if (!text(body.denialId, 128) || Object.keys(body).some(key => !['subject', 'scope', 'denialId', 'widenedFrom', 'piTrust'].includes(key))
        || body.piTrust !== undefined && typeof body.piTrust !== 'boolean') fail(400, 'access-grant-request-invalid');
    const denial = grants.denials().find(row => row.denialId === body.denialId);
    if (!denial) fail(409, 'access-grant-denial-expired');
    if (body.widenedFrom !== undefined && body.widenedFrom !== denial.subject) fail(403, 'access-grant-subject-not-offered');
    // This is an explicit grant request from the authenticated principal. The
    // authority verifies the exact recorded denial and independently derives
    // the allowed subject. No client-side boolean approves a native prompt.
    const result = await grants.createFromDenial({
      denialId: body.denialId, session: denial.session, subject: body.subject, scope: body.scope,
    }, () => true);
    if (!result.ok) {
      const status = result.reason === 'write-failed' ? 503 : result.reason === 'unknown-denial' || result.reason === 'denial-changed' ? 409 : 403;
      fail(status, 'access-grant-' + result.reason);
    }
    if (trust && result.grant.scope === 'project' && typeof body.piTrust === 'boolean') {
      try {
        trust.setChoice('accessGrants', result.grant.subject, body.piTrust);
        trust.rewriteSnapshot();
      } catch {
        return reply({ success: false, error: 'pi-trust-choice-unconfirmed',
          data: { grant: result.grant, grantApplied: true, piTrustApplied: false } }, 503);
      }
    }
    return reply({ success: true, data: result.grant });
  };
}
