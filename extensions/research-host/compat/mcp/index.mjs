import { authenticate, credentialFingerprint } from './server/auth.mjs';
import { dispatchRpc, parseSubscriptionFilter, versionFailureResponse } from './server/dispatch.mjs';
import { extractId, parseRpcRequest, rpcError, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR } from './server/jsonrpc.mjs';
import { PROTOCOL_VERSION_HEADER, resolveProtocolVersion } from './server/protocol.mjs';
import { McpTokenRegistry } from './server/tokens.mjs';
import { AuthFailureThrottle } from './server/rate-limit.mjs';
import { SubscriptionRegistry } from './server/streaming.mjs';
import { GENERATED_TOOLS } from './server/generated/tools.mjs';
import { isDenylisted } from './server/tools.denylist.mjs';
import { listSessions, validateListSessionsArgs } from './server/list-sessions.mjs';
import { isTier, minTier } from './shared/tiers.mjs';

export { GENERATED_TOOLS } from './server/generated/tools.mjs';
export { DENYLIST, isDenylisted } from './server/tools.denylist.mjs';
export { McpTokenRegistry } from './server/tokens.mjs';
export { AuthFailureThrottle } from './server/rate-limit.mjs';
export { listSessions, validateListSessionsArgs } from './server/list-sessions.mjs';
export * from './server/protocol.mjs';

export const MCP_BODY_LIMIT_BYTES = 1024 * 1024;
const paths = new Map([['/mcp', null], ['/mcp/observe', 'observe'], ['/mcp/control', 'control']]);
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

function response(body, statusCode = 200, headers = {}) {
  return { statusCode, body, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } };
}

function fromRpc(value) {
  return { ...response(value.body, value.status, {
    ...(value.sessionId ? { 'Mcp-Session-Id': value.sessionId } : {}),
    ...(value.wwwAuthenticate ? { 'WWW-Authenticate': value.wwwAuthenticate } : {}),
  }), ...(value.body === null ? { empty: true } : {}) };
}

const unauthorized = () => response({ error: 'Unauthorized', message: 'A valid bearer credential is required on every /mcp request.' }, 401, { 'WWW-Authenticate': 'Bearer' });

