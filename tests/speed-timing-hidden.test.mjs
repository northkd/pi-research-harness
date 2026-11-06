import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toCustomEntryForward, toCustomMessageForward } from '../patches/dashboard-v0.20/overlay/packages/extension/src/custom-entry-forward.ts';
import { SPEED_TIMING_CUSTOM_TYPE } from '../patches/dashboard-v0.20/overlay/packages/extension/src/generation-timing.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.resolve(process.env.PI_RESEARCH_DASHBOARD_SOURCE || path.join(root, '.runtime/dashboard-source'));
const replayUrl = pathToFileURL(path.join(root, 'patches/dashboard-v0.20/overlay/packages/shared/src/state-replay.ts')).href;
const usagePath = path.join(dashboard, 'packages/shared/src/usage-totals.ts');

const timing = Object.freeze({
  version: 1, source: 'pi-stream', messageEntryId: 'answer',
  messageTimestamp: 1000, provider: 'test-provider', model: 'test-model',
  requestDurationMs: 10000, firstTokenMs: 8000, generationDurationMs: 2000,
  firstOutputKind: 'text',
});

test('persisted model timing never becomes a live generic custom card', () => {
  const entry = Object.freeze({ type: 'custom', customType: SPEED_TIMING_CUSTOM_TYPE, id: 'timing', data: timing });
  assert.equal(toCustomEntryForward(entry), null);
  // Exclude only the reserved internal type, preserving other plugins and data.
  assert.deepEqual(toCustomEntryForward({ ...entry, customType: 'dashboard-speed-timing-note' }), {
    customType: 'dashboard-speed-timing-note', entryId: 'timing', data: timing,
  });
  assert.equal(entry.data, timing);
});

test('the internal type also stays hidden on the custom-message surface', () => {
  for (const display of [true, undefined, false]) {
    assert.equal(toCustomMessageForward({ customType: SPEED_TIMING_CUSTOM_TYPE, content: 'internal timing', display }), null);
  }
  assert.equal(toCustomMessageForward({ customType: 'review-note', content: 'reviewed', display: true })?.message.content, 'reviewed');
  assert.equal(toCustomMessageForward({ customType: 'review-note', content: 'hidden', display: false }), null);
  assert.equal(toCustomEntryForward({ type: 'custom', customType: 'flow-event', data: {} }), null);
});

if (!fs.existsSync(usagePath)) {
  test('replay timing isolation (prepared Dashboard source required)', { skip: `missing ${usagePath}` }, () => {});
} else {
  // Execute the actual overlay replay module with its unchanged production
  // usage helper. No runtime sync, transcript mutation or renderer stubs.
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === replayUrl && specifier === './usage-totals.js') {
      return { url: pathToFileURL(usagePath).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  const { replayEntriesAsEvents } = await import(replayUrl);
  const { sumEntryUsage } = await import(pathToFileURL(usagePath).href);
  const timestamp = '2026-11-06T00:00:00.000Z';
  const entries = [
    { type: 'model_change', timestamp, provider: 'test-provider', modelId: 'test-model' },
    { type: 'message', id: 'question', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'question' }] } },
    { type: 'message', id: 'answer', timestamp, message: {
      role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'evidence.txt' } }],
      usage: { input: 1000, output: 500, cacheRead: 20, cacheWrite: 10, cost: { total: 0.02 } },
    } },
    { type: 'message', id: 'result', timestamp, message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'evidence' }] } },
    { type: 'custom', id: 'plugin-state', timestamp, customType: 'my-extension', data: { state: 'ready' } },
    { type: 'custom_message', id: 'plugin-note', timestamp, customType: 'review-note', display: true, content: 'reviewed' },
    { type: 'custom', id: 'flow', timestamp, customType: 'flow-event', data: { seq: 0, eventType: 'flow_started', data: { flowRunId: 'run-1' } } },
  ];
  const metadataEntries = [
    { type: 'custom', customType: SPEED_TIMING_CUSTOM_TYPE, id: 'timing', timestamp, data: timing },
    { type: 'custom_message', customType: SPEED_TIMING_CUSTOM_TYPE, id: 'timing-message', timestamp, display: true, content: JSON.stringify(timing) },
    { type: 'custom', customType: SPEED_TIMING_CUSTOM_TYPE, id: 'bad-timing', timestamp, data: null },
  ];
  const augmented = [...metadataEntries.slice(0, 1), ...entries.slice(0, 3), ...metadataEntries.slice(1), ...entries.slice(3)];

  test('cold hydration and live reconnect replay retain exactly the original transcript events', () => {
    for (const options of [undefined, { liveTailOpen: true }]) {
      const baseline = replayEntriesAsEvents('session', entries, 200000, options);
      const actual = replayEntriesAsEvents('session', augmented, 200000, options);
      assert.deepEqual(actual, baseline);
      assert.doesNotMatch(JSON.stringify(actual), /dashboard-speed-timing|requestDurationMs/);
      assert.ok(actual.some(event => event.event.eventType === 'flow_started'));
      assert.ok(actual.some(event => event.event.eventType === 'custom_entry' && event.event.data.customType === 'my-extension'));
      assert.ok(actual.some(event => event.event.eventType === 'tool_execution_end'));
    }
  });

  test('timing metadata does not create extra conversation rows or double-count output usage', () => {
    const events = replayEntriesAsEvents('session', augmented);
    assert.equal(events.filter(event => event.event.eventType === 'message_end').length, 2); // Assistant + visible plugin note.
    assert.equal(events.filter(event => event.event.eventType === 'custom_entry').length, 1);
    const stats = events.filter(event => event.event.eventType === 'stats_update');
    assert.equal(stats.length, 1);
    assert.equal(stats[0].event.data.tokensOut, 500);
    assert.deepEqual(sumEntryUsage(augmented), sumEntryUsage(entries));
    assert.equal(sumEntryUsage(augmented).tokensOut, 500);
  });
}
