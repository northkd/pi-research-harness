import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MainlineStore } from '../src/core.mjs';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
// All seeded events, IDs and verdicts are synthetic; no project state is edited by these tests.
function fixture(t, count = 0, width = 0) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-log-cap-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'notes')); fs.writeFileSync(path.join(cwd, 'notes/a.md'), 'synthetic artifact');
  const store = new MainlineStore(cwd); store.configure({ coreText: 'Synthetic bounded audit core.', approvedPaths: ['notes/a.md'], authorized: true });
  const key = hash('fixture').slice(0, 32), legacy = path.join(store.root, 'events', key + '.jsonl');
  if (count) {
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const events = Array.from({ length: count }, (_, i) => ({ type: 'tool_result', sessionId: 'fixture', revision: i + 2,
      timestamp: i, toolName: 'read', path: 'notes/a.md', material: false, source: 'runtime-event',
      result: { text: 'x'.repeat(width) }, coverage: ['synthetic'], omissions: [] }));
    const bytes = events.map(e => JSON.stringify(e) + '\n').join(''); fs.writeFileSync(legacy, bytes);
    const s = store.getState(); delete s.eventJournalVersion; delete s.eventJournalFiles; delete s.eventSourceGaps;
    s.revision = count + 1; s.materialRevision = count + 1;
    s.eventCount = count; s.eventBytes = Buffer.byteLength(bytes);
    fs.writeFileSync(path.join(store.root, 'state.json'), JSON.stringify(s));
  }
  return { cwd, store, legacy, key };
}
const event = (id, extra = {}) => ({ type: 'tool_result', toolName: 'bash', sessionId: 'fixture', toolCallId: id,
  input: { command: 'withheld synthetic command' }, result: 'withheld synthetic output', ...extra });
function begin(store, id = 'review') {
  const b = store.beginReview({ sessionId: 'fixture', requestId: id }); assert.equal(b.ok, true, JSON.stringify(b));
  store.attachRun(id, 'mock-' + id); return b;
}
const finish = (store, id = 'review', verdict = 'ON_TRACK') => store.finishReview(id, { verdict, findings: [], runId: 'mock-' + id });

test('capacity: legacy byte boundary creates a new segment without altering old source bytes', t => {
  const { store, legacy } = fixture(t, 500, 8192); const before = fs.readFileSync(legacy);
  // Mark the synthetic historical window reviewed, not missing; no real state affected.
  const s = store.getState(); s.reviewedRevision = s.revision; s.reviewedMaterialRevision = s.materialRevision;
  fs.writeFileSync(path.join(store.root, 'state.json'), JSON.stringify(s));
  for (let i = 0; i < 4; i++) store.record(event('over-bytes-' + i));
  assert.deepEqual(fs.readFileSync(legacy), before);
  assert.equal(store.getState().omittedEvents, 0); assert.equal(store.getState().captureLimitReached ?? false, false);
  assert.equal(store.eventsThrough(store.getState().revision).length, 504);
  const files = fs.readdirSync(path.dirname(legacy)); assert.ok(files.some(f => /\.000001\.jsonl$/.test(f)));
  const b = begin(store); const evidence = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json')));
  assert.equal(evidence.events.length, 4); assert.equal(evidence.eventWindow.afterRevision, 501);
  assert.equal(evidence.eventWindow.totalStoredEvents, 504); assert.equal(finish(store).state, 'standby');
});

test('capacity: crossing 2000 events persists all events and seals a bounded segment', t => {
  const { store, legacy } = fixture(t, 2000); const before = fs.readFileSync(legacy);
  for (let i = 0; i < 3; i++) store.record(event('after-count-' + i));
  const s = store.getState(); assert.equal(s.eventCount, 2003); assert.equal(s.omittedEvents, 0);
  assert.equal(store.eventsThrough(s.revision).length, 2003); assert.deepEqual(fs.readFileSync(legacy), before);
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'too-wide' }).reason, 'unreviewed-event-window-exceeds-budget');
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().reviewHealth.kind, 'window-limit');
});

