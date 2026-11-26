import { useEffect, useRef, useState, type ReactNode } from "react";
import { inferPlatform, pathKey } from "@blackbelt-technology/pi-dashboard-shared/session-group-path.js";
import { useApiBase } from "../../lib/api/api-context.js";
import { ResearchCharterBindingControls } from "./ResearchCharterBindingControls.js";

interface MainAgentSession {
  id: string;
  name?: string;
  cwd: string;
  model?: string;
  status: "active" | "idle" | "streaming" | "ended";
}

/** A workspace's chosen conversation is also the exact target of task submissions. */
export function useResearchMainAgent({ cwd, visible, connectionGeneration, refreshSignal, managed }: {
  cwd: string;
  visible: boolean;
  connectionGeneration?: number;
  refreshSignal?: string;
  managed: { selectedId: string | null; pending: boolean; available: boolean; error: string | null; select(id: string): void };
}) {
  const apiBase = useApiBase();
  const platform = inferPlatform([cwd]);
  const requestedPath = pathKey(cwd, platform);
  const scope = JSON.stringify([apiBase, requestedPath]);
  const [catalogue, setCatalogue] = useState<{ scope: string; canonicalCwd?: string; sessions: MainAgentSession[]; loaded: boolean; error: string | null }>({ scope, sessions: [], loaded: false, error: null });
  const current = catalogue.scope === scope ? catalogue : { canonicalCwd: undefined, sessions: [], loaded: false, error: null };

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const [response, bindingResponse] = await Promise.all([
          fetch(`${apiBase}/api/sessions`, { signal: controller.signal }),
          fetch(`${apiBase}/api/res-workflow/connection?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal }),
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!bindingResponse.ok) throw new Error(`工作目录未确认（HTTP ${bindingResponse.status}）`);
        const binding = await bindingResponse.json();
        if (typeof binding?.cwd !== "string" || !binding.cwd || typeof binding.adopted !== "boolean") throw new Error("工作目录绑定格式无效");
        const canonicalCwd = pathKey(binding.cwd, platform);
        const json = await response.json();
        const rows = Array.isArray(json) ? json : json?.data;
        if (!Array.isArray(rows)) throw new Error("会话列表格式无效");
        const sessions = rows.filter((row): row is MainAgentSession => {
          if (!row || typeof row.id !== "string" || typeof row.cwd !== "string" || row.originDeviceId
            || row.driver && row.driver !== "pi" || !["active", "idle", "streaming", "ended"].includes(row.status)) return false;
          // A recorded canonical membership wins over a cosmetic alias. An alias that now
          // resolves elsewhere must not bring a previously bound participant into that project.
          if (typeof row.resWorkflow?.canonicalCwd === "string") return pathKey(row.resWorkflow.canonicalCwd, platform) === canonicalCwd;
          const sessionPath = pathKey(row.cwd, platform);
          return sessionPath === requestedPath || sessionPath === canonicalCwd;
        });
        if (!disposed) setCatalogue({ scope, canonicalCwd, sessions, loaded: true, error: null });
      } catch (error) {
        if (!disposed) setCatalogue(previous => ({ scope, canonicalCwd: previous.scope === scope ? previous.canonicalCwd : undefined, sessions: previous.scope === scope ? previous.sessions : [], loaded: true, error: error instanceof Error ? error.message : "请求失败" }));
      } finally { pending = false; }
    };
    void load();
    const interval = window.setInterval(load, 8000);
    return () => { disposed = true; controller.abort(); window.clearInterval(interval); };
  }, [apiBase, cwd, scope, requestedPath, platform, visible, connectionGeneration, refreshSignal]);

  const { selectedId, select, available } = managed;
  return { scope, selectedId: current.error ? null : selectedId, session: current.error ? undefined : current.sessions.find(session => session.id === selectedId), sessions: current.sessions,
    loading: !current.loaded || managed.pending, error: current.error ?? managed.error, select, available: available && !current.error };
}

export function ResearchMainAgentControls({ controller, cwd, visible, connectionGeneration, refreshSignal, onRebound, accessSlot, metaSlot, planSlot }: {
  controller: ReturnType<typeof useResearchMainAgent>;
  cwd: string;
  visible?: boolean;
  connectionGeneration?: number;
  refreshSignal?: string;
  onRebound?: () => void;
  accessSlot?: ReactNode;
  metaSlot?: ReactNode;
  planSlot?: ReactNode;
}) {
  const apiBase = useApiBase();
  const { selectedId, session, sessions, loading, error, select, available } = controller;
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setFeedback(null); }, [selectedId]);
  const canSend = Boolean(available && session && session.status !== "ended" && !error && !loading);
  const send = async () => {
    if (!canSend || !session || !draft.trim() || inFlight.current) return;
    const target = session;
    inFlight.current = true;
    setSending(true);
    setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/session/${encodeURIComponent(target.id)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `【研究主 Agent 任务 · 先 Plan 后 Work】\n请严格遵循「先 Plan 后 Work」：先调用 research_dispatch（action="plan"）提交或更新结构化执行 Plan（明确任务拆解、分工角色、依赖关系与 Multi-Agent 对应关系），再按 Plan 分派与启动独立 Multi-Agent（Work）、跟踪并核对交付结果后汇总结论。\n\n${draft.trim()}`,
        }),
      });
      const receipt = await response.json().catch(() => ({}));
      if (!response.ok || receipt.success !== true || receipt.transmitted !== true) {
        throw new Error(receipt.error || `投递未确认${response.ok ? "，服务未返回传输回执" : `（HTTP ${response.status}）`}`);
      }
      if (!mounted.current) return;
      setFeedback({ error: false, message: receipt.simulated === true
        ? `模拟发送至「${target.name || target.id}」（未调用模型）。`
        : `已发送给主会话「${target.name || target.id}」。${receipt.warning ? ` ${receipt.warning}` : ""}` });
      setDraft("");
    } catch (error) {
      if (mounted.current) setFeedback({ error: true, message: `发送失败：${error instanceof Error ? error.message : "请求异常"}。草稿已保留。` });
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return <section className="research-main-agent-controls" data-testid="research-main-agent-controls" aria-label="主会话">
    <div className="research-ribbon-primary">
      <div className="research-main-agent-row">
        <label className="research-main-agent-selector"><span>主会话</span>
          <select data-testid="research-main-agent-select" aria-label="选择主会话" value={selectedId ?? ""} disabled={loading || sending || !available} onChange={event => { if (event.target.value) select(event.target.value); }}>
            <option value="" disabled>{loading ? "加载会话中…" : "选择主会话"}</option>
            {selectedId && !session && <option value={selectedId}>已选会话不可用 · {selectedId}</option>}
            {sessions.map(candidate => <option key={candidate.id} value={candidate.id} disabled={candidate.status === "ended"}>{candidate.name || candidate.id}{candidate.status === "ended" ? " · 已结束" : candidate.status === "streaming" ? " · 运行中" : ""}</option>)}
          </select>
        </label>
        {selectedId && <a data-testid="research-main-agent-open" className="research-workspace-action" href={`/session/${encodeURIComponent(selectedId)}`}>打开对话</a>}
        <button type="button" data-testid="research-main-agent-compose" className="research-workspace-action" aria-expanded={composing} onClick={() => setComposing(open => !open)}>发任务</button>
      </div>
      {accessSlot && (
        <>
          <span aria-hidden="true" className="hidden lg:inline-block h-4 w-px bg-[var(--border-subtle)] shrink-0" />
          <div className="flex flex-wrap items-center gap-2 shrink-0">{accessSlot}</div>
        </>
      )}
    </div>
    <div className="research-ribbon-meta">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <ResearchCharterBindingControls cwd={cwd} sessionId={selectedId} visible={visible} connectionGeneration={connectionGeneration} refreshSignal={refreshSignal} onRebound={onRebound} />
        <p className="research-main-agent-caption !m-0">{error ? `状态未同步：${error}` : session?.status === "ended" ? "该会话已结束，请打开对话恢复后发送。" : selectedId && !session ? "当前会话不在活跃列表中，请重选。" : session ? `${session.model ?? "默认模型"}` : "选定主会话后可下发任务或打开对话。"}</p>
      </div>
      {metaSlot && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{metaSlot}</div>
      )}
    </div>
    {planSlot}
    {composing && <form className="research-main-agent-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea data-testid="research-main-agent-prompt" aria-label="任务描述" rows={3} value={draft} disabled={sending} onChange={event => setDraft(event.target.value)} placeholder="描述目标、输入路径或交付要求…" />
      <button data-testid="research-main-agent-send" type="submit" className="research-workspace-action primary" disabled={!canSend || sending || !draft.trim()}>{sending ? "发送中…" : "发送"}</button>
    </form>}
    {feedback && <p data-testid="research-main-agent-feedback" role={feedback.error ? "alert" : "status"} className={feedback.error ? "research-warning px-3 pb-2 text-xs" : "research-main-agent-caption px-3 pb-2"}>{feedback.message}</p>}
  </section>;
}
