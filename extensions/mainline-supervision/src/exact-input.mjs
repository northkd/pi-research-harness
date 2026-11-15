// Human-installed, single-invocation exception. No model tool can create this permit.
// Hashes bind the pre-dispatch versions; this is authorization, not an OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (obj, expected) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === expected;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reserved = /^(?:credentials?|secrets?|sessions?|settings?|models?|auth|private|id_rsa|id_ed25519)(?:[._-]|$)|^\.(?:pi|ssh|aws|config|git|env)(?:[._-]|$)|\.(?:pem|key|p12|pfx)$/i;
const dangerous = /(?:\b(?:rm|dd|mkfs|shutdown|reboot|sudo)\b|(?:^|\s)git\s+(?:reset|clean)\b)/i;
const marker = 'mainline-exact-input:';
export const exactInputRequested = event => event.toolName === 'bg_run' &&
  typeof event.input?.description === 'string' && event.input.description.startsWith(marker);
const permitLeaf = 'exact-input-permit.json';
function canonicalRelative(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./+-]+$/.test(value) || path.isAbsolute(value)) throw new Error('Noncanonical exact path');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || reserved.test(p))) throw new Error('Sensitive exact path');
  return value;
}
function checkAncestors(absolute, allowMissing = false) {
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    let st;
    try { st = fs.lstatSync(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory())) throw new Error('Symlink/non-directory in exact path');
  }
}
function identity(st) { return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, nlink: st.nlink }; }
function version(absolute, maxBytes = 2 * 1024 ** 3) {
  checkAncestors(absolute);
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Exact input not an unaliased bounded regular file');
    const h = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n));
    const after = fs.fstatSync(fd);
    if (!equal(identity(before), identity(after))) throw new Error('Exact file changed while hashing');
    return { ...identity(after), sha256: h.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function absent(cwd, relative) {
  const absolute = path.join(cwd, relative);
  checkAncestors(absolute, true);
  try { fs.lstatSync(absolute); throw new Error('Exact output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let parent = path.dirname(absolute);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const st = fs.statSync(parent);
  return { path: relative, nearestParent: path.relative(cwd, parent), dev: st.dev, ino: st.ino };
}
function visibleArguments(command, permit) {
  if (typeof command !== 'string' || command.length > 12000 || !/^[A-Za-z0-9_./+ :\-]+$/.test(command) || dangerous.test(command)) throw new Error('Opaque or dangerous exact command');
  const args = command.split(' ');
  if (args.some(a => !a) || args[0] !== permit.interpreter.path || !/\/(?:python(?:3(?:\.\d+)?)?|node)$/.test(args[0])) throw new Error('Only exact canonical Python/Node interpreter');
  const declared = new Set(permit.files.map(f => f.path));
  const scripts = [], inputs = [], outputs = [];
  let i = 1;
  const script = () => {
    const value = canonicalRelative(args[i++]);
    if (!/\.(?:py|mjs|js)$/.test(value) || !declared.has(value)) throw new Error('Undeclared script');
    scripts.push(value);
  };
  script();
  while (i < args.length) {
    const flag = args[i++];
    if (flag === '--') {
      if (args[i++] !== permit.interpreter.path) throw new Error('Nested interpreter differs');
      script(); continue;
    }
    const value = args[i++];
    if (flag === '--input') { canonicalRelative(value); if (!declared.has(value)) throw new Error('Undeclared input'); inputs.push(value); }
    else if (flag === '--output') { canonicalRelative(value); if (!permit.outputs.includes(value)) throw new Error('Undeclared output'); outputs.push(value); }
    else if (flag === '--id') { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value ?? '')) throw new Error('Invalid run id'); }
    else if (flag === '--kind') { if (!['synthetic', 'environment', 'material'].includes(value)) throw new Error('Invalid run kind'); }
    else if (flag === '--member') { if (!/^\d{1,4}$/.test(value ?? '')) throw new Error('Invalid member'); }
    else throw new Error('Unknown exact argument');
  }
  if (!inputs.length) throw new Error('Explicit input required');
  return { scripts, inputs, outputs };
}
export function prepareExactInput(store, state, event) {
  if (!exactInputRequested(event)) return null;
  const file = path.join(store.root, permitLeaf);
  checkAncestors(file);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || st.size > 65536 || (st.mode & 0o077)) throw new Error('Invalid exact permit file');
  const text = store.readLocal(file);
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('Malformed exact permit JSON'); }
  if (p?.toolName !== event.toolName || !equal(p?.toolInput, event.input) || event.input.description !== marker + p.id)
    throw new Error('No exact permit for requested invocation');
  if (!keys(p, 'coreDigest,coreRevision,cwd,files,humanReviewed,id,interpreter,outputs,schema,scopeDigest,toolInput,toolName') ||
      p.schema !== 'mainline-exact-input.v1' || p.humanReviewed !== true || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(p.id) ||
      p.cwd !== store.cwd || p.coreRevision !== state.coreRevision || p.coreDigest !== sha(state.coreText ?? '') ||
      p.scopeDigest !== sha(JSON.stringify(state.authorizationScope ?? []))) throw new Error('Invalid or stale exact permit');
  const allowedInputKeys = ['command', 'name', 'isAgent', 'description'];
  if (!p.toolInput || Object.keys(p.toolInput).some(k => !allowedInputKeys.includes(k)) ||
      (event.toolName === 'bg_run' && p.toolInput.isAgent !== false)) throw new Error('Unsupported exact tool input');
  if (!keys(p.interpreter, 'path,sha256') || !path.isAbsolute(p.interpreter.path) || !hex(p.interpreter.sha256)) throw new Error('Invalid interpreter binding');
  if (!Array.isArray(p.files) || !p.files.length || p.files.length > 96 ||
      p.files.some(f => !keys(f, 'path,realpath,sha256') || !hex(f.sha256)) || new Set(p.files.map(f => f.path)).size !== p.files.length ||
      !Array.isArray(p.outputs) || !p.outputs.length || p.outputs.length > 16 || new Set(p.outputs).size !== p.outputs.length) throw new Error('Invalid exact file lists');
  p.files.forEach(f => canonicalRelative(f.path));
  p.outputs.forEach(value => {
    canonicalRelative(value);
    if (!store.scopePath(value) || /^(?:data|raw|trajectories)(?:\/|$)/i.test(value)) throw new Error('Output in protected source tree');
    if (p.files.some(f => f.path === value || f.path.startsWith(value + '/') || value.startsWith(f.path + '/'))) throw new Error('Output aliases input');
  });
  if (dangerous.test(p.toolInput.command) || /(?:^|[\s/])(?:credentials?|secrets?)(?:\/|$)/i.test(p.toolInput.command)) throw new Error('Hard safety rule still applies');
  const visible = visibleArguments(p.toolInput.command, p);
  const permitDigest = sha(text);
  const receipt = path.join(store.root, `exact-input-used-${sha(p.id)}.json`);
  try { fs.lstatSync(receipt); throw new Error('Exact permit already consumed'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const interpreter = version(p.interpreter.path, 256 * 1024 ** 2);
  if (interpreter.sha256 !== p.interpreter.sha256) throw new Error('Interpreter version mismatch');
  const files = {};
  for (const item of p.files) {
    const lexical = path.join(store.cwd, item.path);
    if (typeof item.realpath !== 'string' || !path.isAbsolute(item.realpath) ||
        item.realpath.split(path.sep).some(part => reserved.test(part)) || fs.realpathSync(lexical) !== item.realpath)
      throw new Error('Exact input canonical path mismatch');
    // Only declared source files may traverse a human-reviewed source symlink.
    if (!/^(?:data|raw|trajectories)\//.test(item.path)) checkAncestors(lexical);
    files[item.path] = { realpath: item.realpath, ...version(item.realpath) };
    if (files[item.path].sha256 !== item.sha256 || fs.realpathSync(lexical) !== item.realpath)
      throw new Error('Exact input version mismatch');
  }
  return { permitDigest, permitId: p.id, toolName: event.toolName, inputDigest: sha(JSON.stringify(event.input)),
    interpreter, files, outputs: p.outputs.map(value => absent(store.cwd, value)), visible,
    boundary: 'Human reviewed exact invocation, pre-dispatch file versions and absent outputs only; scripts may have other behavior. No execution-time filesystem or network isolation.' };
}
export function consumeExactInput(store, state, event, snapshot, sessionId) {
  const latest = prepareExactInput(store, state, event);
  if (!latest || !equal(latest, snapshot)) throw new Error('Exact authorization changed before consumption');
  const receipt = path.join(store.root, `exact-input-used-${sha(latest.permitId)}.json`);
  const fd = fs.openSync(receipt, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ schema: 'mainline-exact-input-use.v1', sessionId, utc: new Date().toISOString(),
      permitId: latest.permitId, permitDigest: latest.permitDigest, toolName: latest.toolName, inputDigest: latest.inputDigest,
      consent: 'direct-human-ui', state: 'consumed-before-tool-dispatch-not-execution-proof' }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
