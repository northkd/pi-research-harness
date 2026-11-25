import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openVerifiedTranscript } from '../../transcript.mjs';
import { isDetachedNativeHistory } from '../history.mjs';
import { within, isAllowed, isWritableMdTarget, serializeWrite, extToContentType, decodeFileUri,
  enumerateMdCandidates, listDirectories, classifyPaths, parseFlagsQuery, createDirectory, validateMkdirName,
  createProjectDirectory, CreateProjectError, fileKind, DIGEST_CEILING_BYTES, isImageUnderArtifactRoot } from './upstream.mjs';

export const FILE_LIMITS = Object.freeze({ textBytes: DIGEST_CEILING_BYTES, rawBytes: DIGEST_CEILING_BYTES,
  directoryEntries: 10000, attachmentBytes: 32 * 1024 * 1024, transcriptRecordBytes: 64 * 1024 * 1024 });
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const REPLY_HEADERS = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const CREATE_PROJECT_STATUS = { invalid_name: 400, reserved_name: 400, too_long: 400, outside_root: 400,
  not_a_directory: 409, root_not_a_directory: 409, home_missing: 500, fs_error: 500 };

function fail(statusCode, code, headers) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.headers = headers;
  throw error;
}

const reply = (data, statusCode = 200, headers = {}) => ({ statusCode, body: { success: true, data }, headers: { ...REPLY_HEADERS, ...headers } });
const binary = (body, headers, statusCode = 200) => ({ statusCode, body, headers: { ...REPLY_HEADERS, ...headers } });

function query(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'invalid-file-query');
  return Object.fromEntries(url.searchParams);
}

function validPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) fail(400, 'invalid-file-path');
  return decodeFileUri(value);
}

async function noSymlinks(file) {
  const resolved = await fs.realpath(file);
  if (resolved !== file) fail(403, 'path-outside-working-directory');
  return resolved;
}

async function regularFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail(404, 'not-a-file');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

async function verifyFile(handle, file, previous) {
  const [current, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
  if (named.isSymbolicLink() || named.ino !== previous.ino || named.dev !== previous.dev
      || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs) fail(409, 'file-changed-on-disk');
}

async function verifyTranscript(handle, file, previous) {
  const [current, named] = await Promise.all([handle.stat(), fs.lstat(file)]);
  if (named.isSymbolicLink() || named.ino !== previous.ino || named.dev !== previous.dev || current.size < previous.size
      || current.size === previous.size && (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs)) fail(409, 'file-changed-on-disk');
}

async function readExact(handle, start, length) {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(data, offset, length - offset, start + offset);
    if (!result.bytesRead) fail(409, 'file-changed-on-disk');
    offset += result.bytesRead;
  }
  return data;
}

function byteRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  const invalid = () => fail(416, 'invalid-byte-range', { 'Content-Range': `bytes */${size}` });
  if (!match || !size || !match[1] && !match[2]) invalid();
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) invalid(); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) invalid();
  return { start, end, partial: true };
}

function* imageBlocks(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) yield* imageBlocks(item, depth + 1); return; }
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string') yield value;
  for (const child of Object.values(value)) yield* imageBlocks(child, depth + 1);
}

