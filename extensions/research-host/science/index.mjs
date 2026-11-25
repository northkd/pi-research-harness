import { createHash } from 'node:crypto';
import { ResWorkflowError } from '../workbench/errors.mjs';
import { createScienceServerHosts } from './res-workflow/science-server-hosts.mjs';
import { SCIENCE_HOST_OPEN_DEADLINE_MS } from './res-workflow/science-host-client.mjs';
import { createScienceViewer } from './res-workflow/science-viewer.mjs';
import { isScienceInstanceId, isScienceArtifactId, projectScienceArtifact, projectScienceListResponse, projectScienceDetailResponse, projectScienceUnavailable, SCIENCE_RECORD_LIMITS } from './shared/science-instances.mjs';
import { isScienceViewTarget } from './shared/science-viewer.mjs';

export { createScienceInstancesHost } from './res-workflow/science-instances-host.mjs';
export { createScienceServerHosts, SCIENCE_HOST_PRIVATE_DIR } from './res-workflow/science-server-hosts.mjs';
export { createScienceHostClient, SCIENCE_HOST_OPEN_DEADLINE_MS } from './res-workflow/science-host-client.mjs';
export { createScienceViewer } from './res-workflow/science-viewer.mjs';
export * from './shared/science-instances.mjs';
export * from './shared/science-viewer.mjs';

export const SCIENCE_ROUTES = Object.freeze([
  ['GET', '/api/res-workflow/science/instances'],
  ['GET', '/api/res-workflow/science/instances/:taskId'],
  ['GET', '/api/res-workflow/science/instances/:taskId/artifacts/:artifactId'],
  ['POST', '/api/res-workflow/science/view'],
]);
export const SCIENCE_VIEW_MESSAGES = Object.freeze(['science_view_subscribe', 'science_view_unsubscribe', 'science_view_input']);

const prefix = '/api/res-workflow/science';
const unavailable = { availability: 'unavailable', reason: 'host-unconfigured' };
const offline = { availability: 'unknown', reason: 'host-offline' };
const invalid = { availability: 'unknown', reason: 'invalid-host-response' };
const privateHeaders = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
});
const signatures = new Map([
  ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ['image/jpeg', Buffer.from('ffd8ff', 'hex')],
  ['application/pdf', Buffer.from('%PDF-', 'ascii')],
]);
const openingSockets = new WeakMap();

function response(body, statusCode = 200, headers = {}) {
  return { statusCode, body, headers: { ...privateHeaders, ...headers } };
}

async function boundedRead(action) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('science-read-timeout')), 5000);
      timer.unref?.();
    })]);
  } catch { return offline; }
  finally { clearTimeout(timer); }
}

function artifactBytes(value, artifactId) {
  const artifact = projectScienceArtifact(value.artifact);
  if (!artifact || artifact.id !== artifactId || !(value.content instanceof Uint8Array) || value.content.byteLength > SCIENCE_RECORD_LIMITS.artifactBytes || value.content.byteLength !== artifact.bytes) return null;
  const content = Buffer.from(value.content);
  if (createHash('sha256').update(content).digest('hex') !== artifact.sha256) return null;
  const signature = signatures.get(artifact.mediaType);
  if (signature) {
    if (!content.subarray(0, signature.byteLength).equals(signature)) return null;
  } else {
    try { new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { return null; }
    if (content.includes(0)) return null;
  }
  return { artifact, content };
}

function artifactResponse(artifact, content) {
  const encoded = encodeURIComponent(artifact.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return response(content, 200, {
    'Content-Type': artifact.mediaType,
    'Content-Disposition': `attachment; filename="${artifact.id}"; filename*=UTF-8''${encoded}`,
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Science-Artifact-Sha256': artifact.sha256,
    'Access-Control-Expose-Headers': 'X-Science-Artifact-Sha256',
    'Content-Length': content.byteLength,
  });
}

function queryCwd(url) {
  if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('cwd').length !== 1) throw new ResWorkflowError(400, 'invalid-science-read-request');
  return url.searchParams.get('cwd');
}

function holdOpenTimeout(rawRequest, rawResponse) {
  const socket = rawRequest?.socket;
  if (!socket || !rawResponse || socket.destroyed || typeof socket.setTimeout !== 'function') return;
  let state = openingSockets.get(socket);
  if (!state) {
    state = { previousTimeout: socket.timeout ?? 0, pending: 0 };
    openingSockets.set(socket, state);
  }
  state.pending += 1;
  socket.setTimeout(Math.max(state.previousTimeout, SCIENCE_HOST_OPEN_DEADLINE_MS));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rawRequest.removeListener('aborted', release);
    rawResponse.removeListener('finish', release);
    rawResponse.removeListener('close', release);
    state.pending -= 1;
    if (!state.pending) {
      openingSockets.delete(socket);
      if (!socket.destroyed) socket.setTimeout(state.previousTimeout);
    }
  };
  rawRequest.once('aborted', release);
  rawResponse.once('finish', release);
  rawResponse.once('close', release);
}

