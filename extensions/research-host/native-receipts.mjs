import { createHash } from 'node:crypto';

const ENTRY = 'pi-research-native-prompt-receipt';
const digest = content => createHash('sha256').update(JSON.stringify(content)).digest('hex');
const digestContent = (text, images = []) => digest({
  text, images: images.map(image => [image.mimeType, image.data]),
});

function messageDigest(message) {
  if (message?.role !== 'user') return undefined;
  if (typeof message.content === 'string') return digestContent(message.content);
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
  const images = message.content.filter(part => part?.type === 'image');
  return digestContent(text, images);
}

/** The native Extension API send method is void. Acknowledge only after Pi
 * projects the exact user message into its branch or emits message_start. */
export function createNativePromptReceipts(pi, ctx, acknowledge) {
  const sessionId = ctx.sessionManager.getSessionId();
  let pending;

  async function accepted(receipt) {
    if (ctx.sessionManager.getSessionId() !== sessionId) return false;
    if (receipt.status !== 'accepted') {
      receipt.status = 'accepted';
      pi.appendEntry(ENTRY, { ...receipt });
    }
    await acknowledge(sessionId, receipt.promptId);
    if (pending?.promptId === receipt.promptId) pending = undefined;
    return true;
  }

  function observe(message) {
    if (!pending || messageDigest(message) !== pending.contentHash) return;
    void accepted(pending).catch(() => {});
  }

  async function deliver(message) {
    if (ctx.sessionManager.getSessionId() !== sessionId || typeof message?.promptId !== 'string' || typeof message.text !== 'string') return false;
    const contentHash = digestContent(message.text, message.images);
    const branch = ctx.sessionManager.getBranch().slice(-1024);
    let receiptIndex = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
      if (branch[index]?.type === 'custom' && branch[index].customType === ENTRY &&
          branch[index].data?.promptId === message.promptId) { receiptIndex = index; break; }
    }
    if (receiptIndex >= 0) {
      const record = branch[receiptIndex].data;
      if (record.contentHash !== contentHash) throw new Error('native-prompt-id-conflict');
      if (record.status === 'accepted') return accepted({ ...record });
      if (branch.slice(receiptIndex + 1).some(entry => messageDigest(entry?.message) === contentHash)) {
        return accepted({ ...record });
      }
      pending ??= { ...record };
      return false;
    }
    if (pending) return false;
    pending = { sessionId, promptId: message.promptId, contentHash, status: 'submitted' };
    pi.appendEntry(ENTRY, { ...pending });
    const content = message.images?.length
      ? [{ type: 'text', text: message.text }, ...message.images]
      : message.text;
    pi.sendUserMessage(content, ctx.isIdle() ? undefined : { deliverAs: message.delivery === 'followUp' ? 'followUp' : 'steer' });
    return false;
  }

  return { deliver, observe };
}
