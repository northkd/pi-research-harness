import type { ResearchWorkbenchObservation, ResearchWorkbenchRelation, ResearchWorkbenchExecution } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { deriveResearchSessionRelations, projectResearchSession, type ResearchSessionProvenance } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";

export const RESEARCH_STAGE_IDS = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"] as const;
export type StageId = typeof RESEARCH_STAGE_IDS[number];
export type Signal = "positive" | "negative" | "inconclusive" | "blocked" | "error";
export interface Claim {
  id: string; statement: string; status: string; evidence?: string[];
  acceptance?: { verdict: string; scope?: string; diagnostics?: string[]; jury?: Array<{ modelId?: string; family?: string }>; counterexample?: { status?: string }; unresolvedObligations?: string[]; decidedAt?: string };
  publication?: { authorized?: boolean };
}
export interface Attempt {
  seq: number; phase?: number; at?: string; kind: string; signal: Signal; action: string;
  observed?: string; hypothesisId?: string;
}
export interface LoopState {
  charter?: { objective?: string; successCriteria?: string[]; nonGoals?: string[]; revision?: number; frozenAt?: string };
  stage?: StageId; attempts?: number; phase?: number; claims?: Claim[];
  budget?: { maxAttempts?: number }; updatedAt?: string;
}
export interface ResearchEvent { at?: string; kind: string; detail?: Record<string, unknown> }
export type AutoRunReceipt = Record<string, unknown>;
export type ResearchFileSet = Record<"state.json" | "ledger.jsonl" | "events.jsonl" | "auto-run.json", string | null>;
export interface ResearchSnapshot { state: LoopState | null; attempts: Attempt[]; events: ResearchEvent[]; receipt: AutoRunReceipt | null }
export interface ResearchStep {
  runId: string; key: string; agent: string; stage?: StageId; childRunId?: string;
  status: string; businessStatus?: string; label?: string; observedModel?: string; startedAt?: string; endedAt?: string;
  summary?: string; evidence: string[]; sourceSeq?: number;
  lastActivityAt?: string;
}
export interface ResearchRun {
  runId: string; launchId?: string; parentSessionId?: string; charterRevision?: number;
  registeredAt?: string; taskDir?: string; configuration?: Record<string, unknown>;
  status: string; outcome?: string; reason?: string; steps: ResearchStep[]; launchOrder: number;
}
export interface ResearchProjection {
  stage: StageId | null; enteredStages: Set<StageId>; runs: ResearchRun[];
  currentRun: ResearchRun | null; updatedAt: string | null;
  executions: ResearchExecution[]; relations: ResearchWorkbenchRelation[]; configuration: unknown;
  reviews: ResearchEvent[];
}
export interface ResearchExecution extends Omit<ResearchWorkbenchExecution, "kind" | "status"> {
  kind: ResearchWorkbenchExecution["kind"] | "workflow-step"; status: string; source: "observation" | "workflow-record";
  workflowRunId?: string; workflowKey?: string; summary?: string; evidence: string[];
  workflowStatus?: string;
  observedAt?: string;
}
export interface ConfiguredRole { name: string; skills: string[]; note?: string; model?: string }
export type ResearchExecutionOriginKind = "user-created" | "workflow-created" | "lead-agent-created";
export interface ResearchSessionInfoLike {
  id?: string;
  name?: string;
  firstMessage?: string;
  nameSource?: string;
  via?: string;
  resWorkflow?: { via?: string };
  researchSession?: unknown;
  pluginRefs?: Record<string, Record<string, unknown>>;
}
export interface ResearchExecutionOrigin {
  kind: ResearchExecutionOriginKind;
  label: string;
  creatorSessionId?: string;
  creatorLabel: string;
  role?: string;
  provenance?: ResearchSessionProvenance;
}

/**
 * Three distinct origins for a real execution. A lead-created collaborator is
 * identified only by persisted provenance (role + true creator session); its
 * prompt is never used as identity. Workflow-created means the session was
 * spawned by the workflow host rather than typed by the user.
 */
