import { expect, it } from 'vitest';
import { buildResearchSessionInitialPrompt } from '../res-workflow/research-session-service.mjs';
import { createPendingInitialPromptRegistry, PENDING_INITIAL_PROMPT_MAX_BYTES } from '../pending/pending-initial-prompt-registry.js';

it('the actual token-bound prompt registry admits maximum task briefs without embedding large prerequisite receipts', () => {
  const registry = createPendingInitialPromptRegistry({ normalize: cwd => cwd });
  const row = {
    schema: 'pi-research-session.v1' as const, parentSessionId: 'parent', creatorSessionId: 'parent', creatorAgent: 'research_session' as const,
    role: 'research-coordinator', task: '研'.repeat(4000), stage: '2-experiment' as const,
    charterHash: 'sha256:' + 'a'.repeat(64), adoptionId: 'adopt-' + 'b'.repeat(24), workflowCwd: '/workspace/synthetic',
    spawnToken: 'prompt-budget-child', createdAt: '2026-11-06T00:00:00.000Z', origin: 'research_session' as const, relation: 'dispatch' as const,
    readOnly: true as const,
  };
  const context = { dispatchId: 'dispatch-test', taskId: 'coordinator', prerequisiteResults: Array.from({ length: 11 }, (_, index) => ({
    id: 'dependency-' + index,
    summary: '完整的前置任务结果'.repeat(400),
    evidence: Array.from({ length: 16 }, (_, item) => `evidence/${item}/` + '证'.repeat(900)),
  })) };
  const prompt = buildResearchSessionInitialPrompt(row, context);
  expect(PENDING_INITIAL_PROMPT_MAX_BYTES).toBe(16 * 1024);
  expect(Buffer.byteLength(prompt)).toBeLessThan(PENDING_INITIAL_PROMPT_MAX_BYTES);
  expect(prompt).not.toContain('完整的前置任务结果');
  expect(prompt).not.toContain('evidence/0/');
  expect(prompt).toContain('dependency-10');
  expect(prompt).toContain('READ-ONLY assignment');
  expect(registry.enqueue(row.workflowCwd, prompt + JSON.stringify(context), 'oversized-legacy-body')).toBe(false);
  expect(registry.enqueue(row.workflowCwd, prompt, row.spawnToken)).toBe(true);
  expect(registry.consume(row.workflowCwd, row.spawnToken)).toBe(prompt);
});
