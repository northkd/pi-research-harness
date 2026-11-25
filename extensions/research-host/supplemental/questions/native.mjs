import { randomUUID, createHash } from 'node:crypto';
import { registerAskUserTool } from './upstream/ask-user.js';
import { hasOwnOtherOption } from './upstream/prompt-answer.js';
import { persistQuestionImages, loadQuestionAttachments, readQuestionImagePath, readRunningPiClipboardImage, validateQuestionImages, MAX_QUESTION_ANSWER_BYTES, MAX_QUESTION_IMAGES, MAX_QUESTION_TEXT_BYTES } from './attachments.mjs';

export const QUESTION_CONTEXT_RECORD = 'pi-research-question-context';
export const QUESTION_RESPONSE_EVENT = 'research-host:question-response';
export const QUESTION_RESPONSE_RECORD = 'pi-research-question-response';

function uniqueLabel(label, existing) {
  while (existing.includes(label)) label += ' ';
  return label;
}

function previousResponse(ctx, eventId) {
  const manager = ctx.sessionManager;
  const matches = entry => entry?.type === 'custom' && entry.customType === QUESTION_RESPONSE_RECORD && entry.data?.eventId === eventId;
  if (manager.getLeafEntry && manager.getEntry) {
    let entry = manager.getLeafEntry();
    while (entry) {
      if (matches(entry)) return entry;
      entry = entry.parentId ? manager.getEntry(entry.parentId) : null;
    }
    return;
  }
  return (manager.getBranch?.() || []).findLast(matches);
}