export function projectExecutionOrigin(
  row: ResearchExecution,
  info?: ResearchSessionInfoLike | null,
  workflowParentSessionId?: string,
): ResearchExecutionOrigin {
  const provenance = projectResearchSession({
    id: info?.id ?? row.sessionId ?? row.id,
    researchSession: info?.researchSession,
    pluginRefs: info?.pluginRefs,
  })?.provenance;
  if (provenance) {
    return {
      kind: "lead-agent-created",
      label: "Agent 会话创建",
      creatorSessionId: provenance.creatorSessionId,
      creatorLabel: "父会话",
      role: provenance.role,
      provenance,
    };
  }
  const workflowCreated = row.source === "workflow-record" || !!row.workflowRunId ||
    info?.via === "spawn" || info?.resWorkflow?.via === "spawn";
  if (workflowCreated) {
    return {
      kind: "workflow-created",
      label: "工作流创建",
      ...(workflowParentSessionId ? { creatorSessionId: workflowParentSessionId } : {}),
      creatorLabel: "工作流",
      role: row.role,
    };
  }
  // A native parent execution is also direct ancestry evidence when provenance
  // is unavailable (for example while the session metadata request is loading).
  if (row.kind === "pi-session" && row.parentExecutionId && row.parentExecutionId !== row.id) {
    return {
      kind: "lead-agent-created", label: "Agent 会话创建",
      creatorSessionId: row.parentExecutionId.startsWith("session-") ? row.parentExecutionId.slice(8) : row.parentExecutionId,
      creatorLabel: "父会话", role: row.role,
    };
  }
  return { kind: "user-created", label: "用户创建", creatorLabel: "用户", role: row.role };
}

/**
 * Dispatch edges for lead-created collaborators, resolved through the actual
 * workbench execution ids (`session-<sessionId>`), never raw session ids.
 */
export function projectResearchSessionRelations(
  executions: ResearchExecution[],
  sessions: ResearchSessionInfoLike[],
): ResearchWorkbenchRelation[] {
  return deriveResearchSessionRelations(
    executions.map(row => ({ id: row.id, ...(row.sessionId ? { sessionId: row.sessionId } : {}) })),
    sessions.flatMap(session => typeof session.id === "string"
      ? [{ id: session.id, researchSession: session.researchSession, pluginRefs: session.pluginRefs }]
      : []),
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, limit = 512): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function isResearchStage(value: unknown): value is StageId {
  return RESEARCH_STAGE_IDS.includes(value as StageId);
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function jsonObject(value: string | null, name: string): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = object(JSON.parse(value));
    if (parsed) return parsed;
  } catch { /* The caller needs a distinct corrupt-file state, not an empty project. */ }
  throw new Error(name === "state.json" ? "研究状态文件损坏：state.json" : `研究文件损坏：${name}`);
}
function jsonLines(value: string | null, name: string): Record<string, unknown>[] {
  return (value ?? "").split("\n").filter(line => line.trim()).map((line, index) => {
    try {
      const parsed = object(JSON.parse(line));
      if (parsed) return parsed;
    } catch { /* A partially written line is retried by the live reader. */ }
    throw new Error(`研究文件损坏：${name} 第 ${index + 1} 行`);
  });
}

