import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { Icon } from "@mdi/react";
import { mdiTuneVariant, mdiDragVertical, mdiPlay, mdiRefresh, mdiInformationOutline } from "@mdi/js";
import { Dialog } from "@blackbelt-technology/pi-dashboard-client-utils/Dialog";
import type { ResearchCollaborationPlan, ResearchCollaborationTask, ResearchNativeQueueItem } from "@blackbelt-technology/pi-dashboard-shared/research-collaboration.js";
import type { ResearchCollaborationController } from "./use-research-collaboration.js";
import "./research-collaboration-controls.css";

type Feedback = { error: boolean; text: string } | null;
/** Async feedback belongs to the exact mounted workspace, including A→B→A.
 * The transport hook aborts stale requests, but their rejection still settles. */
function useFeedbackGuard(scope: string) {
  const context = useRef({ scope, generation: 0, mounted: true });
  if (context.current.scope !== scope) { context.current.scope = scope; context.current.generation++; }
  useEffect(() => {
    context.current.mounted = true;
    return () => { context.current.mounted = false; context.current.generation++; };
  }, [scope]);
  return () => { const generation = context.current.generation; return () => context.current.mounted && context.current.generation === generation; };
}
const activeTask = (status: string) => ["launching", "running", "recovery-required"].includes(status);
const queuedTasks = (plan: ResearchCollaborationPlan) => plan.tasks.filter(task => task.status === "queued")
  .sort((a, b) => (a.rank ?? plan.tasks.indexOf(a)) - (b.rank ?? plan.tasks.indexOf(b)));
export function moveQueuedTask(ids: string[], from: string, to: string): string[] {
  if (from === to || !ids.includes(from) || !ids.includes(to)) return ids;
  const next = ids.filter(id => id !== from);
  next.splice(ids.indexOf(to), 0, from);
  return next;
}