async function attachmentOriginal(row, attachmentId, sessionsDir) {
  const { handle, info, headerEnd } = await openVerifiedTranscript(row, { sessionsDir });
  let pending = Buffer.alloc(0), discarding = false, position = headerEnd;
  try {
    while (position < info.size) {
      const chunk = await readExact(handle, position, Math.min(1024 * 1024, info.size - position));
      position += chunk.length;
      let start = 0;
      for (let offset = 0; offset < chunk.length; offset++) {
        if (chunk[offset] !== 10) continue;
        if (!discarding) {
          const line = pending.length ? Buffer.concat([pending, chunk.subarray(start, offset)]) : chunk.subarray(start, offset);
          if (line.length <= FILE_LIMITS.transcriptRecordBytes) {
            let record;
            try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { record = undefined; }
            for (const block of imageBlocks(record)) {
              if (createHash('sha256').update(block.data, 'utf8').digest('hex') !== attachmentId) continue;
              const mimeType = block.mimeType.split(';', 1)[0].trim().toLowerCase();
              if (!IMAGE_MIMES.has(mimeType)) return null;
              if (block.data.length > Math.ceil(FILE_LIMITS.attachmentBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) fail(413, 'attachment-too-large');
              const bytes = Buffer.from(block.data, 'base64');
              if (bytes.length > FILE_LIMITS.attachmentBytes) fail(413, 'attachment-too-large');
              await verifyTranscript(handle, row.sessionFile, info);
              return { bytes, mimeType };
            }
          }
        }
        pending = Buffer.alloc(0); discarding = false; start = offset + 1;
      }
      if (start < chunk.length && !discarding) {
        if (pending.length + chunk.length - start > FILE_LIMITS.transcriptRecordBytes) { pending = Buffer.alloc(0); discarding = true; }
        else pending = Buffer.concat([pending, chunk.subarray(start)]);
      }
    }
    await verifyTranscript(handle, row.sessionFile, info);
    return null;
  } finally { await handle.close(); }
}

export function createFileCompatibility({ workbench, sessions, localOperatorPrincipal, home = os.homedir(), sessionsDir,
  legacyAttachmentRoots = [], getPinnedDirectories, workspaceDirectories, grants, ...viewerOptions }) {
  if (!workbench?.accessFor || !sessions?.getSession || !sessions?.listSessions || !localOperatorPrincipal) throw new TypeError('file compatibility host dependencies required');
  const agentRoot = path.join(home, '.pi', 'agent');
  const principalOf = input => input.context?.principal ?? localOperatorPrincipal;

  async function scope(cwd, input, write = false, allowPinned = false) {
    const known = sessions.listSessions().some(row => row.cwd === cwd && !row.originDeviceId)
      || allowPinned && getPinnedDirectories?.().includes(cwd);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !known) fail(403, 'unknown-session-path');
    const access = await workbench.accessFor(cwd, { principal: principalOf(input), expiresAt: input.context?.expiresAt, write });
    await access.revalidate();
    return access;
  }

  async function target(cwd, rawPath, input, { write = false, tree = false, markdown = false, artifact = false, exists = false, browse = false } = {}) {
    const raw = validPath(rawPath);
    let access, resolved;
    if (browse && workspaceDirectories && principalOf(input) === localOperatorPrincipal) {
      if (cwd) {
        access = await workbench.accessFor(cwd, { principal: principalOf(input), write });
        await access.revalidate();
      }
      resolved = path.resolve(access?.cwd ?? home, raw);
      await noSymlinks(resolved);
      if (!workspaceDirectories.canBrowse(resolved, input.request)) fail(403, 'path-outside-working-directory');
      return { resolved, access };
    }
    if (cwd) { access = await scope(cwd, input, write, exists); resolved = path.resolve(access.cwd, raw); }
    else {
      if (!markdown || principalOf(input) !== localOperatorPrincipal || !path.isAbsolute(raw)) fail(400, 'cwd-and-path-required');
      resolved = path.resolve(raw);
    }
    if (markdown) {
      if (!await isWritableMdTarget(resolved, { ...(access ? { cwd: access.cwd } : {}), home })) fail(403, 'target-not-writable-markdown-in-scope');
    } else {
      const anchors = [access.cwd];
      if (!tree && principalOf(input) === localOperatorPrincipal) anchors.push(path.join(home, '.pi'));
      if (exists && principalOf(input) === localOperatorPrincipal) anchors.push(...(getPinnedDirectories?.() ?? []));
      if (!await isAllowed(resolved, { anchors }) && !(artifact && principalOf(input) === localOperatorPrincipal && await isImageUnderArtifactRoot(resolved))) {
        if (write || browse || !grants || principalOf(input) !== localOperatorPrincipal) fail(403, 'path-outside-working-directory');
        const grantOptions = { site: input.pathname, session: access.cwd, subjectKind: 'auto',
          quiet: input.pathname === '/api/file/digest' || input.pathname === '/api/file/resolve-mention' };
        const decision = await grants.evaluatePath(resolved, anchors, grantOptions);
        if (!decision.allowed) {
          const error = new Error('path-outside-working-directory');
          error.code = error.message;
          error.statusCode = 403;
          if (!grantOptions.quiet) error.remedy = decision.remedy;
          throw error;
        }
        const admission = access, targetPath = resolved;
        access = { ...admission, async revalidate() {
          await admission.revalidate();
          if (!(await grants.evaluatePath(targetPath, anchors, { ...grantOptions, quiet: true })).allowed) {
            fail(403, 'path-outside-working-directory');
          }
        } };
      }
    }
    if (!write && principalOf(input) === localOperatorPrincipal) {
      const mapped = legacyAttachmentRoots.find(item => path.isAbsolute(item.from) && path.isAbsolute(item.to) && within(resolved, item.from));
      if (mapped) resolved = path.join(mapped.to, path.relative(mapped.from, resolved));
    }
    await noSymlinks(resolved);
    return { resolved, access };
  }

  async function authorizedSession(id, input) {
    const row = sessions.getSession(id);
    if (!row?.sessionFile) fail(404, 'not-found');
    if (principalOf(input) === localOperatorPrincipal && isDetachedNativeHistory(row)) return row;
    const access = await scope(row.cwd, input);
    if (!await access.canReadHistory(row)) fail(404, 'not-found');
    await access.revalidate();
    return row;
  }

  async function readPath(params, input, markdown = false) {
    const { resolved, access } = await target(params.cwd, params.path, input, { markdown });
    const info = await fs.lstat(resolved);
    if (info.isDirectory() && !markdown) {
      const entries = [], iterator = await fs.opendir(resolved);
      let truncated = false;
      for await (const entry of iterator) { if (entries.length === FILE_LIMITS.directoryEntries) { truncated = true; break; } entries.push(entry.name); }
      await access?.revalidate();
      return reply({ type: 'directory', entries: entries.sort(), ...(truncated ? { truncated } : {}) });
    }
    const { handle, stat } = await regularFile(resolved);
    try {
      const sniff = await readExact(handle, 0, Math.min(1024, stat.size));
      const kind = fileKind(resolved, sniff);
      let content;
      if (markdown || ['monaco', 'markdown'].includes(kind.viewer) || kind.editable) {
        if (stat.size > FILE_LIMITS.textBytes) fail(413, 'file-too-large');
        const bytes = await readExact(handle, 0, stat.size);
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail(415, 'file-not-utf8'); }
      }
      await verifyFile(handle, resolved, stat); await access?.revalidate();
      return reply(markdown ? { content, mtime: stat.mtimeMs } : { type: 'file', kind: kind.kind, mimeType: kind.mimeType, size: stat.size, mtime: stat.mtimeMs, ...(content !== undefined ? { content } : {}) });
    } finally { await handle.close(); }
  }

  async function readRaw(params, input) {
    const { resolved, access } = await target(params.cwd, params.path, input, { artifact: true });
    const { handle, stat } = await regularFile(resolved);
    try {
      const range = byteRange(input.request?.headers?.range, stat.size);
      const length = Math.max(0, range.end - range.start + 1);
      if (length > FILE_LIMITS.rawBytes) fail(413, 'file-too-large', { 'Accept-Ranges': 'bytes' });
      const bytes = await readExact(handle, range.start, length);
      await verifyFile(handle, resolved, stat); await access.revalidate();
      return binary(bytes, { 'Content-Type': extToContentType(path.extname(resolved)), 'Content-Disposition': 'inline',
        'Content-Security-Policy': "sandbox; default-src 'none'", 'Accept-Ranges': 'bytes',
        ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` } : {}) }, range.partial ? 206 : 200);
    } finally { await handle.close(); }
  }

  async function writeMarkdown(body, input) {
    if (!body || Object.keys(body).some(key => !['cwd', 'path', 'content', 'mtime'].includes(key)) || typeof body.content !== 'string' || !Number.isFinite(body.mtime)) fail(400, 'path-content-and-mtime-required');
    const bytes = Buffer.from(body.content, 'utf8');
    if (bytes.length > FILE_LIMITS.textBytes) fail(413, 'content-too-large');
    const { resolved, access } = await target(body.cwd, body.path, input, { write: true, markdown: true });
    return serializeWrite(resolved, async () => {
      const current = await fs.lstat(resolved);
      if (!current.isFile() || current.nlink !== 1 || current.isSymbolicLink()) fail(403, 'target-not-writable-markdown-in-scope');
      if (current.mtimeMs !== body.mtime) fail(409, 'file-changed-on-disk');
      const temporary = path.join(path.dirname(resolved), '.' + path.basename(resolved) + '.' + randomBytes(12).toString('hex') + '.tmp');
      try {
        const output = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, current.mode & 0o777);
        try { await output.writeFile(bytes); await output.chmod(current.mode & 0o777); await output.sync(); }
        finally { await output.close(); }
        await noSymlinks(resolved);
        const fresh = await fs.lstat(resolved);
        if (fresh.ino !== current.ino || fresh.dev !== current.dev || fresh.mtimeMs !== current.mtimeMs || fresh.ctimeMs !== current.ctimeMs) fail(409, 'file-changed-on-disk');
        await access?.revalidate();
        await fs.rename(temporary, resolved);
        const after = await fs.stat(resolved);
        return reply({ mtime: after.mtimeMs, size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') });
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
  }

  async function readScoped(params, input, maximum, targetOptions) {
    const { resolved, access } = await target(params.cwd, params.path, input, targetOptions);
    const { handle, stat } = await regularFile(resolved);
    try {
      if (stat.size > maximum) fail(413, 'file-too-large');
      const bytes = await readExact(handle, 0, stat.size);
      await verifyFile(handle, resolved, stat); await access.revalidate();
      return { resolved, stat, bytes, async revalidate() {
        const current = await fs.lstat(resolved);
        if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size
            || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) fail(409, 'file-changed-on-disk');
        await access.revalidate();
      } };
    } finally { await handle.close(); }
  }

  let richCompatibility;

  return async function handle(input) {
    const { method, pathname, url, body } = input;
    const richRoute = ['/api/file/render', '/api/file/rendered-pdf', '/api/file/sheet', '/api/file/eml', '/api/file/eml-attachment'].includes(pathname);
    const attachment = /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
    const known = ['/api/file', '/api/file/tree', '/api/file/raw', '/api/file/digest', '/api/file/md-read', '/api/file/md-candidates', '/api/file/write', '/api/file/exists', '/api/file/resolve-mention', '/api/browse', '/api/browse/flags', '/api/browse/mkdir', '/api/browse/create-project', '/api/pinned-dirs'];
    if (!attachment && !known.includes(pathname) && !richRoute) return null;
    try {
      if (richRoute) {
        richCompatibility ??= import('./rich.mjs').then(module => module.createRichFileCompatibility({ readScoped, reply, binary, query, fail, options: viewerOptions }));
        return await (await richCompatibility)(input);
      }
      if (attachment && method === 'GET') {
        const row = await authorizedSession(decodeURIComponent(attachment[1]), input);
        const id = decodeURIComponent(attachment[2]);
        if (!/^[a-f0-9]{64}$/.test(id)) fail(400, 'invalid-attachment-id');
        const original = await attachmentOriginal(row, id, sessionsDir);
        if (!original) fail(404, 'not-found');
        return binary(original.bytes, { 'Content-Type': original.mimeType, 'Content-Security-Policy': "default-src 'none'; sandbox" });
      }
      if (method === 'POST' && pathname === '/api/browse/create-project') {
        if (principalOf(input) !== localOperatorPrincipal) fail(403, 'global-file-access-refused');
        if (!body || Object.keys(body).some(key => key !== 'name')) fail(400, 'invalid-directory-request');
        try {
          try {
            await noSymlinks(home);
            try { await noSymlinks(path.join(home, 'Projects')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          } catch (error) {
            if (error.statusCode === 403) throw new CreateProjectError('outside_root', 'projects root resolves outside the permitted path');
            if (error.code !== 'ENOENT') throw error;
          }
          const created = await createProjectDirectory(body.name, home);
          if (created.path !== path.join(home, 'Projects', body.name)) throw new CreateProjectError('outside_root', 'project directory resolves outside the permitted path');
          await noSymlinks(created.path);
          workspaceDirectories?.registerCreated(created.path);
          return reply(created);
        } catch (error) {
          const reason = error instanceof CreateProjectError ? error.reason : 'fs_error';
          return { statusCode: CREATE_PROJECT_STATUS[reason], body: { success: false, error: error.message || 'create-project failed', reason }, headers: { ...REPLY_HEADERS } };
        }
      }
      if (method === 'POST' && pathname === '/api/file/write') return await writeMarkdown(body, input);
      if (method === 'POST' && pathname === '/api/file/resolve-mention') {
        if (!body || Object.keys(body).some(key => !['cwd', 'mention'].includes(key)) || typeof body.mention !== 'string' || !body.mention) fail(400, 'cwd-and-mention-required');
        const access = await scope(body.cwd, input);
        const mention = body.mention;
        const kind = mention.startsWith('~/') ? 'tilde' : path.isAbsolute(mention) ? 'abs' : 'relative';
        const candidate = mention.startsWith('~/') ? path.join(home, mention.slice(2)) : path.resolve(access.cwd, mention);
        try {
          const result = await target(access.cwd, candidate, input);
          await access.revalidate();
          return reply({ resolved: result.resolved, kind });
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'path-outside-working-directory') return reply({ resolved: null });
          throw error;
        }
      }
      if (method === 'POST' && pathname === '/api/browse/mkdir') {
        if (!body || Object.keys(body).some(key => !['parent', 'name', 'cwd'].includes(key)) || typeof body.name !== 'string') fail(400, 'invalid-directory-request');
        if (validateMkdirName(body.name)) fail(400, 'invalid-directory-name');
        const cwd = body.cwd ?? (!workspaceDirectories && sessions.listSessions().find(row => within(path.resolve(body.parent ?? ''), row.cwd))?.cwd);
        const { resolved, access } = await target(cwd, body.parent, input, { write: true, tree: true, browse: true });
        const created = await createDirectory(resolved, body.name);
        await noSymlinks(created); await access?.revalidate();
        return reply({ path: created });
      }
      if (method === 'PATCH' && pathname === '/api/pinned-dirs' && workspaceDirectories) {
        if (principalOf(input) !== localOperatorPrincipal) fail(403, 'global-file-access-refused');
        return reply(workspaceDirectories.update(body, input.request));
      }
      if (method !== 'GET' || pathname === '/api/browse/create-project') fail(405, 'file-method-not-allowed');
      if (pathname === '/api/pinned-dirs') {
        query(url, []);
        if (typeof getPinnedDirectories !== 'function') fail(503, 'pinned-directories-unavailable');
        const pinned = await getPinnedDirectories();
        if (!Array.isArray(pinned) || pinned.length > FILE_LIMITS.directoryEntries
            || pinned.some(item => typeof item !== 'string' || !path.isAbsolute(item) || item.length > 4096 || item.includes('\0'))) fail(503, 'pinned-directories-unavailable');
        if (principalOf(input) === localOperatorPrincipal) return reply([...pinned]);
        const visible = [];
        for (const cwd of pinned) {
          try {
            const access = await workbench.accessFor(cwd, { principal: principalOf(input), expiresAt: input.context?.expiresAt });
            await access.revalidate(); visible.push(cwd);
          } catch {}
        }
        return reply(visible);
      }
      if (pathname === '/api/file/md-candidates') {
        const params = query(url, ['cwd']);
        if (params.cwd) await scope(params.cwd, input);
        else if (principalOf(input) !== localOperatorPrincipal) fail(403, 'global-file-access-refused');
        const candidates = await enumerateMdCandidates({ ...(params.cwd ? { cwd: params.cwd } : {}), home });
        const safe = [];
        for (const candidate of candidates) { try { await noSymlinks(candidate.path); safe.push(candidate); } catch {} }
        return reply({ candidates: safe });
      }
      if (pathname === '/api/browse/flags') {
        const params = query(url, ['paths']);
        const parsed = parseFlagsQuery(params.paths);
        if (!parsed.ok) fail(400, 'invalid-browse-paths');
        for (const file of parsed.paths) {
          const cwd = !workspaceDirectories && sessions.listSessions().find(row => within(path.resolve(file), row.cwd))?.cwd;
          await target(cwd, file, input, { tree: true, browse: true });
        }
        return reply({ flags: await classifyPaths(parsed.paths) });
      }
      if (pathname === '/api/browse') {
        const params = query(url, ['path', 'q', 'detect', 'cwd']);
        const requested = params.path ?? params.cwd ?? (workspaceDirectories ? home : sessions.listSessions()[0]?.cwd);
        const cwd = params.cwd ?? (!workspaceDirectories && sessions.listSessions().find(row => within(path.resolve(requested ?? ''), row.cwd))?.cwd);
        const { resolved, access } = await target(cwd, requested, input, { tree: true, browse: true });
        const result = await listDirectories(resolved, params.q, { detect: params.detect === '1' });
        if (result.parent && !(workspaceDirectories && principalOf(input) === localOperatorPrincipal
          ? workspaceDirectories.canBrowse(result.parent, input.request)
          : await isAllowed(result.parent, { anchors: [access.cwd] }))) result.parent = null;
        return reply({ ...result, confined: true });
      }
      const params = query(url, pathname === '/api/file/digest' ? ['cwd', 'path', 'purpose'] : ['cwd', 'path']);
      if (pathname === '/api/file') return await readPath(params, input);
      if (pathname === '/api/file/md-read') return await readPath(params, input, true);
      if (pathname === '/api/file/raw') return await readRaw(params, input);
      if (pathname === '/api/file/exists' && !path.isAbsolute(validPath(params.path))) fail(403, 'path-outside-working-directory');
      const exists = pathname === '/api/file/exists';
      const { resolved, access } = await target(params.cwd, params.path, input, { tree: exists || pathname === '/api/file/tree', exists });
      if (pathname === '/api/file/exists') { await access.revalidate(); return reply({ exists: true }); }
      if (pathname === '/api/file/tree') {
        const entries = [], iterator = await fs.opendir(resolved);
        let truncated = false;
        for await (const entry of iterator) {
          if (entries.length === FILE_LIMITS.directoryEntries) { truncated = true; break; }
          entries.push({ name: entry.name, isDir: entry.isDirectory(), ...(entry.isSymbolicLink() ? { isSymlink: true } : {}) });
        }
        entries.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
        await access.revalidate();
        return reply({ entries, ...(truncated ? { truncated } : {}) });
      }
      const { handle, stat } = await regularFile(resolved);
      try {
        const data = { size: stat.size, mtime: stat.mtimeMs };
        if (stat.size <= DIGEST_CEILING_BYTES) {
          const hash = createHash('sha1');
          for (let position = 0; position < stat.size; position += 1024 * 1024) hash.update(await readExact(handle, position, Math.min(1024 * 1024, stat.size - position)));
          data.sha1 = hash.digest('hex');
        }
        await verifyFile(handle, resolved, stat); await access.revalidate();
        return reply(data);
      } finally { await handle.close(); }
    } catch (error) {
      const status = error.statusCode ?? (error.code === 'ENOENT' ? 404 : error.code === 'ELOOP' ? 403 : 503);
      const code = /^[a-z][a-z0-9-]{1,120}$/.test(error.code ?? '') ? error.code : status === 404 ? 'not-found' : 'file-operation-unavailable';
      return { statusCode: status, body: { success: false, error: code, code, ...error.remedy }, headers: { ...REPLY_HEADERS, ...error.headers } };
    }
  };
}
