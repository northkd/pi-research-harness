import { Icon } from "@mdi/react";
import { mdiArrowRight, mdiClose, mdiFileDocumentOutline, mdiPlayOutline } from "@mdi/js";
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { DialogPortal } from "@blackbelt-technology/pi-dashboard-client-utils/DialogPortal";
import { LayerHostProvider } from "@blackbelt-technology/pi-dashboard-client-utils/LayerPortal";
import { useEscapeDismiss } from "@blackbelt-technology/pi-dashboard-client-utils/escape-stack";
import { useFocusTrap } from "@blackbelt-technology/pi-dashboard-client-utils/useFocusTrap";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { claimEvidence, type Claim, type ResearchProjection, type StageId } from "./research-projection.js";
import { STAGES } from "./ResearchOverviewAndBudget.js";

export function ResearchStageOverview({ projection, objective, viewStage, onSelectStage, onStartStage, onOpenArtifact }: {
  projection: ResearchProjection;
  objective: string | null;
  viewStage: StageId | null;
  onSelectStage: (stage: StageId | null) => void;
  onStartStage?: (stage: StageId) => void;
  onOpenArtifact?: (path: string) => void;
}) {
  const selectedStage = viewStage ?? projection.stage;
  const tasks = projection.currentRun?.steps.filter(step => selectedStage === null || step.stage === selectedStage || viewStage === null && !step.stage) ?? [];
  const artifacts = [...new Set(tasks.flatMap(step => claimEvidence({ id: step.key, statement: "", status: step.status, evidence: step.evidence })))];
  const current = STAGES.find(stage => stage.id === projection.stage);
  const selected = STAGES.find(stage => stage.id === selectedStage);
  return <section className="research-stage-overview" aria-label="研究阶段总览">
    <div className="research-section-heading">
      <div><p className="research-eyebrow">研究目标</p><h2>{objective ?? "尚未记录研究目标"}</h2></div>
      <span className="research-status-label">实际阶段 · {current?.short ?? "未登记"}</span>
    </div>
    <ol className="research-stage-track">
      {STAGES.map((stage, index) => <li key={stage.id}>
        <button type="button" className="research-stage-select" data-testid={`research-stage-${stage.id}`} aria-label={`查看阶段：${stage.short}`}
          aria-pressed={selectedStage === stage.id} aria-current={projection.stage === stage.id ? "step" : undefined}
          onClick={() => onSelectStage(stage.id)}>
          <span className="research-stage-number">{index + 1}</span>
          <span><strong>{stage.short}</strong><small>{projection.stage === stage.id ? "最近进入" : projection.enteredStages.has(stage.id) ? "此前进入" : "无进入记录"}</small></span>
        </button>
        {onStartStage && <button type="button" className="research-stage-start" data-testid={`research-stage-start-${stage.id}`} aria-label={`独立启动${stage.short}`} onClick={() => onStartStage(stage.id)}><Icon path={mdiPlayOutline} size={0.65} />独立启动</button>}
      </li>)}
    </ol>
    <div className="research-stage-caption">
      <span>正在查看：{selected?.short ?? "全部已记录阶段"}。选择阶段只筛选记录。</span>
      {viewStage && <button type="button" onClick={() => onSelectStage(null)}>跟随当前实际记录</button>}
    </div>
    <div className="research-stage-resources">
      <div><h3>阶段任务 <span>{tasks.length}</span></h3>
        {tasks.length ? <ul>{tasks.map(step => <li key={step.key}><span>{step.label || step.agent || step.key}</span><small>{!step.stage ? "阶段未登记 · " : ""}{step.status}</small></li>)}</ul> : <p>暂无这一阶段的正式任务记录。</p>}
      </div>
      <div><h3>阶段产物 <span>{artifacts.length}</span></h3>
        {artifacts.length ? <ul>{artifacts.map(path => <li key={path}><button type="button" disabled={!onOpenArtifact} onClick={() => onOpenArtifact?.(path)}><Icon path={mdiFileDocumentOutline} size={0.65} /><span>{path}</span></button></li>)}</ul> : <p>尚无已登记的阶段产物。</p>}
      </div>
    </div>
  </section>;
}