export function ResearchConcurrencyControls({ controller }: { controller: ResearchCollaborationController }) {
  const { snapshot, stale, loading, busy } = controller;
  const [open, setOpen] = useState(false);
  const [multi, setMulti] = useState("4"), [sub, setSub] = useState("3");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const openedRevision = useRef<number | null>(null);
  const dialogGeneration = useRef(0);
  const captureFeedback = useFeedbackGuard(controller.scope);
  const labelId = useId();
  useEffect(() => { dialogGeneration.current++; setOpen(false); setFeedback(null); }, [controller.scope]);
  const begin = () => {
    if (!snapshot) return;
    dialogGeneration.current++;
    openedRevision.current = snapshot.revision;
    setMulti(String(snapshot.limits.maxMultiAgents)); setSub(String(snapshot.limits.maxSubagents)); setFeedback(null); setOpen(true);
  };
  const maxMulti = snapshot?.limitMaximums.maxMultiAgents ?? 32, maxSub = snapshot?.limitMaximums.maxSubagents ?? 32;
  const valid = /^\d+$/.test(multi) && /^\d+$/.test(sub) && Number(multi) >= 1 && Number(multi) <= maxMulti && Number(sub) >= 1 && Number(sub) <= maxSub;
  const save = async () => {
    if (!valid || busy || stale) return;
    const sameScope = captureFeedback(), generation = dialogGeneration.current;
    const relevant = () => sameScope() && generation === dialogGeneration.current;
    try {
      const value = await controller.mutate("limits", { maxMultiAgents: Number(multi), maxSubagents: Number(sub), expectedRevision: openedRevision.current });
      if (!value || !relevant()) return;
      if (value.limits.maxMultiAgents !== Number(multi) || value.limits.maxSubagents !== Number(sub)) throw new Error("设置回执与提交值不一致，请刷新核对。");
      setOpen(false); setFeedback({ error: false, text: `已生效：每个主 Agent 最多 ${value.limits.maxMultiAgents} 个 Multi-agent；每个 Multi-agent 最多 ${value.limits.maxSubagents} 个 Subagent 同时执行。` });
    } catch (error) {
      if (!relevant()) return;
      setFeedback({ error: true, text: error instanceof Error ? error.message : "设置未确认，输入已保留。" });
      // Keep the user's values, but let an explicit second click review a newly
      // read revision. Never replay the setting automatically after a conflict.
      const fresh = await controller.refresh();
      if (fresh && relevant()) openedRevision.current = fresh.revision;
    }
  };
  return <div className="research-concurrency-controls" data-testid="research-concurrency-controls">
    <button type="button" className="research-concurrency-trigger" data-testid="research-concurrency-open" onClick={begin} disabled={loading || busy || stale || !snapshot} title="调整实时并发席位；不会中断正在运行的任务">
      <Icon path={mdiTuneVariant} size={0.65} />
      <span>并发设置</span>
      {snapshot && <span className="research-concurrency-values">Multi <b>{snapshot.limits.maxMultiAgents}</b><span> / </span>Sub <b>{snapshot.limits.maxSubagents}</b></span>}
    </button>
    {feedback && !open && <span className={feedback.error ? "research-warning" : "research-concurrency-saved"} role={feedback.error ? "alert" : "status"}>{feedback.error ? feedback.text : "已实时生效"}</span>}
    <Dialog open={open} onClose={() => { if (!busy) { dialogGeneration.current++; setOpen(false); } }} title="调整分发并发数" size="md" testId="research-concurrency-dialog">
      <form className="research-collaboration-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p id={labelId}>这是同时执行的数量，不是本次研究的任务总数。超过限制的任务会提前登记并进入队列。</p>
        <label><span>每个主 Agent 的 Multi-agents</span><input aria-label="Multi-agents 并发数" aria-describedby={labelId} data-testid="research-limit-multi" type="number" min="1" max={maxMulti} step="1" value={multi} disabled={busy} onChange={event => setMulti(event.target.value)} /></label>
        <label><span>每个 Multi-agent 的 Subagents</span><input aria-label="Subagents 并发数" aria-describedby={labelId} data-testid="research-limit-sub" type="number" min="1" max={maxSub} step="1" value={sub} disabled={busy} onChange={event => setSub(event.target.value)} /></label>
        <div className="research-collaboration-note"><Icon path={mdiInformationOutline} size={0.7} /><span>提高后补发未暂停队列中的就绪任务；降低后等待现有任务自然结束。暂停状态、依赖、项目权限和内存检查仍有效。</span></div>
        {snapshot?.operationalLimits && <p className="research-collaboration-operational">当前主机的独立研究会话总执行保护上限为 {snapshot.operationalLimits.maxTotal}；原生 Subagent 使用独立执行进程。这里不会增加研究预算或审批门槛。</p>}
        {!valid && <p role="alert" className="research-warning">请输入 1–{maxMulti} / 1–{maxSub} 之间的整数。</p>}
        {feedback?.error && <p role="alert" className="research-warning">{feedback.text}</p>}
        <div className="research-collaboration-dialog-actions"><button type="button" className="research-workspace-action" disabled={busy} onClick={() => { dialogGeneration.current++; setOpen(false); }}>取消</button><button type="submit" className="research-workspace-action primary" disabled={!valid || busy || stale}>{busy ? "正在应用…" : "保存并立即生效"}</button></div>
      </form>
    </Dialog>
  </div>;
}

function dependencyLabel(plan: ResearchCollaborationPlan, task: ResearchCollaborationTask) {
  const prerequisites = task.dependsOn.map(id => plan.tasks.find(row => row.id === id));
  if (prerequisites.some(row => !row || row.status !== "completed")) return "依赖未满足";
  if (plan.schedulingPaused === true) return "分发已暂停";
  const reason = `${task.queueReason ?? ""} ${task.error ?? ""}`;
  if (/main.*not.selected/.test(reason)) return "等待选择主 Agent";
  if (/memory/.test(reason)) return "等待可用内存";
  if (/resource/.test(reason)) return "等待资源检查";
  if (/limit|capacity/.test(reason)) return "等待空位";
  if (reason.trim()) return "等待调度检查";
  return "就绪";
}

