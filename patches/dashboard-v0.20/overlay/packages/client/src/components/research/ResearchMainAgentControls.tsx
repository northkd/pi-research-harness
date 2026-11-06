import { useEffect, useRef, useState } from "react";
import { inferPlatform, pathKey } from "@blackbelt-technology/pi-dashboard-shared/session-group-path.js";
import { useApiBase } from "../../lib/api/api-context.js";

interface MainAgentSession {
  id: string;
  name?: string;
  cwd: string;
  model?: string;
  status: "active" | "idle" | "streaming" | "ended";
}

type Preference = { key: string; id: string | null | undefined };
const selectionEvent = "res-workflow-main-agent-change";
function readPreference(key: string): Preference {
  try {
    const saved = window.localStorage.getItem(key);
    return { key, id: saved === null ? undefined : saved || null };
  } catch { return { key, id: undefined }; }
}

/** A workspace's chosen conversation is also the exact target of task submissions. */
export function useResearchMainAgent({ cwd, activeSessionId, visible, connectionGeneration, refreshSignal }: {
  cwd: string;
  activeSessionId?: string;
  visible: boolean;
  connectionGeneration?: number;
  refreshSignal?: string;
}) {
  const apiBase = useApiBase();
  const platform = inferPlatform([cwd]);
  const requestedPath = pathKey(cwd, platform);
  const scope = JSON.stringify([apiBase, requestedPath]);
  const [catalogue, setCatalogue] = useState<{ scope: string; canonicalCwd?: string; sessions: MainAgentSession[]; loaded: boolean; error: string | null }>({ scope, sessions: [], loaded: false, error: null });
  const current = catalogue.scope === scope ? catalogue : { canonicalCwd: undefined, sessions: [], loaded: false, error: null };
  const key = `res_workflow_main_agent:${JSON.stringify([apiBase, current.canonicalCwd ?? requestedPath])}`;
  const [preference, setPreference] = useState(() => readPreference(key));
  const choice = preference.key === key ? preference : readPreference(key);
  const select = (id: string | null) => {
    setPreference({ key, id });
    try { window.localStorage.setItem(key, id ?? ""); } catch { /* The mounted workspace still keeps the explicit choice. */ }
    window.dispatchEvent(new CustomEvent(selectionEvent, { detail: { key, id } }));
  };

  useEffect(() => {
    setPreference(readPreference(key));
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) setPreference(readPreference(key)); };
    const onSelection = (event: Event) => {
      const detail = (event as CustomEvent<Preference>).detail;
      if (detail?.key === key && (typeof detail.id === "string" || detail.id === null)) setPreference(detail);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(selectionEvent, onSelection);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(selectionEvent, onSelection); };
  }, [key]);

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

  const defaultSession = current.sessions.find(session => session.id === activeSessionId && session.status !== "ended");
  const selectedId = choice.id === undefined ? defaultSession?.id ?? null : choice.id;
  useEffect(() => {
    // Capture the initial active conversation once, so opening a collaborator later cannot silently retarget a task.
    if (choice.id === undefined && defaultSession && !current.error) {
      const latest = readPreference(key);
      if (latest.id !== undefined) setPreference(latest);
      else select(defaultSession.id);
    }
  }, [key, choice.id, defaultSession?.id, current.error]);

  return { scope, selectedId, session: current.sessions.find(session => session.id === selectedId), sessions: current.sessions, loading: !current.loaded, error: current.error, select };
}

export function ResearchMainAgentControls({ controller }: { controller: ReturnType<typeof useResearchMainAgent> }) {
  const apiBase = useApiBase();
  const { selectedId, session, sessions, loading, error, select } = controller;
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setFeedback(null); }, [selectedId]);
  const canSend = Boolean(session && session.status !== "ended" && !error && !loading);
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
        body: JSON.stringify({ text: `【研究主 Agent 任务】\n请负责拆解任务、分派适合独立执行的工作、核对交付结果并汇总结论。\n\n${draft.trim()}` }),
      });
      const receipt = await response.json().catch(() => ({}));
      if (!response.ok || receipt.success !== true || receipt.transmitted !== true) {
        throw new Error(receipt.error || `投递未确认${response.ok ? "，服务未返回传输回执" : `（HTTP ${response.status}）`}`);
      }
      if (!mounted.current) return;
      setFeedback({ error: false, message: receipt.simulated === true
        ? `已完成向主 Agent「${target.name || target.id}」的模拟投递；未调用模型。`
        : `已提交给主 Agent「${target.name || target.id}」，等待会话执行。${receipt.warning ? ` ${receipt.warning}` : ""}` });
      setDraft("");
    } catch (error) {
      if (mounted.current) setFeedback({ error: true, message: `提交失败：${error instanceof Error ? error.message : "请求异常"}。草稿已保留。` });
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return <section className="research-main-agent-controls" data-testid="research-main-agent-controls" aria-label="主 Agent">
    <div className="research-main-agent-row">
      <label className="research-main-agent-selector"><span>主 Agent</span>
        <select data-testid="research-main-agent-select" aria-label="选择主 Agent" value={selectedId ?? ""} disabled={loading || sending} onChange={event => select(event.target.value || null)}>
          <option value="">{loading ? "正在读取会话…" : "选择本项目的 Pi 会话"}</option>
          {selectedId && !session && <option value={selectedId}>已选会话不可用 · {selectedId}</option>}
          {sessions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}{candidate.status === "ended" ? " · 已结束" : candidate.status === "streaming" ? " · 执行中" : ""}</option>)}
        </select>
      </label>
      {selectedId && <a data-testid="research-main-agent-open" className="research-workspace-action" href={`/session/${encodeURIComponent(selectedId)}`}>打开主对话</a>}
      <button type="button" data-testid="research-main-agent-compose" className="research-workspace-action" aria-expanded={composing} onClick={() => setComposing(open => !open)}>发送任务</button>
    </div>
    <p className="research-main-agent-caption">{error ? `会话状态未同步：${error}` : session?.status === "ended" ? "该会话已结束；请打开主对话恢复会话后再发送。" : selectedId && !session ? "所选会话不在当前可用列表中，请重新选择。" : session ? `任务发送到此会话${session.model ? ` · ${session.model}` : ""}` : "选择后，打开主对话和发送任务均使用该会话。"}</p>
    {composing && <form className="research-main-agent-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea data-testid="research-main-agent-prompt" aria-label="给主 Agent 的任务" rows={3} value={draft} disabled={sending} onChange={event => setDraft(event.target.value)} placeholder="描述目标、已有资料和需要交付的结果…" />
      <button data-testid="research-main-agent-send" type="submit" className="research-workspace-action primary" disabled={!canSend || sending || !draft.trim()}>{sending ? "正在提交…" : "提交给主 Agent"}</button>
    </form>}
    {feedback && <p data-testid="research-main-agent-feedback" role={feedback.error ? "alert" : "status"} className={feedback.error ? "research-warning" : "research-main-agent-caption"}>{feedback.message}</p>}
  </section>;
}