export function ResearchTaskOverview({ projection, claims, observation, stale, activeSessionId, checkedAt, onClose, onOpenAgents, onOpenConversation, onOpenBudget }: {
  projection: ResearchProjection;
  claims: Claim[];
  observation?: ResearchWorkbenchObservation | null;
  stale: boolean;
  activeSessionId?: string;
  checkedAt?: string | null;
  onClose: () => void;
  onOpenAgents?: () => void;
  onOpenConversation?: () => void;
  onOpenBudget?: () => void;
}) {
  const active = projection.executions.filter(row => row.source === "observation" && ["streaming", "started", "running", "queued", "pending"].includes(row.status));
  const blocked = claims.filter(claim => claim.acceptance?.verdict === "blocked" || claim.acceptance?.unresolvedObligations?.length);
  const conversation = projection.executions.find(row => row.kind === "pi-session" && row.sessionId === activeSessionId);
  const current = STAGES.find(stage => stage.id === projection.stage);
  return <aside className="research-task-overview" aria-label="任务概览" data-testid="research-task-overview">
    <header><h2>任务概览</h2><button type="button" aria-label="收起任务概览" onClick={onClose}><Icon path={mdiClose} size={0.7} /></button></header>
    <section><h3>当前研究</h3><dl><div><dt>实际阶段</dt><dd>{current?.short ?? "未登记"}</dd></div><div><dt>运行记录</dt><dd>{projection.currentRun?.status ?? "暂无正式运行"}</dd></div><div><dt>待解决主张</dt><dd>{blocked.length} 条</dd></div></dl></section>
    <section><h3>协作状态</h3><p className={stale ? "research-warning" : "research-summary-number"}>{stale ? "执行观测待同步" : `${active.length} 项活动执行`}</p><p className="research-muted">独立会话 {projection.executions.filter(row => row.kind === "pi-session").length} · 原生子代理 {projection.executions.filter(row => row.kind === "native-subagent").length}</p>{onOpenAgents && <button type="button" className="research-text-link" onClick={onOpenAgents}>打开协作页 <Icon path={mdiArrowRight} size={0.6} /></button>}</section>
    <section><h3>当前交互入口</h3><p>{conversation ? "已选中的独立会话" : activeSessionId ? "导航中选中的会话，暂无执行观测" : "尚未选择会话"}</p>{activeSessionId && <p className="research-muted font-mono" title={activeSessionId}>{activeSessionId}</p>}{onOpenConversation && <button type="button" className="research-text-link" onClick={onOpenConversation}>回到对话 <Icon path={mdiArrowRight} size={0.6} /></button>}</section>
    <section><h3>使用量</h3><p>{observation ? `${observation.observedUsage.responses} 次已观测响应` : "尚无使用量观测"}</p><p className="research-muted">费用在计费明细中核对；已保存响应不等于完整物理请求次数。</p>{onOpenBudget && <button type="button" className="research-text-link" onClick={onOpenBudget}>查看研究总览 <Icon path={mdiArrowRight} size={0.6} /></button>}</section>
    <footer><span className={stale ? "research-warning" : "research-muted"}>{stale ? "执行状态尚未确认" : "执行观测已同步"}</span>{checkedAt && <time>正式记录核对于 {new Date(checkedAt).toLocaleTimeString("zh-CN")}</time>}</footer>
  </aside>;
}

/** Keep scoped form drafts mounted while closed; no new form exists until the user opens it. */
export function ResearchPersistentDrawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const ref = useCallback((node: HTMLDivElement | null) => { panelRef.current = node; setPanel(node); }, []);
  useFocusTrap(panelRef, open);
  useEscapeDismiss(open, onClose);
  return <DialogPortal><div className="research-drawer-layer" hidden={!open}>
    <div className="research-drawer-backdrop" onClick={onClose} />
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="research-drawer">
      <header><div><p className="research-eyebrow">项目设置</p><h2 id={titleId}>{title}</h2></div><button type="button" onClick={onClose} aria-label={`关闭${title}`}><Icon path={mdiClose} size={0.85} /></button></header>
      <div className="research-drawer-content"><LayerHostProvider host={panel}>{children}</LayerHostProvider></div>
    </div>
  </div></DialogPortal>;
}
