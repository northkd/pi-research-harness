import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchReceiptHandler, isResearchDispatchReceiptId } from '../research-dispatch-receipts.mjs';
const id = 'research-message-message-' + 'a'.repeat(48);
const text = `[research_communication receipt ${id}] Request from child.`;
test('formal communication receipts deduplicate across bridge restart and ack after native acceptance', async () => {
  let launches = 0; const history = [], acks = [];
  const options = { getSessionId: () => 'parent', readHistory: () => history,
    handle: async message => { launches++; assert.equal(acks.length, 0); history.push({ message: { role: 'user', content: message.text } }); },
    sendAck: value => acks.push(value) };
  const message = { type: 'send_prompt', sessionId: 'parent', promptId: id, text };
  await createResearchReceiptHandler(options)(message);
  await createResearchReceiptHandler(options)(message);
  assert.equal(launches, 1); assert.equal(acks.length, 2);
  assert.equal(isResearchDispatchReceiptId(id), true);
});
test('failed native prompt acceptance does not acknowledge delivery', async () => {
  let acknowledged = 0;
  const handler = createResearchReceiptHandler({ getSessionId: () => 'parent', readHistory: () => [],
    handle: async () => ({ type: 'error' }), sendAck: () => { acknowledged++; } });
  await handler({ type: 'send_prompt', sessionId: 'parent', promptId: id, text });
  assert.equal(acknowledged, 0);
});
