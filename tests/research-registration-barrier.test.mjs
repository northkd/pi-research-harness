import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchRegistrationBarrier } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-registration-barrier.mjs';

test('initial research prompt waits for membership and duplicate register cannot race it', async () => {
  const barrier = createResearchRegistrationBarrier();
  let release, joined = false, delivered = 0;
  const membership = new Promise(resolve => { release = resolve; });
  const association = barrier.register('child', async () => { await membership; joined = true; });
  const deliver = () => { assert.equal(joined, true); delivered++; };
  const first = barrier.deliver('child', deliver), duplicate = barrier.deliver('child', deliver);
  await Promise.resolve(); assert.equal(delivered, 0);
  release(); await association;
  assert.deepEqual(await Promise.all([first, duplicate]), [true, false]);
  assert.equal(delivered, 1);
});

test('provisional and failed research association retain the unconsumed prompt', async () => {
  const barrier = createResearchRegistrationBarrier();
  let consumed = false;
  assert.equal(await barrier.deliver('provisional', () => { consumed = true; }, { deferred: true }), false);
  const failed = barrier.register('child', async () => { throw new Error('membership denied'); });
  await assert.rejects(failed, /membership denied/);
  assert.equal(await barrier.deliver('child', () => { consumed = true; }), false);
  assert.equal(await barrier.deliver('child', () => { consumed = true; }), false);
  assert.equal(consumed, false);
  barrier.clear('child');
  assert.equal(await barrier.deliver('child', () => { consumed = true; }), false, 'failed research must not become ordinary after unregister');
  assert.equal(consumed, false);
  await barrier.register('child', async () => {});
  assert.equal(await barrier.deliver('child', () => { consumed = true; }), true);
  assert.equal(consumed, true);
});

test('unregister or a newer association cannot release a stale first prompt', async () => {
  const barrier = createResearchRegistrationBarrier();
  let release, delivered = false;
  const pending = new Promise(resolve => { release = resolve; });
  barrier.register('old', () => pending);
  const attempt = barrier.deliver('old', () => { delivered = true; });
  barrier.clear('old'); release();
  assert.equal(await attempt, false); assert.equal(delivered, false);
  let finishOld;
  barrier.register('same-id', () => new Promise(resolve => { finishOld = resolve; }));
  const stale = barrier.deliver('same-id', () => { delivered = true; });
  await Promise.resolve();
  await barrier.register('same-id', async () => {});
  finishOld();
  assert.equal(await stale, false); assert.equal(delivered, false);
});

test('non-research initial prompt keeps the existing synchronous delivery order', async () => {
  const barrier = createResearchRegistrationBarrier(), events = [];
  const sent = barrier.deliver('ordinary', () => events.push('prompt'));
  events.push('next-registration-step');
  assert.deepEqual(events, ['prompt', 'next-registration-step']);
  assert.equal(await sent, true);
});
