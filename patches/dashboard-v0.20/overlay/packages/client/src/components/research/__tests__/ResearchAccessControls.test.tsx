import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchAccessControls } from '../ResearchAccessControls.js';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), base: '' }));
vi.mock('../../../lib/api/research-access-mode-api.js', () => ({
  getResearchAccessMode: api.get, updateResearchAccessMode: api.update,
}));
vi.mock('../../../lib/api/api-context.js', () => ({
  useApiBase: () => api.base, getApiBase: () => api.base,
}));
vi.mock('@blackbelt-technology/dashboard-plugin-runtime', () => ({ randomUuid: () => 'request-12345678' }));

const state = (cwd = '/project', mode: 'default' | 'full-access' = 'default', revision: string | null = null) => ({
  cwd, mode, revision, updatedAt: revision ? '2026-11-06T10:00:00.000Z' : null,
  inheritance: 'workspace-sessions' as const,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { api.get.mockReset(); api.update.mockReset(); api.base = ''; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('direct workspace access mode', () => {
  it('saves one explicit selection without task, budget, expiry or a second approval', async () => {
    api.get.mockResolvedValue(state());
    const saving = deferred<ReturnType<typeof state>>();
    api.update.mockReturnValueOnce(saving.promise).mockResolvedValueOnce(state('/project', 'default', 'revision-2'));
    render(<ResearchAccessControls cwd="/project" />);
    const select = screen.getByRole('combobox', { name: '访问权限' });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'full-access' } });
    expect(api.update.mock.calls[0][0]).toEqual({ cwd: '/project', mode: 'full-access', expectedRevision: null, requestId: 'request-12345678' });
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect((select as HTMLSelectElement).value).toBe('default');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/批准并启用|授权时长|本次任务与交付/)).toBeNull();
    await act(async () => saving.resolve(state('/project', 'full-access', 'revision-1')));
    expect((select as HTMLSelectElement).value).toBe('full-access');
    expect(screen.getByTestId('research-access-status').textContent).toContain('完全访问已开启');
    fireEvent.change(select, { target: { value: 'default' } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('default'));
    expect(api.update.mock.calls[1][0].expectedRevision).toBe('revision-1');
  });

  it('reads a persisted mode on remount without silently enabling permissions', async () => {
    api.get.mockResolvedValue(state('/project', 'full-access', 'saved-revision'));
    const first = render(<ResearchAccessControls cwd="/project" />);
    await screen.findByText('完全访问已开启');
    first.unmount();
    render(<ResearchAccessControls cwd="/project" />);
    await screen.findByText('完全访问已开启');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('accepts a canonical read and pins the write to that directory instead of an alias', async () => {
    api.get.mockResolvedValue(state('/private/var/project'));
    api.update.mockResolvedValue(state('/private/var/project', 'full-access', 'canonical-revision'));
    render(<ResearchAccessControls cwd="/var/project" />);
    const select = screen.getByRole('combobox', { name: '访问权限' }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'full-access' } });
    await screen.findByText('完全访问已开启');
    expect(api.get.mock.calls[0][0]).toBe('/var/project');
    expect(api.update.mock.calls[0][0].cwd).toBe('/private/var/project');
  });

  it('does not present an unknown mode as default when reading fails, and can recover', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(state());
    render(<ResearchAccessControls cwd="/project" />);
    await screen.findByRole('alert');
    const select = screen.getByRole('combobox', { name: '访问权限' }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '刷新权限状态' }));
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('default');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('keeps an unconfirmed write unknown until a fresh read, without automatic write retry', async () => {
    api.get.mockResolvedValueOnce(state()).mockResolvedValueOnce(state('/project', 'full-access', 'actually-saved'));
    api.update.mockRejectedValue(new Error('connection-lost'));
    render(<ResearchAccessControls cwd="/project" />);
    const select = screen.getByRole('combobox', { name: '访问权限' }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'full-access' } });
    await screen.findByRole('alert');
    expect(select.value).toBe('');
    expect(select.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新权限状态' }));
    await screen.findByText('完全访问已开启');
    expect(api.update).toHaveBeenCalledTimes(1);
  });

  it('cannot apply an earlier workspace write response to the newly selected workspace', async () => {
    api.get.mockImplementation((cwd: string) => Promise.resolve(state(cwd)));
    const saving = deferred<ReturnType<typeof state>>();
    api.update.mockReturnValue(saving.promise);
    const view = render(<ResearchAccessControls cwd="/project" />);
    const select = screen.getByRole('combobox', { name: '访问权限' }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'full-access' } });
    view.rerender(<ResearchAccessControls cwd="/other" />);
    await waitFor(() => expect(select.disabled).toBe(false));
    await act(async () => saving.resolve(state('/project', 'full-access', 'old-workspace')));
    expect(select.value).toBe('default');
    expect(screen.queryByText('完全访问已开启')).toBeNull();
    expect(api.update.mock.calls[0][1].aborted).toBe(true);
  });

  it('ignores an old poll response after a newer mode has been saved', async () => {
    api.get.mockResolvedValueOnce(state());
    const polling = deferred<ReturnType<typeof state>>();
    api.get.mockReturnValueOnce(polling.promise);
    api.update.mockResolvedValue(state('/project', 'full-access', 'new-mode'));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<ResearchAccessControls cwd="/project" />);
    const select = screen.getByRole('combobox', { name: '访问权限' }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await act(async () => vi.advanceTimersByTime(15000));
    fireEvent.change(select, { target: { value: 'full-access' } });
    await screen.findByText('完全访问已开启');
    await act(async () => polling.resolve(state()));
    expect(select.value).toBe('full-access');
  });
});