export function parseResearchSnapshot(files: ResearchFileSet): ResearchSnapshot {
  const state = jsonObject(files["state.json"], "state.json");
  if (state) {
    const charter = object(state.charter);
    if ((state.charter !== undefined && !charter)
      || (charter?.objective !== undefined && typeof charter.objective !== "string")
      || (charter?.successCriteria !== undefined && (!Array.isArray(charter.successCriteria) || charter.successCriteria.some(c => typeof c !== "string")))
      || (state.claims !== undefined && (!Array.isArray(state.claims) || state.claims.some(c => {
        const claim = object(c);
        if (!claim || typeof claim.id !== "string" || typeof claim.statement !== "string" || typeof claim.status !== "string") return true;
        const acceptance = object(claim.acceptance), publication = object(claim.publication);
        return (claim.acceptance != null && (!acceptance || typeof acceptance.verdict !== "string"))
          || (claim.publication != null && (!publication || (publication.authorized !== undefined && typeof publication.authorized !== "boolean")));
      })))) throw new Error("研究状态文件损坏：state.json 字段类型不正确");
    if (Array.isArray(state.claims)) state.claims = state.claims.map((value: unknown) => {
      const claim = object(value)!, acceptance = object(claim.acceptance);
      const strings = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").slice(0, 64).map(item => item.slice(0, 2000)) : undefined;
      return { ...claim, ...(acceptance ? { acceptance: { ...acceptance, diagnostics: strings(acceptance.diagnostics), unresolvedObligations: strings(acceptance.unresolvedObligations),
        jury: Array.isArray(acceptance.jury) ? acceptance.jury.slice(0, 32).flatMap(item => { const row = object(item); return row ? [{ modelId: text(row.modelId, 256), family: text(row.family, 128) }] : []; }) : undefined,
        counterexample: object(acceptance.counterexample) ? { status: text(object(acceptance.counterexample)?.status, 128) } : undefined,
      } } : {}) };
    });
  }
  const attempts = jsonLines(files["ledger.jsonl"], "ledger.jsonl");
  if (attempts.some(a => number(a.seq) === undefined || typeof a.action !== "string" || typeof a.kind !== "string"
    || !["positive", "negative", "inconclusive", "blocked", "error"].includes(String(a.signal))
    || (a.observed !== undefined && typeof a.observed !== "string") || (a.hypothesisId !== undefined && typeof a.hypothesisId !== "string"))) {
    throw new Error("研究文件损坏：ledger.jsonl 尝试字段类型不正确");
  }
  const events = jsonLines(files["events.jsonl"], "events.jsonl");
  if (events.some(e => typeof e.kind !== "string" || (e.detail !== undefined && !object(e.detail)))) {
    throw new Error("研究文件损坏：events.jsonl 事件字段类型不正确");
  }
  return {
    state: state as LoopState | null,
    attempts: attempts as unknown as Attempt[], events: events as unknown as ResearchEvent[],
    receipt: jsonObject(files["auto-run.json"], "auto-run.json"),
  };
}

function evidencePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is string => typeof p === "string" && p.length <= 1024).map(p => p.replaceAll("\\", "/"))
    .filter(p => p.length > 0 && !p.startsWith("/") && !/^[a-z]+:/i.test(p) && !p.includes("\0") && !p.split("/").includes(".."));
}
const TERMINAL = new Set(["completed", "failed", "stopped", "cancelled", "blocked"]);

