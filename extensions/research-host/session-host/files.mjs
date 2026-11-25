import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function privateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('session-host-directory-unsafe');
  if (info.uid !== process.getuid?.()) fail('session-host-owner-invalid');
  fs.chmodSync(directory, 0o700);
  return directory;
}

export function readJson(file, maximum = 512 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || info.uid !== process.getuid?.()) fail('session-host-file-unsafe');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(value)) fail('session-host-record-invalid');
  return value;
}

export function maybeJson(file, maximum) {
  try { return readJson(file, maximum); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export function atomicJson(file, value) {
  privateDir(path.dirname(file));
  const previous = (() => { try { return fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } })();
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) fail('session-host-file-unsafe');
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID());
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function writeExclusiveJson(file, value) {
  privateDir(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (rest[0] === 'Z') return undefined;
    return { pid, startTime: rest[19] };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error; }
}

export function sameProcess(identity) {
  return !!identity && processIdentity(identity.pid)?.startTime === identity.startTime;
}

export function sessionHeader(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(file) !== file) fail('session-host-history-unsafe');
  const fd = fs.openSync(file, 'r');
  let text;
  try { const bytes = Buffer.alloc(32 * 1024); const count = fs.readSync(fd, bytes); text = bytes.subarray(0, count).toString('utf8').split('\n', 1)[0]; }
  finally { fs.closeSync(fd); }
  const header = JSON.parse(text);
  if (header.type !== 'session' || !SESSION_ID.test(header.id ?? '') || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) fail('session-host-history-identity-invalid');
  return header;
}

export const metaPath = sessionFile => sessionFile.slice(0, -6) + '.meta.json';

export function nativeHistoryHasPrompt(file, text, images) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) fail('session-host-history-unsafe');
  const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(64 * 1024), decoder = new StringDecoder('utf8');
  let pending = '', position = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, bytes, 0, bytes.length, position);
      if (!count) return false;
      position += count; pending += decoder.write(bytes.subarray(0, count));
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        const record = JSON.parse(line), message = record.message;
        if (message?.role !== 'user') continue;
        const content = typeof message.content === 'string' ? message.content
          : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
        const actualImages = Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : [];
        if (content === text && JSON.stringify(actualImages) === JSON.stringify(images ?? [])) return true;
      }
      if (pending.length > 64 * 1024 * 1024) fail('session-history-record-too-large');
    }
  } finally { fs.closeSync(fd); }
}
