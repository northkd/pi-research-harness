import crypto from "node:crypto";
import { rank } from "../shared/tiers.mjs";
import { evaluateSelfTarget } from "./guard.mjs";
import {
  RPC_INSUFFICIENT_SCOPE,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  rpcError,
  rpcResult
} from "./jsonrpc.mjs";
import {
  MODERN_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS
} from "./protocol.mjs";
import { GENERATED_TOOLS } from "./generated/tools.mjs";
import { findTool, listTools } from "./tools.mjs";
const REMOVED_METHODS = [
  // SEP-2575 removed the handshake. Accepting it silently would let a legacy
  // client believe it negotiated something (E9).
  "initialize",
  "notifications/initialized",
  // Replaced by subscriptions/listen (S7).
  "resources/subscribe",
  "resources/unsubscribe"
];
const VERSION_FAILURES = {
  AmbiguousHeader: {
    status: 400,
    message: "MCP-Protocol-Version header was sent more than once",
    type: "AmbiguousHeader"
  },
  MissingHeader: {
    status: 400,
    message: "MCP-Protocol-Version header is required on every request",
    type: "MissingProtocolVersionHeader"
  },
  MissingMeta: {
    status: 400,
    message: "params._meta must declare io.modelcontextprotocol/protocolVersion",
    type: "MissingProtocolVersion"
  },
  HeaderMismatch: {
    status: 400,
    message: "MCP-Protocol-Version header disagrees with params._meta",
    type: "HeaderMismatch"
  },
  UnsupportedProtocolVersion: {
    status: 400,
    message: `Unsupported protocol version. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    type: "UnsupportedProtocolVersionError"
  }
};
function versionFailureResponse(code, id) {
  const f = VERSION_FAILURES[code];
  return rpcError(f.status, id, RPC_INVALID_PARAMS, f.message, f.type);
}
function toolsFor(deps) {
  return deps.tools ?? GENERATED_TOOLS;
}
function tierRefusalResponse(id, scope) {
  return {
    status: 403,
    wwwAuthenticate: `Bearer error="insufficient_scope", scope="${scope}"`,
    body: {
      jsonrpc: "2.0",
      id,
      error: {
        code: RPC_INSUFFICIENT_SCOPE,
        message: "insufficient_scope",
        data: { scope, type: "InsufficientScope" }
      }
    }
  };
}
function argsOf(params) {
  if (typeof params !== "object" || params === null) return {};
  const args = params.arguments;
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
}
function buildDiscoverResult(serverInfo, streamingAvailable = true) {
  return {
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: {
      tools: { listChanged: false },
      subscriptions: { listen: streamingAvailable },
      // Stated explicitly rather than by omission: these are gone in this
      // revision, and a client should not have to infer that.
      resources: { subscribe: false }
    },
    serverInfo: { ...serverInfo }
  };
}
function parseSubscriptionFilter(params) {
  const raw = typeof params === "object" && params !== null ? params.sessionIds : void 0;
  if (raw === void 0) {
    return { ok: false, message: "params.sessionIds is required \u2014 there is no subscribe-to-all" };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: "params.sessionIds must be an array of session ids" };
  }
  if (raw.length === 0) {
    return { ok: false, message: "params.sessionIds must name at least one session" };
  }
  if (!raw.every((s) => typeof s === "string" && s.length > 0)) {
    return { ok: false, message: "params.sessionIds must contain only non-empty strings" };
  }
  return { ok: true, sessionIds: raw };
}
function mintSessionId() {
  return crypto.randomBytes(16).toString("hex");
}
async function dispatchRpc(request, resolved, caller, deps, ctx = {}) {
  const id = request.id ?? null;
  const { era } = resolved;
  if (era === "legacy") {
    return dispatchLegacy(request, resolved, id, caller, deps, ctx);
  }
  if (REMOVED_METHODS.includes(request.method)) {
    return rpcError(
      404,
      id,
      RPC_METHOD_NOT_FOUND,
      `${request.method} is not supported on protocol revision ${MODERN_PROTOCOL_VERSION}`,
      "MethodRemoved"
    );
  }
  return dispatchModernRest(request, id, caller, deps, ctx);
}
async function dispatchModernRest(request, id, caller, deps, ctx) {
  switch (request.method) {
    case "server/discover":
      return rpcResult(
        id,
        buildDiscoverResult(deps.serverInfo, deps.streamingAvailable ?? deps.openSubscription !== void 0)
      );
    case "tools/list":
      return rpcResult(id, { tools: listTools(toolsFor(deps), caller.tier) });
    case "tools/call":
      return dispatchToolCall(request, id, caller, deps, ctx);
    case "subscriptions/listen": {
      const filter = parseSubscriptionFilter(request.params);
      if (!filter.ok) {
        return rpcError(400, id, RPC_INVALID_PARAMS, filter.message, "InvalidSubscriptionFilter");
      }
      if (!deps.openSubscription) {
        return rpcError(500, id, RPC_METHOD_NOT_FOUND, "Streaming is not wired up");
      }
      return rpcResult(id, await deps.openSubscription(filter.sessionIds, caller));
    }
    default:
      return rpcError(404, id, RPC_METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
  }
}
function dispatchLegacy(request, resolved, id, caller, deps, ctx) {
  if (request.method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }
  switch (request.method) {
    case "initialize":
      return {
        status: 200,
        sessionId: mintSessionId(),
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: resolved.version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { ...deps.serverInfo }
          }
        }
      };
    case "ping":
      return rpcResult(id, {});
    case "subscriptions/listen":
      return rpcError(
        404,
        id,
        RPC_METHOD_NOT_FOUND,
        `subscriptions/listen is not supported on protocol revision ${resolved.version}`,
        "MethodRemoved"
      );
    default:
      break;
  }
  return dispatchModernRest(request, id, caller, deps, ctx);
}
function checkString(name, value, allowed) {
  if (typeof value !== "string") return `${name} must be a string`;
  if (allowed && !allowed.includes(value)) return `${name} must be one of ${allowed.join(", ")}`;
  return null;
}
function checkNumber(name, value, opts) {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number`;
  if (opts.integer && !Number.isInteger(value)) return `${name} must be an integer`;
  if (opts.minimum !== void 0 && value < opts.minimum) return `${name} must be >= ${opts.minimum}`;
  if (opts.maximum !== void 0 && value > opts.maximum) return `${name} must be <= ${opts.maximum}`;
  return null;
}
function checkArray(name, schema, value) {
  if (!Array.isArray(value)) return `${name} must be an array`;
  const items = schema.items;
  if (!items) return null;
  for (let i = 0; i < value.length; i += 1) {
    if (items.type !== "string" && items.type !== "number" && items.type !== "integer") continue;
    const prefix = `${name}[${i}]`;
    const error = items.type === "string" ? checkString(prefix, value[i], items.enum) : checkNumber(prefix, value[i], { integer: items.type === "integer" });
    if (error) return error;
  }
  return null;
}
function validatePropertyValue(name, schema, value) {
  switch (schema.type) {
    case "string":
      return checkString(name, value, schema.enum);
    case "number":
      return checkNumber(name, value, { integer: false, minimum: schema.minimum, maximum: schema.maximum });
    case "integer":
      return checkNumber(name, value, { integer: true, minimum: schema.minimum, maximum: schema.maximum });
    case "boolean":
      return typeof value === "boolean" ? null : `${name} must be a boolean`;
    case "array":
      return checkArray(name, schema, value);
    default:
      return null;
  }
}
function validateToolArguments(tool, args) {
  const schema = tool.inputSchema;
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(props, key)) {
        return `${tool.name} does not accept an argument named "${key}"`;
      }
    }
  }
  for (const [name, raw] of Object.entries(props)) {
    const value = args[name];
    if (value === void 0) continue;
    const error = validatePropertyValue(name, raw, value);
    if (error) return `${tool.name}: ${error}`;
  }
  return null;
}
async function dispatchToolCall(request, id, caller, deps, ctx) {
  const name = typeof request.params === "object" && request.params !== null ? request.params.name : void 0;
  const tool = findTool(name, toolsFor(deps));
  if (!tool) {
    return rpcError(404, id, RPC_METHOD_NOT_FOUND, `Unknown tool: ${String(name)}`);
  }
  if (rank(tool.tier) > rank(caller.tier)) {
    deps.recordTierRefusal?.({
      caller,
      tool: tool.name,
      callerTier: caller.tier,
      requiredTier: tool.tier
    });
    return tierRefusalResponse(id, tool.tier);
  }
  const args = argsOf(request.params);
  for (const required of tool.inputSchema.required ?? []) {
    if (typeof args[required] !== "string" || args[required].length === 0) {
      return rpcError(
        400,
        id,
        RPC_INVALID_PARAMS,
        `${tool.name} requires a non-empty "${required}" argument`
      );
    }
  }
  const argError = validateToolArguments(tool, args) ?? deps.validateToolArgs?.(tool.name, args) ?? null;
  if (argError) {
    return rpcError(400, id, RPC_INVALID_PARAMS, argError, "InvalidToolArguments");
  }
  if (tool.sessionTargeting) {
    const verdict = evaluateSelfTarget(caller, args.sessionId, tool.name);
    if (!verdict.allowed) {
      deps.recordRefusal?.({
        callerSessionId: verdict.callerSessionId,
        targetSessionId: verdict.targetSessionId,
        tool: verdict.tool
      });
      return rpcError(
        403,
        id,
        RPC_INVALID_PARAMS,
        "A session may not drive itself through the MCP endpoint",
        "SelfTargetRefused"
      );
    }
  }
  try {
    return rpcResult(id, toCallToolResult(await executeTool(tool, args, caller, deps, ctx)));
  } catch (err) {
    if (err instanceof ToolArgumentError) {
      return rpcError(400, id, RPC_INVALID_PARAMS, err.message, "InvalidToolArguments");
    }
    throw err;
  }
}
const UNSAFE_PATH_CHARS = /[/?#%]/;
function toCallToolResult(value) {
  if (typeof value === "object" && value !== null && Array.isArray(value.content)) {
    return value;
  }
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
}
async function executeTool(tool, args, caller, deps, ctx) {
  switch (tool.bind.kind) {
    case "context":
      return deps.invokeTool({ tool, args, caller });
    case "session":
      return executeSession(tool, args, deps);
    case "rest":
      return executeRest(tool, args, caller, deps, ctx);
  }
}
async function executeSession(tool, args, deps) {
  if (tool.bind.kind !== "session") throw new Error("not a session-bound tool");
  const sessionId = args.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ToolArgumentError('requires a non-empty "sessionId"');
  }
  const { sessionId: _sid, ...rest } = args;
  const delivered = await deps.sendToSession?.(sessionId, {
    type: tool.bind.message,
    sessionId,
    ...rest
  });
  return { delivered: delivered === true };
}
class ToolArgumentError extends Error {
}
async function executeRest(tool, args, caller, deps, ctx) {
  if (tool.bind.kind !== "rest") throw new Error("not a rest-bound tool");
  if (!deps.inject) throw new Error(`no REST transport wired for ${tool.name}`);
  const split = tool.paramSplit;
  const pathArgNames = new Set(split.path.map((p) => p.arg));
  let url = tool.bind.path;
  for (const { arg, param } of split.path) {
    const value = args[arg];
    if (typeof value !== "string" || value.length === 0) {
      throw new ToolArgumentError(`${tool.name} requires a non-empty "${arg}" path argument`);
    }
    if (UNSAFE_PATH_CHARS.test(value) || value === "." || value === "..") {
      throw new ToolArgumentError(`${arg} must not contain /, ?, # or % and must not be a dot segment`);
    }
    url = url.replace(`:${param}`, encodeURIComponent(value));
  }
  const rest = {};
  for (const [k, v] of Object.entries(args)) if (!pathArgNames.has(k)) rest[k] = v;
  let payload;
  if (tool.bind.method === "GET") {
    const queryNames = split.queryAll ? Object.keys(rest) : split.query ?? [];
    const params = new URLSearchParams();
    for (const name of queryNames) {
      const v = rest[name];
      if (v === void 0 || v === null) continue;
      params.append(name, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  } else {
    const bodyNames = split.bodyAll ? Object.keys(rest) : split.body ?? [];
    const body = {};
    for (const name of bodyNames) if (rest[name] !== void 0) body[name] = rest[name];
    Object.assign(body, tool.bind.fixed ?? {});
    payload = body;
  }
  const { headers, remoteAddress } = injectIdentity(caller, ctx);
  const options = { method: tool.bind.method, url, headers, remoteAddress };
  if (tool.bind.method !== "GET") options.payload = payload;
  const res = await deps.inject(options);
  return mapRestEnvelope(tool.name, res);
}
function injectIdentity(caller, ctx) {
  const src = ctx.headers ?? {};
  const headers = {};
  const pick = (name) => {
    const v = src[name];
    if (typeof v === "string") headers[name] = v;
  };
  if (caller.kind === "device") {
    pick("host");
    pick("authorization");
    pick("x-forwarded-for");
    pick("x-forwarded-proto");
    pick("x-real-ip");
    return { headers, remoteAddress: ctx.remoteAddress ?? "127.0.0.1" };
  }
  pick("host");
  return { headers, remoteAddress: "127.0.0.1" };
}
function mapRestEnvelope(name, res) {
  const body = res.body;
  if (res.statusCode >= 400) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body ?? {}) }] };
  }
  if (body && body.success === false) {
    const message = typeof body.error === "string" ? body.error : `${name} failed`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
  const data = body && "data" in body ? body.data : body;
  return { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
}
export {
  REMOVED_METHODS,
  ToolArgumentError,
  buildDiscoverResult,
  dispatchRpc,
  parseSubscriptionFilter,
  tierRefusalResponse,
  toCallToolResult,
  validateToolArguments,
  versionFailureResponse
};
