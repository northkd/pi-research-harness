import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createFileCompatibility } from './index.mjs';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-files-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), home = path.join(root, 'home'), sessionsDir = path.join(home, '.pi/agent/sessions');
  await fs.mkdir(cwd); await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(path.join(cwd, '.pi')); await fs.mkdir(path.join(cwd, '.git')); await fs.mkdir(path.join(cwd, 'folder'));
  const session = { id: 'native-test', cwd, sessionFile: path.join(sessionsDir, 'different-name.jsonl') };
  await fs.writeFile(session.sessionFile, JSON.stringify({ type: 'session', id: session.id, cwd }) + '\n');
  const rows = [session];
  const principal = Object.freeze({ iss: 'local', sub: 'operator' });
  const workbench = { async accessFor(requested, identity) {
    if (requested !== cwd || identity.principal?.sub === 'outsider') { const error = new Error('workspace-not-found'); error.statusCode = 404; error.code = 'workspace-not-found'; throw error; }
    return { cwd, write: identity.write, revalidate: async () => {}, canReadHistory: async row => row.cwd === cwd };
  } };
  const sessions = { getSession: id => rows.find(row => row.id === id), listSessions: () => rows };
  const options = { workbench, sessions, localOperatorPrincipal: principal, home, sessionsDir, ...overrides };
  const handle = createFileCompatibility(options);
  async function request(route, { method = 'GET', body = null, headers = {}, context } = {}) {
    const url = new URL(route, 'http://127.0.0.1');
    return handle({ method, pathname: url.pathname, url, body, request: { headers }, context });
  }
  const fileUrl = (suffix, name) => '/api/file' + suffix + '?cwd=' + encodeURIComponent(cwd) + '&path=' + encodeURIComponent(name);
  return { root, cwd, home, sessionsDir, session, rows, principal, options, handle, request, fileUrl };
}

test('file reads preserve content metadata and hidden directory types', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'notes.md'), '中文正文😀\n');
  const response = await f.request(f.fileUrl('', 'notes.md'));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.content, '中文正文😀\n');
  assert.equal(response.body.data.kind, 'markdown');
  assert.equal(typeof response.body.data.mtime, 'number');
  const tree = await f.request(f.fileUrl('/tree', '.'));
  assert.equal(tree.body.data.entries.find(entry => entry.name === '.pi').isDir, true);
  assert.equal(tree.body.data.entries.find(entry => entry.name === '.git').isDir, true);
});

test('file reads reject traversal, symlinks, unknown project and named-owner escape', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'outside.txt'), 'outside');
  await fs.symlink(path.join(f.root, 'outside.txt'), path.join(f.cwd, 'link.txt'));
  assert.equal((await f.request(f.fileUrl('', '../outside.txt'))).statusCode, 403);
  assert.equal((await f.request(f.fileUrl('', 'link.txt'))).statusCode, 403);
  assert.equal((await f.request('/api/file?cwd=' + encodeURIComponent(f.root) + '&path=outside.txt')).statusCode, 403);
  assert.equal((await f.request(f.fileUrl('', '.'), { context: { principal: { iss: 'named', sub: 'outsider' } } })).statusCode, 404);
});

test('markdown saves preserve private mode, return matching digest and reject stale concurrent writes', async t => {
  const f = await fixture(t);
  const file = path.join(f.cwd, 'notes.md');
  await fs.writeFile(file, 'old', { mode: 0o600 });
  const before = await fs.stat(file);
  const input = { cwd: f.cwd, path: 'notes.md', content: 'new 中文', mtime: before.mtimeMs };
  const results = await Promise.all([
    f.request('/api/file/write', { method: 'POST', body: input }),
    f.request('/api/file/write', { method: 'POST', body: { ...input, content: 'stale' } }),
  ]);
  assert.deepEqual(results.map(row => row.statusCode).sort(), [200, 409]);
  assert.equal(await fs.readFile(file, 'utf8'), 'new 中文');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const digest = await f.request(f.fileUrl('/digest', 'notes.md'));
  assert.equal(digest.body.data.sha1, results.find(row => row.statusCode === 200).body.data.sha1);
  assert.equal(digest.body.data.sha1, createHash('sha1').update('new 中文').digest('hex'));
  assert.equal((await f.request('/api/file/write', { method: 'POST', body: input })).statusCode, 409);
  await fs.writeFile(path.join(f.cwd, 'script.txt'), 'keep');
  assert.equal((await f.request('/api/file/write', { method: 'POST', body: { ...input, path: 'script.txt' } })).statusCode, 403);
});