/** Preserve the legacy ask_user schema and results, using real native Pi dialogs. */
export function registerNativeQuestionTools(pi, options = {}) {
  const pendingRemote = new Map();
  let definition;
  registerAskUserTool({ registerTool(tool) { definition = tool; } });
  const tool = {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await options.getConfig?.(ctx) || {};
      const seconds = typeof config.askUserPromptTimeoutSeconds === 'number' ? config.askUserPromptTimeoutSeconds : 300;
      const timeout = seconds > 0 ? seconds * 1000 : undefined;
      const deadline = timeout ? Date.now() + timeout : undefined;
      const ui = ctx.ui;
      const rootDir = options.dataDir || config.stateDir || process.env.PI_RESEARCH_HOST_DIR;
      const resultImages = new Map();
      const reservedImages = new Map();
      function reserveImages(loaded) {
        const candidate = new Map(reservedImages);
        for (const image of loaded) candidate.set(image.attachment.hash, image.attachment.bytes);
        if (candidate.size > MAX_QUESTION_IMAGES || [...candidate.values()].reduce((sum, bytes) => sum + bytes, 0) > MAX_QUESTION_ANSWER_BYTES) {
          throw new Error('question-images-too-large');
        }
        for (const [key, bytes] of candidate) reservedImages.set(key, bytes);
      }
      if (!ui || !['select', 'input', 'confirm'].every(method => typeof ui[method] === 'function')) {
        throw new Error('native-question-ui-unavailable');
      }

      async function invoke(method, title, value, metadata = {}) {
        if (signal?.aborted || deadline && Date.now() >= deadline) return method === 'confirm' ? false : undefined;
        const contextId = randomUUID();
        const controller = new AbortController();
        const nativeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let remote;
        let resolveRemote;
        let imageTimer;
        const acceptsImages = metadata.acceptsImages === true;
        const transport = acceptsImages ? 'question-native' : options.remoteDialogs ? 'external-native' : undefined;
        if (transport) {
          remote = new Promise(resolve => { resolveRemote = resolve; });
          pendingRemote.set(contextId, { sessionId: ctx.sessionManager.getSessionId(), method, options: method === 'select' ? value : undefined, resolve: resolveRemote, published: false, acceptsImages, rootDir, reserveImages });
        }
        const data = { contextId, toolCallId, phase: 'pending', method, title, ...(metadata.message ? { message: metadata.message } : {}),
          ...(transport ? { transport, ...(acceptsImages ? { acceptsImages: true } : {}), ...(method === 'select' ? { options: value } : method === 'confirm' ? { message: value } : { placeholder: value }) } : {}) };
        if (remote) pendingRemote.get(contextId).context = data;
        pi.appendEntry?.(QUESTION_CONTEXT_RECORD, data);
        try {
          if (options.publishContext) {
            await options.publishContext(data, ctx);
            if (remote && pendingRemote.has(contextId)) pendingRemote.get(contextId).published = true;
          }
        }
        catch (error) { options.onDiagnostic?.(error); }
        try {
          const opts = { signal: nativeSignal, ...(deadline ? { timeout: Math.max(1, deadline - Date.now()) } : {}) };
          const presented = acceptsImages ? options.remoteDialogs === false ? new Promise(resolve => {
            nativeSignal.addEventListener('abort', () => resolve(undefined), { once: true });
            if (opts.timeout) imageTimer = setTimeout(() => resolve(undefined), opts.timeout);
          }) : presentImageInput(title, value, opts) : ui[method](title, value, opts);
          if (!remote) return await presented;
          const selected = await Promise.race([presented.then(answer => ({ local: true, answer })), remote.then(response => ({ local: false, response }))]);
          if (!acceptsImages) return selected.local ? selected.answer : selected.response.cancelled ? method === 'confirm' ? false : undefined : method === 'confirm' ? selected.response.confirmed : selected.response.value;
          if (selected.local && selected.answer === undefined || !selected.local && selected.response.cancelled) return undefined;
          const answer = selected.local ? selected.answer : selected.response.value;
          const text = typeof answer === 'string' ? answer : answer.value;
          const attachments = selected.local ? answer.images?.length ? persistQuestionImages({ rootDir, sessionId: ctx.sessionManager.getSessionId(), promptId: contextId, images: answer.images }) : [] : selected.response.attachments || [];
          const loaded = selected.local ? attachments.length ? loadQuestionAttachments({ rootDir, sessionId: ctx.sessionManager.getSessionId(), promptId: contextId, attachments }) : [] : selected.response.verifiedImages || [];
          if (selected.local) {
            reserveImages(loaded);
            if (typeof pi.appendEntry !== 'function') throw new Error('native-question-durability-unavailable');
            pi.appendEntry(QUESTION_RESPONSE_RECORD, { eventId: 'local-' + contextId, status: 'accepted', response: { type: 'extension_ui_response', id: contextId, value: text, ...(attachments.length ? { attachments } : {}) } });
          }
          for (const image of loaded) resultImages.set(image.attachment.hash, image.content);
          return loaded.length ? { value: text, attachments: loaded.map(image => image.attachment) } : text;
        } finally {
          pendingRemote.delete(contextId);
          if (imageTimer) clearTimeout(imageTimer);
          controller.abort();
          const closed = { contextId, toolCallId, phase: 'resolved', method, title, ...(transport ? { transport } : {}) };
          pi.appendEntry?.(QUESTION_CONTEXT_RECORD, closed);
          try { await options.publishContext?.(closed, ctx); }
          catch (error) { options.onDiagnostic?.(error); }
        }
      }

      async function presentImageInput(title, placeholder, opts) {
        const images = [];
        for (;;) {
          if (opts.signal.aborted || deadline && Date.now() >= deadline) return undefined;
          const answer = await ui.input(title + (images.length ? ` (${images.length} images attached)` : ''), placeholder || 'Text, @image relative/path.png, or @clipboard', { ...opts, ...(deadline ? { timeout: Math.max(1, deadline - Date.now()) } : {}) });
          if (answer === undefined) return undefined;
          if (typeof answer !== 'string') throw new Error('native-question-input-invalid');
          if (Buffer.byteLength(answer) > MAX_QUESTION_TEXT_BYTES) { ui.notify?.('question-answer-too-large', 'warning'); continue; }
          const selectedPath = /^@image\s+(.+)$/s.exec(answer.trim());
          if (selectedPath || answer.trim() === '@clipboard') {
            try {
              const image = selectedPath ? readQuestionImagePath(selectedPath[1].trim(), ctx.cwd)
                : await (options.readClipboardImage || readRunningPiClipboardImage)();
              if (!image) throw new Error('question-clipboard-image-unavailable');
              validateQuestionImages([...images, image]);
              images.push(image);
            } catch (error) { ui.notify?.(error.code || error.message || 'question-image-unavailable', 'warning'); }
            continue;
          }
          return images.length ? { value: answer, images } : answer;
        }
      }

      const native = {
        ...ui,
        confirm: (title, message) => invoke('confirm', title, message, { message }),
        input: (title, placeholder, extra) => invoke('input', title, placeholder, extra),
        inputWithImages: (title, placeholder, extra) => invoke('input', title, placeholder, { ...extra, acceptsImages: true }),
        async select(title, values, extra = {}) {
          const allowOther = extra.allowOther === true && !hasOwnOtherOption(values);
          const other = uniqueLabel('Other (write an answer)', values);
          const result = await invoke('select', title, allowOther ? [...values, other] : values, extra);
          if (!allowOther || result !== other) return result;
          const custom = await invoke('input', title + ' — custom answer', '', extra);
          return typeof custom === 'string' ? custom.trim() || undefined : undefined;
        },
        async multiselect(title, values, extra = {}) {
          const selected = new Set();
          let custom;
          const labels = values.map(value => '[ ] ' + value);
          const done = uniqueLabel('Done', labels);
          const all = uniqueLabel('Select all', [...labels, done]);
          const other = uniqueLabel('Other (write an answer)', [...labels, done, all]);
          for (;;) {
            const displayed = values.map(value => `[${selected.has(value) ? 'x' : ' '}] ${value}`);
            const choices = [...displayed, all, ...(extra.allowOther === true && !hasOwnOtherOption(values) ? [other] : []), done];
            const answer = await invoke('select', title, choices, extra);
            if (answer === undefined) return undefined;
            if (answer === done) return [...values.filter(value => selected.has(value)), ...(custom ? [custom] : [])];
            if (answer === all) { for (const value of values) selected.add(value); continue; }
            if (answer === other) { custom = (await invoke('input', title + ' — custom answer', custom || '', extra))?.trim(); continue; }
            const index = displayed.indexOf(answer);
            if (index < 0) throw new Error('native-question-option-invalid');
            const value = values[index];
            if (selected.has(value)) selected.delete(value); else selected.add(value);
          }
        },
        async batch(_title, questions, extra = {}) {
          const answers = [];
          for (const question of questions) {
            if (signal?.aborted || deadline && Date.now() >= deadline) return undefined;
            const metadata = { ...extra, ...question, message: question.message || extra.message };
            if (question.method === 'confirm') answers.push({ confirmed: await native.confirm(question.title, metadata.message || '') });
            else if (question.method === 'multiselect') {
              const values = await native.multiselect(question.title, question.options, metadata);
              if (values === undefined) return undefined;
              answers.push({ values });
            } else if (question.method === 'select' || question.method === 'input') {
              const value = question.method === 'select' ? await native.select(question.title, question.options, metadata)
                : await native.inputWithImages(question.title, question.placeholder, metadata);
              if (value === undefined) return undefined;
              answers.push({ value });
            } else throw new Error('native-question-method-unsupported');
          }
          return answers;
        },
      };
      const result = await definition.execute(toolCallId, params, signal, onUpdate, { ...ctx, ui: native });
      return resultImages.size && !result.details?.cancelled ? { ...result, content: [...result.content, ...resultImages.values()] } : result;
    },
  };
  let registered = false;
  const register = () => { if (!registered) { pi.registerTool(tool); registered = true; } };
  pi.on('session_start', register);
  async function consumeEvent(event, ctx) {
    if (event?.eventType !== QUESTION_RESPONSE_EVENT) return null;
    const sessionId = ctx.sessionManager.getSessionId();
    const data = event.data;
    const response = data?.response;
    if (typeof event.eventId !== 'string' || data?.sessionId !== sessionId || response?.type !== 'extension_ui_response' || typeof response.id !== 'string') {
      return { status: 'rejected', reason: 'native-question-response-invalid' };
    }
    const signature = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const prior = previousResponse(ctx, event.eventId);
    if (prior) return prior.data.signature === signature ? { status: prior.data.status, duplicate: true, ...(prior.data.reason ? { reason: prior.data.reason } : {}) }
      : { status: 'rejected', reason: 'native-question-response-conflict' };
    const pending = pendingRemote.get(response.id);
    let reason;
    let verifiedImages = [];
    if (!pending || pending.sessionId !== sessionId) reason = 'native-question-not-pending';
    else if (response.images !== undefined) reason = 'native-question-use-attachment-receipts';
    else if (typeof response.value === 'string' && Buffer.byteLength(response.value) > MAX_QUESTION_TEXT_BYTES) reason = 'question-answer-too-large';
    else if (response.cancelled !== true && (pending.method === 'confirm' ? typeof response.confirmed !== 'boolean'
      : typeof response.value !== 'string' || pending.method === 'select' && !pending.options.includes(response.value))) reason = 'native-question-response-invalid';
    if (!reason && response.attachments !== undefined) {
      if (!pending.acceptsImages || response.cancelled) reason = 'native-question-attachments-not-allowed';
      else try {
        verifiedImages = loadQuestionAttachments({ rootDir: pending.rootDir, sessionId, promptId: response.id, attachments: response.attachments });
        pending.reserveImages(verifiedImages);
      }
      catch (error) { reason = error.code || 'native-question-attachment-invalid'; }
    }
    const status = reason ? 'rejected' : 'accepted';
    if (typeof pi.appendEntry !== 'function') return { status: 'rejected', reason: 'native-question-durability-unavailable' };
    pi.appendEntry(QUESTION_RESPONSE_RECORD, { eventId: event.eventId, signature, status, ...(reason ? { reason } : {}), ...(status === 'accepted' ? { response } : {}) });
    if (!reason) pending.resolve({ ...response, verifiedImages });
    return { status, ...(reason ? { reason } : {}) };
  }
  async function publishPending(ctx, { force = true } = {}) {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const pending of pendingRemote.values()) {
      if (pending.sessionId !== sessionId || !force && pending.published || !options.publishContext) continue;
      await options.publishContext(pending.context, ctx);
      pending.published = true;
    }
  }
  return { tool, register, consumeEvent, publishPending };
}

export default registerNativeQuestionTools;
