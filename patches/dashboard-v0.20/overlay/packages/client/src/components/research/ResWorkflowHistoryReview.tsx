import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { ResWorkflowAdoption as Adoption, ResWorkflowHistoryReviewPlan as Plan, ResWorkflowModel } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { useEffect, useRef, useState } from "react";
import { analyzeResWorkflowHistoryReview, getResWorkflowModels, knownResWorkflowErrorCode, prepareResWorkflowHistoryReview, ResWorkflowApiError, resWorkflowErrorCode, type ResWorkflowErrorCode } from "../../lib/api/res-workflow-api.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { t } from "../../lib/i18n/i18n.js";
import { ModelSelector } from "../settings/ModelSelector.js";

const BUTTON = "focus-ring min-h-9 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11";
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const pair = (model?: ResWorkflowModel) => model ? `${model.provider}/${model.id}` : "";

export function historyReviewFailureLabel(value: unknown): string | null {
  switch (knownResWorkflowErrorCode(value)) {
    case "analysis-full-output-too-large":
      return t("research.historyOutputTooLarge", undefined, "An earlier model response exceeded the output limit and produced no verified complete batch result. This is not a history-file reading failure. The request may already have incurred charges; its record is retained and will not be retried automatically.");
    case "analysis-full-thinking-too-large":
      return t("research.historyThinkingTooLarge", undefined, "An earlier model response exceeded the thinking-output limit. It did not produce a verified complete result and may already have incurred charges. Its record is retained; it will not be retried automatically.");
    case "analysis-full-output-incomplete":
      return t("research.historyOutputIncomplete", undefined, "An earlier model output was incomplete and could not be verified. That request may already have incurred charges. It will not be replayed automatically.");
    case "analysis-full-output-event-too-large":
    case "analysis-full-output-metadata-too-large":
      return t("research.historyResponsePartTooLarge", undefined, "An earlier model response event or its metadata exceeded the size limit, so no verified complete result was accepted. That request may already have incurred charges. Its record is retained and it will not be replayed automatically.");
    case "analysis-full-result-unknown-no-replay":
    case "result-unknown":
    case "request-timeout-result-unknown":
      return t("research.historyResultUnknown", undefined, "The system will not replay the earlier model request because its complete result is unconfirmed. That request may already have incurred charges. You may explicitly prepare a new plan, then review its model and material scope before authorizing it.");
    case "analysis-full-known-invalid-new-plan-required":
    case "analysis-full-known-invalid-output-new-plan-required":
    case "analysis-full-known-invalid-source-new-plan-required":
    case "known-invalid-output-new-plan-required":
    case "known-invalid-source-new-plan-required":
      return t("research.historyKnownInvalid", undefined, "An earlier model result failed validation and is not accepted as a valid result. It may already have incurred charges. Keep its record and prepare a distinct new plan before authorizing additional requests.");
    case "analysis-full-recovery-request-invalid":
      return t("research.historyRecoveryRequestInvalid", undefined, "The new-plan request does not match the supported request format. Refresh the current task and prepare its exact plan again. No new model request was sent.");
    case "analysis-full-recovery-plan-mismatch":
      return t("research.historyRecoveryPlanChanged", undefined, "The earlier plan changed before this local preparation. Refresh the current task and review its latest plan before preparing a new one. The old request will not be replayed.");
    case "analysis-full-new-plan-preparation-failed":
      return t("research.historyNewPlanPreparationFailed", undefined, "The local preparation of the new plan failed. The old plan and request records were not changed. This click sent no new model request; earlier requests may already have incurred charges. Nothing is retried automatically.");
    default: return null;
  }
}
function needsDistinctPlan(value: unknown): boolean {
  const code = knownResWorkflowErrorCode(value);
  return !!code && code !== "analysis-full-recovery-request-invalid" && code !== "analysis-full-recovery-plan-mismatch";
}
function prepareFailureLabel(error: unknown): string {
  const detail = historyReviewFailureLabel(resWorkflowErrorCode(error));
  const noNewRequest = t("research.historyPrepareNoNewRequest", undefined, "This preparation click sent no new model request. It does not change any earlier charges.");
  if (detail) return `${detail} ${noNewRequest}`;
  if (error instanceof Error && (error.message === "recovery-plan-not-new" || error.message === "recovery-archive-mismatch")) {
    return t("research.historyRecoveryResponseInvalid", undefined, "The service did not return a distinct new plan with the preserved earlier-attempt record. This response was not adopted; refresh the task before authorizing anything.");
  }
  if (error instanceof Error && error.message === "scope-mismatch") return t("research.historyPlanResponseMismatch", undefined, "The returned plan does not match the current folder, task or model. It was not adopted. Refresh the task; this preparation sent no new model request.");
  if (error instanceof ResWorkflowApiError && error.status >= 400) return t("research.historyPrepareHttpFailed", { status: error.status }, "Local plan preparation was rejected (HTTP {status}). This click sent no new model request; earlier requests may already have incurred charges. Nothing is retried automatically.");
  return t("research.historyPrepareFailed", undefined, "The local preparation did not return a plan. This click sent no new model request; earlier requests may already have incurred charges. Nothing is retried automatically.");
}