function PlanQueue({ plan, controller, sessionName }: { plan: ResearchCollaborationPlan; controller: ResearchCollaborationController; sessionName: (id: string) => string }) {
  const captureFeedback = useFeedbackGuard(JSON.stringify([controller.scope, plan.id]));
  const queued = queuedTasks(plan), ids = queued.map(task => task.id);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const drag = useRef<{ id: string; revision: number; ids: string[] } | null>(null);
  const current = controller.snapshot?.tenures.find(tenure => tenure.id === controller.snapshot?.currentTenureId);
  const isCurrent = Boolean(current && (plan.tenureId ? plan.tenureId === current.id : current.sessionIds.includes(plan.parentSessionId)));
  const disabled = controller.busy || controller.stale || !isCurrent;
  useEffect(() => { setFeedback(null); drag.current = null; setDragId(null); setOverId(null); }, [plan.id, controller.scope]);
  useEffect(() => { if (drag.current && drag.current.revision !== plan.revision) { drag.current = null; setDragId(null); setOverId(null); setFeedback({ error: true, text: "队列刚刚发生变化，请按最新顺序重新拖动。" }); } }, [plan.revision]);
  const reorder = async (next: string[], revision = plan.revision) => {
    if (disabled || next.join("\0") === ids.join("\0")) return;
    const relevant = captureFeedback();
    setFeedback(null);
    try { const result = await controller.mutate("reorder", { planId: plan.id, sessionId: plan.parentSessionId, taskIds: next, queueRevision: revision }); if (result && relevant()) setFeedback({ error: false, text: "队列顺序已保存。" }); }
    catch (error) { if (relevant()) setFeedback({ error: true, text: error instanceof Error ? error.message : "排序未确认，已保留服务端顺序。" }); }
  };
  const drop = (event: DragEvent, target: string) => {
    event.preventDefault();
    const picked = drag.current;
    drag.current = null; setOverId(null); setDragId(null);
    if (picked && !disabled) void reorder(moveQueuedTask(picked.ids, picked.id, target), picked.revision);
  };
  const start = async (task: ResearchCollaborationTask) => {
    if (disabled || plan.schedulingPaused === true || dependencyLabel(plan, task) === "依赖未满足") return;
    const relevant = captureFeedback();
    setFeedback(null);
    try {
      const result = await controller.mutate("start", { planId: plan.id, sessionId: plan.parentSessionId, taskId: task.id, queueRevision: plan.revision });
      if (!result || !relevant()) return;
      const returnedPlan = result.plans.find(row => row.id === plan.id);
      const started = returnedPlan?.tasks.find(row => row.id === task.id);
      if (!started) throw new Error("回执中未找到该任务，请刷新核对，暂不重复启动。");
      if (["failed", "cancelled", "blocked"].includes(started.status)) throw new Error("任务未启动，状态已变化；请查看任务详情。");
      if (started.status === "recovery-required") throw new Error("已有启动尝试的结果待核实，未重复启动。");
      setFeedback({ error: false, text: started.status === "completed" ? "任务已完成。" : activeTask(started.status) ? "任务已进入启动流程。" : returnedPlan?.schedulingPaused === true ? "队列已暂停；任务尚未启动，恢复分发后才会继续调度。" : "已优先排队；有可用席位且检查通过后立即启动，不中断现有任务。" });
    } catch (error) { if (relevant()) setFeedback({ error: true, text: error instanceof Error ? error.message : "启动结果未确认，请核对任务状态。" }); }
  };
  const count = plan.tasks.filter(task => activeTask(task.status)).length;
  return <div className="research-plan-queue" data-testid="research-plan-queue" data-plan-id={plan.id}>
    <div className="research-queue-scope"><span>{sessionName(plan.parentSessionId)}</span><span>{plan.schedulingPaused === true ? "分发已暂停 · " : ""}{count} / {plan.effectiveConcurrency ?? plan.concurrency} 席使用中</span></div>
    <ol className="research-dispatch-cards" aria-label={`${sessionName(plan.parentSessionId)} 的待调度队列`}>
      {queued.map((task, index) => {
        const label = dependencyLabel(plan, task), blocked = label === "依赖未满足";
        const title = task.task.trim().split("\n").find(Boolean) || task.role;
        return <li key={task.id} className={`research-dispatch-card${dragId === task.id ? " is-dragging" : ""}${overId === task.id && dragId !== task.id ? " is-drop-target" : ""}`} data-testid="research-queue-card" data-task-id={task.id}
          draggable={!disabled} onDragStart={event => { if (disabled) { event.preventDefault(); return; } drag.current = { id: task.id, revision: plan.revision, ids }; setDragId(task.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); }}
          onDragOver={event => { if (drag.current && !disabled) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOverId(task.id); } }} onDrop={event => drop(event, task.id)}
          onDragEnd={() => { drag.current = null; setDragId(null); setOverId(null); }}>
          <button type="button" className="research-queue-grip" aria-label={`移动任务 ${title}`} title="拖动排序，或按左右方向键移动" disabled={disabled}
            onKeyDown={event => { const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0; if (!offset) return; event.preventDefault(); const target = ids[index + offset]; if (target) void reorder(moveQueuedTask(ids, task.id, target)); }}><Icon path={mdiDragVertical} size={0.75} /></button>
          <div className="research-queue-card-body"><div className="research-queue-card-title"><span className="research-queue-rank">{String(index + 1).padStart(2, "0")}</span><strong title={task.task}>{title}</strong></div>
            <span className="research-queue-role" title={`${task.role} · 模型在启动时确定，尚未调用`}>{task.role} · 模型待启动确认</span>
            <div className="research-queue-card-footer"><span className={`research-queue-state ${blocked ? "is-blocked" : label === "就绪" ? "is-ready" : "is-waiting"}`} title={task.queueReason || task.error}><i />{label}</span>
              <button type="button" className="research-queue-start" disabled={disabled || blocked || plan.schedulingPaused === true} onClick={() => { void start(task); }} title={plan.schedulingPaused === true ? "分发已暂停；恢复队列后才能启动，拖动和调整并发数不会自动恢复" : blocked ? "先完成前置任务；拖动不能绕过依赖" : "有空位时立即开始；满额时优先排队，不抢占正在运行的任务"}><Icon path={mdiPlay} size={0.6} />立即开始</button></div>
          </div>
        </li>;
      })}
    </ol>
    {feedback && <p className={feedback.error ? "research-warning" : "research-queue-feedback"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
  </div>;
}

function NativeQueue({ items, controller, sessionName }: { items: ResearchNativeQueueItem[]; controller: ResearchCollaborationController; sessionName: (id: string) => string }) {
  const captureFeedback = useFeedbackGuard(controller.scope);
  const queued = [...items].sort((a, b) => a.rank - b.rank || a.createdAt.localeCompare(b.createdAt));
  const ids = queued.map(item => item.id), parent = queued[0]?.parentSessionId;
  const revision = controller.snapshot?.revision ?? -1;
  const [overId, setOverId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const drag = useRef<{ id: string; ids: string[]; revision: number } | null>(null);
  const disabled = controller.busy || controller.stale;
  useEffect(() => { drag.current = null; setOverId(null); setFeedback(null); }, [controller.scope, parent]);
  useEffect(() => {
    if (drag.current && drag.current.revision !== revision) {
      drag.current = null; setOverId(null);
      setFeedback({ error: true, text: "Subagent 队列已更新，请按最新顺序重新拖动。" });
    }
  }, [revision]);
  const reorder = async (next: string[], expectedRevision = revision) => {
    if (!parent || disabled || next.join("\0") === ids.join("\0")) return;
    const relevant = captureFeedback();
    try {
      const result = await controller.mutate("native-reorder", { sessionId: parent, taskIds: next, expectedRevision });
      if (result && relevant()) setFeedback({ error: false, text: "Subagent 排队顺序已保存。" });
    } catch (error) { if (relevant()) setFeedback({ error: true, text: error instanceof Error ? error.message : "排序未确认，请核对服务端顺序。" }); }
  };
  if (!parent) return null;
  return <div className="research-plan-queue research-native-queue">
    <div className="research-queue-scope"><span>Subagents · 来源：{sessionName(parent)}</span><span>候补 {queued.length}</span></div>
    <ol className="research-dispatch-cards" aria-label={`${sessionName(parent)} 的 Subagent 队列`}>
      {queued.map((item, index) => {
        const title = item.task?.trim().split("\n").find(Boolean) || item.role;
        return <li key={item.id} className={`research-dispatch-card${overId === item.id && drag.current?.id !== item.id ? " is-drop-target" : ""}`} data-testid="research-native-queue-item" data-task-id={item.id}
          draggable={!disabled} onDragStart={event => { if (disabled) { event.preventDefault(); return; } drag.current = { id: item.id, ids, revision }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }}
          onDragOver={event => { if (drag.current && !disabled) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOverId(item.id); } }}
          onDrop={event => { event.preventDefault(); const picked = drag.current; drag.current = null; setOverId(null); if (picked) void reorder(moveQueuedTask(picked.ids, picked.id, item.id), picked.revision); }}
          onDragEnd={() => { drag.current = null; setOverId(null); }}>
          <button type="button" className="research-queue-grip" aria-label={`移动 Subagent ${title}`} title="拖动排序，或按左右方向键移动" disabled={disabled}
            onKeyDown={event => { const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0; if (!offset) return; event.preventDefault(); const target = ids[index + offset]; if (target) void reorder(moveQueuedTask(ids, item.id, target)); }}><Icon path={mdiDragVertical} size={0.75} /></button>
          <div className="research-queue-card-body"><div className="research-queue-card-title"><span className="research-queue-rank">{String(index + 1).padStart(2, "0")}</span><strong title={item.task || item.role}>{title}</strong></div>
            <span className="research-queue-role" title={item.model ? `计划模型：${item.model}` : "模型在启动时确定"}>{item.role} · {item.model || "模型待启动确认"}</span>
            <div className="research-queue-card-footer"><span className="research-queue-state is-waiting"><i />等待 Subagent 席位</span></div>
          </div>
        </li>;
      })}
    </ol>
    {feedback && <p className={feedback.error ? "research-warning" : "research-queue-feedback"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
  </div>;
}

export function ResearchDispatchQueue({ controller, sessionName = id => id }: { controller: ResearchCollaborationController; sessionName?: (id: string) => string }) {
  const { snapshot } = controller;
  const [expanded, setExpanded] = useState(false);
  const plans = useMemo(() => {
    const current = snapshot?.tenures.find(tenure => tenure.id === snapshot.currentTenureId);
    return snapshot?.plans.filter(plan => plan.tasks.some(task => task.status === "queued")
      && (plan.tenureId ? plan.tenureId === current?.id : !current || current.sessionIds.includes(plan.parentSessionId))
      && !snapshot.detachedSessionIds.includes(plan.parentSessionId)) ?? [];
  }, [snapshot]);
  const native = snapshot?.nativeQueue.filter(item => item.status === "queued" && item.tenureId === snapshot.currentTenureId) ?? [];
  const nativeParents = [...new Set(native.map(item => item.parentSessionId))];
  const total = plans.reduce((sum, plan) => sum + queuedTasks(plan).length, 0) + native.length;
  const shownPlans = expanded ? plans : plans.slice(0, 3);
  return <section className="research-dispatch-queue" data-testid="research-dispatch-queue" aria-label="待调度队列">
    <header><div><h3>待调度队列 <span>({total})</span></h3><span className="research-queue-hint">拖动调整同一队列的优先级 · 不绕过依赖</span></div><button type="button" className="research-queue-refresh" disabled={controller.busy || controller.loading} onClick={() => { void controller.refresh(); }} aria-label="刷新调度队列"><Icon path={mdiRefresh} size={0.65} /></button></header>
    {snapshot && !snapshot.currentMainSessionId && total > 0 && <p className="research-queue-empty">尚未绑定主 Agent；已有队列暂停保留，选择主 Agent 后再核对归属。</p>}
    {!snapshot ? <p className="research-queue-empty">{controller.loading ? "正在读取服务端队列…" : "队列状态待同步"}</p> : !total ? <p className="research-queue-empty">暂无待调度任务。新任务超过并发席位后会在这里排队。</p> : <>
      {shownPlans.map(plan => <PlanQueue key={`${controller.scope}:${plan.id}`} plan={plan} controller={controller} sessionName={sessionName} />)}
      {nativeParents.map(parent => <NativeQueue key={`${controller.scope}:${parent}`} items={native.filter(item => item.parentSessionId === parent)} controller={controller} sessionName={sessionName} />)}
      {plans.length > 3 && <button type="button" className="research-text-link" onClick={() => setExpanded(value => !value)}>{expanded ? "收起其他队列" : `查看全部 ${plans.length} 个分发队列`}</button>}
    </>}
  </section>;
}

export function ResearchDetachDialog({ controller, target, onClose }: {
  controller: ResearchCollaborationController; target: { sessionId: string; title: string; tenureId?: string; main: boolean } | null; onClose: () => void;
}) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const captureFeedback = useFeedbackGuard(JSON.stringify([controller.scope, target?.sessionId, target?.tenureId]));
  useEffect(() => { setFeedback(null); }, [controller.scope, target?.sessionId, target?.tenureId]);
  const detach = async () => {
    if (!target || controller.busy) return;
    const relevant = captureFeedback();
    try {
      const result = await controller.mutate("detach", { sessionId: target.sessionId, ...(target.tenureId ? { tenureId: target.tenureId } : {}) });
      if (!result || !relevant()) return;
      const tenure = target.tenureId ? result.tenures.find(row => row.id === target.tenureId) : undefined;
      const confirmed = tenure ? target.main ? tenure.mainSessionId === target.sessionId && tenure.status === "removed"
        : tenure.detachedSessionIds?.includes(target.sessionId) === true
        : !target.tenureId && result.detachedSessionIds.includes(target.sessionId);
      if (!confirmed) throw new Error("返回状态未确认该会话已移出，暂不关闭确认；请刷新核对。");
      if (result.warnings?.length) { setFeedback({ error: true, text: "后续派发已关闭，但部分关联标记尚未清理；原对话和运行记录保留，请刷新核对。" }); return; }
      onClose();
    }
    catch (error) { if (relevant()) setFeedback({ error: true, text: error instanceof Error ? error.message : "移出结果未确认。" }); }
  };
  return <Dialog open={Boolean(target)} onClose={() => { if (!controller.busy) onClose(); }} title="移出 res-workflow" size="md" testId="research-detach-dialog">
    <div className="research-collaboration-form"><p>移出「<strong>{target?.title}</strong>」{target?.main ? "及此任期下实际派发的全部下属" : "及其实际派发的下属"}？</p>
      <div className="research-collaboration-note"><Icon path={mdiInformationOutline} size={0.8} /><span>解除工作流关联并停止后续排队分发；保留原对话、文件、运行记录和已在执行的任务，不强制终止进程。</span></div>
      {target?.main && <p>如果这是当前主 Agent，移出后将不再绑定主 Agent；不会自动选取其他会话接替。</p>}
      {feedback && <p role="alert" className="research-warning">{feedback.text}</p>}
      <div className="research-collaboration-dialog-actions"><button type="button" className="research-workspace-action" disabled={controller.busy} onClick={onClose}>取消</button><button type="button" className="research-workspace-action research-detach-confirm" data-testid="research-detach-confirm" disabled={controller.busy || controller.stale} onClick={() => { void detach(); }}>{controller.busy ? "正在移出…" : "确认移出"}</button></div>
    </div>
  </Dialog>;
}
