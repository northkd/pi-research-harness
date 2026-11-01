import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import { useEffect, useRef, useState } from "react";
import {
  getResWorkflowResearchBudget, updateResWorkflowResearchBudget,
  type ResWorkflowResearchBudget,
} from "../../lib/api/res-workflow-api.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";

const BUTTON = "win11-btn focus-ring min-h-8 px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const INPUT = "min-w-0 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)]";
type Budget = ResWorkflowResearchBudget;
type Draft = { token: symbol; revision: Budget["revision"]; attempts: string; modelRequests: string };
type Notice = { token: symbol; message: string; reloadRequired: boolean };
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const parseLimit = (value: string): number | null => value.trim() !== "" && integer(Number(value)) ? Number(value) : null;
const limitText = (value: number | null) => value === null ? "未配置" : String(value);
function validBudget(value: Budget, cwd: string): boolean {
  return !!value && value.cwd === cwd && (value.revision === null || typeof value.revision === "string") &&
    !!value.limits && [value.limits.attempts, value.limits.modelRequests].every(n => n === null || integer(n)) &&
    !!value.usage && [value.usage.attempts, value.usage.modelRequests, value.usage.inFlight, value.usage.unknown].every(integer) &&
    !!value.enforcement && typeof value.enforcement.attempts === "boolean" && typeof value.enforcement.modelRequests === "boolean" &&
    value.enforcement.scope === "native-research-workflow" && value.enforcement.physicalTransport === "sse-http";
}