export function selectedHistoryCount(job: Adoption): number {
  return Math.max(job.historySelection?.length ?? 0, job.selectedHistories?.length ?? 0, job.historyReview?.coverage.selectedHistories ?? 0);
}

export function historyReviewReady(job: Adoption): boolean {
  if (job.status === "confirmed") return true;
  if (job.agentJob && (!job.agentJob.authorized || job.agentJob.phase !== "proposal-ready")) return false;
  if (selectedHistoryCount(job) === 0) return true;
  const review = job.historyReview, coverage = review?.coverage;
  return job.status === "proposal-ready" && !!review && review.status === "complete" && review.canConfirm === true && !!coverage &&
    (!job.agentJob || Object.entries(coverage).every(([key, value]) => job.agentJob!.coverage[key as keyof typeof coverage] === value)) &&
    Object.values(coverage).every(value => count(value)) &&
    coverage.selectedHistories === selectedHistoryCount(job) && coverage.completedHistories === coverage.selectedHistories &&
    coverage.completedMessages === coverage.eligibleMessages && coverage.completedBytes === coverage.eligibleBytes &&
    coverage.completedBatches === coverage.totalBatches;
}

function validPlan(plan: Plan): boolean {
  const total = plan.totalRequests ?? plan.batchCount + plan.mergeCallCount;
  const reused = plan.reusedRequests ?? 0;
  return typeof plan.planId === "string" && !!plan.planId && typeof plan.planHash === "string" && !!plan.planHash &&
    !!pair(plan.model) && [plan.contextWindow, plan.maxTokens, plan.maxRequests, plan.batchCount, plan.mergeCallCount, total, reused].every(count) &&
    plan.maxRequests + reused === total && total === plan.batchCount + plan.mergeCallCount &&
    Array.isArray(plan.histories) && plan.histories.every(history => !history.blockers?.length) && Array.isArray(plan.blockers) && plan.blockers.length === 0;
}
function matchesSelection(plan: Plan, job: Adoption): boolean {
  const ids = job.historySelection?.length ? job.historySelection : (job.selectedHistories ?? []).map(history => history.id);
  return ids.length === selectedHistoryCount(job) && new Set(ids).size === ids.length && plan.histories.length === ids.length &&
    new Set(plan.histories.map(history => history.id)).size === ids.length && plan.histories.every(history => ids.includes(history.id));
}

export interface HistoryPrepareIntent {
  jobId: string;
  nonce: string;
  model: ResWorkflowModel;
  selection: string;
}

