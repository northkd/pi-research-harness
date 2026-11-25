import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createQuestionRuntime } from './index.mjs';
import { registerNativeQuestionTools, QUESTION_CONTEXT_RECORD, QUESTION_RESPONSE_EVENT, QUESTION_RESPONSE_RECORD } from './native.mjs';
import { validateQuestionImages, persistQuestionImages, loadQuestionAttachments, readQuestionImagePath, MAX_QUESTION_IMAGE_BYTES } from './attachments.mjs';

const PNG = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('question images enforce MIME, canonical base64, content signature, dimensions and byte limits before persistence', async () => {
  assert.equal(validateQuestionImages([PNG])[0].data, PNG.data);
  assert.throws(() => validateQuestionImages([{ ...PNG, mimeType: 'image/jpeg' }]), /format-invalid/);
  assert.throws(() => validateQuestionImages([{ mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }]), /type-invalid/);
  assert.throws(() => validateQuestionImages([{ ...PNG, data: PNG.data + '\n' }]), /base64-invalid/);
  assert.throws(() => validateQuestionImages([{ ...PNG, data: Buffer.alloc(MAX_QUESTION_IMAGE_BYTES + 1).toString('base64') }]), /base64-invalid|too-large/);
  const enormous = Buffer.from(PNG.data, 'base64'); enormous.writeUInt32BE(20000, 16);
  assert.throws(() => validateQuestionImages([{ ...PNG, data: enormous.toString('base64') }]), /format-invalid/);
});

