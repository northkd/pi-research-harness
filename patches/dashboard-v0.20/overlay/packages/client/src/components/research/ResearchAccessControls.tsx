import { useEffect, useId, useRef, useState } from 'react';
import { randomUuid } from '@blackbelt-technology/dashboard-plugin-runtime';
import { getApiBase, useApiBase } from '../../lib/api/api-context.js';
import { getResearchAccessMode, updateResearchAccessMode, type ResearchAccessMode } from '../../lib/api/research-access-mode-api.js';

/** A persisted workspace preference. Choosing a mode is the operator action. */
export function ResearchAccessControls({ cwd, connectionGeneration = 0 }: {
  cwd: string;
  connectionGeneration?: number;
}) {
  const apiBase = useApiBase(), id = useId();
  const scope = JSON.stringify([apiBase, cwd, connectionGeneration]);
  const generation = useRef(scope); generation.current = scope;
  const [record, setRecord] = useState<{ scope: string; value: ResearchAccessMode } | null>(null);
  const [error, setError] = useState<{ scope: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sequence = useRef(0), pendingSave = useRef<string | null>(null);
  const requests = useRef(new Set<AbortController>());
  const value = record?.scope === scope ? record.value : null;
  const message = error?.scope === scope ? error.text : null;
  const current = (abort: AbortController) => !abort.signal.aborted && generation.current === scope && getApiBase() === apiBase;

  async function reload() {
    if (pendingSave.current === scope) return;
    const read = ++sequence.current;
    const abort = new AbortController(); requests.current.add(abort);
    try {
      const fresh = await getResearchAccessMode(cwd, abort.signal);
      // The admitted server canonicalizes directory aliases (for example
      // /var on macOS). Request scope/epoch, not string equality, binds a read.
      if (!current(abort) || read !== sequence.current || pendingSave.current === scope) return;
      setRecord({ scope, value: fresh }); setError(null);
    } catch {
      if (current(abort) && read === sequence.current && pendingSave.current !== scope) {
        setRecord(null); setError({ scope, text: '暂时无法确认访问权限，请刷新状态后重试。' });
      }
    } finally { requests.current.delete(abort); }
  }

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 15000);
    return () => {
      sequence.current++; window.clearInterval(timer);
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, [scope]);

  async function choose(mode: ResearchAccessMode['mode']) {
    if (!value || pendingSave.current === scope || mode === value.mode || !['default', 'full-access'].includes(mode)) return;
    const abort = new AbortController(); requests.current.add(abort);
    pendingSave.current = scope; sequence.current++; setBusy(scope); setError(null);
    try {
      // Pin the admitted directory so a changed symlink cannot redirect a
      // selection between reading the mode and saving the operator's choice.
      const fresh = await updateResearchAccessMode({ cwd: value.cwd, mode, expectedRevision: value.revision, requestId: randomUuid() }, abort.signal);
      if (!current(abort)) return;
      if (fresh.cwd !== value.cwd) throw new Error('access-mode-scope-mismatch');
      setRecord({ scope, value: fresh });
    } catch (cause) {
      if (!current(abort)) return;
      // A lost response can follow a successful write. Re-read before claiming
      // either mode is active; never retry an access-changing request silently.
      setRecord(null);
      setError({ scope, text: cause instanceof Error && cause.message.includes('revision')
        ? '权限已在别处更新，请刷新状态后再选择。'
        : '未确认权限变更，请刷新状态后重试。' });
    } finally {
      requests.current.delete(abort);
      if (pendingSave.current === scope) pendingSave.current = null;
      if (generation.current === scope) setBusy(null);
    }
  }

  return <section data-testid="research-access-controls" className="win11-card-subtle min-w-0 space-y-2 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor={id} className="font-semibold text-[var(--text-primary)]">访问权限</label>
      <select id={id} aria-label="访问权限" data-testid="research-access-select"
        className="focus-ring min-h-8 max-w-full rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-sm text-[var(--text-primary)] disabled:opacity-60"
        value={value?.mode ?? ''} disabled={!value || busy === scope}
        onChange={event => void choose(event.target.value as ResearchAccessMode['mode'])}>
        {!value && <option value="" disabled>{message ? '权限状态待核对' : '正在读取权限…'}</option>}
        <option value="default">默认权限</option>
        <option value="full-access">完全访问</option>
      </select>
    </div>
    <p role="status" data-testid="research-access-status" className="text-[var(--text-secondary)]">
      {busy === scope ? '正在保存权限…' : !value ? '尚未确认当前权限' : value.mode === 'full-access' ? '完全访问已开启' : '按默认规则处理权限请求'}
    </p>
    <p className="leading-relaxed text-[var(--text-tertiary)]">选择后立即保存，同一操作者在本工作区的 Pi 会话共用，直到切回默认。系统和远程账号权限由运行环境决定。</p>
    {message && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-[var(--severity-warning-fg)]">{message}</p>
      <button type="button" className="win11-btn focus-ring min-h-8 px-2.5 py-1" onClick={() => void reload()} disabled={busy === scope}>刷新权限状态</button>
    </div>}
  </section>;
}
