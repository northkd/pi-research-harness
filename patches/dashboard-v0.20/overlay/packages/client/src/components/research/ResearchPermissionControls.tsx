import { useEffect, useRef, useState } from 'react';
import { randomUuid } from '@blackbelt-technology/dashboard-plugin-runtime';
import { getApiBase, useApiBase } from '../../lib/api/api-context.js';
import { getResearchTaskPermissions, updateResearchTaskPermissions, type ResearchTaskPermissions } from '../../lib/api/research-task-permissions-api.js';
const BUTTON = 'win11-btn focus-ring min-h-8 px-3 py-1.5 text-xs font-semibold disabled:opacity-50';
const INPUT = 'min-w-0 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)]';
const labels = { localExecution: '本地计算、项目文件修改与实验续跑', delegation: '拆分工作并向协作智能体继续分发', publicResearch: '公开文献检索与公开网页读取', projectDependencies: '安装当前项目所需依赖（不含全局安装）' };
const statusLabels = { unconfigured: '尚未设置', active: '无人值守授权生效中', expired: '授权已到期', revoked: '授权已撤销', 'scope-changed': '研究约定已变更，请重新核对' };
type Draft = { task: string; durationHours: 12 | 24 | 48 | 72; capabilities: ResearchTaskPermissions['capabilities']; roots: string };
export function ResearchPermissionControls({ cwd, connectionGeneration = 0, onRefresh }: { cwd: string; connectionGeneration?: number; onRefresh?: () => void }) {
  const apiBase = useApiBase(), scope = JSON.stringify([apiBase, cwd, connectionGeneration]);
  const generation = useRef(scope); generation.current = scope;
  const [record, setRecord] = useState<{ scope: string; value: ResearchTaskPermissions } | null>(null);
  const [editing, setEditing] = useState<{ scope: string; draft: Draft } | null>(null);
  const [message, setMessage] = useState<{ scope: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const readSequence = useRef(0);
  const pendingSaveScope = useRef<string | null>(null);
  const aborts = useRef(new Set<AbortController>());
  const value = record?.scope === scope ? record.value : null;
  const draft = editing?.scope === scope ? editing.draft : null;
  const current = (abort: AbortController) => !abort.signal.aborted && generation.current === scope && getApiBase() === apiBase;
  async function reload(signal?: AbortSignal) {
    if (pendingSaveScope.current === scope) return;
    const sequence = ++readSequence.current;
    const fresh = await getResearchTaskPermissions(cwd, signal);
    if (sequence !== readSequence.current || pendingSaveScope.current === scope || signal?.aborted || generation.current !== scope || fresh.cwd !== cwd || getApiBase() !== apiBase) return;
    setRecord({ scope, value: fresh });
  }
  useEffect(() => {
    const abort = new AbortController(); aborts.current.add(abort); readSequence.current++;
    void reload(abort.signal).catch(() => { if (current(abort)) setMessage({ scope, text: '暂时无法读取任务授权，请刷新后重试。' }); });
    const interval = window.setInterval(() => { if (pendingSaveScope.current !== scope) void reload(abort.signal).catch(() => {}); }, 15000);
    return () => { abort.abort(); aborts.current.delete(abort); clearInterval(interval); };
  }, [scope]);
  useEffect(() => () => { for (const abort of aborts.current) abort.abort(); }, []);
  const edit = () => value && setEditing({ scope, draft: { task: value.task, durationHours: value.durationHours, capabilities: { ...value.capabilities }, roots: value.additionalRoots.join('\n') } });
  async function save(action: 'authorize' | 'revoke') {
    if (!value || busy === scope || action === 'authorize' && !draft?.task.trim()) return;
    const abort = new AbortController(); aborts.current.add(abort); pendingSaveScope.current = scope; readSequence.current++; setBusy(scope); setMessage(null);
    try {
      const fresh = await updateResearchTaskPermissions({ cwd, expectedRevision: value.revision, requestId: randomUuid(), action, confirmed: true, ...(action === 'authorize' && draft ? { task: draft.task.trim(), durationHours: draft.durationHours, capabilities: draft.capabilities, additionalRoots: draft.roots.split('\n').map(p => p.trim()).filter(Boolean) } : {}) }, abort.signal);
      if (!current(abort) || fresh.cwd !== cwd) return;
      setRecord({ scope, value: fresh }); setEditing(null);
      setMessage({ scope, text: action === 'authorize' ? '任务授权已保存，加入本工作区的协作会话会继承；下一次工具调用即按新授权判断。' : '已撤销后续自动批准；已启动的计算不会被强制终止。' });
      onRefresh?.();
    } catch (error) {
      if (!current(abort)) return;
      const code = error instanceof Error ? error.message : '';
      const text = code.includes('revision') || code.includes('scope') ? '授权或研究约定已更新，请刷新并重新核对后保存。' : code.includes('invalid-root') ? '附加目录不可授权：请使用存在的具体项目或数据目录，不能选择系统、个人主目录或凭据目录。' : '任务授权未确认保存，请刷新查看当前状态后再试。';
      setMessage({ scope, text });
    } finally { aborts.current.delete(abort); if (pendingSaveScope.current === scope) pendingSaveScope.current = null; if (generation.current === scope) setBusy(null); }
  }
  return <section className="win11-card-subtle space-y-3 p-4 text-xs" data-testid="research-permissions">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-[var(--text-primary)]">长任务执行授权</h3><p className="mt-1 text-[var(--text-secondary)]">一次核对当前研究任务，授权自动执行与协作分发。</p></div>
      {!draft && <button type="button" className={BUTTON} disabled={!value || busy === scope} onClick={edit} data-testid="research-permissions-edit">{value?.status === 'active' ? '调整任务授权' : '设置无人值守授权'}</button>}</div>
    <p role="status" data-testid="research-permissions-status">{value ? statusLabels[value.status] : '正在加载任务授权…'}</p>
    {value?.task && <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{value.task}</p>}
    {value?.expiresAt && <p className="text-[var(--text-secondary)]">有效期至 {new Date(value.expiresAt).toLocaleString()} · 当前约定下所有已加入的研究协作会话共享</p>}
    {!draft && value?.status === 'active' && <div className="flex flex-wrap gap-2">{Object.entries(labels).filter(([key]) => value.capabilities[key as keyof typeof labels]).map(([key, label]) => <span className="rounded bg-[var(--bg-tertiary)] px-2 py-1 text-[var(--text-secondary)]" key={key}>{label}</span>)}</div>}
    {draft && <div className="space-y-3 border-t border-[var(--border-secondary)] pt-3" data-testid="research-permissions-editor">
      <label className="flex flex-col gap-1">本次任务与交付结论<textarea className={INPUT} rows={3} maxLength={4000} value={draft.task} disabled={busy === scope} data-testid="research-permissions-task" placeholder="例如：完成已约定的消融实验、记录结果并给出结论" onChange={e => setEditing({ scope, draft: { ...draft, task: e.target.value } })} /></label>
      <div className="grid gap-2 sm:grid-cols-2">{Object.entries(labels).map(([key, label]) => <label className="flex items-start gap-2" key={key}><input type="checkbox" checked={draft.capabilities[key as keyof typeof labels]} disabled={busy === scope} onChange={e => setEditing({ scope, draft: { ...draft, capabilities: { ...draft.capabilities, [key]: e.target.checked } } })} /><span>{label}</span></label>)}</div>
      <label className="flex items-center gap-2">授权时长<select className={INPUT} value={draft.durationHours} disabled={busy === scope} data-testid="research-permissions-duration" onChange={e => setEditing({ scope, draft: { ...draft, durationHours: Number(e.target.value) as Draft['durationHours'] } })}>{[12, 24, 48, 72].map(n => <option key={n} value={n}>{n} 小时</option>)}</select></label>
      <details><summary className="cursor-pointer text-[var(--text-secondary)]">附加读写目录（可选）</summary><label className="mt-2 flex flex-col gap-1">当前工作区已包括在内；每行填一个具体目录<textarea className={INPUT} rows={2} value={draft.roots} disabled={busy === scope} placeholder="/data/my-research-project" onChange={e => setEditing({ scope, draft: { ...draft, roots: e.target.value } })} /></label></details>
      <p className="text-[var(--text-secondary)]">保存即批准以上任务和范围，协作会话继承至到期或撤销。原有计算预算、外部服务凭据与材料外发许可继续适用；发表、全局软件安装、远程破坏性操作需要独立授权。超出范围的操作会记录阻塞，智能体继续可执行的工作。</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={BUTTON} data-testid="research-permissions-save" disabled={busy === scope || !draft.task.trim()} onClick={() => void save('authorize')}>{busy === scope ? '保存中…' : '批准并启用长任务授权'}</button><button type="button" className={BUTTON} disabled={busy === scope} onClick={() => setEditing(null)}>取消</button></div>
    </div>}
    {value?.status === 'active' && !draft && <button type="button" className={BUTTON} disabled={busy === scope} onClick={() => void save('revoke')} data-testid="research-permissions-revoke">撤销任务授权</button>}
    {!!value?.blockers.length && <div className="space-y-1 border-t border-[var(--border-secondary)] pt-2" data-testid="research-permissions-blockers"><p className="font-semibold">需要补齐的执行条件</p>{value.blockers.slice(0, 5).map((b, index) => <p className="break-words text-[var(--severity-warning-fg)]" key={`${b.at}-${index}`}>{b.tool} · {b.code === 'file-access-out-of-scope' ? '目录不在预授权范围' : b.code === 'operation-out-of-scope' ? '操作不在预授权范围' : b.code}{b.target ? ` · ${b.target}` : ''}（{b.hits} 次）</p>)}</div>}
    {message?.scope === scope && <p role="alert" className="text-[var(--text-secondary)]" data-testid="research-permissions-message">{message.text}</p>}
    <button type="button" className="text-[var(--text-tertiary)] underline" disabled={busy === scope} onClick={() => void reload().catch(() => setMessage({ scope, text: '刷新失败，请稍后重试。' }))}>刷新授权状态</button>
  </section>;
}
