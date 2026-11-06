import { useCallback, useEffect, useRef, useState } from 'react';
import { randomUuid } from '@blackbelt-technology/dashboard-plugin-runtime';
import { useApiBase } from '../../lib/api/api-context.js';
import {
  getResearchCharterBinding, updateResearchCharterBinding,
  type ResearchCharterBinding, type ResearchCharterBindingUpdate,
} from '../../lib/api/research-charter-binding-api.js';

interface Props {
  cwd: string;
  sessionId?: string | null;
  visible?: boolean;
  connectionGeneration?: number;
  refreshSignal?: string;
  onRebound?: () => void;
}

function bindingLabel(value: ResearchCharterBinding | null, sessionId?: string | null): string {
  if (!value || value.status === 'unavailable') return '目标绑定状态待核对';
  if (value.status === 'not-adopted') return '项目尚未接入 res-workflow';
  if (value.session?.status === 'assignment-stale') return '会话已接入 · 此协作任务仍绑定旧目标';
  const membership = !sessionId ? '' : value.session?.status === 'joined' ? '会话已接入 · '
    : value.session?.status === 'not-joined' ? '会话未接入 · ' : '会话接入状态待核对 · ';
  return membership + (value.status === 'stale'
    ? `目标绑定已过期（当前版本 ${value.currentCharterRevision}）`
    : `目标版本 ${value.currentCharterRevision} 已绑定`);
}

function guidance(value: ResearchCharterBinding | null): string | null {
  if (value?.status === 'not-adopted') return '请通过“资料接入与项目设置”完成项目接入。';
  if (value?.status === 'unavailable') return '暂时无法核对接管凭证与当前目标，请刷新重试。';
  if (value?.session?.status === 'not-joined') return '请在会话菜单选择“并入 res-workflow”。';
  if (value?.session?.status === 'assignment-stale') return '此协作任务保留旧目标范围；请回到主会话按当前目标重新分派。';
  if (value?.session?.status === 'unavailable') return '会话接入记录暂时无法核对，请刷新重试。';
  return value?.status === 'stale' ? '衔接将保留原工作流与历史，追加到当前目标的绑定记录。' : null;
}