test('raw binary reads support exact range, suffix range and content type', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'image.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]));
  const range = await f.request(f.fileUrl('/raw', 'image.png'), { headers: { range: 'bytes=1-3' } });
  assert.equal(range.statusCode, 206);
  assert.deepEqual([...range.body], [80, 78, 71]);
  assert.equal(range.headers['Content-Type'], 'image/png');
  assert.equal(range.headers['Content-Range'], 'bytes 1-3/8');
  const suffix = await f.request(f.fileUrl('/raw', 'image.png'), { headers: { range: 'bytes=-2' } });
  assert.deepEqual([...suffix.body], [3, 4]);
  const invalid = await f.request(f.fileUrl('/raw', 'image.png'), { headers: { range: 'bytes=20-30' } });
  assert.equal(invalid.statusCode, 416);
  assert.equal(invalid.headers['Content-Range'], 'bytes */8');
});

test('attachment recovery uses the original base64 hash, exact session scope and safe raster mime', async t => {
  const f = await fixture(t);
  const data = Buffer.from('synthetic image bytes').toString('base64');
  const id = createHash('sha256').update(data, 'utf8').digest('hex');
  const message = { type: 'message', id: 'image-entry', message: { role: 'user', content: [{ type: 'image', data, mimeType: 'IMAGE/JPG; charset=binary' }] } };
  await fs.appendFile(f.session.sessionFile, JSON.stringify(message) + '\n');
  const recovered = await f.request('/api/sessions/native-test/attachments/' + id);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.toString(), 'synthetic image bytes');
  assert.equal(recovered.headers['Content-Type'], 'image/jpg');
  assert.equal(recovered.headers['Cache-Control'], 'no-store, private');
  assert.equal((await f.request('/api/sessions/missing/attachments/malformed')).statusCode, 404);
  assert.equal((await f.request('/api/sessions/native-test/attachments/malformed')).statusCode, 400);
  const svg = Buffer.from('<svg>script</svg>').toString('base64');
  await fs.appendFile(f.session.sessionFile, JSON.stringify({ type: 'message', message: { content: [{ type: 'image', data: svg, mimeType: 'image/svg+xml' }] } }) + '\n');
  const svgId = createHash('sha256').update(svg).digest('hex');
  assert.equal((await f.request('/api/sessions/native-test/attachments/' + svgId)).statusCode, 404);
});