/** Deployed MCP protocol and tool schemas over explicitly implemented host roads. */
export function createMcpCompatibility(options) {
  const tokens = new McpTokenRegistry();
  const throttle = options.throttle ?? new AuthFailureThrottle();
  const subscriptions = new SubscriptionRegistry();
  let disposed = false;
  const diagnostic = options.onDiagnostic ?? (() => {});
  const handlers = { ...options.contextHandlers };
  if (!handlers.list_sessions && typeof options.listSessions === 'function') handlers.list_sessions = ({ args, caller }) => listSessions(options.listSessions(caller), args);
  if (!handlers.send_prompt && typeof options.sendPrompt === 'function') handlers.send_prompt = async ({ args, caller }) => ({ delivered: await options.sendPrompt(args.sessionId, args.text, caller) === true });
  if (!handlers.spawn_session && typeof options.spawnSession === 'function') handlers.spawn_session = ({ args, caller }) => options.spawnSession({ cwd: args.cwd }, caller);
  if (!handlers.abort && typeof options.abortSession === 'function') handlers.abort = async ({ args, caller }) => ({ aborted: await options.abortSession(args.sessionId, caller) === true });

  const activeSession = sessionId => {
    try {
      const row = options.getSession?.(sessionId);
      return !!row && ['active', 'idle', 'streaming'].includes(row.status);
    } catch { return false; }
  };
  const auth = {
    tokens: { resolve(token) {
      const caller = tokens.resolve(token);
      if (caller && !activeSession(caller.sessionId)) { tokens.revokeSession(caller.sessionId); return null; }
      return caller;
    } },
    verifyDeviceToken: () => null,
    verifyDeviceTokenTier(token) {
      if (typeof options.invokeForDevice !== 'function') return null;
      try {
        const value = options.verifyDeviceTokenTier?.(token);
        return value && typeof value.id === 'string' && value.id && isTier(value.tier) ? value : null;
      } catch { return null; }
    },
  };

  const missing = [];
  const tools = GENERATED_TOOLS.filter(tool => {
    let supported;
    if (tool.bind.kind === 'rest') supported = !isDenylisted(tool.bind.path) && typeof options.invokeRoute === 'function' && options.hasRoute?.(tool.bind.method, tool.bind.path) === true;
    else if (tool.bind.kind === 'context') supported = typeof handlers[tool.name] === 'function';
    else supported = typeof options.sendToSession === 'function' && options.hasSessionMessage?.(tool.bind.message) === true;
    if (!supported) missing.push({ name: tool.name, bind: tool.bind.kind, ...(tool.bind.kind === 'rest' ? { method: tool.bind.method, path: tool.bind.path } : {}) });
    return supported;
  });
  const deviceTools = () => tools.filter(tool => tool.bind.kind === 'rest' || tool.bind.kind === 'context' && typeof options.deviceContextHandlers?.[tool.name] === 'function' || tool.bind.kind === 'session' && typeof options.sendToSessionForDevice === 'function');
  const streamingAvailable = typeof options.onEvent === 'function';

  async function streamResponse(request, rpc, caller) {
    const selected = parseSubscriptionFilter(rpc.params);
    if (!selected.ok) return fromRpc(rpcError(400, rpc.id ?? null, RPC_INVALID_PARAMS, selected.message, 'InvalidSubscriptionFilter'));
    if (!streamingAvailable || caller.kind === 'device' && typeof options.authorizeSubscription !== 'function') return fromRpc(rpcError(404, rpc.id ?? null, RPC_METHOD_NOT_FOUND, 'subscriptions/listen is not available'));
    if (caller.kind === 'device' && !await options.authorizeSubscription(caller, selected.sessionIds, request)) return response({ error: 'Forbidden', message: 'Subscription scope is unavailable.' }, 403);
    return { statusCode: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
      stream(rawRequest, rawResponse) {
        rawResponse.writeHead(200, this.headers);
        rawResponse.flushHeaders?.();
        const subscription = subscriptions.open({ onEvent: options.onEvent }, selected.sessionIds,
          { write: chunk => rawResponse.write(chunk), end: () => rawResponse.end(), onDrain: handler => rawResponse.on('drain', handler) }, caller,
          { isStillAuthorised: () => !disposed && authenticate(request.headers?.authorization, auth) !== null });
        const release = () => subscription.close();
        rawResponse.on('close', release); rawResponse.on('error', release);
        rawRequest?.on('aborted', release);
        return release;
      } };
  }

  async function handle(request) {
    const pathname = request.pathname ?? request.url?.pathname;
    if (pathname !== '/mcp' && !pathname?.startsWith('/mcp/')) return null;
    if (!paths.has(pathname)) return response({ error: 'Not Found', message: 'Unknown MCP endpoint. Use /mcp, /mcp/observe or /mcp/control.' }, 404);
    if (request.method !== 'POST') return response({ error: 'Method Not Allowed', message: 'The MCP endpoint accepts POST only.' }, 405, { Allow: 'POST' });
    if (disposed) return unauthorized();
    const headers = request.headers ?? {};
    const source = request.remoteAddress ?? request.rawRequest?.socket?.remoteAddress ?? '<unknown>';
    const fingerprint = credentialFingerprint(headers.authorization);
    const allowed = throttle.check(source, fingerprint);
    if (!allowed.allowed) return response({ error: 'Too Many Requests', message: 'Too many failed authentication attempts.' }, 429, { 'Retry-After': String(allowed.retryAfterSeconds) });
    const authenticated = authenticate(headers.authorization, auth);
    if (!authenticated) { throttle.recordFailure(source, fingerprint); return unauthorized(); }
    throttle.recordSuccess(source, fingerprint);
    const cap = paths.get(pathname);
    const caller = cap ? { ...authenticated, tier: minTier(authenticated.tier, cap) } : authenticated;
    if (request.parseError) return fromRpc(rpcError(400, null, RPC_PARSE_ERROR, 'Parse error'));
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(request.body) ?? ''); }
    catch { return fromRpc(rpcError(400, null, RPC_PARSE_ERROR, 'Parse error')); }
    if (bytes > MCP_BODY_LIMIT_BYTES || request.bodyTooLarge) return fromRpc(rpcError(413, null, RPC_PARSE_ERROR, 'Request body too large'));
    const parsed = parseRpcRequest(request.body);
    if (!('ok' in parsed)) return fromRpc(parsed);
    const rpc = parsed.request;
    const resolved = resolveProtocolVersion(rpc.method, headers[PROTOCOL_VERSION_HEADER], rpc.params);
    if (!resolved.ok) return fromRpc(versionFailureResponse(resolved.code, rpc.id ?? null));
    const callerTools = caller.kind === 'session' ? tools : deviceTools();
    if (rpc.method === 'subscriptions/listen' && resolved.era === 'modern') return streamResponse(request, rpc, caller);
    const deps = {
      tools: callerTools, serverInfo: options.serverInfo ?? { name: 'pi-research', version: '1.0.0' },
      streamingAvailable: streamingAvailable && (caller.kind === 'session' || typeof options.authorizeSubscription === 'function'),
      invokeTool(invocation) {
        const handler = caller.kind === 'session' ? handlers[invocation.tool.name] : options.deviceContextHandlers?.[invocation.tool.name];
        if (typeof handler !== 'function') throw new Error('MCP context route unavailable');
        return handler({ ...invocation, request });
      },
      async inject(input) {
        const invoke = caller.kind === 'session' ? options.invokeRoute : options.invokeForDevice;
        const result = await invoke(input, caller, request);
        return result ? { statusCode: result.statusCode, body: result.body } : { statusCode: 404, body: { success: false, error: 'mcp-route-unavailable' } };
      },
      sendToSession: (sessionId, message) => caller.kind === 'session' ? options.sendToSession?.(sessionId, message, caller) : options.sendToSessionForDevice?.(sessionId, message, caller, request),
      validateToolArgs: (name, args) => name === 'list_sessions' ? validateListSessionsArgs(args) : null,
      recordRefusal: () => diagnostic('mcp-self-target-refused'),
      recordTierRefusal: () => diagnostic('mcp-tier-refused'),
    };
    try { return fromRpc(await dispatchRpc(rpc, resolved, caller, deps, { headers, remoteAddress: source })); }
    catch { diagnostic('mcp-method-failed'); return fromRpc(rpcError(500, extractId(request.body), RPC_INTERNAL_ERROR, 'Internal error')); }
  }

  return {
    handle,
    mintForSession(sessionId) {
      if (disposed || typeof sessionId !== 'string' || !identifier.test(sessionId) || !activeSession(sessionId)) throw new Error('mcp-session-unavailable');
      return tokens.mintForSession(sessionId);
    },
    revokeSession: sessionId => tokens.revokeSession(sessionId),
    surface: () => ({ tools: tools.map(tool => ({ name: tool.name, tier: tool.tier })), omitted: missing.map(value => ({ ...value })), deviceScoped: typeof options.invokeForDevice === 'function', streaming: streamingAvailable }),
    dispose() { disposed = true; subscriptions.closeAll(); tokens.dispose(); },
  };
}