export function ResearchBudgetControls({ cwd, connectionGeneration = 0, onRefresh, observation, observationStale = false }: {
  cwd: string;
  connectionGeneration?: number;
  onRefresh?: () => void;
  observation?: ResearchWorkbenchObservation | null;
  observationStale?: boolean;
}) {
  const apiBase = useApiBase();
  const scope = JSON.stringify([apiBase, cwd, connectionGeneration]);
  const current = useRef({ scope, token: Symbol() });
  if (current.current.scope !== scope) current.current = { scope, token: Symbol() };
  const token = current.current.token;
  const [record, setRecord] = useState<{ token: symbol; value: Budget } | null>(null);
  const [draftState, setDraft] = useState<Draft | null>(null);
  const [noticeState, setNotice] = useState<Notice | null>(null);
  const [savedState, setSaved] = useState<{ token: symbol; message: string } | null>(null);
  const [loadingToken, setLoading] = useState<symbol | null>(null);
  const [savingToken, setSaving] = useState<symbol | null>(null);
  const readController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const budget = record?.token === token ? record.value : null;
  const draft = draftState?.token === token ? draftState : null;
  const notice = noticeState?.token === token ? noticeState : null;
  const saving = savingToken === token;
  const loading = loadingToken === token;
  const observed = observation?.schema === "res-workflow.workbench-observation.v1" && observation.cwd === cwd
    && observation.observedUsage?.metric === "observed-assistant-responses"
    && [observation.observedUsage.responses, observation.observedUsage.inputTokens, observation.observedUsage.outputTokens, observation.observedUsage.inheritedExcluded].every(integer)
    ? observation : null;
  const isCurrent = (abort: AbortController) => !abort.signal.aborted && current.current.token === token && getApiBase() === apiBase;

  async function load(explicitReload = false) {
    if (saveController.current || !explicitReload && readController.current) return;
    readController.current?.abort();
    const abort = new AbortController(), sequence = ++readSequence.current;
    readController.current = abort; setLoading(token);
    try {
      const next = await getResWorkflowResearchBudget(cwd, abort.signal);
      if (!isCurrent(abort) || sequence !== readSequence.current) return;
      if (!validBudget(next, cwd)) throw new Error("research-budget-response-invalid");
      setRecord({ token, value: next });
      if (explicitReload) {
        setDraft(null); setNotice(null); setSaved({ token, message: "已加载最新预算，请重新编辑。" });
      } else {
        setNotice(previous => previous?.token === token && previous.reloadRequired ? previous : null);
      }
    } catch {
      if (isCurrent(abort) && sequence === readSequence.current) setNotice(previous => previous?.token === token && previous.reloadRequired ? previous : {
        token, reloadRequired: false, message: "暂时无法读取当前研究预算；保留上次显示的记录，未保存任何更改。",
      });
    } finally {
      if (readController.current === abort) readController.current = null;
      if (current.current.token === token && sequence === readSequence.current) setLoading(null);
    }
  }

  useEffect(() => {
    void load();
    const poll = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(poll, 5_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer); document.removeEventListener("visibilitychange", poll);
      ++readSequence.current; readController.current?.abort(); readController.current = null;
      saveController.current?.abort(); saveController.current = null;
    };
  }, [scope]);

  const edit = () => {
    if (!budget || saving || notice?.reloadRequired) return;
    setDraft({ token, revision: budget.revision, attempts: String(budget.limits.attempts ?? 60), modelRequests: budget.limits.modelRequests === null ? "" : String(budget.limits.modelRequests) });
    setNotice(null); setSaved(null);
  };
  const attempts = draft ? parseLimit(draft.attempts) : null;
  const modelRequests = draft ? parseLimit(draft.modelRequests) : null;
  async function save() {
    if (!draft || attempts === null || modelRequests === null || saving || saveController.current || notice?.reloadRequired || current.current.token !== token || getApiBase() !== apiBase) return;
    readController.current?.abort(); readController.current = null; ++readSequence.current;
    const abort = new AbortController(); saveController.current = abort; setSaving(token); setNotice(null); setSaved(null);
    try {
      const next = await updateResWorkflowResearchBudget({ cwd, expectedRevision: draft.revision, requestId: randomUuid(), limits: { attempts, modelRequests } }, abort.signal);
      if (!isCurrent(abort)) return;
      if (!validBudget(next, cwd)) throw new Error("research-budget-response-invalid");
      setRecord({ token, value: next }); setDraft(null); setSaved({ token, message: "研究预算已保存；未启动研究，也未取消在途请求。" });
      onRefresh?.();
    } catch (error) {
      if (isCurrent(abort)) {
        const conflict = !!error && typeof error === "object" && "status" in error && error.status === 409;
        setNotice({ token, reloadRequired: true, message: conflict
          ? "预算版本或当前状态发生冲突。输入已保留；请重新加载最新预算，再重新编辑。不会自动重试保存。"
          : "暂时无法确认保存结果。输入已保留；请重新加载最新预算后核对，页面不会自动重试。" });
      }
    } finally {
      if (saveController.current === abort) saveController.current = null;
      if (current.current.token === token) setSaving(null);
    }
  }

  return <section data-testid="research-budget" className="win11-card-subtle space-y-3 p-4 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] pb-2.5"><h2 className="text-sm font-semibold text-[var(--text-primary)]">研究预算</h2>
      {!draft && <button type="button" className={BUTTON} data-testid="research-budget-edit" disabled={!budget || saving || !!notice?.reloadRequired} onClick={edit}>修改研究预算</button>}
    </div>
    <p className="leading-relaxed text-[var(--text-secondary)]">研究尝试包含收窄记录；预算表中的模型请求按受控研究通道统计，包含重试。已接入会话及子代理的观测用量在下方单列。</p>
    {!budget && <p role="status" className="text-[var(--text-secondary)]">{loading ? "正在读取研究预算…" : "当前研究预算尚不可用。"}</p>}
    {budget && <>
      <div className="overflow-x-auto rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)]"><table className="w-full text-left border-collapse"><thead><tr className="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]"><th className="px-3 py-2 font-semibold">类别</th><th className="px-3 py-2 font-semibold">当前上限</th><th className="px-3 py-2 font-semibold">已用</th><th className="px-3 py-2 font-semibold">剩余</th><th className="px-3 py-2 font-semibold">执行约束</th></tr></thead><tbody className="divide-y divide-[var(--border-primary)]">
        {(["attempts", "modelRequests"] as const).map(kind => <tr key={kind} data-testid={kind === "attempts" ? "research-budget-attempt-row" : "research-budget-model-row"}>
          <th className="px-3 py-2.5 font-medium text-[var(--text-primary)]">{kind === "attempts" ? "研究尝试" : "模型请求（受控通道）"}</th><td className="px-3 py-2.5 font-mono">{limitText(budget.limits[kind])}</td><td className="px-3 py-2.5 font-mono">{budget.usage[kind]}</td>
          <td className="px-3 py-2.5 font-mono font-semibold text-[var(--accent-text)]">{budget.limits[kind] === null ? "未配置" : Math.max(0, budget.limits[kind]! - budget.usage[kind])}</td>
          <td className="px-3 py-2.5">{budget.enforcement[kind] ? "已接管" : "未接管 · 不保证硬限制"}</td>
        </tr>)}
      </tbody></table></div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
        <p>模型请求：在途 {budget.usage.inFlight} · 结果未确认 {budget.usage.unknown}</p>
        <p>更新于 {budget.updatedAt && Number.isFinite(Date.parse(budget.updatedAt)) ? new Date(budget.updatedAt).toLocaleString() : "尚无保存记录"}</p>
      </div>
    </>}
    <div data-testid="research-budget-observed-usage" className="space-y-1.5 border-t border-[var(--border-primary)] pt-3">
      <p className="font-semibold text-[var(--text-primary)]">加入工作台后的会话与子代理观测用量</p>
      {observed ? <>
        <p data-testid="research-budget-observed-responses">已观测模型响应至少 {observed.observedUsage.responses} 次 · 输入 {observed.observedUsage.inputTokens} tokens · 输出 {observed.observedUsage.outputTokens} tokens</p>
        {observed.observedUsage.inheritedExcluded > 0 && <p>已排除 {observed.observedUsage.inheritedExcluded} 条继承的历史响应，避免重复计数。</p>}
        {observationStale && <p role="status">观测记录已过期，当前显示上次取得的用量。</p>}
        {observed.coverage.partial && <p role="status">正在补齐已接入会话记录，当前观测尚不完整。</p>}
      </> : <p>尚无可核验的会话用量观测，实际调用次数仍未知。</p>}
      <p className="text-[var(--text-secondary)]">观测数来自已保存的模型响应，未保存的失败和重试可能未计入；受控请求可能也出现在这里，两项不能相加。观测计数不表示硬限制已接管，不包含接入助手或外部 agy。</p>
    </div>
    <p>调低额度不会取消在途请求，也不会清零已用次数；调高额度可能允许后续模型请求并产生费用。保存只修改预算，不启动研究，不改目标、当前运行或模型。</p>
    {draft && <div className="space-y-3 border-t border-[var(--border-secondary)] pt-3" data-testid="research-budget-editor">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-0 flex-col gap-1">研究尝试上限<input className={INPUT} data-testid="research-budget-attempts" type="number" min="0" step="1" value={draft.attempts} disabled={saving || !!notice?.reloadRequired} onChange={event => setDraft({ ...draft, attempts: event.target.value })} /></label>
        <label className="flex min-w-0 flex-col gap-1">模型请求上限<input className={INPUT} data-testid="research-budget-model-requests" type="number" min="0" step="1" placeholder="未配置，请明确填写" value={draft.modelRequests} disabled={saving || !!notice?.reloadRequired} onChange={event => setDraft({ ...draft, modelRequests: event.target.value })} /></label>
      </div>
      {budget?.limits.attempts === null && <p>研究尝试尚未配置；60 是待你确认的初始值，填写后保存才生效。</p>}
      <p className="text-[var(--text-secondary)]">两个上限都需填写为非负安全整数，0 表示上限为零，未接管时不保证执行拦截。进度会自动更新，未保存输入会保留；保存仍核对开始编辑时的预算版本。</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={BUTTON} data-testid="research-budget-save" aria-busy={saving} disabled={saving || attempts === null || modelRequests === null || !!notice?.reloadRequired} onClick={() => void save()}>{saving ? "保存中…" : "保存研究预算"}</button>
        <button type="button" className={BUTTON} disabled={saving} onClick={() => setDraft(null)}>取消编辑</button>
      </div>
    </div>}
    {notice && <p role="alert" data-testid="research-budget-error" className="break-words text-[var(--severity-warning-fg)]">{notice.message}</p>}
    {notice && <button type="button" className={BUTTON} data-testid="research-budget-reload" disabled={saving || loading} onClick={() => void load(true)}>重新加载最新预算</button>}
    {savedState?.token === token && <p role="status">{savedState.message}</p>}
  </section>;
}