test('capacity: synthetic segment rolls at its own byte boundary; ordered complete readback', t => {
  const { store } = fixture(t);
  // Approved read payloads exercise real record -> sanitize -> append -> rotation.
  for (let i = 0; i < 530; i++) store.record(event('segment-' + i, { toolName: 'read', input: { path: 'notes/a.md' }, result: 'q'.repeat(8192) }));
  const s = store.getState(), files = fs.readdirSync(path.join(store.root, 'events'));
  assert.ok(files.length >= 2); assert.equal(s.omittedEvents, 0);
  for (const f of files) assert.ok(fs.statSync(path.join(store.root, 'events', f)).size <= 4 * 1024 * 1024);
  const events = store.eventsThrough(s.revision); assert.equal(events.length, 530);
  assert.deepEqual(events.map(e => e.revision), Array.from({ length: 530 }, (_, i) => i + 2));
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'over-bytes' }).reason, 'unreviewed-event-window-exceeds-budget');
});

test('capacity: review windows retain all not-yet-reviewed events and do not re-read reviewed history', t => {
  const { store } = fixture(t); store.record(event('first')); const a = begin(store, 'a'); finish(store, 'a', 'INSUFFICIENT_CONTEXT');
  const oldPacket = fs.readFileSync(path.join(a.packetDir, 'EVIDENCE.json'));
  store.record(event('second')); const b = begin(store, 'b');
  const e = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json')));
  assert.deepEqual(e.events.map(v => v.toolCallId), ['second']); assert.equal(e.eventWindow.afterRevision, a.revision);
  assert.match(JSON.stringify(e.eventWindow), /not a whole-history/);
  finish(store, 'b'); assert.deepEqual(fs.readFileSync(path.join(a.packetDir, 'EVIDENCE.json')), oldPacket);
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'repeat' }).reason, 'no-new-evidence');
});

test('capacity: historical omissions remain disclosed blind spots, not a project-wide stop or retrospective proof', t => {
  const { store } = fixture(t); const s = store.getState();
  s.omittedEvents = 12; s.captureLimitReached = true; s.blocked = true;
  fs.writeFileSync(path.join(store.root, 'state.json'), JSON.stringify(s));
  store.record(event('new')); const b = begin(store);
  const e = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json')));
  assert.ok(e.sourceGaps.some(g => g.kind === 'unpersisted-source-events' && g.count === 12 && g.status === 'UNVERIFIED'));
  assert.equal(finish(store).state, 'standby'); assert.equal(store.getState().blocked, false);
  assert.equal(store.getState().reviewHealth.status, 'BLIND_SPOT');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.packetDir, 'RESULT.json'))).publicationAuthorized, false);
  assert.equal(store.getState().omittedEvents, 12); assert.equal(store.getState().captureLimitReached, true);
  assert.match(store.statusText(), /12.*缺口/);
  store.configure({ coreText: s.coreText, approvedPaths: ['notes/a.md'], authorized: true });
  store.recordCorrection({ text: 'Declaration cannot settle missing events', evidencePaths: ['notes/a.md'] });
  store.record(event('unrelated')); begin(store, 'again'); finish(store, 'again');
  assert.equal(store.getState().blocked, false); assert.ok(store.getState().reviewedRevision > 0);
  assert.equal(store.getState().eventSourceGaps[0].status, 'UNVERIFIED');
});

test('capacity: tamper, missing segment and orphan append cannot create verified evidence', t => {
  for (const kind of ['tamper', 'missing', 'orphan']) {
    const { store } = fixture(t); store.record(event(kind));
    const file = path.join(store.root, 'events', fs.readdirSync(path.join(store.root, 'events'))[0]);
    if (kind === 'tamper') fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('bash', 'fake'));
    if (kind === 'missing') fs.unlinkSync(file);
    if (kind === 'orphan') fs.appendFileSync(file, JSON.stringify({ revision: 9999, type: 'tool_result' }) + '\n');
    assert.throws(() => store.eventsThrough(10000), /journal|event|source|segment/i, kind);
    assert.equal(store.beginReview({ sessionId: 'fixture', requestId: kind }).ok, false);
    assert.equal(store.getState().blocked, false); assert.equal(store.getState().captureFailure, true);
  }
});

test('capacity: failed append is not passed evidence; capture failure prevents dispatch, not all research', t => {
  const { store } = fixture(t); const append = store.append.bind(store);
  store.append = (file, e) => { if (file.includes('/events/')) throw new Error('synthetic disk failure'); return append(file, e); };
  assert.throws(() => store.record(event('disk-failure')), /disk failure/); store.markCaptureFailure();
  assert.equal(store.getState().captureFailure, true); assert.equal(store.getState().blocked, false);
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'cannot-pass' }).reason, 'source-capture-failed');
});
