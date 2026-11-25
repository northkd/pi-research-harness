// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchWorkbenchObservation } from '@blackbelt-technology/pi-dashboard-shared/research-workbench.js';
import type { ResearchProjection } from '../research-projection.js';
import { ResearchOverviewAndBudget } from '../ResearchOverviewAndBudget.js';
import { ResearchStartGuide } from '../ResearchStartGuide.js';

const legacy = vi.hoisted(() => ({ budget: vi.fn(), permissions: vi.fn() }));
vi.mock('../ResearchBudgetControls.js', () => ({ ResearchBudgetControls: () => { legacy.budget(); return null; } }));
vi.mock('../ResearchPermissionControls.js', () => ({ ResearchPermissionControls: () => { legacy.permissions(); return null; } }));

const projection: ResearchProjection = { stage: null, enteredStages: new Set(), runs: [], currentRun: null, updatedAt: null, executions: [], relations: [], configuration: null, reviews: [] };
const observation: ResearchWorkbenchObservation = {
  schema: 'res-workflow.workbench-observation.v1', cwd: '/synthetic', adoptionId: 'adopt-synthetic', charterHash: `sha256:${'a'.repeat(64)}`, revision: `sha256:${'b'.repeat(64)}`,
  updatedAt: '2026-11-06T10:00:00.000Z', heartbeatAt: '2026-11-06T10:00:00.000Z', coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 1 }, executions: [], relations: [],
  observedUsage: { responses: 17, inputTokens: 100, outputTokens: 50, inheritedExcluded: 2, metric: 'observed-assistant-responses' },
};
const base = { cwd: '/synthetic', viewStage: null, onSelectStage: vi.fn(), projection, state: null, attempts: [], claims: [], adopted: true, showStageSelector: false };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('research overview without budget setup', () => {
  it('keeps real observed usage and never mounts budget or task-authorization forms', async () => {
    await act(async () => { render(<ResearchOverviewAndBudget {...base} workbench={observation} />); });
    expect(screen.getByTestId('research-observed-responses').textContent).toContain('17');
    expect(screen.getByTestId('research-observed-usage').textContent).toContain('输入 100 tokens');
    expect(screen.getByTestId('research-observed-usage').textContent).toContain('输出 50 tokens');
    expect(screen.getByTestId('research-observed-usage').textContent).toContain('排除 2');
    expect(document.body.textContent).not.toMatch(/研究预算|长任务执行授权|预算上限|修改预算/);
    expect(legacy.budget).not.toHaveBeenCalled();
    expect(legacy.permissions).not.toHaveBeenCalled();
  });

  it('distinguishes missing observations from zero and does not leak another directory counts', () => {
    const view = render(<ResearchOverviewAndBudget {...base} adopted={false} />);
    expect(screen.getByTestId('research-observed-usage').textContent).toContain('尚无');
    expect(screen.queryByTestId('research-observed-responses')).toBeNull();
    expect(document.body.textContent).not.toMatch(/接入.*授权|配置.*预算/);
    view.rerender(<ResearchOverviewAndBudget {...base} workbench={{ ...observation, cwd: '/another' }} />);
    expect(screen.queryByTestId('research-observed-responses')).toBeNull();
    view.rerender(<ResearchOverviewAndBudget {...base} workbench={{ ...observation, observedUsage: { ...observation.observedUsage, responses: -1 } }} />);
    expect(screen.queryByTestId('research-observed-responses')).toBeNull();
    view.rerender(<ResearchOverviewAndBudget {...base} workbench={{ ...observation, observedUsage: { ...observation.observedUsage, responses: 0 } }} />);
    expect(screen.getByTestId('research-observed-responses').textContent).toContain('至少 0 次');
  });

  it('updates usage while retaining stale, partial and retry-coverage qualifications', () => {
    const view = render(<ResearchOverviewAndBudget {...base} workbench={observation} />);
    view.rerender(<ResearchOverviewAndBudget {...base} observationStale workbench={{ ...observation, observedUsage: { ...observation.observedUsage, responses: 18 }, coverage: { ...observation.coverage, partial: true } }} />);
    const text = screen.getByTestId('research-observed-usage').textContent;
    expect(text).toContain('18'); expect(text).toContain('过期'); expect(text).toContain('补齐'); expect(text).toContain('失败和重试');
  });

  it('start and continue instructions do not ask the user to configure quotas first', () => {
    render(<ResearchStartGuide cwd='/synthetic' objective='A synthetic question' />);
    expect((screen.getByTestId('research-start-instructions') as HTMLTextAreaElement).value).not.toMatch(/预算|门禁/);
    fireEvent.click(screen.getByTestId('research-continue-choice'));
    const instructions = (screen.getByTestId('research-start-instructions') as HTMLTextAreaElement).value;
    expect(instructions).not.toMatch(/预算|门禁/);
    expect(instructions).toContain('不重复派发');
    expect(instructions).toContain('不能把它当作历史恢复');
  });
});
