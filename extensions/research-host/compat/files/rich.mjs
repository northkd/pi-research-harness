import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { OFFICE_CAPS, createDefaultDocxPdfEngine, renderDocx, parseSheet, resolveRowLimit,
  EML_SIZE_CAP, loadParsedEml, toParseResult, loadPurify, repairAsciiDoc } from './rich-upstream.mjs';

const require = createRequire(import.meta.url);
let asciidoctor;
const COLUMN_WIDTH = /^\s*width:\s*[\d.]+%?;?\s*$/;

function keepColumnWidths(node, data) {
  if (data.attrName === 'style' && (!['col', 'colgroup'].includes(node.nodeName.toLowerCase()) || !COLUMN_WIDTH.test(data.attrValue))) data.keepAttr = false;
}

async function renderAsciiDoc(source) {
  asciidoctor ??= require('asciidoctor')();
  const { LoggerManager, MemoryLogger } = asciidoctor;
  const previous = LoggerManager.getLogger(), memory = MemoryLogger.create();
  LoggerManager.setLogger(memory);
  let html, warnings;
  try {
    html = String(asciidoctor.convert(source, { safe: 'secure', standalone: false, attributes: { showtitle: '' } }));
    warnings = memory.getMessages().map(message => {
      const line = message.getSourceLocation?.()?.getLineNumber?.();
      return { text: String(message.getText?.() ?? ''), line: typeof line === 'number' ? line : null };
    });
  } finally { LoggerManager.setLogger(previous); }
  const purify = await loadPurify();
  purify.addHook('uponSanitizeAttribute', keepColumnWidths);
  try {
    return { html: purify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'] }), warnings };
  } finally { purify.removeHook('uponSanitizeAttribute', keepColumnWidths); }
}

export function createRichFileCompatibility({ readScoped, reply, binary, query, fail, options = {} }) {
  const caps = { ...OFFICE_CAPS, ...options.officeCaps };
  const engine = options.docxPdfEngine ?? createDefaultDocxPdfEngine();
  const cacheDir = path.resolve(options.previewCacheDir ?? path.join(process.env.PI_RESEARCH_HOST_DIR || path.join(os.homedir(), '.pi', 'research-host'), 'document-previews'));
  const pdfJobs = new Map();
  const failure = error => ({ statusCode: 200, body: { success: false, error: String(error) }, headers: { 'Cache-Control': 'no-store, private' } });

  async function pdfFor(source) {
    const key = createHash('sha256').update(`${source.resolved}\0${source.stat.dev}\0${source.stat.ino}\0${source.stat.mtimeMs}\0${source.stat.ctimeMs}\0${source.stat.size}`).digest('hex');
    if (pdfJobs.has(key)) return pdfJobs.get(key);
    const job = (async () => {
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const directory = await fs.lstat(cacheDir);
      if (directory.isSymbolicLink() || await fs.realpath(cacheDir) !== cacheDir || directory.uid !== process.getuid()) fail(403, 'document-cache-invalid');
      await fs.chmod(cacheDir, 0o700);
      const output = path.join(cacheDir, key + '.pdf');
      try { await fs.lstat(output); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const temporaryDir = await fs.mkdtemp(path.join(cacheDir, key + '.pending-'));
        const temporary = path.join(temporaryDir, 'document.pdf');
        try {
          await engine.toPdf(source.resolved, temporary);
          await source.revalidate();
          const created = await fs.lstat(temporary);
          if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1) fail(409, 'document-render-invalid');
          await fs.chmod(temporary, 0o600);
          await fs.rename(temporary, output);
        } finally { await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {}); }
      }
      const handle = await fs.open(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024) fail(413, 'rendered-pdf-too-large');
        const bytes = await handle.readFile();
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail(409, 'document-render-invalid');
        await source.revalidate();
        return bytes;
      } finally { await handle.close(); }
    })().finally(() => { pdfJobs.delete(key); });
    pdfJobs.set(key, job);
    return job;
  }

  return async function handleRich(input) {
    const { pathname, url } = input;
    if (input.method !== 'GET') fail(405, 'file-method-not-allowed');
    if (pathname === '/api/file/sheet') {
      const params = query(url, ['cwd', 'path', 'limit']);
      const ext = path.extname(params.path ?? '').toLowerCase();
      if (!['.xlsx', '.csv'].includes(ext)) fail(400, 'renderer-not-supported-for-extension');
      const source = await readScoped(params, input, caps.sheetSizeCap);
      const result = await parseSheet(source.bytes, ext, { rowLimit: resolveRowLimit(params.limit === undefined ? undefined : Number(params.limit), caps), colCap: caps.colCap });
      await source.revalidate();
      if (!result.success) return failure(result.error);
      const { success: _, ...data } = result;
      return reply(data);
    }
    if (pathname === '/api/file/eml' || pathname === '/api/file/eml-attachment') {
      const attachment = pathname.endsWith('-attachment');
      const params = query(url, ['cwd', 'path', ...(attachment ? ['index'] : ['allowRemote'])]);
      if (path.extname(params.path ?? '').toLowerCase() !== '.eml') fail(400, 'renderer-not-supported-for-extension');
      const source = await readScoped(params, input, EML_SIZE_CAP);
      let parsed;
      try { parsed = await loadParsedEml(source.resolved, source.stat, source.bytes); }
      catch (error) { fail(400, error.message || 'failed-to-parse-eml'); }
      if (!attachment) {
        const data = await toParseResult(parsed, { allowRemote: params.allowRemote === '1' });
        await source.revalidate();
        return reply(data);
      }
      const index = Number(params.index);
      if (params.index === undefined || params.index === '' || !Number.isInteger(index) || index < 0) fail(400, 'invalid-attachment-index');
      const part = parsed.attachments?.[index];
      if (!part) fail(404, 'attachment-index-out-of-range');
      const name = (part.filename || `attachment-${index}`).replace(/["\r\n]/g, '');
      await source.revalidate();
      return binary(part.content, { 'Content-Type': part.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Security-Policy': "sandbox; default-src 'none'" });
    }
    const params = query(url, pathname === '/api/file/render' ? ['cwd', 'path', 'repair'] : ['cwd', 'path']);
    const ext = path.extname(params.path ?? '').toLowerCase();
    const pdf = pathname === '/api/file/rendered-pdf';
    if (!['.docx', '.pptx', ...(!pdf ? ['.adoc', '.asciidoc'] : [])].includes(ext)) fail(400, 'renderer-not-supported-for-extension');
    const maximum = ext === '.pptx' ? caps.pptxSizeCap : ext === '.docx' ? caps.docxSizeCap : 10 * 1024 * 1024;
    const source = await readScoped(params, input, maximum);
    if (ext === '.adoc' || ext === '.asciidoc') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
      const repaired = params.repair === '0' ? { source: text, repairs: [] } : repairAsciiDoc(text);
      const rendered = await renderAsciiDoc(repaired.source);
      await source.revalidate();
      return reply({ ...rendered, repairs: repaired.repairs, mtime: source.stat.mtimeMs });
    }
    if (pdf) {
      try { return binary(await pdfFor(source), { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Content-Security-Policy': "sandbox; default-src 'none'" }); }
      catch (error) { if (error.statusCode) throw error; fail(500, error.message || 'failed-to-render-pdf'); }
    }
    if (ext === '.pptx' || options.docxRenderMode !== 'html') {
      try { if (await engine.available()) { await pdfFor(source); return reply({ mode: 'pdf' }); } }
      catch (error) { if (ext === '.pptx') return failure(error.message); }
    }
    if (ext === '.pptx') return failure('presentation rendering requires the document engine');
    const result = await renderDocx(source.resolved, source.stat, { mode: 'html', engine, caps });
    await source.revalidate();
    if (!result.success) return failure(result.error);
    const { success: _, ...data } = result;
    return reply(data);
  };
}
