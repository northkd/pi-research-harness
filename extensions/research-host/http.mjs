import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { QUESTION_IMAGE_HTTP_BYTES } from './supplemental/questions/attachments.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FILE_WRITE_BODY_BYTES = 600 * 1024 * 1024;
const QUESTION_ANSWER_ROUTE = /^\/api\/questions\/[A-Za-z0-9_-]{22}\/answer$/;
const SAFE_CODE = /^[a-z0-9-]{1,120}$/;

export class HostHttpError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function fail(statusCode, code) {
  throw new HostHttpError(statusCode, code);
}

export const reply = (data, statusCode = 200) => ({ statusCode, body: data });

function tokenMatches(expected, value) {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  const candidate = Buffer.from(value, 'utf8');
  const basis = Buffer.from(expected, 'utf8');
  return candidate.length === basis.length && timingSafeEqual(candidate, basis);
}

export function authenticateRequest(request, token) {
  return request.socket.remoteAddress === '127.0.0.1' && tokenMatches(token, request.headers['x-pi-local-token']);
}

export function sameRequestOrigin(request) {
  const value = request.headers.origin;
  if (value === undefined) return true;
  try {
    const origin = new URL(value);
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === value && origin.host === request.headers.host;
  } catch { return false; }
}

async function readBody(request, maximum = MAX_BODY_BYTES) {
  const mime = request.headers['content-type']?.split(';', 1)[0];
  if (mime !== 'application/json') fail(415, 'json-content-type-required');
  if (Number(request.headers['content-length']) > maximum) fail(413, 'request-too-large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) fail(413, 'request-too-large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'invalid-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'json-object-required');
  return value;
}

function writeResponse(response, status, body, headers, headOnly = false) {
  const binary = Buffer.isBuffer(body);
  const payload = binary ? body : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': binary ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(headOnly ? undefined : payload);
}

/** The browser-facing service uses its own same-origin server to authenticate
 * callers before forwarding requests to this loopback-only host. */
export function createHostHttpServer({ token, handle, handleMcp, onError = () => {} }) {
  return createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000 }, async (request, response) => {
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) fail(400, 'invalid-request-target');
      const url = new URL(request.url, 'http://127.0.0.1');
      const method = request.method;
      if (handleMcp && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) {
        if (request.socket.remoteAddress !== '127.0.0.1') fail(401, 'research-host-auth-required');
        let body, parseError, bodyTooLarge;
        if (method === 'POST') {
          try { body = await readBody(request); }
          catch (error) { parseError = error.statusCode !== 413; bodyTooLarge = !parseError; }
        }
        const result = await handleMcp({
          method, url, body, parseError, bodyTooLarge,
          headers: request.headers, rawRequest: request, remoteAddress: request.socket.remoteAddress,
        });
        if (!result) fail(404, 'research-host-route-not-found');
        if (typeof result.stream === 'function') result.stream(request, response);
        else if (result.empty) { response.writeHead(result.statusCode, result.headers); response.end(); }
        else writeResponse(response, result.statusCode, result.body, result.headers);
        return;
      }
      if (!authenticateRequest(request, token)) fail(401, 'research-host-auth-required');
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) fail(405, 'method-not-allowed');
      const read = method === 'GET' || method === 'HEAD';
      if (!read && !sameRequestOrigin(request)) fail(403, 'research-host-origin-refused');
      const emptyBody = !request.headers['content-type'] && !request.headers['transfer-encoding']
        && Number(request.headers['content-length'] ?? 0) === 0;
      const maximum = url.pathname === '/api/file/write' ? FILE_WRITE_BODY_BYTES
        : QUESTION_ANSWER_ROUTE.test(url.pathname) ? QUESTION_IMAGE_HTTP_BYTES : MAX_BODY_BYTES;
      const body = read ? null : emptyBody ? {} : await readBody(request, maximum);
      const result = await handle({ method: read ? 'GET' : method, url, body, pathname: url.pathname, request });
      if (!result) fail(404, 'research-host-route-not-found');
      writeResponse(response, result.statusCode, result.body, result.headers, method === 'HEAD');
    } catch (error) {
      const code = SAFE_CODE.test(error?.code ?? '') ? error.code : 'research-host-unavailable';
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode : 503;
      if (status >= 500) onError(code);
      if (!response.headersSent && !response.destroyed) {
        writeResponse(response, status, { success: false, error: code, code });
      }
    }
  });
}
