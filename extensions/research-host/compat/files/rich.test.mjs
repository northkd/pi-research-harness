import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createFileCompatibility } from './index.mjs';
import { createDefaultDocxPdfEngine } from './rich-upstream.mjs';

const require = createRequire(import.meta.url);

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-viewers-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const row = { id: 'session-test', cwd };
  const principal = Object.freeze({ iss: 'local', sub: 'operator' });
  let conversions = 0;
  const engine = { available: async () => false, toPdf: async () => { conversions++; throw new Error('unexpected converter call'); } };
  const handle = createFileCompatibility({ home: root, previewCacheDir: path.join(root, 'previews'),
    workbench: { async accessFor(requested) { assert.equal(requested, cwd); return { cwd, revalidate: async () => {}, canReadHistory: async () => true }; } },
    sessions: { getSession: id => id === row.id ? row : null, listSessions: () => [row] }, localOperatorPrincipal: principal,
    docxPdfEngine: engine, ...overrides });
  const request = async (route, file, extra = {}) => {
    const url = new URL('/api/file/' + route, 'http://127.0.0.1');
    url.searchParams.set('cwd', cwd); url.searchParams.set('path', file);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return handle({ method: 'GET', pathname: url.pathname, url, request: { headers: {} } });
  };
  return { root, cwd, request, conversions: () => conversions };
}

async function docxBytes() {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Word 文档</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('CSV viewer returns actual structured rows, original encoding and row truncation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'table.csv'), '\ufeffname,value\n中文,1\nsecond,2\nthird,3\n');
  const result = await f.request('sheet', 'table.csv', { limit: '1' });
  assert.equal(result.statusCode, 200); assert.equal(result.body.success, true);
  const sheet = result.body.data.sheets[0];
  assert.deepEqual(sheet.header, ['name', 'value']);
  assert.deepEqual(sheet.rows, [['中文', '1']]);
  assert.equal(sheet.totalRows, 3); assert.equal(sheet.truncated, true);
});

test('XLSX viewer reads actual worksheets through the installed SheetJS implementation', async t => {
  const f = await fixture(t), XLSX = require('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['element', 'value'], ['Na', 23]]), 'first');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['material'], ['synthetic']]), 'second');
  await fs.writeFile(path.join(f.cwd, 'table.xlsx'), XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const result = await f.request('sheet', 'table.xlsx');
  assert.equal(result.body.success, true);
  assert.deepEqual(result.body.data.sheets.map(sheet => sheet.name), ['first', 'second']);
  assert.deepEqual(result.body.data.sheets[0].rows, [['Na', '23']]);
});

test('EML viewer sanitizes remote HTML and serves an exact attachment as a download', async t => {
  const f = await fixture(t);
  const mail = [
    'From: Sender <sender@example.invalid>', 'To: Reader <reader@example.invalid>', 'Subject: Synthetic report',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="synthetic-boundary"', '',
    '--synthetic-boundary', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Hello</p><script>alert(1)</script><img src="https://example.invalid/tracker.png">',
    '--synthetic-boundary', 'Content-Type: text/plain; name="report.txt"', 'Content-Disposition: attachment; filename="report.txt"',
    'Content-Transfer-Encoding: base64', '', Buffer.from('exact attachment 中文').toString('base64'),
    '--synthetic-boundary--', '',
  ].join('\r\n');
  await fs.writeFile(path.join(f.cwd, 'mail.eml'), mail);
  const result = await f.request('eml', 'mail.eml');
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.headers.subject, 'Synthetic report');
  assert.equal(result.body.data.hasRemote, true);
  assert.ok(!result.body.data.html.includes('<script'));
  assert.ok(!/\ssrc="https:/.test(result.body.data.html));
  assert.equal(result.body.data.attachments[0].filename, 'report.txt');
  const attachment = await f.request('eml-attachment', 'mail.eml', { index: '0' });
  assert.equal(attachment.body.toString(), 'exact attachment 中文');
  assert.ok(attachment.headers['Content-Disposition'].startsWith('attachment;'));
  assert.equal((await f.request('eml-attachment', 'mail.eml', { index: '2' })).statusCode, 404);
});

test('AsciiDoc uses secure conversion with sanitization and never includes an outside local file', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.adoc');
  await fs.writeFile(outside, 'SHOULD_NOT_RENDER');
  await fs.writeFile(path.join(f.cwd, 'note.adoc'), '= Synthetic title\n\n*bold*\n\ninclude::' + outside + '[]\n\n++++\n<script>alert(1)</script><p>Safe HTML</p>\n++++\n');
  const result = await f.request('render', 'note.adoc');
  assert.equal(result.statusCode, 200); assert.equal(result.body.success, true);
  assert.ok(result.body.data.html.includes('Synthetic title'));
  assert.ok(result.body.data.html.includes('<strong>bold</strong>'));
  assert.ok(!result.body.data.html.includes('SHOULD_NOT_RENDER'));
  assert.ok(!result.body.data.html.includes('<script'));
  assert.equal(typeof result.body.data.mtime, 'number');
});

test('DOCX renders real local HTML when the production document image is unavailable', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'note.docx'), await docxBytes());
  const result = await f.request('render', 'note.docx');
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.mode, 'html');
  assert.ok(result.body.data.html.includes('Synthetic Word 文档'));
  assert.equal(f.conversions(), 0);
});

