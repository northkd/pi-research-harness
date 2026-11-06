import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGenerationTiming, SPEED_TIMING_CUSTOM_TYPE } from '../patches/dashboard-v0.20/overlay/packages/extension/src/generation-timing.ts';

function fixture() {
  let clock = 0, active = true;
  const handlers = new Map(), persisted = [];
  const pi = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
  const tracker = registerGenerationTiming(pi, { now: () => clock, isActive: () => active });
  const message = (timestamp = 1000, model = 'test-model') => ({ role: 'assistant', timestamp, provider: 'test-provider', model, content: [], usage: { output: 500 }, stopReason: 'stop' });
  return {
    handlers, persisted, tracker, message,
    at(time) { clock = time; },
    deactivate() { active = false; },
    emit(name, event = {}) { return handlers.get(name)?.(event); },
    start(m) { handlers.get('message_start')?.({ message: m }); },
    delta(m, type = 'text_delta', delta = 'x') { handlers.get('message_update')?.({ message: m, assistantMessageEvent: { type, delta } }); },
    end(m, id = 'entry-1') {
      handlers.get('message_end')?.({ message: m });
      tracker.afterAppend(m, id, (kind, data) => persisted.push({ kind, data }));
    },
  };
}

test('source timing separates eight seconds before first output from two seconds of generation', () => {
  const f = fixture(), m = f.message();
  // Timing must not inspect the request payload at all.
  f.at(100); f.emit('before_provider_request', {
    get payload() { throw new Error('timing must not read request payload'); },
  });
  f.at(1000); f.start({ ...m });
  f.at(8100); f.delta({ ...m });
  f.at(10100); f.end(m);
  assert.deepEqual(f.persisted, [{ kind: SPEED_TIMING_CUSTOM_TYPE, data: {
    version: 1, source: 'pi-stream', messageEntryId: 'entry-1', messageTimestamp: 1000,
    provider: 'test-provider', model: 'test-model', requestDurationMs: 10000,
    firstTokenMs: 8000, generationDurationMs: 2000, firstOutputKind: 'text',
  } }]);
  assert.doesNotMatch(JSON.stringify(f.persisted), /payload|apiKey/);
});

test('start, empty deltas, metadata and usage-only updates are not first output', () => {
  const f = fixture(), m = f.message();
  f.emit('before_provider_request'); f.start(m);
  for (const type of ['start', 'text_start', 'thinking_start', 'done', 'usage', 'ping']) {
    f.at(100); f.delta(m, type, 'metadata');
  }
  f.at(200); f.delta(m, 'text_delta', '');
  f.at(300); f.delta(m, 'thinking_delta', 'reasoning');
  f.at(2000); f.end(m);
  assert.equal(f.persisted[0].data.firstTokenMs, 300);
  assert.equal(f.persisted[0].data.firstOutputKind, 'thinking');
  assert.equal(f.persisted[0].data.generationDurationMs, 1700);
});

test('tool-call argument output and a nonempty function name count as output', () => {
  for (const first of ['toolcall_delta', 'toolcall_start']) {
    const f = fixture(), m = f.message();
    f.emit('before_provider_request'); f.start(m); f.at(500);
    if (first === 'toolcall_delta') f.delta(m, first, '{');
    else f.emit('message_update', { message: m, assistantMessageEvent: {
      type: first, contentIndex: 0, partial: { content: [{ type: 'toolCall', name: 'read', arguments: {} }] },
    } });
    f.at(800); f.end(m);
    assert.equal(f.persisted[0].data.firstTokenMs, 500);
    assert.equal(f.persisted[0].data.firstOutputKind, 'toolcall');
  }
});

test('wall-clock changes and delayed append do not change the captured interval', () => {
  const f = fixture(), m = f.message(9_999_999_999);
  f.at(10); f.emit('before_provider_request'); f.start(m);
  f.at(1010); f.delta(m); f.at(3010); f.emit('message_end', { message: m });
  f.at(90000);
  f.tracker.afterAppend(m, 'late-log-write', (kind, data) => f.persisted.push({ kind, data }));
  assert.equal(f.persisted[0].data.requestDurationMs, 3000);
  assert.equal(f.persisted[0].data.generationDurationMs, 2000);
  assert.equal(f.persisted[0].data.messageEntryId, 'late-log-write');
});

test('metadata requires a captured in-process ticket and the exact persisted identity, and is consumed only once', () => {
  const f = fixture(), m = f.message();
  f.emit('before_provider_request'); f.start(m); f.at(100); f.delta(m);
  const unrelated = { ...m };
  f.at(500); f.emit('message_end', { message: m });
  f.tracker.afterAppend(unrelated, 'unrelated', (kind, data) => f.persisted.push({ kind, data }));
  f.tracker.afterAppend(JSON.parse(JSON.stringify(m)), 'replayed', (kind, data) => f.persisted.push({ kind, data }));
  assert.equal(f.persisted.length, 0);
  f.tracker.afterAppend(m, 'correct', (kind, data) => f.persisted.push({ kind, data }));
  f.tracker.afterAppend(m, 'duplicate', (kind, data) => f.persisted.push({ kind, data }));
  f.emit('message_end', { message: m });
  f.tracker.afterAppend(m, 'duplicate-end', (kind, data) => f.persisted.push({ kind, data }));
  assert.equal(f.persisted.length, 1);
  assert.equal(f.persisted[0].data.messageEntryId, 'correct');
});

