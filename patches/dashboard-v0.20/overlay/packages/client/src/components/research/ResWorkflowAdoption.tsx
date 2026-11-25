import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import { RES_WORKFLOW_MAX_HISTORY_SELECTION, type ResWorkflowAdoption as Adoption, type ResWorkflowHistoryCandidatesResponse, type ResWorkflowStatus } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { useEffect, useId, useRef, useState } from "react";
import {
  analyzeResWorkflowAdoption, cancelResWorkflowAdoption, confirmResWorkflowAdoption,
  createResWorkflowAdoption, createResWorkflowAgent, getResWorkflowHistoryCandidates, getResWorkflowModels, joinResWorkflowSession,
} from "../../lib/api/res-workflow-api.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { t } from "../../lib/i18n/i18n.js";
import { ModelSelector } from "../settings/ModelSelector.js";
import { historyReviewFailureLabel, historyReviewReady, ResWorkflowHistoryReview, selectedHistoryCount, type HistoryPrepareIntent } from "./ResWorkflowHistoryReview.js";
import { intakeAgentPhaseLabel, ResWorkflowIntakeAgent } from "./ResWorkflowIntakeAgent.js";

const BUTTON = "win11-btn focus-ring min-h-8 px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50";
const INPUT = "w-full min-w-0 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-2 text-sm text-[var(--text-primary)]";
const isRunning = (status: ResWorkflowStatus) => status === "inventory" || status === "analyzing";

function statusLabel(status: ResWorkflowStatus, job?: Adoption): string {
  if (job?.agentJob && status !== "confirmed") return intakeAgentPhaseLabel(job.agentJob.phase);
  if (job && selectedHistoryCount(job) > 0 && status !== "confirmed") {
    if (job.historyReview?.status === "running") return t("research.historyStatusRunning", undefined, "Full-history batch review is running");
    if (job.historyReview?.status === "prepared") return t("research.historyStatusPrepared", undefined, "Full-history plan awaits explicit authorization");
    if (status === "awaiting-model") return t("research.historyStatusLocalPlan", undefined, "Awaiting a local full-text plan · no model call");
    if (status === "proposal-ready" && !historyReviewReady(job)) return t("research.historyDirectoryDraft", undefined, "Directory draft · histories not yet covered");
  }
  switch (status) {
    case "inventory": return t("research.adoptionInventory", undefined, "Read-only inventory");
    case "awaiting-model": return t("research.adoptionAwaiting", undefined, "Awaiting model authorization");
    case "analyzing": return t("research.adoptionAnalyzing", undefined, "Analyzing the authorized snapshot");
    case "proposal-ready": return t("research.adoptionProposal", undefined, "Draft ready · unverified");
    case "confirmed": return t("research.adoptionConfirmed", undefined, "Connected · not scientific acceptance");
    case "blocked": return t("research.adoptionBlocked", undefined, "Blocked · explicit action required");
    case "failed": return t("research.adoptionFailed", undefined, "Connection failed");
    case "cancelled": return t("research.adoptionCancelled", undefined, "Connection cancelled");
  }
}

function agentPhaseLabel(phase: NonNullable<Adoption["agentProgress"]>["phase"]): string {
  switch (phase) {
    case "preparing": return t("research.agentPreparing", undefined, "Preparing read-only assistant");
    case "waiting-model": return t("research.agentWaitingModel", undefined, "Waiting for model");
    case "reading-sources": return t("research.agentReadingSources", undefined, "Reading approved sources");
    case "drafting": return t("research.agentDrafting", undefined, "Drafting proposal");
    case "completed": return t("research.agentCompleted", undefined, "Read-only analysis completed");
  }
}
const agentCount = (value: number) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "?";

