import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchCharterBindingControls } from '../ResearchCharterBindingControls.js';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), base: '' }));
vi.mock('../../../lib/api/research-charter-binding-api.js', () => ({
  getResearchCharterBinding: api.get, updateResearchCharterBinding: api.update,
}));
vi.mock('../../../lib/api/api-context.js', () => ({ useApiBase: () => api.base, getApiBase: () => api.base }));
vi.mock('@blackbelt-technology/dashboard-plugin-runtime', () => ({ randomUuid: () => 'request-12345678' }));

const OLD = 'sha256:' + 'a'.repeat(64), CURRENT = 'sha256:' + 'b'.repeat(64);
const ADOPTION = 'adopt-' + '1'.repeat(24);
function state(options: { cwd?: string; sessionId?: string; current?: boolean; sessionStatus?: string; boundRevision?: number | null } = {}) {
  return {
    schema: 'pi-research-charter-binding.v1', cwd: options.cwd ?? '/project', adopted: true,
    adoptionId: ADOPTION, status: options.current ? 'current' : 'stale', bindingRevision: options.current ? 1 : 0,
    boundCharterHash: options.current ? CURRENT : OLD, boundCharterRevision: options.current ? 2 : options.boundRevision === undefined ? 1 : options.boundRevision,
    currentCharterHash: CURRENT, currentCharterRevision: 2, currentObjective: '保留原研究，核对有限驻留的行为证据。',
    currentCharter: { revision: 2, objective: '保留原研究，核对有限驻留的行为证据。', successCriteria: ['保存反例与未定结果'], constraints: ['仅使用已声明资料'], nonGoals: ['不扩大为电导提升'] },
    canRebind: !options.current, updatedAt: '2026-11-06T10:00:00.000Z',
    session: { sessionId: options.sessionId ?? 'main-session', status: options.sessionStatus ?? 'joined' },
  };
}
const saved = () => { const { session: _session, ...value } = state({ current: true }); return value; };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const props = { cwd: '/project', sessionId: 'main-session' };
beforeEach(() => { api.get.mockReset(); api.update.mockReset(); api.base = ''; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('research target binding beside the chosen main conversation', () => {
  it('distinguishes an already joined session with an old charter binding and previews the exact current scope', async () => {
    api.get.mockResolvedValue(state({ boundRevision: null }));
    render(<ResearchCharterBindingControls {...props} />);
    await screen.findByText('会话已接入 · 目标绑定已过期（当前版本 2）');
    expect(screen.getByTestId('research-charter-binding-rebind').textContent).toBe('衔接到目标版本 2');
    expect(screen.queryByText(/会话未接入/)).toBeNull();
    const preview = screen.getByTestId('research-charter-binding-preview');
    fireEvent.click(within(preview).getByText('查看当前目标与约束'));
    expect(preview.textContent).toContain('保留原研究，核对有限驻留的行为证据。');
    for (const text of ['保存反例与未定结果', '仅使用已声明资料', '不扩大为电导提升']) expect(preview.textContent).toContain(text);
    expect(preview.textContent).not.toContain('版本 1');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('performs one explicit CAS handoff on the admitted directory and rechecks the selected session before showing current', async () => {
    api.get.mockResolvedValueOnce(state({ cwd: '/canonical/project' })).mockResolvedValueOnce(state({ cwd: '/canonical/project', current: true }));
    const updating = deferred<ReturnType<typeof saved>>();
    api.update.mockReturnValue(updating.promise);
    const onRebound = vi.fn();
    render(<ResearchCharterBindingControls {...props} cwd="/project-alias" onRebound={onRebound} />);
    const button = await screen.findByTestId('research-charter-binding-rebind');
    fireEvent.click(button); fireEvent.click(button);
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][0]).toEqual({ cwd: '/canonical/project', adoptionId: ADOPTION,
      expectedBindingRevision: 0, expectedBoundCharterHash: OLD, expectedCharterHash: CURRENT, requestId: 'request-12345678' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('会话已接入 · 目标版本 2 已绑定')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
    await act(async () => updating.resolve({ ...saved(), cwd: '/canonical/project' }));
    await screen.findByText('会话已接入 · 目标版本 2 已绑定');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get.mock.calls[1][1]).toBe('main-session');
    expect(onRebound).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('research-charter-binding-rebind')).toBeNull();
  });

  it.each([
    ['not-joined', '会话未接入 · 目标版本 2 已绑定', '并入 res-workflow'],
    ['assignment-stale', '会话已接入 · 此协作任务仍绑定旧目标', '重新分派'],
    ['unavailable', '会话接入状态待核对 · 目标版本 2 已绑定', '核对'],
  ])('does not promote %s to a joined current assignment', async (sessionStatus, label, guidance) => {
    api.get.mockResolvedValue(state({ current: true, sessionStatus }));
    render(<ResearchCharterBindingControls {...props} />);
    await screen.findByText(label);
    expect(screen.getByTestId('research-charter-binding').textContent).toContain(guidance);
    expect(screen.queryByTestId('research-charter-binding-rebind')).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('does not equate a transport failure with missing membership and can refresh without mutation', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(state({ current: true }));
    render(<ResearchCharterBindingControls {...props} />);
    await screen.findByRole('alert');
    expect(screen.getByTestId('research-charter-binding-status').textContent).toBe('目标绑定状态待核对');
    expect(screen.queryByText(/会话未接入/)).toBeNull();
    expect(screen.queryByTestId('research-charter-binding-rebind')).toBeNull();
    fireEvent.click(screen.getByTestId('research-charter-binding-refresh'));
    await screen.findByText('会话已接入 · 目标版本 2 已绑定');
    expect(api.update).not.toHaveBeenCalled();
  });

  it.each([409, 0])('requires a fresh read after a conflicting or unconfirmed update (status %s), without retrying it', async status => {
    api.get.mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ current: true }));
    api.update.mockRejectedValue(Object.assign(new Error('write-unconfirmed'), { status }));
    render(<ResearchCharterBindingControls {...props} />);
    fireEvent.click(await screen.findByTestId('research-charter-binding-rebind'));
    await screen.findByRole('alert');
    expect(screen.queryByText('会话已接入 · 目标版本 2 已绑定')).toBeNull();
    expect(screen.queryByTestId('research-charter-binding-rebind')).toBeNull();
    expect(screen.getByTestId('research-charter-binding-status').textContent).toBe('目标绑定状态待核对');
    fireEvent.click(screen.getByTestId('research-charter-binding-refresh'));
    await screen.findByText('会话已接入 · 目标版本 2 已绑定');
    expect(api.update).toHaveBeenCalledTimes(1);
  });

  it('does not carry a previous workspace update into a newly selected workspace', async () => {
    api.get.mockImplementation((cwd: string, sessionId: string) => Promise.resolve(state({ cwd, sessionId })));
    const updating = deferred<ReturnType<typeof saved>>();
    api.update.mockReturnValue(updating.promise);
    const onRebound = vi.fn();
    const view = render(<ResearchCharterBindingControls {...props} onRebound={onRebound} />);
    fireEvent.click(await screen.findByTestId('research-charter-binding-rebind'));
    view.rerender(<ResearchCharterBindingControls cwd="/other" sessionId="other-main" onRebound={onRebound} />);
    await screen.findByTestId('research-charter-binding-rebind');
    await act(async () => updating.resolve(saved()));
    expect(screen.queryByText('会话已接入 · 目标版本 2 已绑定')).toBeNull();
    expect(api.update.mock.calls[0][1].aborted).toBe(true);
    expect(onRebound).not.toHaveBeenCalled();
    expect(api.get.mock.calls.filter(([, id]) => id === 'main-session')).toHaveLength(1);
  });

  it('rejects a late session status after the main conversation changes', async () => {
    const first = deferred<ReturnType<typeof state>>();
    api.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce(state({ current: true, sessionId: 'other-main', sessionStatus: 'not-joined' }));
    const view = render(<ResearchCharterBindingControls {...props} />);
    view.rerender(<ResearchCharterBindingControls {...props} sessionId="other-main" />);
    await screen.findByText('会话未接入 · 目标版本 2 已绑定');
    await act(async () => first.resolve(state()));
    expect(screen.queryByTestId('research-charter-binding-rebind')).toBeNull();
    expect(screen.getByTestId('research-charter-binding-status').textContent).toContain('会话未接入');
  });

  it('ignores an older poll after a successful handoff and fresh session read', async () => {
    const polling = deferred<ReturnType<typeof state>>();
    api.get.mockResolvedValueOnce(state()).mockReturnValueOnce(polling.promise).mockResolvedValueOnce(state({ current: true }));
    api.update.mockResolvedValue(saved());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<ResearchCharterBindingControls {...props} />);
    await screen.findByTestId('research-charter-binding-rebind');
    await act(async () => vi.advanceTimersByTime(15000));
    fireEvent.click(screen.getByTestId('research-charter-binding-rebind'));
    await screen.findByText('会话已接入 · 目标版本 2 已绑定');
    await act(async () => polling.resolve(state()));
    expect(screen.getByTestId('research-charter-binding-status').textContent).toBe('会话已接入 · 目标版本 2 已绑定');
  });

  it('does not claim dispatch readiness if the saved binding cannot be rechecked for this session', async () => {
    api.get.mockResolvedValueOnce(state()).mockRejectedValueOnce(new Error('session recheck unavailable'));
    api.update.mockResolvedValue(saved());
    const onRebound = vi.fn();
    render(<ResearchCharterBindingControls {...props} onRebound={onRebound} />);
    fireEvent.click(await screen.findByTestId('research-charter-binding-rebind'));
    await screen.findByRole('alert');
    expect(screen.queryByText('会话已接入 · 目标版本 2 已绑定')).toBeNull();
    expect(onRebound).not.toHaveBeenCalled();
    expect(api.update).toHaveBeenCalledTimes(1);
  });

  it('rejects an update acknowledgement for a different target instead of declaring the requested repair complete', async () => {
    api.get.mockResolvedValue(state());
    api.update.mockResolvedValue({ ...saved(), currentCharterHash: 'sha256:' + 'c'.repeat(64), boundCharterHash: 'sha256:' + 'c'.repeat(64) });
    render(<ResearchCharterBindingControls {...props} />);
    fireEvent.click(await screen.findByTestId('research-charter-binding-rebind'));
    await screen.findByRole('alert');
    expect(screen.queryByText('会话已接入 · 目标版本 2 已绑定')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
