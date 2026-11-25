// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResWorkflowAdoption as Adoption } from '@blackbelt-technology/pi-dashboard-shared/res-workflow.js';
import * as api from '../../../lib/api/res-workflow-api.js';
import { setGlobalApiBase } from '../../../lib/api/api-context.js';
import { zhCNCatalog } from '../../../lib/i18n/i18n-zh-CN.js';
import { historyReviewFailureLabel, ResWorkflowHistoryReview } from '../ResWorkflowHistoryReview.js';

vi.mock('../../../lib/api/res-workflow-api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../lib/api/res-workflow-api.js')>(),
  getResWorkflowModels: vi.fn(), analyzeResWorkflowHistoryReview: vi.fn(), prepareResWorkflowHistoryReview: vi.fn(),
}));
vi.mock('../../settings/ModelSelector.js', () => ({ ModelSelector: () => null }));
const cwd = '/isolated/full-history';
const model = { provider: 'proxy', id: 'selected-model' };
function job(): Adoption {
  return {
    id: 'history-job', cwd, status: 'awaiting-model', createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
    partial: false, progress: { files: 0, sessions: 1, bytes: 100 }, sources: [], skipped: [], charterHash: 'none', model,
    historySelection: ['history-one'], historyReview: {
      status: 'prepared', canConfirm: false,
      plan: { planId: 'plan-one', planHash: 'hash-one', model, contextWindow: 32000, maxTokens: 8192, maxRequests: 2,
        batchCount: 1, mergeCallCount: 1, eligibleMessages: 1, eligibleBytes: 100, blockers: [],
        histories: [{ id: 'history-one', sessionId: 'session-one', eligibleMessages: 1, eligibleBytes: 100, chunkCount: 1, blockers: [] }] },
      coverage: { selectedHistories: 1, completedHistories: 0, eligibleMessages: 1, completedMessages: 0, eligibleBytes: 100, completedBytes: 0, completedBatches: 0, totalBatches: 1 },
    },
  };
}
const onJob = vi.fn(), onRefresh = vi.fn();
async function draw(value = job()) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<ResWorkflowHistoryReview cwd={value.cwd} job={value} onJob={onJob} onRefresh={onRefresh} />); });
  return view;
}
beforeEach(() => {
  vi.clearAllMocks(); setGlobalApiBase('');
  vi.mocked(api.getResWorkflowModels).mockResolvedValue([{ ...model, name: model.id }] as any);
  vi.mocked(api.analyzeResWorkflowHistoryReview).mockResolvedValue({ ...job(), status: 'analyzing', historyReview: { ...job().historyReview!, status: 'running' } });
});
afterEach(() => { cleanup(); setGlobalApiBase(''); });

describe('full-history compatibility without cap authorization', () => {
  it('shows planned workload and model limits, then authorizes only the model/material plan', async () => {
    await draw();
    expect(document.body.textContent).toContain('Planned workload: 2 model requests');
    expect(document.body.textContent).toContain('Model context limit 32000 tokens');
    expect(document.body.textContent).toContain('output limit per request 8192 tokens');
    expect(document.body.textContent).not.toMatch(/budget|up to \d+.*model requests/i);
    const button = screen.getByTestId('res-workflow-history-analyze') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(api.analyzeResWorkflowHistoryReview).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('res-workflow-history-consent')); });
    await act(async () => { fireEvent.click(button); });
    expect(api.analyzeResWorkflowHistoryReview).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(api.analyzeResWorkflowHistoryReview).mock.calls[0];
    expect(request.model).toEqual(model);
    expect(request.consent).toEqual({ scope: 'research-files-and-normal-messages', includeUnpublished: true, analysisMode: 'full-history-review-v1', planId: 'plan-one', planHash: 'hash-one' });
    expect(request.consent).not.toHaveProperty('maxRequests');
    expect(onJob).toHaveBeenCalledTimes(1);
  });

  it('does not treat zero remaining planned calls as a quota barrier when all planned nodes are reused', async () => {
    const value = job();
    Object.assign(value.historyReview!.plan!, { maxRequests: 0, totalRequests: 2, reusedRequests: 2 });
    await draw(value);
    expect(document.body.textContent).toContain('Planned workload: 0 model requests');
    expect(document.body.textContent).toContain('2 completed requests reused');
    await act(async () => { fireEvent.click(screen.getByTestId('res-workflow-history-consent')); });
    expect((screen.getByTestId('res-workflow-history-analyze') as HTMLButtonElement).disabled).toBe(false);
    expect(api.analyzeResWorkflowHistoryReview).not.toHaveBeenCalled();
  });

  it('still refuses a plan that covers a different history selection', async () => {
    const value = job(); value.historySelection = ['other-history'];
    await draw(value);
    expect(screen.queryByTestId('res-workflow-history-consent')).toBeNull();
    expect(screen.queryByTestId('res-workflow-history-analyze')).toBeNull();
    expect(api.analyzeResWorkflowHistoryReview).not.toHaveBeenCalled();
  });

  it('keeps unknown-result reconciliation and Chinese scope consent without extra budget approval', () => {
    const failure = historyReviewFailureLabel('result-unknown');
    expect(failure).toMatch(/not replay.*unconfirmed/);
    expect(failure).not.toMatch(/budget/i);
    for (const key of ['research.historyPlanFirst', 'research.historyPlanWorkload', 'research.historyFullConsent', 'research.historyResultUnknown', 'research.historyNewPlanExplanation', 'research.historyPreparedNoDraft', 'research.historyNoDraftYet']) {
      expect(zhCNCatalog[key]).toBeTruthy(); expect(zhCNCatalog[key]).not.toMatch(/预算|额度|最多.*模型请求/);
    }
  });
});