/** Selection, workflow membership and charter binding are displayed as separate facts. */
export function ResearchCharterBindingControls({ cwd, sessionId, visible = true, connectionGeneration = 0, refreshSignal, onRebound }: Props) {
  const apiBase = useApiBase();
  const scope = JSON.stringify([apiBase, cwd, sessionId ?? null, connectionGeneration]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writing = useRef<{ scope: string; controller: AbortController } | null>(null);
  const onReboundRef = useRef(onRebound);
  onReboundRef.current = onRebound;
  const [state, setState] = useState<{ scope: string; value: ResearchCharterBinding | null; reading: boolean; saving: boolean; error: string | null }>({ scope, value: null, reading: false, saving: false, error: null });
  const current = state.scope === scope ? state : { value: null, reading: false, saving: false, error: null };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++readSequence.current;
      readController.current?.abort();
      writing.current?.controller.abort();
      writing.current = null;
    };
  }, [scope]);

  const refresh = useCallback(async () => {
    if (writing.current?.scope === scope) return;
    const sequence = ++readSequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const active = () => mounted.current && currentScope.current === scope && sequence === readSequence.current && !controller.signal.aborted;
    setState(previous => ({ scope, value: previous.scope === scope ? previous.value : null, saving: false, reading: true, error: null }));
    try {
      const value = await getResearchCharterBinding(cwd, sessionId || undefined, controller.signal);
      if (active()) setState({ scope, value, saving: false, reading: false, error: null });
    } catch {
      // A failed read is unknown, never evidence that a previously joined session left.
      if (active()) setState({ scope, value: null, saving: false, reading: false, error: '暂时无法核对接入与目标绑定，请刷新重试。' });
    }
  }, [scope, cwd, sessionId]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 15000);
    return () => window.clearInterval(interval);
  }, [refresh, visible, refreshSignal]);

  const value = current.value;
  const canRebind = value?.status === 'stale' && value.canRebind && value.adoptionId && value.boundCharterHash && value.currentCharterHash && value.currentCharterRevision !== null;
  const rebind = async () => {
    if (!canRebind || !value?.adoptionId || !value.boundCharterHash || !value.currentCharterHash || writing.current) return;
    const admitted = value;
    // Freeze exactly the reviewed version. A conflict needs a new read and explicit click.
    const request: ResearchCharterBindingUpdate = {
      cwd: admitted.cwd, adoptionId: value.adoptionId, expectedBindingRevision: admitted.bindingRevision,
      expectedBoundCharterHash: value.boundCharterHash, expectedCharterHash: value.currentCharterHash, requestId: randomUuid(),
    };
    const pending = { scope, controller: new AbortController() };
    writing.current = pending;
    ++readSequence.current;
    readController.current?.abort();
    const active = () => mounted.current && currentScope.current === scope && !pending.controller.signal.aborted;
    setState({ scope, value: admitted, reading: false, saving: true, error: null });
    let acknowledged = false;
    try {
      const receipt = await updateResearchCharterBinding(request, pending.controller.signal);
      if (!active()) return;
      if (receipt.cwd !== admitted.cwd || receipt.adoptionId !== request.adoptionId || receipt.status !== 'current'
        || receipt.boundCharterHash !== request.expectedCharterHash || receipt.currentCharterHash !== request.expectedCharterHash
        || receipt.bindingRevision <= request.expectedBindingRevision) throw new Error('research-charter-binding-unconfirmed');
      acknowledged = true;
      setState({ scope, value: null, reading: true, saving: true, error: null });
      // POST has no session fact. Read it back before displaying membership or assignment readiness.
      const fresh = await getResearchCharterBinding(admitted.cwd, sessionId || undefined, pending.controller.signal);
      if (!active()) return;
      if (fresh.cwd !== admitted.cwd || fresh.adoptionId !== admitted.adoptionId) throw new Error('research-charter-binding-unconfirmed');
      setState({ scope, value: fresh, reading: false, saving: false, error: null });
      onReboundRef.current?.();
    } catch (error) {
      if (!active()) return;
      const conflict = error && typeof error === 'object' && 'status' in error && error.status === 409;
      setState({ scope, value: null, reading: false, saving: false, error: acknowledged
        ? '已收到目标衔接回执，会话状态尚未核对；请刷新确认。'
        : conflict ? '目标版本或接管状态已变化，请刷新核对后再衔接。' : '此次衔接结果尚未确认，请刷新核对。' });
    } finally {
      if (writing.current === pending) writing.current = null;
    }
  };
  const hint = guidance(value);
  const charter = value && (value.status === 'current' || value.status === 'stale') ? value.currentCharter : undefined;
  return <div className="research-charter-binding" data-testid="research-charter-binding">
    <div className="research-charter-binding-row">
      <p data-testid="research-charter-binding-status" aria-live="polite" className={value?.status === 'stale' || value?.session?.status === 'assignment-stale' ? 'research-warning' : undefined}>{bindingLabel(value, sessionId)}</p>
      <button type="button" className="research-workspace-action" data-testid="research-charter-binding-refresh" disabled={current.reading || current.saving} onClick={() => void refresh()} aria-label="刷新目标绑定状态">{current.reading ? '核对中…' : '刷新绑定'}</button>
      {canRebind && <button type="button" className="research-workspace-action" data-testid="research-charter-binding-rebind" disabled={current.saving} onClick={() => void rebind()}>{current.saving ? '正在衔接…' : `衔接到目标版本 ${value?.currentCharterRevision}`}</button>}
    </div>
    {current.error && <p role="alert" className="research-warning" data-testid="research-charter-binding-error">{current.error}</p>}
    {hint && <p className="research-main-agent-caption">{hint}</p>}
    {charter && <details className="research-charter-binding-preview" data-testid="research-charter-binding-preview">
      <summary>查看当前目标与约束</summary>
      <p>目标版本 {charter.revision}：{charter.objective}</p>
      {([
        ['完成标准', charter.successCriteria], ['约束', charter.constraints], ['范围之外', charter.nonGoals],
      ] as const).map(([label, items]) => items?.length ? <div key={label}><strong>{label}</strong><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null)}
    </details>}
  </div>;
}