test('attachment receipts are private, content addressed, prompt scoped and reject changed bytes or links', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-receipts-'));
  try {
    const input = { rootDir, sessionId: 'synthetic-session', promptId: 'synthetic-prompt', images: [PNG] };
    const attachments = persistQuestionImages(input);
    assert.deepEqual(persistQuestionImages(input), attachments);
    const loaded = loadQuestionAttachments({ ...input, attachments });
    assert.equal(loaded[0].content.data, PNG.data);
    assert.equal((await fs.stat(loaded[0].attachment.path)).mode & 0o777, 0o600);
    assert.throws(() => loadQuestionAttachments({ ...input, promptId: 'other-prompt', attachments }), /scope-invalid|ENOENT/);
    await fs.writeFile(loaded[0].attachment.path, 'synthetic changed bytes');
    assert.throws(() => loadQuestionAttachments({ ...input, attachments }), /hash-conflict/);
    await fs.unlink(loaded[0].attachment.path);
    await fs.symlink('/dev/null', loaded[0].attachment.path);
    assert.throws(() => loadQuestionAttachments({ ...input, attachments }), /ELOOP|unsafe/);
  } finally { await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('a browser image answer survives question-host restart, emits real model image blocks and has replayable native acceptance', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-browser-images-'));
  const history = [];
  const pending = new Map();
  const sessionId = 'synthetic-browser-session';
  const ctx = { cwd: rootDir, sessionManager: { getSessionId: () => sessionId, getBranch: () => history } };
  let runtime, native, lastEvent;
  const config = { stateDir: rootDir, askUserPromptTimeoutSeconds: -1, questions: { autoBrief: false, minBriefChars: 240 } };
  const options = { dataDir: rootDir, authorizeSession: (_id, operator) => operator === 'synthetic-owner', getConfig: () => config,
    deliverUiResponse: async (_id, response, metadata) => {
      if (metadata.transport === 'question-native') {
        lastEvent = { eventType: QUESTION_RESPONSE_EVENT, eventId: randomUUID(), data: { sessionId, response } };
        const outcome = await native.consumeEvent(lastEvent, ctx);
        return { accepted: outcome.status === 'accepted' };
      }
      pending.get(response.id)?.resolve(undefined); pending.delete(response.id);
      await runtime.onNativeEvent(sessionId, { type: 'extension_ui_resolved', id: response.id });
      return { accepted: true };
    } };
  runtime = createQuestionRuntime(options);
  native = registerNativeQuestionTools({ on() {}, registerTool() {}, appendEntry(customType, data) {
    const entry = { type: 'custom', customType, data }; history.push(entry);
    if (customType === QUESTION_CONTEXT_RECORD) void runtime.onNativeEvent(sessionId, { type: 'entry_appended', entry });
  } }, { getConfig: () => config, remoteDialogs: false, publishContext: data => runtime.onNativeEvent(sessionId, { type: QUESTION_CONTEXT_RECORD, data }) });
  ctx.ui = { select() {}, confirm() {}, input(title) {
    const event = { type: 'extension_ui_request', id: randomUUID(), method: 'input', title };
    return new Promise(resolve => { pending.set(event.id, { resolve, event }); void runtime.onNativeEvent(sessionId, event); });
  } };
  try {
    const result = native.tool.execute('synthetic-image-tool', { method: 'input', title: 'Describe this synthetic image' }, undefined, undefined, ctx);
    await tick();
    const id = runtime.store.listRows()[0].id;
    assert.equal(runtime.store.listRows().length, 1);
    runtime.dispose(); runtime = createQuestionRuntime(options);
    runtime.reconcile(sessionId, [...pending.values()].map(item => item.event));
    await native.publishPending(ctx, { force: true });
    assert.equal(runtime.store.listRows()[0].id, id);
    const request = { method: 'POST', pathname: `/api/questions/${id}/answer`, context: 'synthetic-owner' };
    const detail = await runtime.handle({ ...request, method: 'GET', pathname: `/api/questions/${id}` });
    assert.equal(detail.body.data.acceptsImages, true);
    assert.equal(pending.size, 0);
    assert.equal(detail.body.data.nativeRequestId, undefined);
    assert.equal((await runtime.handle({ ...request, context: 'stranger', body: { answer: '', images: [PNG] } })).statusCode, 404);
    assert.equal((await runtime.handle({ ...request, body: { answer: '', images: [{ ...PNG, mimeType: 'image/jpeg' }] } })).statusCode, 400);
    const accepted = await runtime.handle({ ...request, body: { answer: 'Synthetic visual evidence', images: [PNG] } });
    assert.equal(accepted.body.data.transmitted, true);
    const output = await result;
    assert.equal(output.details.result.value, 'Synthetic visual evidence');
    assert.equal(output.details.result.attachments.length, 1);
    assert.deepEqual(output.content.find(item => item.type === 'image'), PNG);
    assert.equal((await fs.readFile(output.details.result.attachments[0].path)).toString('base64'), PNG.data);
    const acceptedEntry = history.find(entry => entry.customType === QUESTION_RESPONSE_RECORD && entry.data.status === 'accepted');
    assert.equal(acceptedEntry.data.response.attachments[0].sessionId, sessionId);
    assert.equal(JSON.stringify(acceptedEntry.data).includes(PNG.data), false);
    assert.deepEqual(await native.consumeEvent(lastEvent, ctx), { status: 'accepted', duplicate: true });
    assert.equal(runtime.store.listRows().length, 0);
  } finally { runtime.dispose(); await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('interactive CLI image paths and explicit clipboard input yield persisted model-visible images inside the session scope', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-cli-images-'));
  const cwd = path.join(rootDir, 'project'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'synthetic.png'), Buffer.from(PNG.data, 'base64'));
  await fs.writeFile(path.join(rootDir, 'outside.png'), Buffer.from(PNG.data, 'base64'));
  const history = [];
  const warnings = [];
  const answers = ['@image ../outside.png', '@image synthetic.png', '@clipboard', 'Synthetic CLI image answer'];
  const native = registerNativeQuestionTools({ on() {}, registerTool() {}, appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); } }, {
    dataDir: rootDir, remoteDialogs: true, getConfig: () => ({ askUserPromptTimeoutSeconds: -1 }), readClipboardImage: async () => PNG,
  });
  try {
    assert.throws(() => readQuestionImagePath('../outside.png', cwd), /outside-cwd/);
    const output = await native.tool.execute('synthetic-cli-tool', { method: 'batch', questions: [{ method: 'input', title: 'Synthetic images' }], title: 'Synthetic batch' }, undefined, undefined,
      { cwd, sessionManager: { getSessionId: () => 'synthetic-cli-session', getBranch: () => history }, ui: { select() {}, confirm() {}, input: async () => answers.shift(), notify: message => warnings.push(message) } });
    assert.equal(output.content.filter(block => block.type === 'image').length, 1);
    assert.equal(output.content.find(block => block.type === 'image').data, PNG.data);
    assert.equal(output.details.results[0].value, 'Synthetic CLI image answer');
    assert.equal(output.details.results[0].attachments.length, 2);
    assert.ok(warnings.includes('question-image-path-outside-cwd'));
    assert.ok(history.some(entry => entry.customType === QUESTION_RESPONSE_RECORD && entry.data.eventId.startsWith('local-') && entry.data.response.attachments.length === 2));
  } finally { await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('concurrent same-title image questions preserve exact native prompt and tool-call scope', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-question-image-scope-'));
  const history = [];
  const sessionId = 'synthetic-parallel-session';
  const ctx = { cwd: rootDir, sessionManager: { getSessionId: () => sessionId, getBranch: () => history }, ui: { select() {}, confirm() {}, input() { throw new Error('managed image questions must use their own transport'); } } };
  const config = { stateDir: rootDir, askUserPromptTimeoutSeconds: -1, questions: { autoBrief: false, minBriefChars: 240 } };
  let native;
  const runtime = createQuestionRuntime({ dataDir: rootDir, authorizeSession: () => true, getConfig: () => config,
    deliverUiResponse: async (_sessionId, response, metadata) => {
      assert.equal(metadata.transport, 'question-native');
      const out = await native.consumeEvent({ eventId: randomUUID(), eventType: QUESTION_RESPONSE_EVENT, data: { sessionId, response } }, ctx);
      return { accepted: out.status === 'accepted' };
    } });
  native = registerNativeQuestionTools({ on() {}, registerTool() {}, appendEntry(customType, data) {
    const entry = { type: 'custom', customType, data }; history.push(entry);
    if (customType === QUESTION_CONTEXT_RECORD) void runtime.onNativeEvent(sessionId, { type: 'entry_appended', entry });
  } }, { getConfig: () => config, remoteDialogs: false });
  try {
    const first = native.tool.execute('scope-first', { method: 'input', title: 'Identical synthetic title' }, undefined, undefined, ctx);
    const second = native.tool.execute('scope-second', { method: 'input', title: 'Identical synthetic title' }, undefined, undefined, ctx);
    await tick();
    assert.equal(runtime.store.listRows().length, 2);
    for (const [toolCallId, text] of [['scope-first', 'Answer for first'], ['scope-second', 'Answer for second']]) {
      const promptId = history.find(entry => entry.customType === QUESTION_CONTEXT_RECORD && entry.data.phase === 'pending' && entry.data.toolCallId === toolCallId).data.contextId;
      const row = runtime.store.listRows().find(row => runtime.store.get(row.id).promptId === promptId);
      const response = await runtime.handle({ method: 'POST', pathname: `/api/questions/${row.id}/answer`, body: { answer: text, images: [PNG] } });
      assert.equal(response.statusCode, 200);
    }
    assert.equal((await first).details.result.value, 'Answer for first');
    assert.equal((await second).details.result.value, 'Answer for second');
    const receipts = history.filter(entry => entry.customType === QUESTION_RESPONSE_RECORD && entry.data.status === 'accepted');
    assert.equal(new Set(receipts.map(entry => entry.data.response.attachments[0].promptId)).size, 2);
  } finally { runtime.dispose(); await fs.rm(rootDir, { recursive: true, force: true }); }
});