export function ResWorkflowAdoption({ cwd, adopted, adoption, charter, onRefresh, onOpenSource }: {
  cwd: string;
  adopted: boolean;
  adoption: Adoption | null;
  charter?: { objective?: string; successCriteria?: string[] };
  onRefresh: () => void;
  onOpenSource?: (adoptionId: string, sourceId: string) => void;
}) {
  const apiBase = useApiBase();
  const scope = `${apiBase}\0${cwd}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [step, setStep] = useState<"intro" | "sources" | "model" | null>(() => !adopted && (!adoption || ["failed", "cancelled"].includes(adoption.status)) ? "intro" : null);
  const [localJob, setLocalJob] = useState<Adoption | null>(null);
  const replacementOrigin = useRef<string | null>(null);
  const scopedAdoption = adoption?.cwd === cwd ? adoption : null;
  const job = localJob?.cwd === cwd && (!scopedAdoption || localJob.id === scopedAdoption.id && Date.parse(localJob.updatedAt) > Date.parse(scopedAdoption.updatedAt) || replacementOrigin.current === scopedAdoption.id && ["confirmed", "failed", "cancelled"].includes(scopedAdoption.status)) ? localJob : scopedAdoption;
  const currentJobId = useRef(job?.id);
  currentJobId.current = job?.id;
  const connected = adopted || job?.status === "confirmed";
  const canStart = !job || ["confirmed", "failed", "cancelled"].includes(job.status);
  const showIntro = step === "intro" || step === null && !connected && canStart;
  const [histories, setHistories] = useState<ResWorkflowHistoryCandidatesResponse | null>(null);
  const [historySelection, setHistorySelection] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [selected, setSelected] = useState("");
  const [consent, setConsent] = useState(false);
  const [analyzeId, setAnalyzeId] = useState<string | null>(null);
  const [historyPrepareIntent, setHistoryPrepareIntent] = useState<HistoryPrepareIntent | null>(null);
  const [replaceAdoptionId, setReplaceAdoptionId] = useState<string | null>(null);
  const [resolvedParticipants, setResolvedParticipants] = useState<{ adoptionId: string; sessionIds: string[] } | null>(null);
  const participantFailures = (job?.participantFailures ?? []).filter(failure => !resolvedParticipants || resolvedParticipants.adoptionId !== job?.id || !resolvedParticipants.sessionIds.includes(failure.sessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef("");
  const controller = useRef<AbortController | null>(null);
  const detailsId = useId();
  const canCollapse = connected && (!job || job.status === "confirmed") && step === null;
  const collapseScope = JSON.stringify([scope, job?.id ?? null, canCollapse]);
  const [expandedChoice, setExpandedChoice] = useState<{ scope: string; expanded: boolean } | null>(null);
  const detailsExpanded = !canCollapse || busy || expandedChoice?.scope === collapseScope && expandedChoice.expanded;

  useEffect(() => { setExpandedChoice(null); }, [collapseScope]);

  useEffect(() => () => { controller.current?.abort(); }, [scope]);

  useEffect(() => {
    if (step !== "sources") return;
    const abort = new AbortController();
    setHistoryLoading(true);
    setHistoryError(null);
    setHistories(null);
    void getResWorkflowHistoryCandidates(cwd, abort.signal).then(result => {
      if (abort.signal.aborted || currentScope.current !== scope) return;
      setHistories(result);
      setHistorySelection(previous => previous.filter(id => result.candidates.some(candidate => candidate.id === id)));
    }).catch(err => {
      if (!abort.signal.aborted && currentScope.current === scope) setHistoryError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!abort.signal.aborted && currentScope.current === scope) setHistoryLoading(false); });
    return () => abort.abort();
  }, [step, cwd, scope, historyRevision]);

  useEffect(() => {
    if (step !== "model") return;
    const abort = new AbortController();
    setModelsLoading(true);
    setModelError(null);
    setModels([]);
    setSelected("");
    setConsent(false);
    void getResWorkflowModels(cwd, abort.signal).then(result => {
      if (!abort.signal.aborted && currentScope.current === scope) setModels(result);
    }).catch(err => {
      if (!abort.signal.aborted && currentScope.current === scope) setModelError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!abort.signal.aborted && currentScope.current === scope) setModelsLoading(false); });
    return () => abort.abort();
  }, [step, cwd, scope, modelRevision]);

  const open = (nextStep: "intro" | "model", id: string | null = null, replaceId: string | null = null) => {
    requestId.current = randomUuid();
    setAnalyzeId(id);
    setReplaceAdoptionId(replaceId);
    setHistorySelection([]);
    setResolvedParticipants(null);
    setSelected("");
    setConsent(false);
    setError(null);
    setStep(nextStep);
  };
  const chooseSources = () => {
    requestId.current = randomUuid();
    setAnalyzeId(null);
    setHistorySelection([]);
    setSelected("");
    setConsent(false);
    setError(null);
    setStep("sources");
  };
  const cancelPreparation = () => {
    requestId.current = "";
    setHistorySelection([]);
    setSelected("");
    setConsent(false);
    setAnalyzeId(null);
    setReplaceAdoptionId(null);
    setStep(null);
  };

  async function perform(action: (signal: AbortSignal) => Promise<Adoption>) {
    if (busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    try {
      const next = await action(abort.signal);
      if (abort.signal.aborted || currentScope.current !== scope || getApiBase() !== apiBase) return;
      setLocalJob(next);
      setStep(null);
      onRefresh();
    } catch (err) {
      if (!abort.signal.aborted && currentScope.current === scope) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!abort.signal.aborted && currentScope.current === scope) setBusy(false);
    }
  }

  async function retryParticipant(sessionId: string) {
    const adoptionId = job?.id;
    if (busy || !adoptionId) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    try {
      await joinResWorkflowSession(cwd, sessionId, abort.signal);
      if (abort.signal.aborted || currentScope.current !== scope || getApiBase() !== apiBase || currentJobId.current !== adoptionId) return;
      setResolvedParticipants(previous => ({ adoptionId, sessionIds: [...(previous?.adoptionId === adoptionId ? previous.sessionIds : []), sessionId] }));
      onRefresh();
    } catch (err) {
      if (!abort.signal.aborted && currentScope.current === scope && currentJobId.current === adoptionId) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!abort.signal.aborted && currentScope.current === scope) setBusy(false);
    }
  }

  const selectedModel = models.find(model => `${model.provider}/${model.id}` === selected);
  const historyCount = analyzeId ? job?.historySelection?.length : historySelection.length;
  const fullHistoryChoice = (historyCount ?? 0) > 0;
  const historyIncomplete = !!job && selectedHistoryCount(job) > 0 && !historyReviewReady(job);
  const start = () => {
    if (!selectedModel || !fullHistoryChoice && !consent) return;
    if (!requestId.current) requestId.current = randomUuid();
    if (fullHistoryChoice) {
      const model = { provider: selectedModel.provider, id: selectedModel.id };
      if (!analyzeId) {
        const previousId = job?.id ?? null;
        void perform(async signal => {
          const next = await createResWorkflowAgent({ cwd, requestId: requestId.current, model, historySelection: [...historySelection].sort() }, signal);
          if (next.cwd !== cwd || next.agentJob?.mode !== "full-history-agent-v2" || next.id === previousId ||
            next.model?.provider !== model.provider || next.model?.id !== model.id ||
            JSON.stringify([...(next.historySelection ?? [])].sort()) !== JSON.stringify([...historySelection].sort())) throw new Error("Local preparation scope changed");
          if (!signal.aborted && currentScope.current === scope && getApiBase() === apiBase) replacementOrigin.current = previousId;
          return next;
        });
        return;
      }
      void perform(async signal => {
        // A selected-history intake creates only a local inventory. The
        // explicit plan-preparation intent may continue once that same job's
        // inventory is ready; it never authorizes a model request.
        const next = analyzeId && job ? job : await createResWorkflowAdoption({ cwd, requestId: requestId.current, model, historySelection: [...historySelection].sort() }, signal);
        const expectedSelection = analyzeId ? job?.historySelection ?? [] : historySelection;
        if (signal.aborted || currentScope.current !== scope || getApiBase() !== apiBase || next.cwd !== cwd ||
          JSON.stringify([...(next.historySelection ?? [])].sort()) !== JSON.stringify([...expectedSelection].sort())) throw new Error("Local preparation scope changed");
        setHistoryPrepareIntent({ jobId: next.id, nonce: randomUuid(), model, selection: JSON.stringify([...(next.historySelection ?? [])].sort()) });
        return next;
      });
      return;
    }
    const body = { cwd, requestId: requestId.current, model: { provider: selectedModel.provider, id: selectedModel.id }, consent: { scope: "research-files-and-normal-messages" as const, includeUnpublished: true as const, analysisMode: "snapshot-agent-v1" as const } };
    void perform(async signal => {
      if (analyzeId) return analyzeResWorkflowAdoption(analyzeId, body, signal);
      if (replaceAdoptionId) await cancelResWorkflowAdoption(replaceAdoptionId, cwd, signal);
      return createResWorkflowAdoption({ ...body, historySelection: [...historySelection].sort() }, signal);
    });
  };

  return <section data-testid="res-workflow-adoption" className="win11-card min-w-0 space-y-3 p-4 text-xs">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">res-workflow</h2>
        <p className="mt-1 text-[var(--text-secondary)]">{t("research.directoryShared", undefined, "One folder, one shared workbench. Inventory never runs experiments or resumes old sessions.")}</p>
      </div>
      {canStart && !showIntro && step === null && <button type="button" className={BUTTON} data-testid="res-workflow-rescan" onClick={() => open("intro")}>
        {connected ? t("research.rescan", undefined, "Explicit supplemental scan") : t("research.connect", undefined, "Connect this folder")}
      </button>}
      {canCollapse && <button type="button" className={BUTTON} data-testid="res-workflow-adoption-toggle" disabled={busy}
        aria-expanded={detailsExpanded} aria-controls={detailsId} onClick={() => setExpandedChoice({ scope: collapseScope, expanded: !detailsExpanded })}>
        {detailsExpanded ? t("research.hideIntakeDetails", undefined, "Collapse intake details") : t("research.showIntakeDetails", undefined, "Expand intake details")}
      </button>}
    </div>
    {canCollapse && <p data-testid="res-workflow-connected-summary" className="text-[var(--text-secondary)]">{job?.historyReview?.coverage
      ? t("research.connectedCoverageSummary", { done: agentCount(job.historyReview.coverage.completedHistories), total: agentCount(job.historyReview.coverage.selectedHistories), messages: agentCount(job.historyReview.coverage.completedMessages), totalMessages: agentCount(job.historyReview.coverage.eligibleMessages), batches: agentCount(job.historyReview.coverage.completedBatches), totalBatches: agentCount(job.historyReview.coverage.totalBatches) }, "Connected · full-history coverage: histories {done} / {total} · normal messages {messages} / {totalMessages} · batches {batches} / {totalBatches}")
      : t("research.connectedIntakeSummary", undefined, "Connected · intake record available in details")}</p>}
    {error && <p role="alert" className="break-words text-[var(--severity-error-fg)]">{error}</p>}
    <div id={detailsId} data-testid="res-workflow-adoption-details" role="region" aria-label={t("research.intakeDetails", undefined, "Intake details")} hidden={!detailsExpanded} className="space-y-3">
    {(showIntro || step === "sources" || step === "model") && <div data-testid="res-workflow-connect-inline" className="space-y-3 border-t border-[var(--border-secondary)] pt-3">
      <p className="break-all text-xs text-[var(--text-secondary)]">{cwd}</p>
      {charter && <p className="rounded border border-[var(--severity-info-border)] bg-[var(--severity-info-bg)] p-3 text-[var(--text-primary)]">{t("research.existingCharter", undefined, "Connect the existing study. Its frozen goal and success criteria will not be overwritten.")}</p>}
      {showIntro && <div data-testid="res-workflow-connect-intro" className="space-y-3">
        <h3 className="text-sm font-semibold">{t("research.connectQuestion", undefined, "Connect this folder to research-pipeline?")}</h3>
        <p className="leading-relaxed text-[var(--text-secondary)]">{step === null ? t("research.connectPaused", undefined, "Connection is paused. You can continue here whenever you are ready.") : t("research.inlineConnectExplanation", undefined, "Choose this study's histories and an exact model. Preparing the plan reads material locally without a model call; you will authorize external requests separately after seeing their exact limit.")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BUTTON} data-testid="res-workflow-decline" onClick={cancelPreparation}>{t("research.notNow", undefined, "Not now")}</button>
          <button type="button" className={BUTTON} data-testid="res-workflow-connect-next" onClick={chooseSources}>{t("research.continueChooseHistories", undefined, "Continue · choose histories")}</button>
        </div>
      </div>}
      {step === "sources" && <div className="space-y-3" data-testid="res-workflow-history-sources">
        <h3 className="text-sm font-semibold">{t("research.chooseHistories", undefined, "Choose this study's Pi histories")}</h3>
        <p className="leading-relaxed text-[var(--text-secondary)]">{t("research.historyMetadataOnly", undefined, "This list reads metadata only. No histories are preselected. Selected histories will use a full normal-text batch plan, without sampling fallback. Resource or privacy limits block preparation with reasons. Preparing the local plan does not call a model; a separate checkbox authorizes its exact request limit.")}</p>
        {historyLoading && <p role="status" className="text-[var(--text-secondary)]">{t("research.loadingHistories", undefined, "Reading history metadata…")}</p>}
        {historyError && <div className="space-y-2"><p role="alert" className="break-words text-[var(--severity-error-fg)]">{historyError}</p><button type="button" className={BUTTON} data-testid="res-workflow-history-retry" onClick={() => setHistoryRevision(value => value + 1)}>{t("research.retryHistoryCatalogue", undefined, "Retry history list")}</button></div>}
        {histories && <>
          <p className="text-[var(--text-secondary)]">{t("research.historySelectionCount", { count: historySelection.length, limit: RES_WORKFLOW_MAX_HISTORY_SELECTION }, "Selected {count} / {limit} histories · empty selection means files only")}</p>
          {histories.candidates.length === 0 && <p className="text-[var(--text-secondary)]">{t("research.noSelectableHistories", undefined, "No selectable histories were found. You can connect directory files only.")}</p>}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {histories.candidates.map(candidate => <label key={candidate.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-[var(--border-secondary)] bg-[var(--bg-primary)] p-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-primary)]" data-testid={`res-workflow-history-${candidate.id}`} checked={historySelection.includes(candidate.id)} disabled={!historySelection.includes(candidate.id) && historySelection.length >= RES_WORKFLOW_MAX_HISTORY_SELECTION} onChange={event => {
                setConsent(false);
                setHistorySelection(previous => event.target.checked ? [...previous, candidate.id] : previous.filter(id => id !== candidate.id));
              }} />
              <span className="min-w-0 space-y-1">
                <span className="block break-words font-semibold">{candidate.name || `Pi ${candidate.sessionId}`}</span>
                <span className="block break-all text-[var(--text-secondary)]">{candidate.sessionId} · {candidate.kind === "retained" ? t("research.retainedHistory", undefined, "retained remote history") : candidate.registered ? t("research.registeredHistory", undefined, "registered local history") : t("research.discoveredHistory", undefined, "discovered local history")}</span>
                <span className="block break-words text-[var(--text-tertiary)]">{candidate.timestamp ?? t("research.timeUnrecorded", undefined, "time not recorded")}{candidate.kind === "retained" && candidate.incomplete && <span title={t("research.retainedIntegrityPendingHint", undefined, "Only retained-history metadata is listed here; message completeness has not been checked. The authorized intake will report what was read and what remains uncovered.")}> · {t("research.retainedIntegrityPending", undefined, "Retained completeness not yet verified")}</span>}</span>
              </span>
            </label>)}
          </div>
          {(histories.partial || histories.skipped.length > 0) && <details className="text-[var(--text-secondary)]"><summary className="cursor-pointer py-1">{t("research.partialHistoryCatalogue", undefined, "Finite history coverage · skipped records")}</summary><ul className="mt-1 space-y-1">{histories.skipped.map((skip, index) => <li key={index} className="break-words">{skip.label} · {skip.reason}</li>)}</ul></details>}
        </>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BUTTON} data-testid="res-workflow-decline" onClick={cancelPreparation}>{t("common.cancel", undefined, "Cancel")}</button>
          <button type="button" className={BUTTON} data-testid="res-workflow-files-only" onClick={() => { setHistorySelection([]); setConsent(false); setStep("model"); }}>{t("research.filesOnly", undefined, "Directory files only")}</button>
          <button type="button" className={BUTTON} data-testid="res-workflow-sources-next" disabled={historyLoading || !!historyError || !histories} onClick={() => { setConsent(false); setStep("model"); }}>{t("research.continueChooseModel", undefined, "Continue · choose model")}</button>
        </div>
      </div>}
      {step === "model" && <div className="space-y-3" data-testid="res-workflow-model-step">
        <h3 className="text-sm font-semibold">{t("research.chooseAnalysisModel", undefined, "Choose this connection's analysis model")}</h3>
        <div className="min-w-0" data-testid="res-workflow-model-picker"><ModelSelector models={models} current={selected || undefined} onSelect={label => { setSelected(label); setConsent(false); }} allowRoles={false} disabled={modelsLoading || busy || !!modelError} placeholder={t("research.selectExactModel", undefined, "Select an explicit provider/model")} /></div>
        {modelsLoading && <p role="status" className="text-[var(--text-secondary)]">{t("research.loadingModels", undefined, "Reading available models…")}</p>}
        {modelError && <div className="space-y-2"><p role="alert" className="break-words text-[var(--severity-error-fg)]">{modelError}</p><button type="button" className={BUTTON} data-testid="res-workflow-model-retry" onClick={() => setModelRevision(value => value + 1)}>{t("research.retryModelCatalogue", undefined, "Retry model list")}</button></div>}
        <div className="space-y-2 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 leading-relaxed text-[var(--text-secondary)]">
          <p className="break-all font-semibold text-[var(--text-primary)]" data-testid="res-workflow-recipient">{t("research.recipient", undefined, "Recipient")} · {selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : t("research.notSelected", undefined, "not selected")}</p>
          <p>{fullHistoryChoice && !analyzeId ? t("research.intakePlanFirst", { count: historyCount! }, "Hand all {count} selected histories to one intake task. Local preparation runs in the background without a model call. Then authorize the fixed model and material scope once, including recovery within this task. Completed batches are kept in that task.") : fullHistoryChoice ? t("research.historyPlanFirst", { count: historyCount! }, "Prepare a local full-text plan for all {count} selected histories first. The plan will show reading batches, merge requests and the physical model before you authorize processing the selected materials.") : historyCount === undefined ? t("research.legacyFrozenScope", undefined, "This legacy task uses its already frozen material snapshot. Changing its scope requires a new connection request.") : t("research.selectedMaterialScope", { count: historyCount }, "Scope: bounded research files and normal messages from {count} explicitly selected Pi histories. Unselected histories are excluded; real header cwd and source ownership are rechecked.")}</p>
          {analyzeId && job?.selectedHistories?.length ? <ul className="space-y-1">{job.selectedHistories.map(history => <li key={history.id} className="break-words">{history.name || `Pi ${history.sessionId}`}</li>)}</ul> : null}
          <p>{t("research.excludedScope", undefined, "Excluded: thinking, tool arguments, credentials and raw logs. No symlinks, code execution, experiment runs, old-session restore or changes to research-role models.")}</p>
          <p>{t("research.externalPurpose", undefined, "This may include unpublished research. The snapshot will be sent to the selected model's external provider only to prepare a source-linked connection draft. Failure never falls back to another model.")}</p>
        </div>
        {!fullHistoryChoice && <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--text-primary)]">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-primary)]" data-testid="res-workflow-consent" checked={consent} disabled={!selectedModel || busy} onChange={event => setConsent(event.target.checked)} />
          <span>{t("research.snapshotAgentConsent", undefined, "I authorize the read-only connection assistant for this run: up to 6 model requests, which may incur charges, using only the confirmed materials and selected histories. It will not start experiments or restore sessions. I will review and confirm the draft. This does not enable thinking translation or authorize publication.")}</span>
        </label>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BUTTON} disabled={busy} data-testid="res-workflow-decline" onClick={cancelPreparation}>{t("common.cancel", undefined, "Cancel")}</button>
          {!analyzeId && <button type="button" className={BUTTON} disabled={busy} data-testid="res-workflow-back-sources" onClick={() => { setConsent(false); setSelected(""); setStep("sources"); }}>{t("research.backToHistories", undefined, "Change histories")}</button>}
          <button type="button" className={BUTTON} data-testid="res-workflow-start" disabled={!selectedModel || !fullHistoryChoice && !consent || busy} onClick={start}>{busy ? t("research.submitting", undefined, "Submitting…") : fullHistoryChoice && !analyzeId ? t("research.intakeCreate", undefined, "Prepare one intake task (does not call a model)") : fullHistoryChoice ? t("research.historyPrepareCount", { count: historyCount! }, "Prepare a full-text plan for {count} histories (does not call a model)") : t("research.authorizeStart", undefined, "Authorize and start")}</button>
        </div>
      </div>}
    </div>}
    {participantFailures.length > 0 && <div className="space-y-2 rounded border border-[var(--severity-warning-border)] bg-[var(--severity-warning-bg)] p-3" data-testid="res-workflow-participant-failures">
      <p>{t("research.participantPartial", undefined, "Sources are connected, but some session associations need attention. Retrying below does not repeat the analysis.")}</p>
      {participantFailures.map(failure => <div key={failure.sessionId} className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-all">{failure.sessionId} · {failure.reason}</span><button type="button" className={BUTTON} disabled={busy} data-testid={`res-workflow-retry-participant-${failure.sessionId}`} onClick={() => void retryParticipant(failure.sessionId)}>{t("research.retryParticipant", undefined, "Retry association")}</button></div>)}
    </div>}
    {job && <>
      <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2" data-testid="res-workflow-job-status" data-status={job.status}>
        <span className="font-semibold">{isRunning(job.status) ? "◌ " : "○ "}{statusLabel(job.status, job)}</span>
        {job.partial && <span data-testid="res-workflow-partial" className="rounded border border-[var(--severity-warning-border)] bg-[var(--severity-warning-bg)] px-2 py-1 text-[var(--text-primary)]">{t("research.partial", undefined, "Partial coverage")}</span>}
      </div>
      <p className="text-[var(--text-secondary)]">{t("research.inventoryCounts", { files: job.progress.files, sessions: job.progress.sessions, bytes: job.progress.bytes }, "Local inventory: files {files} · histories catalogued {sessions} · directory/sample snapshot {bytes} bytes")}</p>
      {historyIncomplete && <p data-testid="res-workflow-history-incomplete" className="text-[var(--severity-warning-fg)]">{t("research.historyNeedsCoverage", { done: job.historyReview?.coverage.completedHistories ?? 0, total: selectedHistoryCount(job) }, "Selected histories covered {done} / {total}. Full review must finish before a draft can be confirmed.")}</p>}
      {!job.agentJob && job.agentProgress && <div role="status" aria-live="polite" data-testid="res-workflow-agent-progress" className="space-y-1 text-[var(--text-secondary)]">
        <p className="font-semibold">{historyIncomplete && job.agentProgress.phase === "completed" ? t("research.historySnapshotComplete", undefined, "Directory snapshot draft generated · full histories remain uncovered") : agentPhaseLabel(job.agentProgress.phase)}</p>
        <p>{t("research.agentCounts", { requests: agentCount(job.agentProgress.requests), toolCalls: agentCount(job.agentProgress.toolCalls), readSources: agentCount(job.agentProgress.readSources), readBytes: agentCount(job.agentProgress.readBytes) }, "Snapshot assistant: model requests {requests} / 6 · read operations {toolCalls} / 32 · sources {readSources} · {readBytes} bytes")}</p>
        <p>{t("research.agentUpdatedAt", { time: Number.isFinite(Date.parse(job.agentProgress.updatedAt)) ? new Date(job.agentProgress.updatedAt).toLocaleString() : t("research.timeUnrecorded", undefined, "time not recorded") }, "Progress updated {time}")}</p>
      </div>}
      {job.model && <p className="break-all text-[var(--text-secondary)]">{t("research.analysisModel", undefined, "Analysis model")} · {job.model.provider}/{job.model.id}</p>}
      {!job.agentJob && job.error && <p role="alert" data-testid="res-workflow-job-error" className="break-words text-[var(--severity-warning-fg)]">{historyReviewFailureLabel(job.error) ?? job.error}</p>}
      {!job.agentJob && job.status === "blocked" && !job.agentProgress && <p className="text-[var(--text-secondary)]" data-testid="res-workflow-legacy-no-retry">{t("research.legacyNoAutoRetry", undefined, "This earlier task stays paused and will not retry automatically. Use the button below to review the scope and authorize a new request.")}</p>}
      {!job.agentJob && selectedHistoryCount(job) === 0 && (job.status === "awaiting-model" || job.status === "blocked") && <button type="button" className={BUTTON} data-testid="res-workflow-retry" disabled={busy} onClick={() => job.status === "blocked" ? open("intro", null, job.id) : open("model", job.id)}>
        {job.status === "blocked" ? t("research.restartAdoption", undefined, "Re-inventory and authorize again (a previous request may already have incurred a charge)") : t("research.authorizeRetry", undefined, "Choose a model and authorize explicitly (a retry may incur another charge)")}
      </button>}
      {job.agentJob?.mode === "full-history-agent-v2" && <ResWorkflowIntakeAgent key={`${scope}\0${job.id}`} cwd={cwd} job={job} onRefresh={onRefresh}
        onJob={next => { if (currentScope.current === scope && getApiBase() === apiBase && currentJobId.current === job.id && next.id === job.id && next.cwd === cwd) setLocalJob(next); }} />}
      {!job.agentJob && selectedHistoryCount(job) > 0 && !["confirmed", "cancelled"].includes(job.status) && <ResWorkflowHistoryReview key={`${scope}\0${job.id}`} cwd={cwd} job={job} onRefresh={onRefresh}
        onJob={next => { if (currentScope.current === scope && getApiBase() === apiBase && currentJobId.current === job.id && next.id === job.id && next.cwd === cwd) setLocalJob(next); }}
        autoPrepare={historyPrepareIntent?.jobId === job.id ? historyPrepareIntent : null} onAutoPrepareConsumed={nonce => setHistoryPrepareIntent(previous => previous?.nonce === nonce ? null : previous)} />}
      {!connected && !["failed", "cancelled"].includes(job.status) && <button type="button" className={BUTTON} data-testid="res-workflow-cancel-job" disabled={busy} onClick={() => void perform(signal => cancelResWorkflowAdoption(job.id, cwd, signal))}>
        {t("research.cancelAdoption", undefined, "Cancel connection")}
      </button>}
      {job.proposal && <Proposal key={`${job.id}:${job.proposalHash}`} job={job} charter={charter} busy={busy}
        onOpenSource={onOpenSource} onConfirm={(objective, successCriteria) => void perform(signal => confirmResWorkflowAdoption(job.id, { cwd, proposalHash: job.proposalHash!, objective, successCriteria }, signal))} />}
      {job.sources.length > 0 && <details data-testid="res-workflow-sources">
        <summary className="focus-ring cursor-pointer py-1 font-semibold">{t("research.sources", undefined, "Sources · unverified")} ({job.sources.length})</summary>
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
          {job.sources.map(source => <li key={source.id} className="min-w-0 rounded border border-[var(--border-primary)] p-2">
            <button type="button" disabled={!onOpenSource} onClick={() => onOpenSource?.(job.id, source.id)} className="focus-ring max-w-full break-all text-left text-[var(--accent-text)] underline disabled:no-underline">{source.label}</button>
            <p className="mt-1 break-all text-[var(--text-secondary)]">{source.kind} · {source.timestamp ?? t("research.timeUnrecorded", undefined, "time not recorded")} · {source.bytes} B{source.incomplete ? ` · ${t("research.incomplete", undefined, "incomplete")}` : ""}</p>
          </li>)}
        </ul>
      </details>}
      {job.skipped.length > 0 && <details data-testid="res-workflow-skipped"><summary className="focus-ring cursor-pointer py-1 font-semibold">{t("research.skipped", undefined, "Skipped sources and reasons")} ({job.skipped.length})</summary>
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[var(--text-secondary)]">{job.skipped.map((skip, index) => <li key={index} className="break-words">{skip.label} · {skip.reason}</li>)}</ul>
      </details>}
    </>}
    </div>
  </section>;
}

function Proposal({ job, charter, busy, onConfirm, onOpenSource }: {
  job: Adoption;
  charter?: { objective?: string; successCriteria?: string[] };
  busy: boolean;
  onConfirm: (objective: string, criteria: string[]) => void;
  onOpenSource?: (adoptionId: string, sourceId: string) => void;
}) {
  const proposal = job.proposal!;
  const [objective, setObjective] = useState(proposal.objective);
  const [criteria, setCriteria] = useState(proposal.successCriteria.join("\n"));
  const finalObjective = charter ? charter.objective ?? "" : objective.trim();
  const finalCriteria = charter ? charter.successCriteria ?? [] : criteria.split("\n").map(line => line.trim()).filter(Boolean);
  const sources = new Map(job.sources.map(source => [source.id, source]));
  return <div data-testid="res-workflow-proposal" className="min-w-0 space-y-3 border-t border-[var(--border-primary)] pt-3">
    <h3 className="font-semibold">{!historyReviewReady(job) ? t("research.historyDirectoryDraft", undefined, "Directory draft · histories not yet covered") : t("research.proposalTitle", undefined, "Source-linked draft · not verified findings")}</h3>
    <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{proposal.summary}</p>
    <ul className="max-h-72 space-y-2 overflow-y-auto">{proposal.items.map((item, index) => <li key={index} className="rounded border border-[var(--border-primary)] p-2">
      <p className="whitespace-pre-wrap break-words">{item.text}</p>
      <div className="mt-2 flex flex-wrap gap-2">{item.sourceIds.filter(id => sources.has(id)).map(id => <button key={id} type="button" disabled={!onOpenSource} onClick={() => onOpenSource?.(job.id, id)} className="focus-ring max-w-full break-all text-left text-[var(--accent-text)] underline">{sources.get(id)!.label}</button>)}</div>
    </li>)}</ul>
    {proposal.unresolved.length > 0 && <div><h4 className="font-semibold">{t("research.unresolved", undefined, "Gaps and unverified questions")}</h4><ul className="mt-1 list-inside list-disc space-y-1 text-[var(--text-secondary)]">{proposal.unresolved.map((text, index) => <li key={index} className="break-words">{text}</li>)}</ul></div>}
    {job.status === "proposal-ready" && <>
      {charter ? <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{t("research.preserveGoal", undefined, "Keep the existing frozen goal")} · {charter.objective}</p> : <>
        <label className="block space-y-1"><span>{t("research.confirmObjective", undefined, "Confirm the research goal")}</span><textarea data-testid="res-workflow-objective" rows={2} className={INPUT} value={objective} onChange={event => setObjective(event.target.value)} /></label>
        <label className="block space-y-1"><span>{t("research.confirmCriteria", undefined, "Confirm success criteria (one per line)")}</span><textarea data-testid="res-workflow-criteria" rows={3} className={INPUT} value={criteria} onChange={event => setCriteria(event.target.value)} /></label>
      </>}
      <p className="text-[var(--text-secondary)]">{t("research.confirmBoundary", undefined, "Confirmation only links sources, or configures a missing charter with autoRun:false. It never restarts Stage 1, records experiments, accepts claims or authorizes publication. run is not resume.")}</p>
      <button type="button" className={BUTTON} data-testid="res-workflow-confirm" disabled={busy || !historyReviewReady(job) || !job.proposalHash || !finalObjective.trim() || finalCriteria.length === 0} onClick={() => { if (historyReviewReady(job)) onConfirm(finalObjective, finalCriteria); }}>{t("research.confirmDraft", undefined, "Confirm and connect without running")}</button>
    </>}
  </div>;
}