/** Existing directory-scoped read and viewer contracts, using the host's admission. */
export function createScienceApi(options) {
  if (typeof options.accessFor !== 'function') throw new TypeError('Science host admission required');
  const owned = options.useInstalledHost === false ? undefined : createScienceServerHosts(options, { observe: options.observe });
  const instances = options.scienceInstancesHost ?? owned?.scienceInstancesHost;
  const view = options.scienceViewHost ?? owned?.scienceViewHost;
  const accessFor = (request, cwd, write = false) => options.accessFor(cwd, { principal: request.principal, expiresAt: request.principalExpiresAt, write });
  const viewer = createScienceViewer({ host: view, socketAccess: (socket, cwd, write) => accessFor(socket, cwd, write) });

  async function handle(request) {
    const { method, url, body } = request;
    const pathname = url.pathname;
    if (!pathname.startsWith(prefix + '/')) return null;
    const parts = pathname.slice(prefix.length + 1).split('/');
    const list = method === 'GET' && parts.length === 1 && parts[0] === 'instances';
    const detail = method === 'GET' && parts.length === 2 && parts[0] === 'instances';
    const artifact = method === 'GET' && parts.length === 4 && parts[0] === 'instances' && parts[2] === 'artifacts';
    const openView = method === 'POST' && parts.length === 1 && parts[0] === 'view';
    if (!list && !detail && !artifact && !openView) return null;
    try {
      if (openView) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['cwd', 'target'].includes(key)) || url.searchParams.size || !isScienceViewTarget(body.target)) throw new ResWorkflowError(400, 'invalid-science-view-request');
        const grant = await accessFor(request, body.cwd);
        holdOpenTimeout(request.rawRequest, request.rawResponse);
        return response(await viewer.open(grant, body.target));
      }
      if (body !== undefined && body !== null) throw new ResWorkflowError(400, 'invalid-science-read-request');
      if (detail && !isScienceInstanceId(parts[1])) throw new ResWorkflowError(400, 'invalid-science-task-id');
      if (artifact && (!isScienceInstanceId(parts[1]) || !isScienceArtifactId(parts[3]))) throw new ResWorkflowError(400, 'invalid-science-artifact-id');
      const grant = await accessFor(request, queryCwd(url));
      await grant.revalidate();
      if (!instances) return response(unavailable, artifact ? 503 : 200);
      const partition = { ownerKey: grant.ownerKey, cwd: grant.cwd };
      const result = await boundedRead(() => list ? instances.list(partition) : detail ? instances.detail(partition, parts[1]) : instances.readArtifact(partition, parts[1], parts[3]));
      if (list || detail) {
        const projected = list ? projectScienceListResponse(result) : projectScienceDetailResponse(result);
        await grant.revalidate();
        return response(detail && projected.availability === 'ready' && projected.instance.id !== parts[1] ? invalid : projected);
      }
      if (result?.availability !== 'ready') {
        await grant.revalidate();
        const projected = projectScienceUnavailable(result);
        return response(projected, projected.reason === 'binding-unavailable' ? 404 : 503);
      }
      const checked = artifactBytes(result, parts[3]);
      await grant.revalidate();
      return checked ? artifactResponse(checked.artifact, checked.content) : response(invalid, 503);
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,120}$/.test(error.code) ? error.code : openView ? 'science-view-unavailable' : 'science-records-unavailable';
      const status = [400, 401, 403, 404, 409, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
      return response({ success: false, code, error: code }, status, code === 'cwd-admission-unavailable' ? { 'Retry-After': '1' } : {});
    }
  }

  return { handle, handleMessage: viewer.handleMessage, disconnect: viewer.disconnect,
    dispose() { viewer.dispose(); owned?.dispose(); } };
}