test('PPTX keeps the original explicit no-engine result without inventing a PDF', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'slides.pptx'), 'synthetic pending presentation');
  const result = await f.request('render', 'slides.pptx');
  assert.equal(result.statusCode, 200); assert.equal(result.body.success, false);
  assert.equal(result.body.error, 'presentation rendering requires the document engine');
  assert.equal(f.conversions(), 0);
});

test('PDF render route uses the real converter seam, safe cache and original PDF response', async t => {
  let conversions = 0;
  const engine = { available: async () => true, async toPdf(source, output) {
    assert.ok(source.endsWith('.docx'));
    conversions++;
    await fs.writeFile(output, '%PDF-1.4\nSynthetic fixture\n%%EOF\n');
  } };
  const f = await fixture(t, { docxPdfEngine: engine });
  await fs.writeFile(path.join(f.cwd, 'note.docx'), await docxBytes());
  const result = await f.request('render', 'note.docx');
  assert.deepEqual(result.body.data, { mode: 'pdf' });
  const pdf = await f.request('rendered-pdf', 'note.docx');
  assert.equal(pdf.statusCode, 200); assert.ok(pdf.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.equal(conversions, 1);
});

test('structured viewers reject unsupported types, traversal and over-cap inputs before parsing', async t => {
  const f = await fixture(t, { officeCaps: { sheetSizeCap: 3 } });
  await fs.writeFile(path.join(f.cwd, 'table.csv'), 'a,b\n1,2\n');
  assert.equal((await f.request('sheet', 'table.csv')).statusCode, 413);
  assert.equal((await f.request('sheet', 'note.txt')).statusCode, 400);
  assert.equal((await f.request('eml', '../outside.eml')).statusCode, 403);
});

test('PDF and EML cache keys detect a same-size rewrite with the original mtime restored', async t => {
  let conversions = 0;
  const engine = { available: async () => true, async toPdf(source, output) {
    conversions++;
    await fs.writeFile(output, '%PDF-1.4\n' + await fs.readFile(source, 'utf8') + '\n%%EOF\n');
  } };
  const f = await fixture(t, { docxPdfEngine: engine });
  const word = path.join(f.cwd, 'note.docx'), mail = path.join(f.cwd, 'mail.eml');
  const timestamp = new Date('2020-01-01T00:00:00.000Z');
  await fs.writeFile(word, 'first'); await fs.utimes(word, timestamp, timestamp);
  assert.ok((await f.request('rendered-pdf', 'note.docx')).body.includes(Buffer.from('first')));
  await fs.writeFile(word, 'later'); await fs.utimes(word, timestamp, timestamp);
  assert.ok((await f.request('rendered-pdf', 'note.docx')).body.includes(Buffer.from('later')));
  assert.equal(conversions, 2);
  await fs.writeFile(mail, 'Subject: First\r\n\r\nBody'); await fs.utimes(mail, timestamp, timestamp);
  assert.equal((await f.request('eml', 'mail.eml')).body.data.headers.subject, 'First');
  await fs.writeFile(mail, 'Subject: Later\r\n\r\nBody'); await fs.utimes(mail, timestamp, timestamp);
  assert.equal((await f.request('eml', 'mail.eml')).body.data.headers.subject, 'Later');
  assert.ok((await fs.readdir(path.join(f.root, 'previews'))).every(name => name.endsWith('.pdf')));
});

test('default document facade admits the private output directory and passes no API keys to Docker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-document-facade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'source'), outputDirectory = path.join(root, 'private-cache');
  await fs.mkdir(sourceDirectory); await fs.mkdir(outputDirectory);
  const source = path.join(sourceDirectory, 'input.docx'), output = path.join(outputDirectory, 'output.pdf');
  await fs.writeFile(source, 'synthetic');
  let runs = 0;
  const engine = createDefaultDocxPdfEngine({ image: 'synthetic-local-engine', async runner(argv, stdin) {
    runs++;
    assert.ok(argv.includes(`${sourceDirectory}:${sourceDirectory}:ro`));
    assert.ok(argv.includes(`${outputDirectory}:${outputDirectory}`));
    assert.ok(!argv.includes('-e'));
    const request = JSON.parse(stdin);
    assert.equal(request.command, 'renderPdf');
    assert.equal(request.input, source); assert.equal(request.output, output);
    await fs.writeFile(output, '%PDF-1.4\nSynthetic facade\n%%EOF\n');
    return { stdout: JSON.stringify({ ok: true, output }), stderr: '', exitCode: 0 };
  } });
  await engine.toPdf(source, output);
  assert.equal(runs, 1);
  assert.ok((await fs.readFile(output)).subarray(0, 5).equals(Buffer.from('%PDF-')));
});