test('legacy attachment paths map through a host-owned exact root without rewriting the transcript', async t => {
  const f = await fixture(t);
  const from = path.join(f.home, '.pi/dashboard/attachments');
  const to = path.join(f.root, 'new-attachments');
  await fs.mkdir(to); await fs.writeFile(path.join(to, 'old.png'), 'original');
  const handle = createFileCompatibility({ ...f.options, legacyAttachmentRoots: [{ from, to }] });
  const url = new URL(f.fileUrl('/raw', path.join(from, 'old.png')), 'http://127.0.0.1');
  const before = await fs.readFile(f.session.sessionFile);
  const response = await handle({ method: 'GET', pathname: url.pathname, url, request: { headers: {} } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString(), 'original');
  assert.deepEqual(await fs.readFile(f.session.sessionFile), before);
});

test('directory browse, flags and mkdir retain scoped real effects', async t => {
  const f = await fixture(t);
  const browse = await f.request('/api/browse?path=' + encodeURIComponent(f.cwd));
  assert.equal(browse.body.data.current, f.cwd);
  assert.equal(browse.body.data.parent, null);
  assert.ok(browse.body.data.entries.some(row => row.name === 'folder'));
  const flags = await f.request('/api/browse/flags?paths=' + encodeURIComponent(JSON.stringify([f.cwd])));
  assert.deepEqual(flags.body.data.flags[f.cwd], { isGit: true, isPi: true });
  const mkdir = await f.request('/api/browse/mkdir', { method: 'POST', body: { cwd: f.cwd, parent: f.cwd, name: 'created' } });
  assert.equal(mkdir.statusCode, 200);
  assert.equal((await fs.stat(path.join(f.cwd, 'created'))).isDirectory(), true);
  assert.equal((await f.request('/api/browse/mkdir', { method: 'POST', body: { cwd: f.cwd, parent: f.cwd, name: '../escape' } })).statusCode, 400);
});

test('global instruction picker and saves stay under the original agent root', async t => {
  const f = await fixture(t);
  const file = path.join(f.home, '.pi/agent/AGENTS.md');
  await fs.writeFile(file, 'global');
  const candidates = await f.request('/api/file/md-candidates');
  assert.ok(candidates.body.data.candidates.some(row => row.path === file));
  const read = await f.request('/api/file/md-read?path=' + encodeURIComponent(file));
  assert.equal(read.body.data.content, 'global');
  const write = await f.request('/api/file/write', { method: 'POST', body: { path: file, content: 'saved', mtime: read.body.data.mtime } });
  assert.equal(write.statusCode, 200);
  assert.equal(await fs.readFile(file, 'utf8'), 'saved');
  assert.equal((await f.request('/api/file/md-candidates', { context: { principal: { iss: 'named', sub: 'somebody' } } })).statusCode, 403);
});

test('file mentions resolve through the real scope and existence probes require absolute in-scope paths', async t => {
  const f = await fixture(t);
  const file = path.join(f.cwd, 'notes.md');
  await fs.writeFile(file, 'notes');
  const mention = await f.request('/api/file/resolve-mention', { method: 'POST', body: { cwd: f.cwd, mention: 'notes.md' } });
  assert.deepEqual(mention.body.data, { resolved: file, kind: 'relative' });
  const missing = await f.request('/api/file/resolve-mention', { method: 'POST', body: { cwd: f.cwd, mention: 'missing.md' } });
  assert.deepEqual(missing.body.data, { resolved: null });
  const escape = await f.request('/api/file/resolve-mention', { method: 'POST', body: { cwd: f.cwd, mention: '../outside.md' } });
  assert.deepEqual(escape.body.data, { resolved: null });
  assert.equal((await f.request(f.fileUrl('/exists', file))).body.data.exists, true);
  assert.equal((await f.request(f.fileUrl('/exists', 'notes.md'))).statusCode, 403);
});

test('first-run project creation preserves original create-or-reuse results and validation reasons', async t => {
  const f = await fixture(t);
  const create = name => f.request('/api/browse/create-project', { method: 'POST', body: { name } });
  const expected = path.join(f.home, 'Projects', '研究项目');
  const first = await create('研究项目');
  assert.deepEqual(first.body, { success: true, data: { path: expected, existed: false } });
  assert.equal((await fs.stat(expected)).isDirectory(), true);
  await fs.writeFile(path.join(expected, 'keep.txt'), 'preserved');
  assert.deepEqual((await create('研究项目')).body.data, { path: expected, existed: true });
  assert.equal(await fs.readFile(path.join(expected, 'keep.txt'), 'utf8'), 'preserved');
  for (const [name, reason] of [['../escape', 'invalid_name'], ['CON', 'reserved_name'], ['x'.repeat(256), 'too_long']]) {
    const result = await create(name);
    assert.equal(result.statusCode, 400); assert.equal(result.body.reason, reason);
  }
  await fs.writeFile(path.join(f.home, 'Projects', 'occupied'), 'keep');
  assert.equal((await create('occupied')).body.reason, 'not_a_directory');
  assert.equal((await create('occupied')).statusCode, 409);
  assert.equal((await f.request('/api/browse/create-project')).statusCode, 405);
});

test('project creation rejects named callers and symlink roots before writing outside the home', async t => {
  const f = await fixture(t);
  const denied = await f.request('/api/browse/create-project', { method: 'POST', body: { name: 'refused' }, context: { principal: { iss: 'named', sub: 'reader' } } });
  assert.equal(denied.statusCode, 403);
  await assert.rejects(fs.stat(path.join(f.home, 'Projects')), { code: 'ENOENT' });
  const outside = path.join(f.root, 'outside-projects'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.home, 'Projects'));
  const escaped = await f.request('/api/browse/create-project', { method: 'POST', body: { name: 'refused' } });
  assert.equal(escaped.statusCode, 400); assert.equal(escaped.body.reason, 'outside_root');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('pinned directory reads use current injected state and filter ownership without turning pins into file grants', async t => {
  let pins = [];
  const f = await fixture(t, { getPinnedDirectories: () => pins });
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  pins = [other, f.cwd];
  assert.deepEqual((await f.request('/api/pinned-dirs')).body.data, pins);
  const named = { principal: { iss: 'named', sub: 'reader' } };
  assert.deepEqual((await f.request('/api/pinned-dirs', { context: named })).body.data, [f.cwd]);
  const outsider = { principal: { iss: 'named', sub: 'outsider' } };
  assert.deepEqual((await f.request('/api/pinned-dirs', { context: outsider })).body.data, []);
  assert.equal((await f.request('/api/file?cwd=' + encodeURIComponent(other) + '&path=.')).statusCode, 403);
  pins = [f.cwd];
  assert.deepEqual((await f.request('/api/pinned-dirs')).body.data, [f.cwd]);
  assert.equal((await f.request('/api/pinned-dirs', { method: 'POST' })).statusCode, 405);
  pins = ['relative-invalid'];
  assert.equal((await f.request('/api/pinned-dirs')).statusCode, 503);
});
