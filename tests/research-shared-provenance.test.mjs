// Real shared projection, synthetic metadata only: no process or model is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {
  buildResearchSessionInitialPrompt,
  deriveResearchSessionRelations,
  isResearchSessionProvenance,
  normalizeResearchSessionProvenance,
  projectResearchSession,
  RESEARCH_SESSION_INITIAL_PROMPT_BYTES,
} from '../patches/dashboard-v0.20/overlay/packages/shared/src/research-session.ts';

function provenance(count) {
  return {
    schema: 'pi-research-session.v1', parentSessionId: 'parent', creatorSessionId: 'parent', creatorAgent: 'research_session',
    role: 'research-coordinator', task: 'Coordinate the declared synthetic jobs', stage: '2-experiment',
    charterHash: 'sha256:' + 'a'.repeat(64), adoptionId: 'adopt-' + 'b'.repeat(24), workflowCwd: '/workspace/synthetic',
    spawnToken: 'synthetic-spawn-token', requestId: 'synthetic-request', rootSessionId: 'parent', tenureId: 'tenure-current', depth: 1,
    createdAt: '2026-11-16T00:00:00.000Z', origin: 'research_session', relation: 'dispatch',
    tasks: Array.from({ length: count }, (_, index) => ({
      id: 'job-' + index, role: 'researcher', task: 'Inspect item ' + index, stage: '2-experiment',
      dependsOn: index ? ['job-' + (index - 1)] : [],
    })),
  };
}

for (const count of [1, 13, 64]) {
  test(`shared provenance preserves the main scheduler's ${count}-task declaration and immutable tenure`, () => {
    const row = provenance(count);
    assert.equal(isResearchSessionProvenance(row), true);
    const normalized = normalizeResearchSessionProvenance(row);
    assert.deepEqual(normalized, row);
    assert.notEqual(normalized.tasks, row.tasks);
    assert.equal(normalized.tenureId, 'tenure-current');
    const child = { id: 'child', pluginRefs: { 'res-workflow': { researchSession: normalized } } };
    assert.deepEqual(projectResearchSession(child)?.provenance, row);
    const relations = deriveResearchSessionRelations([
      { id: 'session-parent', sessionId: 'parent' }, { id: 'session-child', sessionId: 'child' },
    ], [child]);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].fromExecutionId, 'session-parent');
    assert.equal(relations[0].toExecutionId, 'session-child');
    assert.equal(relations[0].kind, 'dispatch');
  });
}

for (const count of [0, 65]) {
  test(`shared provenance rejects a ${count}-task declaration instead of inventing a dispatch relation`, () => {
    const row = provenance(count);
    assert.equal(isResearchSessionProvenance(row), false);
    assert.throws(() => normalizeResearchSessionProvenance(row), /research-session-provenance-invalid/);
    assert.equal(projectResearchSession({ researchSession: row }), null);
  });
}

test('legacy provenance without a tenure remains readable but malformed tenure IDs are rejected', () => {
  const legacy = provenance(1); delete legacy.tenureId;
  assert.equal(isResearchSessionProvenance(legacy), true);
  assert.equal('tenureId' in normalizeResearchSessionProvenance(legacy), false);
  assert.equal(isResearchSessionProvenance({ ...legacy, tenureId: '../foreign-tenure' }), false);
});

test('maximum valid shared metadata retains communication guidance inside the real startup byte limit', () => {
  const row = { ...provenance(64), parentSessionId: 'p'.repeat(128), creatorSessionId: 'p'.repeat(128), readOnly: true, task: '研'.repeat(4000) };
  const context = { dispatchId: 'd'.repeat(128), taskId: 't'.repeat(128),
    prerequisiteResults: Array.from({ length: 12 }, (_, index) => ({ id: String(index).padStart(2, '0') + 'x'.repeat(126) })),
  };
  const prompt = buildResearchSessionInitialPrompt(row, context);
  assert.equal(RESEARCH_SESSION_INITIAL_PROMPT_BYTES, 16 * 1024);
  assert.ok(Buffer.byteLength(prompt) < RESEARCH_SESSION_INITIAL_PROMPT_BYTES);
  assert.ok(prompt.includes('research_communication pending'));
  assert.ok(prompt.includes('Prefer research_communication report'));
  assert.ok(prompt.includes('READ-ONLY assignment'));
  assert.ok(prompt.includes(context.prerequisiteResults[11].id));
  assert.equal(prompt.includes('\ufffd'), false);
});

test('metadata-overflow guard throws its explicit error, not an undefined server-only helper', async () => {
  // With today's validated metadata lengths the normal 16 KiB budget is ample.
  // Reduce only this isolated test copy's budget to exercise the defensive branch;
  // production limits, input validation and source files are not changed.
  const source = readFileSync(new URL('../patches/dashboard-v0.20/overlay/packages/shared/src/research-session.ts', import.meta.url), 'utf8');
  const marker = 'export const RESEARCH_SESSION_INITIAL_PROMPT_BYTES = 16 * 1024;';
  assert.ok(source.includes(marker));
  const reduced = stripTypeScriptTypes(source.replace(marker, 'export const RESEARCH_SESSION_INITIAL_PROMPT_BYTES = 256;'), { mode: 'strip' });
  const isolated = await import('data:text/javascript;base64,' + Buffer.from(reduced).toString('base64'));
  assert.throws(() => isolated.buildResearchSessionInitialPrompt(provenance(1)), error =>
    error instanceof Error && !(error instanceof ReferenceError) && error.message === 'research-session-prompt-metadata-too-large');
});
