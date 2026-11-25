const JSONRPC_VERSION = "2.0";
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_INSUFFICIENT_SCOPE = -32001;
function rpcResult(id, result) {
  return { status: 200, body: { jsonrpc: JSONRPC_VERSION, id, result } };
}
function rpcError(status, id, code, message, type) {
  return {
    status,
    body: {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, ...type ? { data: { type } } : {} }
    }
  };
}
function extractId(body) {
  if (typeof body !== "object" || body === null) return null;
  const id = body.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
function parseRpcRequest(body) {
  const id = extractId(body);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return rpcError(400, id, RPC_INVALID_REQUEST, "Request body must be a JSON-RPC object");
  }
  const candidate = body;
  if (candidate.jsonrpc !== JSONRPC_VERSION) {
    return rpcError(400, id, RPC_INVALID_REQUEST, `jsonrpc must be "${JSONRPC_VERSION}"`);
  }
  if (typeof candidate.method !== "string" || candidate.method.length === 0) {
    return rpcError(400, id, RPC_INVALID_REQUEST, "method must be a non-empty string");
  }
  return { ok: true, request: { jsonrpc: candidate.jsonrpc, id, method: candidate.method, params: candidate.params } };
}
export {
  JSONRPC_VERSION,
  RPC_INSUFFICIENT_SCOPE,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  extractId,
  parseRpcRequest,
  rpcError,
  rpcResult
};