export function ResWorkflowHistoryReview({ job, cwd, onJob, onRefresh, autoPrepare, onAutoPrepareConsumed }: {
  job: Adoption;
  cwd: string;
  onJob: (job: Adoption) => void;
  onRefresh: () => void;
  autoPrepare?: HistoryPrepareIntent | null;
  onAutoPrepareConsumed?: (nonce: string) => void;
}) {
  const apiBase = useApiBase();
  const scope = `${apiBase}\0${cwd}\0${job.id}`;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState(false);
  const [modelRevision, setModelRevision] = useState(0);
  const [selected, setSelected] = useState(() => pair(job.historyReview?.plan?.model ?? job.model));
  const [prepared, setPrepared] = useState<Plan | undefined>(() => job.historyReview?.status === "prepared" ? job.historyReview.plan : undefined);
  const [consent, setConsent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureCode, setFailureCode] = useState<ResWorkflowErrorCode | null>(null);
  const mounted = useRef(true), generation = useRef(0), inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const current = useRef({ scope, job, selected, models, consent, failureCode });
  current.current = { scope, job, selected, models, consent, failureCode };
  const serverPlanKey = `${job.historyReview?.plan?.planId ?? ""}\0${job.historyReview?.plan?.planHash ?? ""}`;
  const previousServerPlan = useRef(serverPlanKey);
  useEffect(() => {
    mounted.current = true;
    if (controller.current?.signal.aborted) { inFlight.current = false; setBusy(false); }
    return () => { mounted.current = false; generation.current++; controller.current?.abort(); inFlight.current = false; };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setModelLoading(true); setModelError(false);
    void getResWorkflowModels(cwd, abort.signal).then(result => {
      if (!abort.signal.aborted && current.current.scope === scope) setModels(result);
    }).catch(() => { if (!abort.signal.aborted && current.current.scope === scope) setModelError(true); })
      .finally(() => { if (!abort.signal.aborted && current.current.scope === scope) setModelLoading(false); });
    return () => abort.abort();
  }, [cwd, scope, modelRevision]);
  useEffect(() => {
    if (previousServerPlan.current === serverPlanKey) return;
    previousServerPlan.current = serverPlanKey;
    generation.current++; controller.current?.abort(); inFlight.current = false; setBusy(false); setConsent(null);
    setFailureCode(null); current.current.failureCode = null;
    const plan = job.historyReview?.plan;
    setPrepared(job.historyReview?.status === "prepared" && pair(plan?.model) === current.current.selected ? plan : undefined);
  }, [serverPlanKey, job.historyReview?.status]);

  const selectedModel = models.find(model => pair(model) === selected);
  const review = job.historyReview;
  const running = review?.status === "running" || job.status === "inventory" || job.status === "analyzing";
  const plan = prepared && pair(prepared.model) === selected ? prepared : undefined;
  const planCurrent = !!plan && !!selectedModel && !modelLoading && !modelError && review?.status === "prepared" &&
    review.plan?.planId === plan.planId && review.plan?.planHash === plan.planHash && validPlan(plan) && matchesSelection(plan, job);
  const planBinding = planCurrent ? JSON.stringify([scope, plan!.planId, plan!.planHash, selected]) : "";
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const canPrepare = !!selectedModel && !modelLoading && !modelError && !busy && !running;
  const requiresNewPlan = (review?.status === "interrupted" && needsDistinctPlan(job.error)) || needsDistinctPlan(failureCode);
  const previousPlan = review?.plan;
  const recoveryAvailable = !!previousPlan?.planId && !!previousPlan?.planHash;

  function fresh(token: number, captured: { scope: string; selected: string; jobId: string }, signal: AbortSignal) {
    return mounted.current && !signal.aborted && generation.current === token && current.current.scope === captured.scope &&
      current.current.job.id === captured.jobId && current.current.selected === captured.selected && getApiBase() === apiBase &&
      current.current.models.some(model => pair(model) === captured.selected);
  }
  async function prepare(recovery = false) {
    if (!mounted.current || current.current.scope !== scope || getApiBase() !== apiBase || !canPrepare || inFlight.current || !selectedModel || current.current.selected !== selected ||
      ["inventory", "analyzing"].includes(current.current.job.status) || current.current.job.historyReview?.status === "running") return;
    const oldPlan = current.current.job.historyReview?.plan;
    const unsettled = (current.current.job.historyReview?.status === "interrupted" && needsDistinctPlan(current.current.job.error)) || needsDistinctPlan(current.current.failureCode);
    if (!recovery && unsettled || recovery && (!oldPlan?.planId || !oldPlan.planHash)) return;
    const abort = new AbortController(), token = ++generation.current;
    const captured = { scope, selected, jobId: job.id };
    controller.current = abort; inFlight.current = true; setBusy(true); setError(null); setFailureCode(null); current.current.failureCode = null; setConsent(null); consentRef.current = null; setPrepared(undefined);
    try {
      const next = await prepareResWorkflowHistoryReview(job.id, { cwd, requestId: randomUuid(), model: { provider: selectedModel.provider, id: selectedModel.id },
        ...(recovery ? { recovery: { mode: "new-plan" as const, previousPlanId: oldPlan!.planId, previousPlanHash: oldPlan!.planHash } } : {}),
      }, abort.signal);
      if (!fresh(token, captured, abort.signal)) return;
      if (next.id !== job.id || next.cwd !== cwd || next.historyReview?.plan && pair(next.historyReview.plan.model) !== captured.selected) throw new Error("scope-mismatch");
      if (recovery) {
        const nextPlan = next.historyReview?.plan, archived = next.historyReview?.previousAttempt;
        if (!nextPlan || nextPlan.planId === oldPlan!.planId || nextPlan.planHash === oldPlan!.planHash) throw new Error("recovery-plan-not-new");
        if (archived?.planId !== oldPlan!.planId || archived.planHash !== oldPlan!.planHash) throw new Error("recovery-archive-mismatch");
      }
      setPrepared(next.historyReview?.status === "prepared" ? next.historyReview.plan : undefined); onJob(next); onRefresh();
    } catch (caught) {
      if (fresh(token, captured, abort.signal)) { const code = resWorkflowErrorCode(caught); setFailureCode(code); current.current.failureCode = code; setError(prepareFailureLabel(caught)); }
    } finally { if (mounted.current && generation.current === token) { inFlight.current = false; setBusy(false); } }
  }
  async function analyze() {
    if (!mounted.current || current.current.scope !== scope || getApiBase() !== apiBase || !planCurrent || !plan || !selectedModel || !planBinding || consentRef.current !== planBinding || inFlight.current || running) return;
    const latest = current.current.job.historyReview?.plan;
    if (latest?.planId !== plan.planId || latest.planHash !== plan.planHash || current.current.selected !== selected ||
      current.current.job.historyReview?.status !== "prepared" || !matchesSelection(plan, current.current.job) ||
      !current.current.models.some(model => pair(model) === selected)) return;
    const abort = new AbortController(), token = ++generation.current;
    const captured = { scope, selected, jobId: job.id };
    controller.current = abort; inFlight.current = true; setBusy(true); setError(null); setConsent(null); consentRef.current = null;
    try {
      const next = await analyzeResWorkflowHistoryReview(job.id, { cwd, requestId: randomUuid(), model: { provider: selectedModel.provider, id: selectedModel.id }, consent: {
        scope: "research-files-and-normal-messages", includeUnpublished: true, analysisMode: "full-history-review-v1", planId: plan.planId, planHash: plan.planHash,
      } }, abort.signal);
      if (!fresh(token, captured, abort.signal)) return;
      if (next.id !== job.id || next.cwd !== cwd || next.historyReview?.plan?.planId !== plan.planId || next.historyReview.plan.planHash !== plan.planHash) throw new Error("scope-mismatch");
      onJob(next); onRefresh();
    } catch (caught) {
      if (fresh(token, captured, abort.signal)) { const code = resWorkflowErrorCode(caught); setFailureCode(code); current.current.failureCode = code; setPrepared(undefined); setError(historyReviewFailureLabel(code) ?? t("research.historyAnalyzeFailed", undefined, "This authorization did not return a confirmed start. It may already have incurred charges. Check the current progress before preparing another plan; no model request was retried automatically.")); }
    } finally { if (mounted.current && generation.current === token) { inFlight.current = false; setBusy(false); } }
  }
  useEffect(() => {
    if (!autoPrepare || autoPrepare.jobId !== job.id || job.status !== "awaiting-model" || !canPrepare || pair(autoPrepare.model) !== selected ||
      autoPrepare.selection !== JSON.stringify([...(job.historySelection ?? [])].sort())) return;
    onAutoPrepareConsumed?.(autoPrepare.nonce);
    void prepare();
  }, [autoPrepare?.nonce, job.status, canPrepare, selected, job.id]);

  const coverage = review?.coverage ?? { selectedHistories: selectedHistoryCount(job), completedHistories: 0, eligibleMessages: 0, completedMessages: 0, eligibleBytes: 0, completedBytes: 0, completedBatches: 0, totalBatches: 0 };
  const complete = historyReviewReady(job);
  const displayPlan = plan ?? (review?.status !== "prepared" ? review?.plan : undefined);
  const historyNames = new Map((job.selectedHistories ?? []).map(history => [history.id, history.name || `Pi ${history.sessionId}`]));
  return <div data-testid="res-workflow-history-review" className="space-y-3 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
    <h3 className="font-semibold">{t("research.historyReviewTitle", undefined, "Selected histories · full normal-text review")}</h3>
    <p>{complete ? t("research.historyReviewComplete", undefined, "All selected histories reviewed · draft awaits your confirmation") : review?.status === "running" ? t("research.historyReviewRunning", undefined, "Model review is running. A draft cannot be confirmed until all selected histories and batches are covered.") : job.proposal ? t("research.historyReviewRequired", undefined, "The directory draft is retained. Selected histories are not yet fully covered, so confirmation is disabled.") : review?.status === "prepared" ? t("research.historyPreparedNoDraft", undefined, "The local plan is ready for a new authorization. There is no draft to confirm yet. Review the model and material scope before checking the box.") : t("research.historyNoDraftYet", undefined, "There is no draft to confirm yet. Prepare a local full-history plan, then review its model and material scope before authorizing execution.")}</p>
    <div data-testid="res-workflow-history-coverage" role="status" aria-live="polite" className="space-y-1 text-[var(--text-secondary)]">
      <p>{t("research.historyCoverageCount", { done: coverage.completedHistories, total: coverage.selectedHistories }, "Histories covered {done} / {total}")}</p>
      <p>{t("research.historyModelHistories", { count: Math.max(0, coverage.completedHistories - (coverage.emptyHistories ?? 0)), empty: coverage.emptyHistories ?? 0 }, "Histories processed by the model {count} · locally verified empty histories {empty} (no model call)")}</p>
      <p>{t("research.historyCoverageText", { done: coverage.completedMessages, total: coverage.eligibleMessages, bytes: coverage.completedBytes, totalBytes: coverage.eligibleBytes }, "Normal messages reviewed {done} / {total} · text bytes {bytes} / {totalBytes}")}</p>
      <p>{t("research.historyCoverageBatches", { done: coverage.completedBatches, total: coverage.totalBatches }, "Reading batches completed {done} / {total}")}</p>
    </div>
    {review?.status === "interrupted" && <p className="text-[var(--severity-warning-fg)]">{t("research.historyInterrupted", undefined, "Completed checkpoints are retained. Prepare a new plan before authorizing additional model requests. An interrupted or unknown request may need reconciliation; nothing resumes automatically.")}</p>}
    {review?.status === "blocked" && <p role="alert">{t("research.historyPlanBlocked", undefined, "The local plan is blocked. Resolve the listed scope, resource or privacy problems before authorizing model requests.")}</p>}
    {review?.previousAttempt && <div data-testid="res-workflow-history-previous-attempt" className="space-y-1 border border-[var(--severity-warning-border)] bg-[var(--severity-warning-bg)] p-3">
      <p>{t("research.historyPreviousAttempt", { intents: count(review.previousAttempt.requestIntents) ? review.previousAttempt.requestIntents : "?", completed: count(review.previousAttempt.completedRequests) ? review.previousAttempt.completedRequests : "?" }, "Earlier attempt: {intents} earlier request intents · {completed} verified completed requests. These requests may already have incurred charges; their records are retained.")}</p>
      <p>{historyReviewFailureLabel(review.previousAttempt.errorCode) ?? t("research.historyPreviousOutcome", undefined, "The earlier attempt is not a verified complete result. Preparing this distinct plan does not replay its requests or erase their possible charges.")}</p>
    </div>}
    {!complete && <>
      <ModelSelector models={models} current={selected || undefined} onSelect={label => { generation.current++; controller.current?.abort(); inFlight.current = false; setBusy(false); setSelected(label); current.current.selected = label; setPrepared(undefined); setConsent(null); consentRef.current = null; setError(null); }} allowRoles={false} disabled={running || busy || modelLoading || modelError} placeholder={t("research.selectExactModel", undefined, "Select an explicit provider/model")} />
      {modelError && <button type="button" className={BUTTON} onClick={() => { generation.current++; setConsent(null); setPrepared(undefined); setModelRevision(value => value + 1); }}>{t("research.retryModelCatalogue", undefined, "Retry model list")}</button>}
      {autoPrepare && job.status === "inventory" && <p>{t("research.historyLocalWaiting", undefined, "Local inventory is running. The requested full-history plan will be prepared after inventory finishes; this does not call a model.")}</p>}
      {!requiresNewPlan && <button type="button" className={BUTTON} data-testid="res-workflow-history-prepare" disabled={!canPrepare} onClick={() => void prepare()}>{t("research.historyPrepareCount", { count: selectedHistoryCount(job) }, "Prepare a full-text plan for {count} histories (does not call a model)")}</button>}
      {requiresNewPlan && <div className="space-y-2" data-testid="res-workflow-history-recovery">
        <p>{t("research.historyNewPlanExplanation", undefined, "The earlier request will not be repeated. This action only prepares a distinct local plan and preserves the earlier attempt. Review the new plan and its model/material scope before authorizing execution.")}</p>
        <button type="button" className={BUTTON} data-testid="res-workflow-history-new-plan" disabled={!canPrepare || !recoveryAvailable} onClick={() => void prepare(true)}>{t("research.historyPrepareNewPlanOnly", undefined, "Prepare a new plan only (no model call)")}</button>
        {!recoveryAvailable && <p>{t("research.historyRecoveryRefresh", undefined, "Refresh the current task to obtain its exact earlier plan before preparing a new one.")}</p>}
      </div>}
    </>}
    {displayPlan && <div data-testid="res-workflow-history-plan" className="space-y-2 border-t border-[var(--border-secondary)] pt-3">
      <p className="break-all font-semibold">{t("research.recipient", undefined, "Recipient")} · {pair(displayPlan.model)}</p>
      <p>{t("research.historyPlanWorkload", { count: displayPlan.maxRequests }, "Planned workload: {count} model requests; charges follow actual usage")}</p>
      <p>{t("research.historyPlanBatches", { batches: displayPlan.batchCount, merges: displayPlan.mergeCallCount }, "Full plan: {batches} reading batches + {merges} merge requests")}{(displayPlan.reusedRequests ?? 0) > 0 && ` · ${t("research.historyPlanReuse", { count: displayPlan.reusedRequests! }, "{count} completed requests reused; not sent again")}`}</p>
      <p>{t("research.historyPlanTokens", { context: displayPlan.contextWindow, output: displayPlan.maxTokens }, "Model context limit {context} tokens · output limit per request {output} tokens")}</p>
      {displayPlan.directorySnapshot && <p data-testid="res-workflow-history-directory-snapshot">{t("research.historyDirectorySnapshot", { sources: displayPlan.directorySnapshot.sourceCount, bytes: displayPlan.directorySnapshot.bytes, batches: displayPlan.directorySnapshot.batchCount, artifacts: displayPlan.directorySnapshot.metadataOnlyArtifacts }, "Directory: bounded frozen snapshot only · {sources} sources · {bytes} text bytes · {batches} batches · {artifacts} artifacts described by metadata only. Earlier sampled history text is excluded from this directory scope.")}</p>}
      <p>{t("research.historyReadScope", undefined, "All eligible normal text from every selected history is read in batches. Resource or privacy limits block the plan with reasons; it never silently falls back to a sample.")}</p>
      <ul className="max-h-64 space-y-2 overflow-y-auto">{displayPlan.histories.map(history => <li key={history.id} className="break-words"><span className="font-semibold">{historyNames.get(history.id) ?? `Pi ${history.sessionId}`}</span> · {t("research.historyPlanHistoryCounts", { messages: history.eligibleMessages, bytes: history.eligibleBytes, batches: history.chunkCount }, "{messages} eligible messages · {bytes} text bytes · {batches} batches")}{history.emptyReason && <span> · {history.emptyReason}</span>}{!!history.sensitiveFilteredMessages && <span> · {t("research.historySensitiveBlocked", { count: history.sensitiveFilteredMessages }, "{count} sensitive messages blocked")}</span>}{history.filteredCounts && <p className="text-[var(--text-secondary)]">{t("research.historyFilteredCounts", { tools: history.filteredCounts.toolMessages, nonText: history.filteredCounts.nonTextMessages, custom: history.filteredCounts.customEntries, compacted: history.filteredCounts.compactionEntries, branches: history.filteredCounts.offBranchEntries }, "Excluded structure: tool messages {tools} · non-text {nonText} · custom entries {custom} · compaction entries {compacted} · entries outside the authorized branch {branches}")}</p>}</li>)}</ul>
      <p>{t("research.historyPrivacyScope", undefined, "Only authorized directory material and the selected histories' normal text may be sent to this physical model/provider. This may include unpublished research. Thinking, tool arguments, credentials and raw logs are excluded. No experiments run and no old session is restored.")}</p>
      {displayPlan.blockers.length > 0 && <ul role="alert">{displayPlan.blockers.map(code => <li key={code}>{code}</li>)}</ul>}
      {planCurrent && !running && <>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0" data-testid="res-workflow-history-consent" checked={consent === planBinding} disabled={busy} onChange={event => { const value = event.target.checked ? planBinding : null; consentRef.current = value; setConsent(value); }} /><span>{t("research.historyFullConsent", undefined, "I authorize this exact full-history plan and physical model to process the selected materials, which may include unpublished research. I will review the resulting draft before confirmation. This does not authorize experiments, session restoration or publication.")}</span></label>
        <button type="button" className={BUTTON} data-testid="res-workflow-history-analyze" disabled={busy || consent !== planBinding} onClick={() => void analyze()}>{t("research.historyAuthorizePlan", undefined, "Authorize this plan and review full histories")}</button>
      </>}
    </div>}
    {error && <p role="alert" className="text-[var(--severity-error-fg)]">{error}</p>}
  </div>;
}