/** File evidence is projected without inventing attempts, missing models or completed stages. */
export function projectResearch(snapshot: ResearchSnapshot, observation?: ResearchWorkbenchObservation | null): ResearchProjection {
  const { state, events, receipt } = snapshot;
  const launches = new Map<string, number>();
  events.forEach((e, index) => {
    const launchId = text(e.detail?.launchId);
    if (e.kind === "auto-run" && launchId) launches.set(launchId, index);
  });
  const runs = new Map<string, ResearchRun>();
  events.forEach((e, index) => {
    if (e.kind !== "run-registered") return;
    const d = e.detail ?? {};
    const runId = text(d.runId);
    if (!runId || runs.has(runId)) return;
    const launchId = text(d.launchId);
    runs.set(runId, {
      runId, launchId, parentSessionId: text(d.parentSessionId), charterRevision: number(d.charterRevision),
      registeredAt: timestamp(e.at), taskDir: text(d.taskDir), configuration: object(d.configuration) ?? undefined,
      status: "registered", steps: [], launchOrder: (launchId ? launches.get(launchId) : undefined) ?? index,
    });
  });
  const details = object(object(receipt?.result)?.details);
  const receiptRunId = text(receipt?.runId) ?? text(details?.runId) ?? text(details?.asyncId);
  if (receiptRunId && !runs.has(receiptRunId)) {
    runs.set(receiptRunId, {
      runId: receiptRunId, launchId: text(receipt?.launchId), parentSessionId: text(receipt?.parentSessionId),
      charterRevision: number(receipt?.charterRevision), registeredAt: timestamp(receipt?.at),
      configuration: object(receipt?.configuration) ?? undefined,
      status: "registered", steps: [], launchOrder: -1,
    });
  }
  const seen = new Set<string>();
  const rootSequences = new Map<string, number>();
  for (const e of events) {
    const d = e.detail ?? {};
    const runId = text(d.runId);
    const run = runId ? runs.get(runId) : undefined;
    if (!run) continue;
    const eventId = text(d.eventId);
    const identity = `${e.kind}:${run.runId}:${eventId}`;
    if (eventId && seen.has(identity)) continue;
    if (eventId) seen.add(identity);
    const sequence = number(d.sourceSeq);
    if (e.kind === "run-outcome") {
      if (sequence !== undefined && sequence < (rootSequences.get(run.runId) ?? -1)) continue;
      const next = text(d.status);
      if (next && (!TERMINAL.has(run.status) || TERMINAL.has(next))) run.status = next;
      run.outcome = text(d.outcome) ?? run.outcome;
      run.reason = text(d.reason, 2000) ?? run.reason;
      if (sequence !== undefined) rootSequences.set(run.runId, sequence);
      continue;
    }
    if (e.kind !== "run-step") continue;
    const key = text(d.key);
    const status = text(d.status);
    if (!key || !status) continue;
    const previous = run.steps.find(s => s.key === key);
    if (previous?.sourceSeq !== undefined && sequence !== undefined && sequence < previous.sourceSeq) continue;
    const actualStage = isResearchStage(d.stage) ? d.stage : previous?.stage;
    const patch: ResearchStep = {
      runId: run.runId, key, agent: text(d.agent) ?? previous?.agent ?? "未记录角色",
      stage: actualStage, childRunId: text(d.childRunId) ?? previous?.childRunId,
      status: previous && TERMINAL.has(previous.status) && !TERMINAL.has(status) ? previous.status : status,
      businessStatus: text(d.businessStatus) ?? previous?.businessStatus,
      label: text(d.label) ?? previous?.label, observedModel: text(d.observedModel) ?? previous?.observedModel,
      startedAt: timestamp(d.startedAt) ?? previous?.startedAt ?? ((status === "started" || status === "running") ? timestamp(d.sourceAt) : undefined),
      endedAt: timestamp(d.endedAt) ?? previous?.endedAt ?? (TERMINAL.has(status) ? timestamp(d.sourceAt) : undefined),
      summary: text(d.summary, 4000) ?? previous?.summary,
      evidence: d.evidence !== undefined ? evidencePaths(d.evidence) : previous?.evidence ?? [],
      sourceSeq: sequence ?? previous?.sourceSeq,
      lastActivityAt: timestamp(d.sourceAt) ?? timestamp(e.at) ?? previous?.lastActivityAt,
    };
    if (previous) Object.assign(previous, patch);
    else run.steps.push(patch);
  }
  const frozenAt = timestamp(state?.charter?.frozenAt);
  const revision = state?.charter?.revision;
  const ordered = [...runs.values()].sort((a, b) => b.launchOrder - a.launchOrder);
  for (const run of ordered) {
    if (run.status === "registered" && run.steps.length) {
      run.status = run.steps.some(s => ["started", "running", "queued"].includes(s.status)) ? "running" : "waiting";
    }
  }
  const currentRun = ordered.find(run => {
    if (revision !== undefined && run.charterRevision !== undefined && run.charterRevision !== revision) return false;
    return !frozenAt || !run.registeredAt || run.registeredAt >= frozenAt;
  }) ?? null;
  const stageEvents = events.map((e, index) => ({ e, index })).filter(({ e }) => {
    const d = e.detail ?? {};
    if (e.kind !== "stage-enter" || !isResearchStage(d.stage)) return false;
    // A stage event from an older charter cannot describe the current charter.
    const eventRevision = number(d.charterRevision);
    if (eventRevision !== undefined && revision !== undefined && eventRevision !== revision) return false;
    const id = text(d.runId);
    if (id) return id === currentRun?.runId;
    return !frozenAt || !timestamp(e.at) || timestamp(e.at)! >= frozenAt;
  }).sort((a, b) => {
    const x = number(a.e.detail?.sourceSeq), y = number(b.e.detail?.sourceSeq);
    const ar = text(a.e.detail?.runId), br = text(b.e.detail?.runId);
    if (ar && ar === br && x !== undefined && y !== undefined) return x - y;
    // Runless observations have no source sequence; their real observation
    // time wins, and append order only breaks exact ties.
    const t1 = timestamp(a.e.detail?.selectedAt) ?? timestamp(a.e.detail?.observedAt) ?? timestamp(a.e.detail?.sourceAt) ?? timestamp(a.e.at);
    const t2 = timestamp(b.e.detail?.selectedAt) ?? timestamp(b.e.detail?.observedAt) ?? timestamp(b.e.detail?.sourceAt) ?? timestamp(b.e.at);
    return t1 && t2 ? t1.localeCompare(t2) || a.index - b.index : a.index - b.index;
  });
  const enteredStages = new Set(stageEvents.map(({ e }) => e.detail!.stage as StageId));
  const times = [state?.updatedAt, ...snapshot.attempts.map(a => a.at), ...events.map(e => e.at)]
    .map(timestamp).filter((t): t is string => !!t).sort();
  const executions: ResearchExecution[] = (observation?.executions ?? []).map(row => ({ ...row, source: "observation", evidence: [], observedAt: observation?.updatedAt }));
  for (const run of ordered) {
    if (revision !== undefined && run.charterRevision !== undefined && run.charterRevision !== revision || frozenAt && run.registeredAt && run.registeredAt < frozenAt) continue;
    for (const step of run.steps) {
      const matching = step.childRunId && run.parentSessionId && observation?.executions.some(row => row.nativeRunId === step.childRunId
        && observation.executions.find(parent => parent.id === row.parentExecutionId)?.sessionId === run.parentSessionId);
      if (matching) continue; // Exact native identity only; never deduplicate by name/model/cwd.
      executions.push({ id: `workflow:${run.runId}:${step.key}`, kind: "workflow-step", source: "workflow-record", role: step.agent,
        stage: step.stage, status: step.status, nativeRunId: step.childRunId, observedModel: step.observedModel,
        startedAt: step.startedAt, endedAt: step.endedAt, lastActivityAt: step.lastActivityAt,
        workflowRunId: run.runId, workflowKey: step.key, workflowStatus: run.status, summary: step.summary, evidence: step.evidence });
    }
  }
  const reviews = events.filter(event => ["review-round", "review-gate"].includes(event.kind)
    && (!frozenAt || !timestamp(event.at) || timestamp(event.at)! >= frozenAt)
    && (!text(event.detail?.runId) || event.detail?.runId === currentRun?.runId));
  return { stage: (stageEvents.at(-1)?.e.detail?.stage as StageId | undefined) ?? null, enteredStages, runs: ordered, currentRun,
    updatedAt: times.at(-1) ?? null, executions, relations: observation?.relations ?? [], configuration: observation?.configuration ?? currentRun?.configuration ?? null, reviews };
}

