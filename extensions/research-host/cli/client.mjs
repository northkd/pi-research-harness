import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 16 * 1024 * 1024;
const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);

export class CliError extends Error {
  constructor(message, code = 'cli-error', statusCode) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function readFile(file, maximum, privateFile = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || (privateFile && (stat.mode & 0o077))) {
    throw new CliError('本机宿主配置或令牌文件权限无效。', 'host-auth-unsafe');
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new CliError('读取本机宿主配置时文件发生变化。', 'host-auth-changed');
    }
    const value = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(value) > maximum) throw new CliError('本机宿主配置文件过大。', 'host-auth-oversized');
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadHostAuth({ env = process.env, home = os.homedir() } = {}) {
  const directory = env.PI_RESEARCH_HOST_DIR || path.join(home, '.pi', 'research-host');
  if (!path.isAbsolute(directory)) throw new CliError('PI_RESEARCH_HOST_DIR 必须为绝对路径。', 'host-directory-invalid');
  try {
    const config = JSON.parse(readFile(path.join(directory, 'config.json'), MAX_CONFIG_BYTES));
    const token = readFile(path.join(directory, 'local', 'token'), 1024, true).trim();
    const host = config.bindHost ?? '127.0.0.1';
    if (!loopback(host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !token || /\s/.test(token)) {
      throw new CliError('本机宿主地址或令牌无效。', 'host-auth-invalid');
    }
    const address = host === '::1' ? '[::1]' : host;
    return { baseUrl: `http://${address}:${config.port}`, token };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('无法读取本机科研宿主配置。请先启动科研宿主。', 'host-auth-unavailable');
  }
}

export async function readReply(response) {
  if (!response.body) return null;
  const parts = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_REPLY_BYTES) throw new CliError('宿主响应过大。', 'host-response-oversized');
      parts.push(Buffer.from(item.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const text = Buffer.concat(parts).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new CliError('宿主返回了无效 JSON。', 'host-response-invalid'); }
}

export function unwrapReply(value) {
  return value?.success === true && Object.hasOwn(value, 'data') ? value.data : value;
}

/** Requests always use the configured local host; mutations are never retried. */
export function createHostClient({ auth, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const origin = new URL(auth.baseUrl);
  if (origin.protocol !== 'http:' || !loopback(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new CliError('科研宿主必须使用本机 HTTP 地址。', 'host-destination-invalid');
  }
  return async function request(method, endpoint, body, options = {}) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/') || endpoint.startsWith('//') || endpoint.includes('#') || endpoint.includes('\\')) {
      throw new CliError('请求路径必须位于本机 /api/ 下。', 'host-endpoint-invalid');
    }
    const url = new URL(endpoint, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) throw new CliError('请求路径无效。', 'host-endpoint-invalid');
    const deadline = AbortSignal.timeout(options.timeoutMs ?? timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const payload = body === undefined && method !== 'GET' ? {} : body;
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', signal,
        headers: { 'x-pi-local-token': auth.token, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new CliError(method === 'GET'
        ? '无法连接本机科研宿主。'
        : '请求结果未知。请先查询现有状态，再决定是否使用原请求 ID 重试。', 'host-request-unconfirmed');
    }
    const reply = await readReply(response);
    if (!response.ok || reply?.success === false || reply?.status === 'blocked') {
      const code = typeof reply?.code === 'string' ? reply.code : typeof reply?.error === 'string' ? reply.error : `host-http-${response.status}`;
      throw new CliError(typeof reply?.message === 'string' ? reply.message : code, code, response.status);
    }
    return unwrapReply(reply);
  };
}