test('Pi message replacement copying preserves a private measurement without serializing it into provider content', () => {
  const f = fixture(), original = f.message(), replacement = { ...original, content: [{ type: 'text', text: 'redacted' }] };
  f.emit('before_provider_request'); f.start(original); f.at(100); f.delta(original);
  f.at(500); f.emit('message_end', { message: replacement });
  assert.doesNotMatch(JSON.stringify(replacement), /requestDurationMs|dashboard-speed/);
  // Actual AgentSession ordering: ExtensionRunner returns replacement; Pi
  // copies it in place onto the original object and appends that original.
  for (const key of Object.keys(original)) delete original[key];
  Object.assign(original, replacement);
  f.tracker.afterAppend(original, 'actual-entry-id', (kind, data) => f.persisted.push({ kind, data }));
  assert.equal(f.persisted[0].data.messageEntryId, 'actual-entry-id');
  assert.equal(f.persisted[0].data.generationDurationMs, 400);
  f.tracker.afterAppend(replacement, 'duplicate-copy', (kind, data) => f.persisted.push({ kind, data }));
  assert.equal(f.persisted.length, 1);
});

test('background cache warming cannot erase an already observed assistant stream', () => {
  const f = fixture(), m = f.message();
  f.emit('turn_start'); f.emit('before_provider_request'); f.start(m);
  f.at(1000); f.delta(m);
  f.at(270000); f.emit('before_provider_request', { payload: { warming: true } });
  f.at(271000); f.delta(m); f.at(272000); f.end(m);
  assert.equal(f.persisted.length, 1);
  assert.equal(f.persisted[0].data.firstTokenMs, 1000);
  assert.equal(f.persisted[0].data.generationDurationMs, 271000);
});

test('ambiguous pre-start request hooks withhold TTFT, while a new turn discards an idle warmup', () => {
  const f = fixture(), m = f.message();
  f.emit('before_provider_request'); // Idle background warmup.
  f.at(1000); f.emit('turn_start'); f.emit('before_provider_request');
  f.at(1100); f.emit('before_provider_request'); // Cannot tell which pre-start request owns this hook.
  f.at(1200); f.start(m); f.at(1500); f.delta(m); f.at(2000); f.end(m);
  assert.equal(f.persisted[0].data.firstTokenMs, null);
  assert.equal(f.persisted[0].data.requestDurationMs, null);
  assert.equal(f.persisted[0].data.generationDurationMs, 500);
  const next = f.message(3000);
  f.at(3000); f.emit('before_provider_request'); // Another idle warmup.
  f.at(4000); f.emit('turn_start'); f.emit('before_provider_request'); f.start(next);
  f.at(4500); f.delta(next); f.at(5000); f.end(next, 'next');
  assert.equal(f.persisted[1].data.firstTokenMs, 500);
  assert.equal(f.persisted[1].data.requestDurationMs, 1000);
});

test('retry and model switches cannot reuse a preceding first-output timestamp', () => {
  const f = fixture(), first = f.message(), second = f.message(2000, 'other-model');
  f.emit('before_provider_request'); f.start(first); f.at(500); f.delta(first);
  f.at(1000); f.end({ ...first, stopReason: 'error' }, 'failed');
  f.at(5000); f.emit('before_provider_request'); f.start(second);
  f.at(5500); f.delta(first); // Late event belonging to the prior attempt.
  f.at(7000); f.delta(second); f.at(8000); f.end(second, 'retry');
  assert.equal(f.persisted[1].data.firstTokenMs, 2000);
  assert.equal(f.persisted[1].data.generationDurationMs, 1000);
  assert.equal(f.persisted[1].data.model, 'other-model');
});

test('a stream without a request hook may retain an observed generation window but never invent TTFT', () => {
  const f = fixture(), m = f.message();
  f.at(1000); f.start(m); f.at(1500); f.delta(m); f.at(2000); f.end(m);
  assert.equal(f.persisted[0].data.requestDurationMs, null);
  assert.equal(f.persisted[0].data.firstTokenMs, null);
  assert.equal(f.persisted[0].data.generationDurationMs, 500);
});

test('reload mid-stream, session replacement and inactive bridge cannot fabricate samples', () => {
  const f = fixture(), m = f.message();
  f.at(100); f.delta(m); f.at(500); f.end(m);
  assert.equal(f.persisted.length, 0); // No observed request or message start.
  f.emit('before_provider_request'); f.start(m); f.delta(m); f.emit('session_start'); f.end(m);
  assert.equal(f.persisted.length, 0);
  f.emit('before_provider_request'); f.start(m); f.delta(m); f.deactivate(); f.end(m);
  assert.equal(f.persisted.length, 0);
});

test('a buffered or non-streamed completion has unknown first output rather than fake infinite speed', () => {
  const f = fixture(), m = f.message();
  f.emit('before_provider_request'); f.start(m); f.at(1000); f.end(m);
  assert.equal(f.persisted[0].data.requestDurationMs, 1000);
  assert.equal(f.persisted[0].data.firstTokenMs, null);
  assert.equal(f.persisted[0].data.generationDurationMs, null);
  assert.equal(f.persisted[0].data.firstOutputKind, null);
});

test('a monotonic-clock violation withholds the entire measurement', () => {
  const f = fixture(), m = f.message();
  f.at(500); f.emit('before_provider_request'); f.start(m); f.at(1000); f.delta(m);
  f.at(900); f.end(m);
  assert.equal(f.persisted.length, 0);
});
