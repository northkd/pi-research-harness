import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const SESSION_CONTEXT_SECTION = 'dashboard_session';
export const CONTEXT_DELIMITER = '── pi-dashboard session context ──';

export function sanitizeChangeName(value) {
  return typeof value === 'string' ? value.replace(/[`\r\n\u0000-\u001f\u007f]/g, '').trim() : '';
}

export function buildSessionContext(sessionId, cwd, attachedChange) {
  const lines = [CONTEXT_DELIMITER, `You are pi session \`${sessionId}\` running in \`${cwd}\`.`];
  const change = sanitizeChangeName(attachedChange);
  if (change) lines.push(`Attached OpenSpec change: \`${change}\`. See \`openspec/changes/${change}/{proposal,design,tasks}.md\`.`);
  return lines.join('\n');
}

export function readNativeSessionContext(ctx) {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const header = ctx.sessionManager.getHeader?.();
  if (!sessionId || !sessionFile || header && (header.id !== sessionId || header.cwd !== ctx.cwd)) throw new Error('native-session-context-identity-mismatch');
  const metaFile = sessionFile.replace(/\.jsonl$/, '.meta.json');
  let meta = {};
  let descriptor;
  try {
    descriptor = fs.openSync(metaFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > 256 * 1024 || info.uid !== process.getuid?.() || fs.realpathSync(metaFile) !== metaFile) throw new Error('native-session-context-unsafe');
    meta = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.id !== undefined && meta.id !== sessionId || meta.cwd !== undefined && meta.cwd !== ctx.cwd) throw new Error('native-session-context-identity-mismatch');
  const attachedChange = typeof meta.attachedProposal === 'string' ? meta.attachedProposal : null;
  const fragment = buildSessionContext(sessionId, ctx.cwd, attachedChange);
  return { sessionId, cwd: ctx.cwd, attachedChange, fragment, fragmentHash: createHash('sha256').update(fragment).digest('hex') };
}

/** Structured sections let later native prompt contributors compose normally. */
export function registerSessionContextInjector(pi, { onInjected = () => {} } = {}) {
  pi.on('before_agent_start', (event, ctx) => {
    if (!event?.systemPromptOptions || typeof event.systemPromptOptions !== 'object') return;
    const context = readNativeSessionContext(ctx);
    event.systemPromptOptions.sections ??= {};
    event.systemPromptOptions.sections[SESSION_CONTEXT_SECTION] = context.fragment;
    onInjected(context, ctx);
  });
}
