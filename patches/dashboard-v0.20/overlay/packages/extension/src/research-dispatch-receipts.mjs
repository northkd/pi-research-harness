/** Idempotent hand-off of durable dispatcher wakeups. Native prompt history is
 * consulted on bridge restart; socket retries reuse the same bounded receipt id. */
export const isResearchDispatchReceiptId = value => typeof value === 'string' && /^research-dispatch-receipt-dispatch-[a-f0-9]{40}$/.test(value);
const textOf = entry => {
  const message = entry?.message ?? entry;
  if (message?.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '';
};
export function createResearchReceiptHandler(options) {
  const delivered = new Set(), pending = new Map();
  return async message => {
    const id = message?.promptId, sessionId = options.getSessionId();
    const marker = `[research_dispatch receipt ${id}]`;
    if (message?.type !== 'send_prompt' || !isResearchDispatchReceiptId(id) || message.sessionId !== sessionId || !message.text?.startsWith(marker)) return options.handle(message);
    const key = `${sessionId}:${id}`;
    const acknowledge = () => options.sendAck({ type: 'prompt_received', sessionId, promptId: id, fresh: false });
    let inHistory = false;
    try { inHistory = (options.readHistory?.() ?? []).slice(-512).some(entry => textOf(entry).startsWith(marker)); } catch { /* the in-process reservation still deduplicates */ }
    if (delivered.has(key) || inHistory) { acknowledge(); return; }
    if (pending.has(key)) { await pending.get(key); if (delivered.has(key)) acknowledge(); return; }
    const handoff = (async () => {
      const result = await options.handle(message);
      if (!result || !/error|failed/.test(result.type ?? '')) {
        if (delivered.size >= 512) delivered.delete(delivered.values().next().value);
        delivered.add(key);
        // Emit only AFTER the native handler accepted the prompt, not its
        // speculative pre-send streaming acknowledgement.
        acknowledge();
      }
      return result;
    })();
    pending.set(key, handoff);
    try { return await handoff; } finally { pending.delete(key); }
  };
}
