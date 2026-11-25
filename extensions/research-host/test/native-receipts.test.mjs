import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativePromptReceipts } from '../native-receipts.mjs';

test('a void native API does not prove delivery and a reload does not duplicate a submitted prompt', async () => {
  const branch = [], acks = [], calls = [];
  const ctx = { isIdle: () => false, sessionManager: { getBranch: () => branch, getSessionId: () => 'parent' } };
  const pi = {
    appendEntry(customType, data) { branch.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendUserMessage(...args) { calls.push(args); },
  };
  const pushAck = async (...args) => { acks.push(args); };
  const prompt = { promptId: 'native-request', text: 'Synthetic queued task receipt', delivery: 'followUp' };
  const first = createNativePromptReceipts(pi, ctx, pushAck);
  assert.equal(await first.deliver(prompt), false);
  assert.equal(acks.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].deliverAs, 'followUp');
  const restarted = createNativePromptReceipts(pi, ctx, pushAck);
  assert.equal(await restarted.deliver(prompt), false);
  assert.equal(calls.length, 1);
  branch.push({ type: 'message', message: { role: 'user', content: prompt.text } });
  assert.equal(await restarted.deliver(prompt), true);
  assert.deepEqual(acks, [['parent', prompt.promptId]]);
  assert.equal(calls.length, 1);
  await assert.rejects(restarted.deliver({ ...prompt, text: 'Different text' }), /native-prompt-id-conflict/);
});
