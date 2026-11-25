import path from 'node:path';
import { createQuestionStore } from './upstream/question-store.js';
import { createQuestionFileStore } from './upstream/question-files.js';
import { createBriefGenerator } from './upstream/brief-generator.js';
import { validateQuestionAnswer } from './upstream/prompt-answer.js';
import { QUESTION_CONTEXT_RECORD } from './native.mjs';
import { persistQuestionImages, validateQuestionImages, MAX_QUESTION_IMAGE_BYTES, MAX_QUESTION_ANSWER_BYTES, MAX_QUESTION_IMAGES, MAX_QUESTION_TEXT_BYTES } from './attachments.mjs';

export { createBriefModelResolver } from './upstream/brief-model.js';

const METHODS = new Set(['select', 'input', 'confirm', 'editor']);
const emptyEvents = { getMaxSeq: () => 0, getEventsEndingAt: () => [] };
const result = (statusCode, body) => ({ statusCode, body });
const failure = (code, error) => result(code, { success: false, error });
const keyOf = (sessionId, promptId) => sessionId + '\0' + promptId;

/** The host router must authenticate first and supply its session authorization policy. */
export function createQuestionRuntime(options) {
  if (!path.isAbsolute(options.dataDir || '') || typeof options.authorizeSession !== 'function' || typeof options.deliverUiResponse !== 'function') {
    throw new Error('question-host-hooks-required');
  }
  const requests = new Map();
  const contexts = new Map();
  const contextRequests = new Map();
  const bindings = new Map();
  const diskFiles = createQuestionFileStore({ dir: path.join(options.dataDir, 'questions') });
  for (const file of diskFiles.loadAll()) {
    if (file.nativeBinding?.transport === 'question-native') bindings.set(keyOf(file.sessionId, file.promptId), file.nativeBinding);
  }
  const files = { ...diskFiles, write(file) {
    const binding = bindings.get(keyOf(file.sessionId, file.promptId));
    return diskFiles.write({ ...file, ...(binding ? { nativeBinding: binding } : {}) });
  } };
  const briefs = options.briefs || createBriefGenerator(options.briefProvider || {
    resolveModel: async () => ({ ok: false, reason: 'question-brief-provider-not-configured' }),
    complete: async () => { throw new Error('question-brief-provider-not-configured'); },
  });
  const store = createQuestionStore({
    files,
    eventStore: options.eventStore || emptyEvents,
    describeSession: options.describeSession || (() => undefined),
    briefs,
    config: () => options.getConfig?.().questions || { autoBrief: true, minBriefChars: 240 },
    ...(options.now ? { now: options.now } : {}),
  });
  store.loadPersisted();
  const unsubscribe = store.onChange(change => options.onChanged?.(change));

  function track(sessionId, event) {
    if (typeof event.id !== 'string' || !METHODS.has(event.method)) return;
    const key = keyOf(sessionId, event.id);
    const pending = contexts.get(sessionId);
    if (pending?.acceptsImages && pending.title === event.title && event.method === 'input' && event.id !== pending.contextId) {
      const ownKey = keyOf(sessionId, pending.contextId);
      const own = requests.get(ownKey);
      if (own) {
        own.nativeRequestId = event.id;
        const binding = { transport: 'question-native', acceptsImages: true, nativeRequestId: event.id };
        bindings.set(ownKey, binding);
        const file = diskFiles.loadAll().find(file => file.sessionId === sessionId && file.promptId === pending.contextId);
        if (file) files.write(file);
        return store.get(store.listRows().find(row => store.get(row.id)?.promptId === pending.contextId && row.sessionId === sessionId)?.id);
      }
    }
    requests.set(key, { ...event });
    if (event.transport === 'question-native') bindings.set(key, { transport: event.transport, acceptsImages: event.acceptsImages === true, ...(event.nativeRequestId ? { nativeRequestId: event.nativeRequestId } : {}) });
    const metadata = event.metadata || (pending?.title === event.title && pending?.method === event.method
      ? { message: pending.message } : {});
    if (pending?.contextId && pending?.title === event.title && pending?.method === event.method) contextRequests.set(pending.contextId, key);
    return store.onTracked(sessionId, { promptId: event.id, prompt: { type: event.method, question: event.title || '', ...(event.options ? { options: event.options } : {}), metadata } });
  }

  function remove(sessionId, promptId, reason) {
    requests.delete(keyOf(sessionId, promptId));
    bindings.delete(keyOf(sessionId, promptId));
    return store.removeQuestion(sessionId, promptId, reason);
  }

  async function onNativeEvent(sessionId, event) {
    if (event?.eventType && !event.type) event = { ...event.data, type: event.eventType, data: event.data };
    const entry = event.type === 'entry_appended' ? event.entry : null;
    const context = entry?.customType === QUESTION_CONTEXT_RECORD ? entry.data : event.type === QUESTION_CONTEXT_RECORD ? event.data : null;
    if (context?.phase === 'pending') {
      contexts.set(sessionId, context);
      if (['external-native', 'question-native'].includes(context.transport)) {
        const prior = [...requests].find(([key, request]) => key.startsWith(sessionId + '\0') && request.id !== context.contextId && request.method === context.method && request.title === context.title && !request.transport);
        const nativeRequestId = prior?.[1].id || bindings.get(keyOf(sessionId, context.contextId))?.nativeRequestId;
        if (prior) remove(sessionId, prior[1].id, 'native-question-rebound');
        track(sessionId, { type: 'extension_ui_request', id: context.contextId, method: context.method, title: context.title, options: context.options, transport: context.transport, acceptsImages: context.acceptsImages === true, ...(nativeRequestId ? { nativeRequestId } : {}), metadata: { message: context.message } });
      }
    }
    if (context?.phase === 'resolved') {
      const key = contextRequests.get(context.contextId);
      contextRequests.delete(context.contextId);
      if (contexts.get(sessionId)?.contextId === context.contextId) contexts.delete(sessionId);
      const request = key && requests.get(key);
      if (request) {
        // A timeout/abort in native Pi resolves its dialog promise without an
        // RPC close event. Clear the keeper's exact pending ID as well.
        if (request.nativeRequestId || !['external-native', 'question-native'].includes(request.transport)) {
          try { await options.deliverUiResponse(sessionId, { type: 'extension_ui_response', id: request.nativeRequestId || request.id, cancelled: true }, { transport: 'native-rpc' }); }
          catch { /* Reconciliation retries only still-pending native identities. */ }
        }
        remove(sessionId, request.id, 'native-dialog-resolved');
      }
    }
    if (event.type === 'extension_ui_request') return track(sessionId, event);
    if (event.type === 'extension_ui_resolved') {
      const alias = [...requests].find(([key, request]) => key.startsWith(sessionId + '\0') && request.nativeRequestId === event.id);
      if (alias) {
        const request = alias[1];
        if (event.reason === 'timeout') {
          try { await options.deliverUiResponse(sessionId, { type: 'extension_ui_response', id: request.id, cancelled: true }, { transport: 'question-native' }); } catch {}
        }
        return remove(sessionId, request.id, event.reason || 'resolved');
      }
      return remove(sessionId, event.id, event.reason || 'resolved');
    }
    if (['session_host_ended', 'session_ended'].includes(event.type)) onSessionEnded(sessionId);
  }

  function reconcile(sessionId, pendingUIRequests = []) {
    const pending = pendingUIRequests.filter(event => METHODS.has(event.method)).map(event => {
      const binding = [...bindings].find(([key, binding]) => key.startsWith(sessionId + '\0') && binding.nativeRequestId === event.id);
      return binding ? { ...event, id: binding[0].slice(sessionId.length + 1), nativeRequestId: event.id, transport: 'question-native', acceptsImages: true } : event;
    });
    const external = [...requests].filter(([key, request]) => key.startsWith(sessionId + '\0') && ['external-native', 'question-native'].includes(request.transport)).map(([, request]) => request.id);
    for (const key of bindings.keys()) if (key.startsWith(sessionId + '\0')) external.push(key.slice(sessionId.length + 1));
    store.reconcileSession(sessionId, [...pending.map(event => event.id), ...external]);
    const keep = new Set([...pending.map(event => event.id), ...external].map(id => keyOf(sessionId, id)));
    for (const key of requests.keys()) if (key.startsWith(sessionId + '\0') && !keep.has(key)) requests.delete(key);
    for (const event of pending) track(sessionId, event);
  }

  async function transmit(record, response) {
    const claim = store.claim(record.id);
    if (claim.status !== 'claimed') return failure(claim.status === 'answered' ? 409 : 404, claim.status === 'answered' ? 'answered' : 'question not found');
    try {
      const request = requests.get(keyOf(record.sessionId, record.promptId));
      const delivered = await options.deliverUiResponse(record.sessionId, response, { transport: request?.transport || 'native-rpc' });
      if (!(delivered === true || delivered?.accepted === true)) {
        store.releaseClaim(record.id);
        return failure(503, 'question-answer-unconfirmed');
      }
      store.markTransmitted(record.id);
      return result(200, { success: true, data: { transmitted: true } });
    } catch {
      store.releaseClaim(record.id);
      return failure(503, 'question-answer-unconfirmed');
    }
  }

  async function open(id, context, write) {
    const found = store.lookup(id);
    if (found.state === 'unknown') return { error: failure(404, 'question not found') };
    const sessionId = found.state === 'answered' ? found.sessionId : found.record.sessionId;
    if (!await options.authorizeSession(sessionId, context, write)) return { error: failure(404, 'question not found') };
    if (found.state === 'answered') return { error: failure(write ? 409 : 404, write ? 'answered' : 'question not found') };
    return { record: found.record };
  }

  async function handle({ method, pathname, body, context }) {
    if (pathname === '/api/questions' && method === 'GET') {
      const rows = store.listRows();
      const visible = await Promise.all(rows.map(row => options.authorizeSession(row.sessionId, context, false)));
      return result(200, { success: true, data: rows.filter((_row, index) => visible[index]) });
    }
    const match = /^\/api\/questions\/([A-Za-z0-9_-]{22})(?:\/(answer|summarize))?$/.exec(pathname);
    if (!match) return null;
    const [, id, action] = match;
    if (!(method === 'GET' && !action || method === 'POST' && action)) return failure(405, 'method-not-allowed');
    const found = await open(id, context, method === 'POST');
    if (found.error) return found.error;
    const record = found.record;
    if (method === 'GET') {
      const request = requests.get(keyOf(record.sessionId, record.promptId));
      return result(200, { success: true, data: { ...store.getDetail(id), ...(request?.acceptsImages ? { acceptsImages: true, maxImageBytes: MAX_QUESTION_IMAGE_BYTES, maxImagesBytes: MAX_QUESTION_ANSWER_BYTES, maxImages: MAX_QUESTION_IMAGES } : {}), ...(request?.nativeRequestId ? { nativeRequestId: request.nativeRequestId } : {}) } });
    }
    if (action === 'summarize') {
      const output = await store.summarize(id);
      return output.ok ? result(200, { success: true, data: output.detail })
        : result({ 'not-found': 404, 'already-generated': 409, unavailable: 503, failed: 502 }[output.reason], { success: false, error: output.error, reason: output.reason });
    }
    const answer = body?.answer;
    const cancelled = body?.cancelled;
    if ((answer !== undefined) === (cancelled !== undefined) || answer !== undefined && typeof answer !== 'string' || cancelled !== undefined && cancelled !== true) {
      return failure(400, 'send exactly one of `answer` or `cancelled: true`');
    }
    if (typeof answer === 'string' && Buffer.byteLength(answer) > MAX_QUESTION_TEXT_BYTES) return failure(413, 'question-answer-too-large');
    if (record.origin === 'file') return failure(403, 'file-access prompts are answered on the access approval surface');
    if (answer !== undefined) {
      const valid = validateQuestionAnswer(record, answer);
      if (!valid.ok) return failure(400, valid.reason);
    }
    let attachments;
    if (body?.images !== undefined) {
      const request = requests.get(keyOf(record.sessionId, record.promptId));
      if (cancelled || !request?.acceptsImages || record.type !== 'input') return failure(400, 'question-images-not-allowed');
      try {
        validateQuestionImages(body.images);
        attachments = persistQuestionImages({ rootDir: options.dataDir, sessionId: record.sessionId, promptId: record.promptId, images: body.images });
      } catch (error) { return failure(400, error.code || 'question-images-invalid'); }
    }
    const response = { type: 'extension_ui_response', id: record.promptId, ...(cancelled ? { cancelled: true }
      : record.type === 'confirm' ? { confirmed: answer === 'true' } : { value: answer }), ...(attachments?.length ? { attachments } : {}) };
    return transmit(record, response);
  }

  /** Route direct native UI answers through the same synchronous claim latch. */
  async function respondNative(sessionId, response, context) {
    if (!await options.authorizeSession(sessionId, context, true)) return failure(404, 'question not found');
    const alias = [...requests].find(([key, request]) => key.startsWith(sessionId + '\0') && request.nativeRequestId === response.id);
    const promptId = alias?.[1].id || response.id;
    const record = store.listRows().map(row => store.get(row.id)).find(item => item.sessionId === sessionId && item.promptId === promptId);
    if (!record) return failure(409, 'question-not-pending');
    if (response.type !== 'extension_ui_response') return failure(400, 'native-ui-response-invalid');
    const answer = record.type === 'confirm' ? typeof response.confirmed === 'boolean' ? String(response.confirmed) : undefined : response.value;
    if (response.cancelled !== true) {
      if (typeof answer !== 'string') return failure(400, 'native-ui-response-invalid');
      if (Buffer.byteLength(answer) > MAX_QUESTION_TEXT_BYTES) return failure(413, 'question-answer-too-large');
      const valid = validateQuestionAnswer(record, answer);
      if (!valid.ok) return failure(400, valid.reason);
    }
    if (response.images !== undefined || response.attachments !== undefined) return failure(400, 'question-images-use-answer-route');
    return transmit(record, { ...response, id: promptId });
  }

  function onSessionEnded(sessionId) {
    store.removeQuestionsForSession(sessionId, 'session-ended');
    for (const key of requests.keys()) if (key.startsWith(sessionId + '\0')) requests.delete(key);
    for (const key of bindings.keys()) if (key.startsWith(sessionId + '\0')) bindings.delete(key);
    for (const [contextId, key] of contextRequests) if (key.startsWith(sessionId + '\0')) contextRequests.delete(contextId);
    contexts.delete(sessionId);
  }
  return { handle, onNativeEvent, reconcile, respondNative, onSessionEnded, store, briefs, dispose: unsubscribe };
}