export function latestObservedExecution(executions: ResearchExecution[]): ResearchExecution | undefined {
  const time = (row: ResearchExecution) => Math.max(...[row.lastActivityAt, row.endedAt, row.startedAt, row.observedAt].map(value => value ? Date.parse(value) || 0 : 0));
  return executions.filter(row => row.observedModel).map((row, index) => ({ row, index })).sort((a, b) => time(b.row) - time(a.row) || b.index - a.index)[0]?.row;
}

export function claimEvidence(claim: Claim): string[] { return evidencePaths(claim.evidence); }

export function configuredRolesForStage(configuration: unknown, stage: StageId): ConfiguredRole[] {
  const entry = object(object(object(configuration)?.stages)?.[stage]);
  if (!entry) return [];
  const candidates = [...(Array.isArray(entry.roles) ? entry.roles : []), entry.sequentialRole];
  const roles: ConfiguredRole[] = [];
  for (const item of candidates) {
    const role = object(item);
    const name = text(role?.role) ?? text(item);
    if (!name || roles.some(r => r.name === name)) continue;
    roles.push({ name, skills: Array.isArray(role?.skills) ? role.skills.filter((s): s is string => typeof s === "string") : [], note: text(role?.purpose) ?? text(role?.note), model: text(role?.model) });
  }
  return roles;
}

