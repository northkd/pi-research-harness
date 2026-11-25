import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MAX_QUESTION_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_QUESTION_ANSWER_BYTES = 20 * 1024 * 1024;
export const MAX_QUESTION_IMAGES = 16;
export const MAX_QUESTION_TEXT_BYTES = 128 * 1024;
export const QUESTION_IMAGE_HTTP_BYTES = Math.ceil(MAX_QUESTION_ANSWER_BYTES * 4 / 3) + 256 * 1024;
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function dimensions(bytes, mime) {
  let width, height;
  if (mime === 'image/png' && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/gif' && bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 0x3b) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (mime === 'image/jpeg' && bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = (bits >>> 14 & 0x3fff) + 1; }
  }
  if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40_000_000)) fail('question-image-format-invalid');
}

export function validateQuestionImages(images) {
  if (!Array.isArray(images) || images.length > MAX_QUESTION_IMAGES) fail('question-images-invalid');
  let total = 0;
  return images.map(image => {
    if (!image || !EXTENSIONS[image.mimeType] || typeof image.data !== 'string') fail('question-image-type-invalid');
    const data = image.data;
    if (!data.length || data.length > Math.ceil(MAX_QUESTION_IMAGE_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('question-image-base64-invalid');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_QUESTION_IMAGE_BYTES || (total += bytes.length) > MAX_QUESTION_ANSWER_BYTES) fail('question-images-too-large');
    if (bytes.toString('base64') !== data) fail('question-image-base64-invalid');
    dimensions(bytes, image.mimeType);
    return { type: 'image', data, mimeType: image.mimeType };
  });
}

function directory(rootDir, sessionId, promptId, create = false) {
  if (!path.isAbsolute(rootDir || '') || fs.realpathSync(rootDir) !== rootDir || !identifier(sessionId) || !identifier(promptId)) fail('question-attachment-scope-invalid');
  let current = rootDir;
  for (const name of ['question-attachments', sessionId, promptId]) {
    current = path.join(current, name);
    if (create) try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) fail('question-attachment-directory-unsafe');
  }
  return current;
}

function readFile(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > maximum || info.mode & 0o077) fail('question-attachment-file-unsafe');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function persistQuestionImages({ rootDir, sessionId, promptId, images }) {
  const valid = validateQuestionImages(images);
  const target = directory(rootDir, sessionId, promptId, true);
  return valid.map(image => {
    const bytes = Buffer.from(image.data, 'base64');
    const sha256 = hash(bytes);
    const file = path.join(target, sha256 + EXTENSIONS[image.mimeType]);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (hash(readFile(file, MAX_QUESTION_IMAGE_BYTES)) !== sha256) fail('question-attachment-hash-conflict');
    return { version: 1, sessionId, promptId, sha256, mimeType: image.mimeType, bytes: bytes.length };
  });
}

export function loadQuestionAttachments({ rootDir, sessionId, promptId, attachments }) {
  if (!Array.isArray(attachments) || attachments.length > MAX_QUESTION_IMAGES) fail('question-attachments-invalid');
  const target = directory(rootDir, sessionId, promptId);
  let total = 0;
  return attachments.map(attachment => {
    if (!attachment || attachment.version !== 1 || attachment.sessionId !== sessionId || attachment.promptId !== promptId || !/^[a-f0-9]{64}$/.test(attachment.sha256 || '') || !EXTENSIONS[attachment.mimeType]
      || !Number.isSafeInteger(attachment.bytes) || attachment.bytes <= 0 || attachment.bytes > MAX_QUESTION_IMAGE_BYTES || (total += attachment.bytes) > MAX_QUESTION_ANSWER_BYTES) fail('question-attachment-scope-invalid');
    const file = path.join(target, attachment.sha256 + EXTENSIONS[attachment.mimeType]);
    const bytes = readFile(file, MAX_QUESTION_IMAGE_BYTES);
    if (bytes.length !== attachment.bytes || hash(bytes) !== attachment.sha256) fail('question-attachment-hash-conflict');
    dimensions(bytes, attachment.mimeType);
    return { content: { type: 'image', data: bytes.toString('base64'), mimeType: attachment.mimeType }, attachment: { path: file, mimeType: attachment.mimeType, bytes: bytes.length, hash: attachment.sha256 } };
  });
}

/** CLI paths are explicit user selections and remain inside the session cwd. */
export function readQuestionImagePath(value, cwd) {
  const root = fs.realpathSync(cwd);
  const file = path.resolve(root, value);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || fs.realpathSync(file) !== file) fail('question-image-path-outside-cwd');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_QUESTION_IMAGE_BYTES) fail('question-image-path-invalid');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_QUESTION_IMAGE_BYTES || fs.realpathSync(file) !== file) fail('question-image-path-invalid');
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  const mimeType = Object.keys(EXTENSIONS).find(mime => { try { dimensions(bytes, mime); return true; } catch { return false; } });
  if (!mimeType) fail('question-image-format-invalid');
  return validateQuestionImages([{ mimeType, data: bytes.toString('base64') }])[0];
}

/** Resolve only the running Pi installation; no HOME/package/provider discovery. */
export async function readRunningPiClipboardImage() {
  let current;
  try { current = path.dirname(fs.realpathSync(process.argv[1])); } catch { return null; }
  while (current !== path.dirname(current)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        const { readClipboardImage } = await import(pathToFileURL(path.join(current, 'dist/utils/clipboard-image.js')));
        const image = await readClipboardImage();
        return image ? validateQuestionImages([{ mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') }])[0] : null;
      }
    } catch {}
    current = path.dirname(current);
  }
  return null;
}
