import { createMcpCompatibility } from './mcp/index.mjs';

const REST_ROADS = new Set([
  'GET /api/health',
  'GET /api/sessions',
]);

function sameVisibleScope(actor, row) {
  if (!actor || !row || row.cwd !== actor.cwd || row.originDeviceId) return false;
  const a = actor.principalOwner, b = row.principalOwner;
  return a === undefined && b === undefined || !!a && !!b && a.iss === b.iss && a.sub === b.sub;
}

export function createLocalSessionMcp({ sessions, invokeRoute, onDiagnostic }) {
  const visibleSessions = caller => {
    const actor = sessions.getSession(caller.sessionId);
    return sessions.listSessions().filter(row => sameVisibleScope(actor, row));
  };
  return createMcpCompatibility({
    getSession: sessions.getSession,
    hasRoute: (method, route) => REST_ROADS.has(method + ' ' + route),
    async invokeRoute(input, caller) {
      const url = new URL(input.url, 'http://127.0.0.1');
      if (!REST_ROADS.has(input.method + ' ' + url.pathname)) return null;
      if (url.pathname === '/api/sessions') return { statusCode: 200, body: { success: true, data: visibleSessions(caller) } };
      return invokeRoute({ method: input.method, url, pathname: url.pathname, body: input.payload });
    },
    listSessions: visibleSessions,
    async sendPrompt(id, text, caller) {
      if (!sameVisibleScope(sessions.getSession(caller.sessionId), sessions.getSession(id))) return false;
      const result = await sessions.deliverPrompt(id, { text });
      return result?.accepted === true;
    },
    async abortSession(id, caller) {
      if (!sameVisibleScope(sessions.getSession(caller.sessionId), sessions.getSession(id))) return false;
      return (await sessions.abort(id))?.success === true;
    },
    onEvent: sessions.subscribeEvents,
    onDiagnostic,
  });
}
