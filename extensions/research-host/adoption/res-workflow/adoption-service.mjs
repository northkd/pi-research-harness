import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync, constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RES_WORKFLOW_MAX_HISTORY_SELECTION } from "../shared/res-workflow.mjs";
import { validAgentBudgetChoice } from "./full-history-agent-budget.mjs";
import { validateProposal } from "./analysis.mjs";
import { runReadonlyAdoptionAgent } from "./analysis-agent.mjs";
import { inventoryResearch } from "./inventory.mjs";
import { discoverHistoryCandidates } from "./history-candidates.mjs";
import { ensureProjectDirectory, readBoundedRegular } from "./safe-files.mjs";
import { listAnalysisModels, resolveModel } from "./strict-model.mjs";
import { prepareFullHistoryMaterial, readFullHistoryPlan, readFullHistoryBatch, readFullHistorySource } from "./full-history-material.mjs";
import { runFullHistoryReview } from "./full-history-review.mjs";
import { runFullHistoryAgent, FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH } from "./full-history-agent.mjs";
import { createFullHistoryAgentStore } from "./full-history-agent-store.mjs";
import { isResearchCharterBinding, isResearchCharterBindingUpdate } from "../shared/research-charter-binding.mjs";
class ResWorkflowError extends Error {
  statusCode;
  code;
  constructor(statusCode, code, message = code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
const RES_WORKFLOW_AGENT_TIMEOUT_MS = 15 * 60 * 1e3;
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const ID = /^adopt-[a-f0-9]{24}$/;
const RESEARCH_FILES = ["state.json", "ledger.jsonl", "events.jsonl", "auto-run.json"];
const validRequestId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id);
const copy = (value) => structuredClone(value);
function historySelection(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id || id.length > 128 || /[\x00-\x20]/.test(id))) throw new ResWorkflowError(400, "explicit-history-selection-required");
  if (value.length > RES_WORKFLOW_MAX_HISTORY_SELECTION) throw new ResWorkflowError(400, "history-selection-too-large");
  return [...new Set(value)].sort();
}
function validAuthorization(model, consent) {
  const m = model;
  const c = consent;
  return !!m && typeof m.provider === "string" && !!m.provider && typeof m.id === "string" && !!m.id && !m.provider.startsWith("@") && !m.id.startsWith("@") && c?.scope === "research-files-and-normal-messages" && c.includeUnpublished === true;
}
function validPhysicalModel(model) {
  const value = model;
  return !!value && typeof value.provider === "string" && !!value.provider && typeof value.id === "string" && !!value.id && !value.provider.startsWith("@") && !value.id.startsWith("@") && !/[\x00-\x20]/.test(value.provider) && !/[\x00-\x1f]/.test(value.id);
}
function requireAgentConsent(consent) {
  if (consent.analysisMode !== "snapshot-agent-v1") throw new ResWorkflowError(400, "snapshot-agent-consent-required-refresh-and-authorize");
}
async function resolveInstalledResearchLoopRoot() {
  const configured = process.env.PI_RESEARCH_LOOP_ROOT;
  if (configured !== void 0) {
    try {
      if (!path.isAbsolute(configured)) throw new Error("absolute backend path required");
      const info = await lstat(configured);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("regular backend directory required");
      const manifest = JSON.parse((await readBoundedRegular(path.join(configured, "package.json"), 16384)).text);
      if (manifest.name !== "pi-research-loop-local") throw new Error("unexpected research backend package");
      return await realpath(configured);
    } catch {
      throw new ResWorkflowError(503, "research-backend-unavailable");
    }
  }
  let ancestor = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = path.join(ancestor, "research-loop");
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ResWorkflowError(503, "research-backend-unavailable");
      const manifest = JSON.parse((await readBoundedRegular(path.join(candidate, "package.json"), 16384)).text);
      if (manifest.name !== "pi-research-loop-local") throw new ResWorkflowError(503, "research-backend-unavailable");
      return await realpath(candidate);
    } catch (err) {
      if (err.code !== "ENOENT") throw new ResWorkflowError(503, "research-backend-unavailable");
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new ResWorkflowError(503, "research-backend-unavailable");
}
function createResWorkflowService(deps) {
  deps = { ...deps, privateDir: existsSync(deps.privateDir) ? realpathSync(deps.privateDir) : deps.privateDir };
  const running = /* @__PURE__ */ new Map();
  const confirming = /* @__PURE__ */ new Set();
  const locks = /* @__PURE__ */ new Map();
  const transaction = new AsyncLocalStorage();
  const findModel = deps.resolveModel ?? resolveModel;
  let disposed = false;
  let backendPromise;
  const backend = () => backendPromise ??= (async () => {
    const root = deps.researchLoopRoot ?? await resolveInstalledResearchLoopRoot();
    const mod = await import(pathToFileURL(path.join(root, "src", "adoption.mjs")).href);
    if (typeof mod.confirmAdoption !== "function" || typeof mod.writePrivate !== "function") throw new ResWorkflowError(503, "research-backend-unavailable");
    return mod;
  })();
  const scope = (access) => `${hash(access.ownerKey)}:${hash(access.cwd)}`;
  const directory = (access) => path.join(deps.privateDir, hash(access.ownerKey), hash(access.cwd));
  let bindingBackendPromise;
  const bindingBackend = () => bindingBackendPromise ??= (async () => {
    const root = deps.researchLoopRoot ?? await resolveInstalledResearchLoopRoot();
    const [binding, context] = await Promise.all([
      import(pathToFileURL(path.join(root, "src", "charter-binding.mjs")).href),
      import(pathToFileURL(path.join(root, "src", "workbench-context.mjs")).href)
    ]);
    if (typeof binding.readResearchCharterBinding !== "function" || typeof binding.updateResearchCharterBinding !== "function" || typeof context.inspectWorkbenchRecordContext !== "function") throw new ResWorkflowError(503, "research-charter-binding-unavailable");
    return { ...binding, inspect: context.inspectWorkbenchRecordContext };
  })().catch((error) => {
    bindingBackendPromise = void 0;
    throw error;
  });
  const fileFor = (access, id) => path.join(directory(access), `${id}.json`);
  const publicAdoption = (operation) => {
    const adoption = copy(operation.adoption);
    const selected = operation.historySelection?.length ?? adoption.selectedHistories?.length ?? 0;
    if (selected || adoption.historyReview) {
      adoption.historyReview ??= { status: "unprepared", coverage: { selectedHistories: selected, completedHistories: 0, eligibleMessages: 0, completedMessages: 0, eligibleBytes: 0, completedBytes: 0, completedBatches: 0, totalBatches: 0 }, canConfirm: false };
      adoption.historyReview.canConfirm = adoption.status === "confirmed" || !!operation.historyReview?.completedProposalHash && operation.historyReview.completedProposalHash === adoption.proposalHash && adoption.historyReview.status === "complete" && adoption.historyReview.coverage.completedHistories === selected;
      if (operation.historyReview?.finalSources) adoption.sources = [...adoption.sources, ...copy(operation.historyReview.finalSources).filter((source) => !adoption.sources.some((previous) => previous.id === source.id))];
    }
    if (operation.agent && adoption.agentJob) {
      const budget = adoption.agentJob.budget;
      budget.effectiveMaxRequests = null;
      budget.unlimited = true;
      budget.remainingRequests = 0;
      budget.revision ??= 0;
      budget.policy = "unlimited";
      if (budget.editable === void 0) {
        budget.editable = false;
        budget.editBlockedReason = "authorization-required";
      }
      adoption.agentJob.workerActive = running.has(adoption.id) || adoption.agentJob.workerActive;
      const budgetCanContinue = adoption.agentJob.phase === "awaiting-user" && budget.editable === true && ["budget-exhausted", "node-attempt-limit", "result-incomplete"].includes(adoption.agentJob.needsUserAction?.reason ?? "");
      adoption.agentJob.resumeRequired = !adoption.agentJob.workerActive && (adoption.agentJob.authorized && (!["cancelled", "proposal-ready", "awaiting-user"].includes(adoption.agentJob.phase) || budgetCanContinue) || !adoption.agentJob.authorized && !adoption.agentJob.plan && !adoption.agentJob.grant && adoption.agentJob.phase === "preparing");
      return adoption;
    }
    if (running.has(adoption.id) && operation.historyReview?.authorization && adoption.historyReview && ["blocked", "interrupted", "complete"].includes(adoption.historyReview.status)) {
      adoption.historyReview.status = "running";
      adoption.historyReview.canConfirm = false;
      adoption.status = "analyzing";
    }
    const preparingLocal = !!operation.historyReview && !operation.historyReview.authorization && ["unprepared", "prepared", "blocked"].includes(adoption.historyReview?.status ?? "");
    if (running.has(adoption.id) && !preparingLocal) {
      if (adoption.status === "awaiting-model") adoption.status = "inventory";
      else if (adoption.status === "proposal-ready" || adoption.status === "blocked") adoption.status = operation.analysisIntent ? "analyzing" : "inventory";
      if (adoption.historyReview?.status === "complete") {
        adoption.historyReview.status = "running";
        adoption.historyReview.canConfirm = false;
      }
    }
    return adoption;
  };
  async function locked(access, action) {
    const key = scope(access);
    const previous = locks.get(key) ?? Promise.resolve();
    const current2 = previous.catch(() => {
    }).then(() => {
      const context = { scope: key, active: true };
      return transaction.run(context, async () => {
        try {
          return await action();
        } finally {
          context.active = false;
        }
      });
    });
    locks.set(key, current2);
    try {
      return await current2;
    } finally {
      if (locks.get(key) === current2) locks.delete(key);
    }
  }
  async function readJson(file) {
    try {
      const { text } = await readBoundedRegular(file, 2 * 1024 * 1024, deps.privateDir);
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new ResWorkflowError(409, "private-operation-invalid");
    }
  }
  async function writeJson(access, file, value, exclusive = false) {
    await mkdir(deps.privateDir, { recursive: true, mode: 448 });
    const info = await lstat(deps.privateDir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(deps.privateDir) !== deps.privateDir) throw new ResWorkflowError(409, "private-storage-unsafe");
    await ensureProjectDirectory(deps.privateDir, [hash(access.ownerKey), hash(access.cwd)]);
    (await backend()).writePrivate(file, JSON.stringify(value, null, 2) + "\n", { exclusive });
  }
  async function save(access, operation) {
    operation.adoption.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await writeJson(access, fileFor(access, operation.adoption.id), operation);
  }
  async function operationFor(access, id, required = true) {
    if (!ID.test(id)) {
      if (required) throw new ResWorkflowError(404, "adoption-not-found");
      return null;
    }
    await access.revalidate();
    const live = running.get(id)?.operation;
    const value = live ?? await readJson(fileFor(access, id));
    if (!value) {
      if (required) throw new ResWorkflowError(404, "adoption-not-found");
      return null;
    }
    const operation = value;
    if (operation.schema !== "pi-res-workflow-operation.v1" || operation.ownerKey !== access.ownerKey || operation.cwd !== access.cwd || operation.adoption?.id !== id || operation.adoption.cwd !== access.cwd) throw new ResWorkflowError(404, "adoption-not-found");
    if (operation.detachedAt) return operation;
    if (operation.agent) {
      await refreshAgent(access, operation);
      if (!operation.confirmationIntent || operation.adoption.status !== "proposal-ready") return operation;
    }
    if (!live && operation.adoption.historyReview?.status === "running") {
      operation.adoption.historyReview.status = "interrupted";
      operation.adoption.historyReview.canConfirm = false;
      if (operation.adoption.status === "analyzing") operation.adoption.status = "blocked";
      operation.adoption.error = "analysis-full-interrupted-result-unknown-new-authorization-required";
      await save(access, operation);
    }
    if (!live && ["inventory", "analyzing"].includes(operation.adoption.status)) {
      operation.adoption.status = "blocked";
      operation.adoption.error = operation.analysisIntent ? "analysis-interrupted-result-unknown-explicit-new-request-required" : "adoption-preparation-interrupted-explicit-rescan-required";
      await save(access, operation);
    }
    if (!live && !confirming.has(id) && operation.confirmationIntent && operation.adoption.status === "proposal-ready" && (await readJson(path.join(directory(access), "current.json")))?.id === id) {
      let confirmed = false;
      try {
        const receipt = JSON.parse((await readBoundedRegular(path.join(access.cwd, ".pi", "research-loop", "adoptions", id, "confirmation.json"), 16384, access.cwd)).text);
        confirmed = receipt.confirmationHash === operation.confirmationIntent.hash && receipt.proposalHash === operation.adoption.proposalHash && receipt.charterHash === (await backend()).charterHash(access.cwd);
      } catch {
      }
      operation.adoption.status = confirmed ? "confirmed" : "blocked";
      if (confirmed) {
        await writeJson(access, path.join(directory(access), "adopted.json"), { confirmed: true, id, confirmationHash: operation.confirmationIntent.hash });
        await associateSelected(access, operation);
      } else operation.adoption.error = "confirmation-interrupted-review-current-charter-before-retry";
      await save(access, operation);
    }
    return operation;
  }
  async function current(access) {
    const pointer = await readJson(path.join(directory(access), "current.json"));
    const operation = typeof pointer?.id === "string" ? await operationFor(access, pointer.id, false) : null;
    return operation?.detachedAt ? null : operation;
  }
  async function requireCurrent(access, operation) {
    if (operation.detachedAt || (await readJson(path.join(directory(access), "current.json")))?.id !== operation.adoption.id) throw new ResWorkflowError(409, "adoption-detached-explicit-new-adoption-required");
  }
  async function researchFiles(access) {
    const output = Object.fromEntries(RESEARCH_FILES.map((name) => [name, null]));
    for (const name of RESEARCH_FILES) {
      try {
        const read = await readBoundedRegular(path.join(access.cwd, ".pi", "research-loop", name), name === "state.json" ? 256 * 1024 : 2 * 1024 * 1024, access.cwd);
        if (read.text.includes("\0")) throw new Error();
        if (name === "state.json") {
          const state = JSON.parse(read.text);
          if (!state || typeof state !== "object" || Array.isArray(state) || !state.charter || typeof state.charter !== "object" || typeof state.charter.objective !== "string" || !Array.isArray(state.charter.successCriteria)) throw new Error();
        }
        output[name] = read.text;
      } catch (err) {
        if (err.code !== "ENOENT") throw new ResWorkflowError(409, "research-file-unreadable-or-invalid", `Cannot read verified research snapshot: ${name}`);
      }
    }
    await access.revalidate();
    return output;
  }
  async function publish(access, id, name, value, signal) {
    const dir = await ensureProjectDirectory(access.cwd, [".pi", "research-loop", "adoptions", id]);
    const file = path.join(dir, name);
    const text = JSON.stringify(value, null, 2) + "\n";
    try {
      const existing = await readBoundedRegular(file, 1024 * 1024, access.cwd);
      if (existing.text !== text) throw new ResWorkflowError(409, "project-adoption-file-conflict");
      return;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await access.revalidate();
    if (signal.aborted) throw new Error("cancelled");
    (await backend()).writePrivate(file, text);
  }
  async function validateHistoryOwnership(access, snapshot) {
    for (const binding of snapshot.historyBindings ?? []) {
      if (access.canReadHistory && !await access.canReadHistory(binding)) throw new ResWorkflowError(403, "source-owner-changed");
    }
  }
  async function snapshotFor(access, operation) {
    const snapshot = await readJson(path.join(directory(access), `${operation.adoption.id}.snapshot.json`));
    if (!snapshot || !operation.snapshotHash || hash(snapshot) !== operation.snapshotHash || !Array.isArray(snapshot.sources) || !snapshot.content || hash(snapshot.sources) !== hash(operation.adoption.sources)) throw new ResWorkflowError(409, "material-snapshot-invalid");
    await validateHistoryOwnership(access, snapshot);
    for (const source of snapshot.sources) {
      const content = snapshot.content[source.id];
      if (typeof content !== "string" || hash(content) !== source.sha256) throw new ResWorkflowError(409, "material-snapshot-invalid");
    }
    return snapshot;
  }
  async function check(access, operation, signal) {
    if (disposed || signal.aborted) throw new Error("cancelled");
    await access.revalidate();
    if (signal.aborted || operation.adoption.status === "cancelled") throw new Error("cancelled");
  }
  async function analyze(access, operation, request, signal, authorizedFingerprint) {
    requireAgentConsent(request.consent);
    await check(access, operation, signal);
    const snapshot = await snapshotFor(access, operation);
    if (!snapshot.sources.length) throw new Error("no-authorized-materials");
    const resolved = await findModel(request.model.provider, request.model.id);
    if (authorizedFingerprint && resolved.fingerprint !== authorizedFingerprint) throw new Error("model-configuration-changed-new-consent-required");
    operation.authorization = { adoptionId: operation.adoption.id, at: (/* @__PURE__ */ new Date()).toISOString(), model: request.model, modelFingerprint: resolved.fingerprint, snapshotHash: operation.snapshotHash, consent: request.consent, ...operation.historySelection ? { historySelection: copy(operation.historySelection) } : {}, purpose: "research-adoption" };
    operation.adoption.model = copy(request.model);
    await check(access, operation, signal);
    operation.analysisIntent = { at: (/* @__PURE__ */ new Date()).toISOString(), requestId: request.requestId, snapshotHash: operation.snapshotHash, modelFingerprint: resolved.fingerprint };
    operation.adoption.status = "analyzing";
    delete operation.adoption.error;
    await save(access, operation);
    await check(access, operation, signal);
    const fresh = await findModel(request.model.provider, request.model.id);
    if (fresh.fingerprint !== resolved.fingerprint) throw new Error("model-configuration-changed-new-consent-required");
    await check(access, operation, signal);
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    operation.adoption.agentProgress = { phase: "preparing", requests: 0, toolCalls: 0, readSources: 0, readBytes: 0, startedAt, updatedAt: startedAt };
    const coverageNotice = { label: "\u63A5\u5165\u52A9\u624B\u53EA\u8BFB\u8986\u76D6", reason: "\u52A9\u624B\u4EC5\u6309\u9700\u8BFB\u53D6\u5DF2\u786E\u8BA4\u5FEB\u7167\uFF1B\u672A\u8BFB\u6216\u672A\u5B8C\u6574\u8986\u76D6\u7684\u6B63\u6587\u4ECD\u9700\u590D\u6838\uFF0C\u539F\u59CB\u5FEB\u7167\u4FDD\u6301\u3002" };
    operation.adoption.partial ||= snapshot.sources.length > 0;
    operation.adoption.skipped = [coverageNotice, ...operation.adoption.skipped];
    await save(access, operation);
    await check(access, operation, signal);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), deps.analysisTimeoutMs ?? RES_WORKFLOW_AGENT_TIMEOUT_MS);
    timer.unref?.();
    const combined = AbortSignal.any([signal, timeout.signal]);
    let onAbort;
    try {
      const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(new Error(signal.aborted ? "cancelled" : "analysis-timeout-result-unknown"));
        combined.addEventListener("abort", onAbort, { once: true });
      });
      if (!fresh.loadAgentFactory) throw new Error("model-agent-runtime-unavailable");
      const agentFactory = await Promise.race([fresh.loadAgentFactory(), aborted]);
      await check(access, operation, combined);
      let lastProgressSave = 0;
      let draftSaveFailed = false;
      const assertLive = async () => {
        await check(access, operation, combined);
        await requireCurrent(access, operation);
      };
      const result = await Promise.race([(deps.runAgent ?? runReadonlyAdoptionAgent)({
        resolved: { ...fresh, agentFactory },
        snapshot,
        signal: combined,
        assertScope: assertLive,
        assertHistoryOwnership: async () => {
          await assertLive();
          await validateHistoryOwnership(access, snapshot);
          await assertLive();
        },
        resolveCurrentModel: () => findModel(request.model.provider, request.model.id),
        onBeforeSend: async ({ request: requestNumber, requestBytes, fingerprint }) => {
          await assertLive();
          if (draftSaveFailed) throw new Error("analysis-agent-draft-save-unavailable");
          if (fingerprint !== fresh.fingerprint || !Number.isSafeInteger(requestNumber) || requestNumber < 1 || !Number.isSafeInteger(requestBytes) || requestBytes < 0) throw new Error("model-configuration-changed-new-consent-required");
          if (requestNumber !== (operation.analysisRequests?.length ?? 0) + 1) throw new Error("analysis-agent-request-sequence-invalid");
          const intent = { at: (/* @__PURE__ */ new Date()).toISOString(), requestId: request.requestId, snapshotHash: operation.snapshotHash, modelFingerprint: fresh.fingerprint, requestNumber, requestBytes };
          operation.analysisIntent = intent;
          operation.analysisRequests = [...operation.analysisRequests ?? [], intent];
          await save(access, operation);
          await assertLive();
        },
        onDraftCandidate: async (value, candidateSignal) => {
          try {
            const assertCandidateLive = async () => {
              await assertLive();
              if (candidateSignal?.aborted) throw new Error("cancelled");
            };
            await assertCandidateLive();
            await validateHistoryOwnership(access, snapshot);
            await assertCandidateLive();
            const candidate = copy(value), latest = operation.analysisRequests?.at(-1);
            if (!latest || candidate.request !== latest.requestNumber || candidate.fingerprint !== fresh.fingerprint || candidate.snapshotFingerprint !== operation.snapshotHash || !["valid", "invalid-source", "invalid-output"].includes(candidate.validation)) throw new Error("analysis-agent-draft-save-unavailable");
            if (typeof candidate.raw !== "string" || !candidate.raw || Buffer.byteLength(candidate.raw) > 128 * 1024 || candidate.normalizedRaw !== void 0 && (typeof candidate.normalizedRaw !== "string" || Buffer.byteLength(candidate.normalizedRaw) > 128 * 1024)) throw new Error("analysis-agent-draft-save-unavailable");
            const sourceIds = new Set(snapshot.sources.map((source) => source.id));
            if (!Array.isArray(candidate.readSourceIds) || candidate.readSourceIds.length > sourceIds.size || new Set(candidate.readSourceIds).size !== candidate.readSourceIds.length || candidate.readSourceIds.some((id) => !sourceIds.has(id))) throw new Error("analysis-agent-draft-save-unavailable");
            if (!Array.isArray(candidate.readReferences) || !Array.isArray(candidate.readRanges) || candidate.readReferences.length > sourceIds.size || candidate.readRanges.length > sourceIds.size || Buffer.byteLength(JSON.stringify(candidate)) > 512 * 1024) throw new Error("analysis-agent-draft-save-unavailable");
            if (candidate.validation === "valid") validateProposal(candidate.normalizedRaw ?? candidate.raw, snapshot.sources.filter((source) => candidate.readSourceIds.includes(source.id)));
            const previous = operation.analysisCandidates ?? [];
            if (previous.length >= 2 || previous.some((receipt) => receipt.requestNumber === candidate.request)) throw new Error("analysis-agent-draft-save-unavailable");
            const file = path.join(directory(access), `${operation.adoption.id}.candidate-${candidate.request}.json`);
            if (await readJson(file)) throw new Error("analysis-agent-draft-save-unavailable");
            await assertCandidateLive();
            await validateHistoryOwnership(access, snapshot);
            await assertCandidateLive();
            const at = (/* @__PURE__ */ new Date()).toISOString();
            await writeJson(access, file, { schema: "pi-res-workflow-agent-candidate.v1", ownerKey: access.ownerKey, cwd: access.cwd, adoptionId: operation.adoption.id, requestId: request.requestId, snapshotHash: operation.snapshotHash, modelFingerprint: fresh.fingerprint, at, candidate }, true);
            await assertCandidateLive();
            await validateHistoryOwnership(access, snapshot);
            await assertCandidateLive();
            operation.analysisCandidates = [...previous, { at, requestNumber: candidate.request, sha256: hash(candidate), validation: candidate.validation }];
            await save(access, operation);
            await assertCandidateLive();
          } catch {
            draftSaveFailed = true;
            throw new Error("analysis-agent-draft-save-unavailable");
          }
        },
        onProgress: async (progress) => {
          await assertLive();
          const previous = operation.adoption.agentProgress;
          operation.adoption.agentProgress = { phase: progress.phase, requests: progress.requests, toolCalls: progress.toolCalls, readSources: progress.readSources, readBytes: progress.readBytes, startedAt, updatedAt: progress.updatedAt };
          const changed = previous?.phase !== progress.phase || previous?.requests !== progress.requests || previous?.toolCalls !== progress.toolCalls || previous?.readSources !== progress.readSources;
          if (changed || Date.now() - lastProgressSave >= 5e3) {
            await save(access, operation);
            lastProgressSave = Date.now();
          }
          await assertLive();
        }
      }), aborted]);
      await assertLive();
      const read = new Set(result.readSourceIds);
      const proposal = validateProposal(result.raw, snapshot.sources.filter((source) => read.has(source.id)));
      operation.adoption.partial = snapshot.partial || result.coverage.partial;
      coverageNotice.reason = `\u672C\u6B21\u52A9\u624B\u8BFB\u53D6 ${result.coverage.readSources}/${result.coverage.totalSources} \u4E2A\u5FEB\u7167\u6765\u6E90\uFF0C\u5B8C\u6574\u8BFB\u53D6 ${result.coverage.completeSources} \u4E2A\uFF1B\u672A\u8BFB\u6216\u672A\u8986\u76D6\u7684\u6B63\u6587\u4ECD\u9700\u590D\u6838\uFF0C\u539F\u59CB\u5FEB\u7167\u4FDD\u6301\u3002`;
      operation.adoption.agentProgress = { ...result.progress, phase: "completed", startedAt, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      await publish(access, operation.adoption.id, "proposal.json", proposal, combined);
      await assertLive();
      operation.adoption.proposal = proposal;
      operation.adoption.proposalHash = (await backend()).sha256(proposal);
      operation.adoption.status = "proposal-ready";
      await save(access, operation);
    } finally {
      clearTimeout(timer);
      if (onAbort) combined.removeEventListener("abort", onAbort);
    }
  }
  const fullDirectory = (access, operation) => path.join(directory(access), `${operation.adoption.id}.history-review`);
  const fullCheckpointFile = (access, operation, planId, nodeId) => {
    if (!/^hplan-[a-f0-9]{24}$/.test(planId) || !/^[A-Za-z0-9_-]{1,80}$/.test(nodeId)) throw new ResWorkflowError(409, "analysis-full-plan-invalid");
    return path.join(fullDirectory(access, operation), `${planId}.${nodeId}.checkpoint.json`);
  };
  async function durableFullIntent(access, operation, planId, nodeId, record) {
    const file = fullCheckpointFile(access, operation, planId, nodeId).replace(/\.checkpoint\.json$/, ".intent.json");
    const parent = path.dirname(file);
    if (!["linux", "darwin"].includes(process.platform)) throw new Error("analysis-full-durable-intent-platform-unavailable");
    const parentHandle = await open(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await parentHandle.stat();
      const assertParent = async () => {
        const [named, current2] = await Promise.all([lstat(parent), parentHandle.stat()]);
        const owner = process.getuid?.();
        if (!opened.isDirectory() || !current2.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || current2.dev !== opened.dev || current2.ino !== opened.ino || await realpath(parent) !== parent || (current2.mode & 511) !== 448 || (named.mode & 511) !== 448 || current2.uid !== owner || named.uid !== owner || current2.nlink < 1 || named.nlink !== current2.nlink) throw new Error("analysis-full-private-intent-unsafe");
      };
      await assertParent();
      const anchored = process.platform === "linux" ? `/proc/self/fd/${parentHandle.fd}/${path.basename(file)}` : file;
      const handle = await open(anchored, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 384);
      try {
        const info = await handle.stat();
        const assertLeaf = async () => {
          const [current2, named] = await Promise.all([handle.stat(), lstat(file)]);
          const owner = process.getuid?.();
          if (!current2.isFile() || !named.isFile() || named.isSymbolicLink() || current2.dev !== info.dev || current2.ino !== info.ino || named.dev !== info.dev || named.ino !== info.ino || current2.nlink !== 1 || named.nlink !== 1 || (current2.mode & 511) !== 384 || (named.mode & 511) !== 384 || current2.uid !== owner || named.uid !== owner) throw new Error("analysis-full-private-intent-unsafe");
        };
        await assertParent();
        await assertLeaf();
        await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
        await assertParent();
        await assertLeaf();
        await parentHandle.sync();
        await assertParent();
        await assertLeaf();
      } finally {
        await handle.close();
      }
    } finally {
      await parentHandle.close();
    }
  }
  async function rejectUntrackedFullIntents(access, operation, recovering) {
    let names;
    try {
      names = await readdir(fullDirectory(access, operation));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new ResWorkflowError(409, "analysis-full-private-intent-unsafe");
    }
    if (names.length > 1024) throw new ResWorkflowError(409, "analysis-full-private-intent-budget");
    const intents = [];
    for (const name of names.filter((name2) => /^hplan-[a-f0-9]{24}\.[A-Za-z0-9_-]{1,80}\.intent\.json$/.test(name2)).sort()) {
      const value = await readJson(path.join(fullDirectory(access, operation), name));
      if (!value || value.schema !== "pi-full-history-review-intent.v1" || value.ownerKey !== access.ownerKey || value.cwd !== access.cwd || value.adoptionId !== operation.adoption.id || typeof value.planId !== "string" || typeof value.nodeId !== "string" || name !== `${value.planId}.${value.nodeId}.intent.json` || value.snapshotHash !== operation.snapshotHash) throw new ResWorkflowError(409, "analysis-full-private-intent-unsafe");
      const digest = hash(value);
      const archived = operation.historyReviewArchives?.some((archive) => archive.schema === "pi-full-history-attempt-archive.v1" && archive.previousPlanId === value.planId && archive.previousPlanId === archive.review.plan?.planId && archive.previousPlanHash === archive.review.plan?.planHash && (archive.review.materialPlanHash ?? archive.review.plan?.planHash) === value.planHash && archive.intents.some((intent) => intent.file === name && intent.sha256 === digest));
      if (archived) continue;
      if (recovering && value.planId === recovering.planId && value.planHash === recovering.planHash) {
        const issued = operation.analysisRequests?.find((row) => row.planId === value.planId && row.nodeId === value.nodeId && row.inputHash === value.inputHash && row.requestId === value.requestId && row.requestNumber === value.requestNumber && row.requestBytes === value.requestBytes && row.modelFingerprint === value.modelFingerprint && row.snapshotHash === value.snapshotHash);
        const authorizations = [...operation.historyReview?.authorizations ?? [], ...operation.historyReview?.authorization ? [operation.historyReview.authorization] : []];
        const authorization = authorizations.find((row) => row.requestId === value.requestId && row.planId === value.planId && row.modelFingerprint === value.modelFingerprint);
        if (!issued || !authorization || hash(authorization) !== hash(value.authorization)) throw new ResWorkflowError(409, "analysis-full-result-unknown-no-replay");
        intents.push({ file: name, sha256: digest });
        continue;
      }
      const ref = operation.historyReview?.checkpoints.find((ref2) => ref2.planId === value.planId && ref2.nodeId === value.nodeId);
      const checkpoint = ref ? await readJson(fullCheckpointFile(access, operation, value.planId, value.nodeId)) : null;
      if (ref && checkpoint && hash(checkpoint) === ref.sha256 && checkpoint.terminal === "stop" && checkpoint.validation === "valid" && checkpoint.inputHash === value.inputHash && checkpoint.planHash === value.planHash && checkpoint.modelFingerprint === value.modelFingerprint) continue;
      const candidateRef = operation.historyReview?.candidates?.find((ref2) => ref2.planId === value.planId && ref2.nodeId === value.nodeId);
      const candidate = candidateRef ? await readJson(fullCheckpointFile(access, operation, value.planId, value.nodeId).replace(/\.checkpoint\.json$/, ".candidate.json")) : null;
      if (candidateRef && candidate && hash(candidate) === candidateRef.sha256 && candidate.terminal === "stop" && candidate.validation !== "valid") throw new ResWorkflowError(409, "analysis-full-known-invalid-new-plan-required");
      throw new ResWorkflowError(409, "analysis-full-result-unknown-no-replay");
    }
    return intents;
  }
  async function fullPlan(access, operation, signal) {
    const metadata = operation.historyReview?.plan;
    if (!metadata || metadata.blockers.length) throw new ResWorkflowError(409, "analysis-full-prepared-plan-required");
    await check(access, operation, signal);
    await requireCurrent(access, operation);
    return (deps.readFullHistoryPlan ?? readFullHistoryPlan)({ privateDir: fullDirectory(access, operation), planId: metadata.planId, expectedPlanHash: operation.historyReview.materialPlanHash ?? metadata.planHash, signal, revalidate: async () => {
      await check(access, operation, signal);
      await requireCurrent(access, operation);
    } });
  }
  async function fullRunner(access, operation, request, signal, verifyOnly = false) {
    const plan = await fullPlan(access, operation, signal);
    const review = operation.historyReview, metadata = review.plan;
    const snapshot = await snapshotFor(access, operation);
    const resolved = await findModel(request.model.provider, request.model.id);
    if (resolved.fingerprint !== plan.model.fingerprint || resolved.provider !== plan.model.provider || resolved.id !== plan.model.id || resolved.contextWindow !== plan.model.contextWindow || resolved.maxTokens !== plan.model.maxTokens) throw new Error("model-configuration-changed-new-consent-required");
    if (!resolved.loadAgentFactory) throw new Error("model-agent-runtime-unavailable");
    const agentFactory = await resolved.loadAgentFactory();
    const assertLive = async () => {
      await check(access, operation, signal);
      await requireCurrent(access, operation);
      if (operation.historyReview !== review || review.plan?.planId !== metadata.planId || review.plan?.planHash !== metadata.planHash || !verifyOnly && running.get(operation.adoption.id)?.controller.signal !== signal) throw new Error("analysis-full-attempt-no-longer-active");
    };
    const receipts = /* @__PURE__ */ new Map();
    const baseRequests = operation.analysisRequests?.length ?? 0;
    const coverage = () => {
      const completed = plan.nodes.filter((node) => node.kind === "batch" && receipts.has(node.id));
      const historyComplete = metadata.histories.filter((history) => history.chunkCount === 0 && !!history.emptyReason || plan.nodes.filter((node) => node.kind === "batch" && node.historyId === history.id).length > 0 && plan.nodes.filter((node) => node.kind === "batch" && node.historyId === history.id).every((node) => receipts.has(node.id)));
      return { selectedHistories: metadata.histories.length, completedHistories: historyComplete.length, emptyHistories: metadata.histories.filter((history) => history.chunkCount === 0 && !!history.emptyReason).length, eligibleMessages: metadata.eligibleMessages, completedMessages: completed.filter((node) => node.historyId).reduce((sum, node) => sum + (node.eligibleMessages ?? 0), 0), eligibleBytes: metadata.eligibleBytes, completedBytes: completed.filter((node) => node.historyId).reduce((sum, node) => sum + (node.eligibleBytes ?? 0), 0), completedBatches: completed.length, totalBatches: metadata.batchCount };
    };
    const result = await (deps.runFullHistoryReview ?? runFullHistoryReview)({
      plan: { ...plan, maxRequests: plan.nodes.length },
      resolved: { ...resolved, agentFactory },
      signal,
      assertScope: assertLive,
      assertHistoryOwnership: async () => {
        await assertLive();
        await validateHistoryOwnership(access, snapshot);
        await assertLive();
      },
      resolveCurrentModel: () => findModel(request.model.provider, request.model.id),
      readBatch: async (nodeId) => {
        await assertLive();
        return (deps.readFullHistoryBatch ?? readFullHistoryBatch)({ privateDir: fullDirectory(access, operation), plan, nodeId, signal, revalidate: assertLive });
      },
      readCheckpoint: async (nodeId) => {
        await assertLive();
        const ref = review.checkpoints.find((row) => row.planId === plan.planId && row.nodeId === nodeId);
        const value = await readJson(fullCheckpointFile(access, operation, plan.planId, nodeId));
        if (value && (!ref || ref.sha256 !== hash(value)) || ref && !value) throw new Error("analysis-full-checkpoint-invalid");
        const durableIntent = await readJson(fullCheckpointFile(access, operation, plan.planId, nodeId).replace(/\.checkpoint\.json$/, ".intent.json"));
        if (!value && (verifyOnly || durableIntent || operation.analysisRequests?.some((row) => row.planId === plan.planId && row.nodeId === nodeId))) throw new Error("analysis-full-result-unknown-no-replay");
        if (value && (!durableIntent || durableIntent.schema !== "pi-full-history-review-intent.v1" || durableIntent.planId !== plan.planId || durableIntent.nodeId !== nodeId || durableIntent.planHash !== plan.planHash || durableIntent.inputHash !== value.inputHash || durableIntent.modelFingerprint !== plan.model.fingerprint || durableIntent.ownerKey !== access.ownerKey || durableIntent.cwd !== access.cwd || durableIntent.adoptionId !== operation.adoption.id || durableIntent.snapshotHash !== operation.snapshotHash)) throw new Error("analysis-full-checkpoint-invalid");
        if (value) receipts.set(nodeId, value);
        return value;
      },
      onBeforeSend: async (intent) => {
        await assertLive();
        if (verifyOnly || !review.authorization || review.authorization.planId !== plan.planId || review.authorization.planHash !== metadata.planHash || intent.fingerprint !== plan.model.fingerprint || intent.request < 1 || intent.request > metadata.maxRequests || operation.analysisRequests?.some((row) => row.planId === plan.planId && row.nodeId === intent.nodeId)) throw new Error("analysis-full-send-refused-new-authorization-required");
        if ((operation.analysisRequests?.length ?? 0) !== baseRequests + intent.request - 1) throw new Error("analysis-full-request-sequence-invalid");
        const record = { at: (/* @__PURE__ */ new Date()).toISOString(), requestId: request.requestId, snapshotHash: operation.snapshotHash, modelFingerprint: plan.model.fingerprint, requestNumber: (operation.analysisRequests?.length ?? 0) + 1, requestBytes: intent.requestBytes, analysisMode: "full-history-review-v1", planId: plan.planId, nodeId: intent.nodeId, inputHash: intent.inputHash };
        operation.analysisRequests = [...operation.analysisRequests ?? [], record];
        await save(access, operation);
        await assertLive();
        await durableFullIntent(access, operation, plan.planId, intent.nodeId, { schema: "pi-full-history-review-intent.v1", ownerKey: access.ownerKey, cwd: access.cwd, adoptionId: operation.adoption.id, planHash: plan.planHash, authorization: copy(review.authorization), authorizedPlan: copy(metadata), historySelection: copy(operation.historySelection ?? []), ...record });
        await assertLive();
      },
      onCheckpoint: async (value) => {
        await assertLive();
        const intent = operation.analysisRequests?.find((row) => row.planId === plan.planId && row.nodeId === value.nodeId);
        const candidateRef = review.candidates?.find((row) => row.planId === plan.planId && row.nodeId === value.nodeId);
        if (verifyOnly || !intent || !candidateRef || candidateRef.validation !== "valid" || intent.inputHash !== value.inputHash || value.planId !== plan.planId || value.planHash !== plan.planHash || value.modelFingerprint !== plan.model.fingerprint || value.terminal !== "stop" || value.validation !== "valid" || value.rawHash !== hash(value.raw) || review.checkpoints.some((row) => row.planId === plan.planId && row.nodeId === value.nodeId)) throw new Error("analysis-full-checkpoint-invalid");
        await writeJson(access, fullCheckpointFile(access, operation, plan.planId, value.nodeId), value, true);
        await assertLive();
        review.checkpoints = [...review.checkpoints, { planId: plan.planId, nodeId: value.nodeId, sha256: hash(value) }];
        receipts.set(value.nodeId, value);
        operation.adoption.historyReview.coverage = coverage();
        await save(access, operation);
        await assertLive();
      },
      onTerminalCandidate: async (value) => {
        await assertLive();
        await validateHistoryOwnership(access, snapshot);
        await assertLive();
        const intent = operation.analysisRequests?.find((row) => row.planId === plan.planId && row.nodeId === value.nodeId);
        const node = plan.nodes.find((node2) => node2.id === value.nodeId);
        if (verifyOnly || !intent || !node || value.schema !== "pi-full-history-review-candidate.v1" || intent.inputHash !== value.inputHash || value.planId !== plan.planId || value.planHash !== plan.planHash || value.modelFingerprint !== plan.model.fingerprint || value.terminal !== "stop" || !["valid", "invalid-output", "invalid-source"].includes(value.validation) || typeof value.raw !== "string" || Buffer.byteLength(value.raw) > 128 * 1024 || value.rawHash !== hash(value.raw) || !Array.isArray(value.deliveredReferences) || value.deliveredReferences.some((row) => row.citationRef !== row.sourceId || !node.sourceIds.includes(row.sourceId)) || review.candidates?.some((row) => row.planId === plan.planId && row.nodeId === value.nodeId)) throw new Error("analysis-full-terminal-candidate-invalid");
        await writeJson(access, fullCheckpointFile(access, operation, plan.planId, value.nodeId).replace(/\.checkpoint\.json$/, ".candidate.json"), value, true);
        await assertLive();
        await validateHistoryOwnership(access, snapshot);
        await assertLive();
        review.candidates = [...review.candidates ?? [], { planId: plan.planId, nodeId: value.nodeId, sha256: hash(value), validation: value.validation }];
        await save(access, operation);
        await assertLive();
      }
    });
    await assertLive();
    if (result.checkpoints.length !== plan.nodes.length || coverage().completedHistories !== metadata.histories.length || coverage().completedBatches !== metadata.batchCount || coverage().completedMessages !== metadata.eligibleMessages || coverage().completedBytes !== metadata.eligibleBytes) throw new Error("analysis-full-coverage-incomplete");
    return { ...result, coverage: coverage() };
  }
  async function analyzeFull(access, operation, request, signal) {
    const result = await fullRunner(access, operation, request, signal);
    await check(access, operation, signal);
    await requireCurrent(access, operation);
    const proposal = validateProposal(JSON.stringify(result.proposal), result.sources);
    await publish(access, operation.adoption.id, `history-review-${operation.historyReview.plan.planId}.proposal.json`, proposal, signal);
    await check(access, operation, signal);
    await requireCurrent(access, operation);
    operation.historyReview.finalSources = result.sources;
    operation.adoption.proposal = proposal;
    operation.adoption.proposalHash = (await backend()).sha256(proposal);
    operation.historyReview.completedProposalHash = operation.adoption.proposalHash;
    operation.adoption.historyReview = { status: "complete", plan: copy(operation.historyReview.plan), coverage: result.coverage, canConfirm: true, ...operation.adoption.historyReview?.previousAttempt ? { previousAttempt: copy(operation.adoption.historyReview.previousAttempt) } : {} };
    operation.adoption.status = "proposal-ready";
    delete operation.adoption.error;
    await save(access, operation);
  }
  function previousAttempt(operation, archive) {
    const requestNodes = (operation.analysisRequests ?? []).filter((row) => row.planId === archive.previousPlanId).map((row) => row.nodeId);
    const complete = new Set(archive.review.checkpoints.filter((row) => row.planId === archive.previousPlanId).map((row) => row.nodeId));
    const invalid = new Set((archive.review.candidates ?? []).filter((row) => row.planId === archive.previousPlanId && row.validation !== "valid").map((row) => row.nodeId));
    const outcome = requestNodes.some((node) => !complete.has(node ?? "") && !invalid.has(node ?? "")) ? "unknown" : invalid.size ? "known-invalid" : "incomplete";
    const publicCodes = /* @__PURE__ */ new Set(["analysis-full-output-too-large", "analysis-full-thinking-too-large", "analysis-full-output-event-too-large", "analysis-full-output-metadata-too-large", "analysis-full-output-incomplete", "analysis-full-result-unknown", "analysis-full-request-timeout-result-unknown", "analysis-full-timeout-result-unknown", "analysis-full-known-invalid-output-new-plan-required", "analysis-full-known-invalid-source-new-plan-required", "analysis-full-interrupted-result-unknown-new-authorization-required"]);
    return { planId: archive.previousPlanId, planHash: archive.previousPlanHash, requestIntents: requestNodes.length, completedRequests: complete.size, outcome, ...archive.error && publicCodes.has(archive.error) ? { errorCode: archive.error } : {} };
  }
  async function prepareNewHistoryReviewAttempt(access, operation, request, requestHash) {
    const recovery = request.recovery, review = operation.historyReview, oldPlan = review?.plan;
    if (!review || !oldPlan || oldPlan.planId !== recovery.previousPlanId || oldPlan.planHash !== recovery.previousPlanHash || operation.adoption.historyReview?.plan?.planId !== oldPlan.planId || operation.adoption.historyReview?.plan?.planHash !== oldPlan.planHash) throw new ResWorkflowError(409, "analysis-full-recovery-plan-mismatch");
    const selectedHistories = operation.adoption.selectedHistories ?? [], selected = operation.historySelection ?? [];
    if (!selected.length || selectedHistories.length !== selected.length || selectedHistories.some((row) => !selected.includes(row.id))) throw new ResWorkflowError(409, "analysis-full-selected-history-bindings-required");
    const controller = new AbortController(), signal = controller.signal, priorReviewHash = hash(review);
    const priorAdoption = copy(operation.adoption), priorArchives = operation.historyReviewArchives;
    const priorAdoptionReview = copy(operation.adoption.historyReview);
    const recoveryScope = { planId: oldPlan.planId, planHash: review.materialPlanHash ?? oldPlan.planHash };
    running.set(operation.adoption.id, { controller, operation });
    let committed = false;
    try {
      const assertLive = async () => {
        await check(access, operation, signal);
        await requireCurrent(access, operation);
        if (operation.historyReview !== review || hash(review) !== priorReviewHash) throw new ResWorkflowError(409, "analysis-full-recovery-plan-mismatch");
      };
      await assertLive();
      const intents = await rejectUntrackedFullIntents(access, operation, recoveryScope);
      const snapshot = await snapshotFor(access, operation), bindings = snapshot.historyBindings ?? [];
      if (bindings.length !== selectedHistories.length || selectedHistories.some((row) => bindings.filter((binding) => binding.id === row.sessionId && (!!binding.originDeviceId ? "retained" : "local") === row.kind && binding.cwd === access.cwd).length !== 1)) throw new ResWorkflowError(409, "analysis-full-selected-history-bindings-required");
      const resolved = await findModel(request.model.provider, request.model.id), directorySources = snapshot.sources.filter((source) => source.kind === "file" || source.kind === "artifact");
      const prepared = await (deps.prepareFullHistoryMaterial ?? prepareFullHistoryMaterial)({ cwd: access.cwd, selectedHistories: selectedHistories.map((row) => ({ ...row })), historyBindings: bindings.map((binding) => ({ ...binding })), snapshotSources: directorySources, snapshotContent: Object.fromEntries(directorySources.map((source) => [source.id, snapshot.content[source.id]])), snapshotFingerprint: operation.snapshotHash, model: { provider: resolved.provider, id: resolved.id, fingerprint: resolved.fingerprint, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens }, privateDir: fullDirectory(access, operation), signal, revalidate: assertLive, canReadHistory: async (binding) => {
        await assertLive();
        return access.canReadHistory ? access.canReadHistory(binding) : true;
      }, readRetained: deps.readRetained });
      await assertLive();
      const metadata = prepared.publicPlan;
      if (metadata.planId === oldPlan.planId || metadata.planHash === oldPlan.planHash || operation.historyReviewArchives?.some((archive2) => archive2.previousPlanId === metadata.planId) || metadata.maxRequests !== prepared.privatePlan.nodes.length || metadata.histories.length !== selected.length || metadata.histories.some((row) => !selected.includes(row.id)) || metadata.model.provider !== request.model.provider || metadata.model.id !== request.model.id) throw new ResWorkflowError(409, "analysis-full-new-plan-preparation-failed");
      if (hash(await rejectUntrackedFullIntents(access, operation, recoveryScope)) !== hash(intents)) throw new ResWorkflowError(409, "analysis-full-recovery-plan-mismatch");
      await assertLive();
      const archive = { schema: "pi-full-history-attempt-archive.v1", at: (/* @__PURE__ */ new Date()).toISOString(), requestId: request.requestId, requestHash, previousPlanId: oldPlan.planId, previousPlanHash: oldPlan.planHash, review: copy(review), adoptionReview: priorAdoptionReview, adoptionStatus: priorAdoption.status, ...priorAdoption.error ? { error: priorAdoption.error } : {}, intents };
      operation.historyReviewArchives = [...priorArchives ?? [], archive];
      operation.historyReview = { prepareRequests: [{ id: request.requestId, hash: requestHash, planId: metadata.planId }], plan: copy(metadata), materialPlanHash: metadata.planHash, checkpoints: [], candidates: [] };
      const disclosure = previousAttempt(operation, archive);
      operation.adoption.historyReview = { status: metadata.blockers.length ? "blocked" : "prepared", plan: copy(metadata), coverage: { selectedHistories: selected.length, completedHistories: metadata.histories.filter((row) => row.chunkCount === 0 && !!row.emptyReason).length, emptyHistories: metadata.histories.filter((row) => row.chunkCount === 0 && !!row.emptyReason).length, eligibleMessages: metadata.eligibleMessages, completedMessages: 0, eligibleBytes: metadata.eligibleBytes, completedBytes: 0, completedBatches: 0, totalBatches: metadata.batchCount }, canConfirm: false, previousAttempt: disclosure.requestIntents ? disclosure : priorAdoptionReview.previousAttempt ?? disclosure };
      operation.adoption.status = operation.adoption.proposal ? "proposal-ready" : "awaiting-model";
      if (metadata.blockers.length) operation.adoption.error = "analysis-full-preparation-blocked";
      else delete operation.adoption.error;
      await check(access, operation, signal);
      await requireCurrent(access, operation);
      await save(access, operation);
      committed = true;
      if (running.get(operation.adoption.id)?.controller === controller) running.delete(operation.adoption.id);
      return publicAdoption(operation);
    } catch (error) {
      if (!committed) {
        operation.historyReview = review;
        operation.historyReviewArchives = priorArchives;
        operation.adoption = priorAdoption;
      }
      if (error instanceof ResWorkflowError) throw error;
      if (error instanceof Error && error.message === "history-full-time-budget") console.warn("[res-workflow] history-full-time-budget");
      throw new ResWorkflowError(409, "analysis-full-new-plan-preparation-failed");
    } finally {
      controller.abort();
      if (running.get(operation.adoption.id)?.controller === controller) running.delete(operation.adoption.id);
    }
  }
  async function prepareCompletedPrefix(access, operation, request, requestHash) {
    const review = operation.historyReview, controller = new AbortController(), signal = controller.signal;
    running.set(operation.adoption.id, { controller, operation });
    try {
      const plan = await fullPlan(access, operation, signal), resolved = await findModel(request.model.provider, request.model.id);
      if (request.model.provider !== plan.model.provider || request.model.id !== plan.model.id || resolved.fingerprint !== plan.model.fingerprint || resolved.contextWindow !== plan.model.contextWindow || resolved.maxTokens !== plan.model.maxTokens) throw new ResWorkflowError(409, "model-configuration-changed-new-consent-required");
      const assertLive = async () => {
        await check(access, operation, signal);
        await requireCurrent(access, operation);
        await validateHistoryOwnership(access, await snapshotFor(access, operation));
      };
      const refs = review.checkpoints.filter((row) => row.planId === plan.planId);
      if (refs.length > plan.nodes.length || refs.some((row, index) => row.nodeId !== plan.nodes[index].id) || new Set(refs.map((row) => row.nodeId)).size !== refs.length) throw new ResWorkflowError(409, "analysis-full-checkpoint-invalid");
      const completed = /* @__PURE__ */ new Map(), allSources = /* @__PURE__ */ new Map();
      for (const node of plan.nodes.slice(0, refs.length)) {
        await assertLive();
        const ref = refs.find((row) => row.nodeId === node.id), value = await readJson(fullCheckpointFile(access, operation, plan.planId, node.id));
        const intent = operation.analysisRequests?.find((row) => row.planId === plan.planId && row.nodeId === node.id);
        if (!value || !intent || hash(value) !== ref.sha256 || value.schema !== "pi-full-history-review-checkpoint.v1" || value.nodeId !== node.id || value.planId !== plan.planId || value.planHash !== plan.planHash || value.modelFingerprint !== plan.model.fingerprint || value.inputHash !== intent.inputHash || value.rawHash !== hash(value.raw) || Buffer.from(value.raw).toString("utf8") !== value.raw || value.terminal !== "stop" || value.validation !== "valid") throw new ResWorkflowError(409, "analysis-full-checkpoint-invalid");
        let input, allowed;
        if (node.kind === "batch") {
          const batch = await (deps.readFullHistoryBatch ?? readFullHistoryBatch)({ privateDir: fullDirectory(access, operation), plan, nodeId: node.id, signal, revalidate: assertLive });
          if (hash(batch.prompt) !== node.materialHash) throw new ResWorkflowError(409, "analysis-full-material-changed");
          input = { ...JSON.parse(batch.prompt), kind: "batch" };
          allowed = new Set(node.sourceIds);
          if (batch.sources.length !== allowed.size || new Set(batch.sources.map((source) => source.id)).size !== allowed.size) throw new ResWorkflowError(409, "analysis-full-material-invalid");
          for (const source of batch.sources) {
            if (!allowed.has(source.id) || source.kind === "session-message" && source.incomplete) throw new ResWorkflowError(409, "analysis-full-material-invalid");
            allSources.set(source.id, source);
          }
        } else {
          const children = node.inputNodeIds.map((id) => {
            const receipt = completed.get(id);
            return { summary: JSON.parse(receipt.raw).summary, sourceIds: receipt.sourceIds };
          });
          input = { kind: node.kind, summaries: children };
          allowed = new Set(children.flatMap((child) => child.sourceIds));
        }
        if (hash(JSON.stringify(input)) !== value.inputHash || Buffer.byteLength(value.raw) > (node.kind === "final" ? 128 * 1024 : 8192)) throw new ResWorkflowError(409, "analysis-full-checkpoint-invalid");
        let sourceIds;
        if (node.kind === "final") sourceIds = [...new Set(validateProposal(value.raw, [...allowed].map((id) => allSources.get(id))).items.flatMap((item) => item.sourceIds))];
        else {
          const body = JSON.parse(value.raw);
          if (!body || Object.keys(body).some((key) => !["summary", "sourceIds"].includes(key)) || typeof body.summary !== "string" || !body.summary.trim() || !Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.some((id) => typeof id !== "string" || !allowed.has(id))) throw new ResWorkflowError(409, "analysis-full-checkpoint-invalid");
          sourceIds = [...new Set(body.sourceIds)];
        }
        if (hash(sourceIds) !== hash(value.sourceIds)) throw new ResWorkflowError(409, "analysis-full-checkpoint-invalid");
        completed.set(node.id, value);
      }
      for (const node of plan.nodes.filter((node2) => !completed.has(node2.id))) {
        const durableIntent = await readJson(fullCheckpointFile(access, operation, plan.planId, node.id).replace(/\.checkpoint\.json$/, ".intent.json"));
        if (durableIntent || operation.analysisRequests?.some((row) => row.planId === plan.planId && row.nodeId === node.id)) {
          const ref = review.candidates?.find((row) => row.planId === plan.planId && row.nodeId === node.id);
          const candidate = ref ? await readJson(fullCheckpointFile(access, operation, plan.planId, node.id).replace(/\.checkpoint\.json$/, ".candidate.json")) : null;
          if (ref && candidate && hash(candidate) === ref.sha256 && candidate.terminal === "stop" && candidate.validation !== "valid") throw new ResWorkflowError(409, "analysis-full-known-invalid-new-plan-required");
          throw new ResWorkflowError(409, "analysis-full-result-unknown-no-replay");
        }
      }
      const remaining = plan.nodes.length - completed.size;
      if (!remaining) {
        const final = completed.get(plan.nodes.at(-1).id);
        const proposal = validateProposal(final.raw, [...allSources.values()]);
        await assertLive();
        await publish(access, operation.adoption.id, `history-review-${plan.planId}.proposal.json`, proposal, signal);
        await assertLive();
        review.finalSources = [...new Set(proposal.items.flatMap((item) => item.sourceIds))].map((id) => allSources.get(id));
        operation.adoption.proposal = proposal;
        operation.adoption.proposalHash = (await backend()).sha256(proposal);
        review.completedProposalHash = operation.adoption.proposalHash;
        operation.adoption.status = "proposal-ready";
        operation.adoption.historyReview.status = "complete";
        operation.adoption.historyReview.canConfirm = true;
        delete operation.adoption.error;
      } else {
        const metadata = { ...review.plan, planHash: hash(["pi-full-history-resume.v1", plan.planHash, request.requestId, refs]), maxRequests: remaining, totalRequests: plan.nodes.length, reusedRequests: completed.size };
        review.materialPlanHash = plan.planHash;
        review.plan = metadata;
        if (review.authorization) review.authorizations = [...review.authorizations ?? [], review.authorization];
        delete review.authorization;
        operation.adoption.historyReview = { ...operation.adoption.historyReview, status: "prepared", plan: copy(metadata), canConfirm: false };
        delete operation.adoption.error;
      }
      review.prepareRequests = [...review.prepareRequests, { id: request.requestId, hash: requestHash, planId: plan.planId }];
      await assertLive();
      await save(access, operation);
      if (running.get(operation.adoption.id)?.controller === controller) running.delete(operation.adoption.id);
      return publicAdoption(operation);
    } finally {
      if (running.get(operation.adoption.id)?.controller === controller) running.delete(operation.adoption.id);
    }
  }
  const agentDirectory = (access, operation) => path.join(directory(access), `${operation.adoption.id}.agent-v2`);
  const agentStores = /* @__PURE__ */ new Map();
  const agentStore = (access, operation) => {
    const root = agentDirectory(access, operation);
    let store = agentStores.get(root);
    if (!store) {
      store = createFullHistoryAgentStore({ root, jobId: operation.adoption.id, ownerKey: access.ownerKey, cwd: access.cwd });
      agentStores.set(root, store);
    }
    return store;
  };
  const emptyCoverage = (selected) => ({ selectedHistories: selected, completedHistories: 0, eligibleMessages: 0, completedMessages: 0, eligibleBytes: 0, completedBytes: 0, completedBatches: 0, totalBatches: 0 });
  async function refreshAgent(access, operation) {
    const view = operation.adoption.agentJob;
    if (!view) return;
    let state;
    try {
      state = await agentStore(access, operation).state();
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (state.authorization) {
      if (!view.grant || hash(view.grant) !== hash(state.authorization.grant) || operation.agent.modelFingerprint !== state.authorization.modelFingerprint) throw new ResWorkflowError(409, "analysis-full-agent-grant-invalid");
      view.authorized = true;
      view.authorizedAt = state.authorization.authorizedAt;
      view.expiresAt = state.authorization.expiresAt;
    }
    view.workerActive = state.workerAlive || running.has(operation.adoption.id);
    const rows = state.attempts, g = view.grant;
    const effectiveMaxRequests = null;
    view.budget = { baseRequests: g?.baseRequests ?? 0, retryReserve: g?.retryReserve ?? 0, maxRequests: g?.maxRequests ?? 0, effectiveMaxRequests, revision: state.budgetAuthorization?.revision ?? 0, policy: "unlimited", usedRequests: rows.length, baseUsed: rows.filter((r) => r.intent.bucket === "base").length, recoveryUsed: rows.filter((r) => r.intent.bucket === "reserve").length, remainingRequests: 0, inFlightRequests: view.workerActive ? rows.filter((r) => !r.receipt).length : 0, unknownRequests: rows.filter((r) => r.receipt?.outcome === "unknown" || !r.receipt && !view.workerActive).length, unlimited: true, ...state.budgetAuthorization ? { authorization: { scope: "this-job", authorizationHash: state.budgetAuthorization.authorizationHash, authorizedAt: state.budgetAuthorization.authorizedAt, expiresAt: state.budgetAuthorization.expiresAt } } : {} };
    if (state.cancelled) {
      view.phase = "cancelled";
      operation.adoption.status = "cancelled";
      view.resumeRequired = false;
    } else if (view.authorized && view.expiresAt && Date.now() >= Date.parse(view.expiresAt) && view.phase !== "proposal-ready") {
      view.phase = "awaiting-user";
      view.needsUserAction = { reason: "authorization-expired" };
    }
    const blocked = state.cancelled || view.phase === "cancelled" ? "cancelled" : view.phase === "proposal-ready" || operation.adoption.status === "confirmed" ? "completed" : !state.authorization ? "authorization-required" : Date.now() >= Date.parse(state.authorization.expiresAt) ? "authorization-expired" : void 0;
    view.budget.editable = !blocked;
    if (blocked) view.budget.editBlockedReason = blocked;
  }
  async function agentBoundary(access, operation, signal, lease, authorized = true, allowExpired = false) {
    await check(access, operation, signal);
    await requireCurrent(access, operation);
    await lease.assertCurrent();
    if (authorized) {
      const authorization = await agentStore(access, operation).authorization(), grant = operation.adoption.agentJob?.grant;
      if (!authorization || !grant || authorization.grant.grantHash !== grant.grantHash || authorization.modelFingerprint !== operation.agent?.modelFingerprint) throw new Error("analysis-full-agent-grant-invalid");
      if (!allowExpired && (!authorization.expiresAt || Date.now() >= Date.parse(authorization.expiresAt))) throw new Error("analysis-full-agent-authorization-expired");
    }
    await check(access, operation, signal);
    await lease.assertCurrent();
  }
  async function prepareAgent(access, operation, signal, heldLease) {
    await ensureProjectDirectory(deps.privateDir, [hash(access.ownerKey), hash(access.cwd), `${operation.adoption.id}.agent-v2`]);
    const store = agentStore(access, operation), lease = heldLease ?? await store.acquire();
    try {
      const assertLive = () => agentBoundary(access, operation, signal, lease, false);
      await assertLive();
      const snapshot = await snapshotFor(access, operation), model = operation.adoption.model;
      const resolved = await findModel(model.provider, model.id);
      await assertLive();
      const selected = operation.adoption.selectedHistories ?? [], bindings = snapshot.historyBindings ?? [];
      if (!selected.length || selected.length !== operation.historySelection?.length || selected.some((h) => bindings.filter((b) => b.id === h.sessionId && b.cwd === access.cwd && (!!b.originDeviceId ? "retained" : "local") === h.kind).length !== 1)) throw new Error("analysis-full-selected-history-bindings-required");
      const sources = snapshot.sources.filter((s) => s.kind === "file" || s.kind === "artifact");
      let lastProgress = 0;
      const result = await (deps.prepareFullHistoryMaterial ?? prepareFullHistoryMaterial)({ cwd: access.cwd, selectedHistories: selected, historyBindings: bindings, model: { provider: resolved.provider, id: resolved.id, fingerprint: resolved.fingerprint, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens }, outputTokenLimit: Math.min(resolved.maxTokens, 16384), privateDir: fullDirectory(access, operation), snapshotSources: sources, snapshotContent: Object.fromEntries(sources.map((s) => [s.id, snapshot.content[s.id]])), snapshotFingerprint: operation.snapshotHash, signal, revalidate: assertLive, canReadHistory: async (binding) => {
        await assertLive();
        return access.canReadHistory ? access.canReadHistory(binding) : true;
      }, readRetained: deps.readRetained, onProgress: async (progress) => {
        await assertLive();
        operation.adoption.agentJob.preparation = copy(progress);
        if (Date.now() - lastProgress >= 1e3) {
          lastProgress = Date.now();
          await save(access, operation);
          await assertLive();
        }
      } });
      await assertLive();
      const metadata = result.publicPlan, base = result.privatePlan.nodes.length;
      if (metadata.maxRequests !== base || metadata.maxTokens !== Math.min(resolved.maxTokens, 16384) || result.privatePlan.outputTokenLimit !== metadata.maxTokens || result.privatePlan.model.fingerprint !== resolved.fingerprint || metadata.histories.length !== selected.length || metadata.histories.some((h) => !operation.historySelection.includes(h.id))) throw new Error("analysis-full-plan-invalid");
      const view = operation.adoption.agentJob;
      view.plan = copy(metadata);
      view.coverage = { ...emptyCoverage(selected.length), completedHistories: metadata.histories.filter((h) => !!h.emptyReason && h.chunkCount === 0).length, emptyHistories: metadata.histories.filter((h) => !!h.emptyReason && h.chunkCount === 0).length, eligibleMessages: metadata.eligibleMessages, eligibleBytes: metadata.eligibleBytes, totalBatches: metadata.batchCount };
      operation.historyReview = { prepareRequests: [], plan: copy(metadata), materialPlanHash: metadata.planHash, checkpoints: [] };
      operation.adoption.historyReview = { status: metadata.blockers.length ? "blocked" : "prepared", plan: copy(metadata), coverage: copy(view.coverage), canConfirm: false };
      operation.agent.nodes = result.privatePlan.nodes.map(({ id, kind, historyId, eligibleMessages, eligibleBytes }) => ({ id, kind, historyId, eligibleMessages, eligibleBytes }));
      operation.agent.modelFingerprint = resolved.fingerprint;
      if (!base || metadata.blockers.length) {
        view.phase = "awaiting-user";
        view.needsUserAction = { reason: "material-invalid" };
        operation.adoption.status = "blocked";
      } else {
        const policy = { id: "bounded-intake-v2", maxNodeAttempts: 3, maxJsonRepairsPerNode: 1, maxUnknownRetriesPerNode: 1, maxLengthEscalationsPerNode: 1, unknownRetryMayBillAgain: true, grantLifetimeMs: 864e5, initialOutputTokens: Math.min(resolved.maxTokens, 8192), maxOutputTokens: Math.min(resolved.maxTokens, 16384) };
        const reserve = 0, core = { analysisMode: "full-history-agent-v2", materialPlanId: metadata.planId, materialPlanHash: metadata.planHash, model: copy(model), historySelection: copy(operation.historySelection), baseRequests: base, retryReserve: reserve, maxRequests: base + reserve, policy };
        view.grant = { ...core, grantHash: hash({ ...core, owner: hash(access.ownerKey), cwd: hash(access.cwd), fingerprint: resolved.fingerprint, prompt: FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH }) };
        view.budget = { baseRequests: base, retryReserve: reserve, maxRequests: base + reserve, effectiveMaxRequests: null, policy: "unlimited", unlimited: true, usedRequests: 0, baseUsed: 0, recoveryUsed: 0, remainingRequests: 0, inFlightRequests: 0, unknownRequests: 0 };
        view.phase = "awaiting-authorization";
        view.needsUserAction = { reason: "authorization-required" };
        operation.adoption.status = "awaiting-model";
      }
      delete operation.adoption.error;
      await assertLive();
      await save(access, operation);
      await assertLive();
    } finally {
      if (!heldLease) await lease.release();
    }
  }
  function agentCoverage(operation, completed) {
    const metadata = operation.adoption.agentJob.plan, nodes = operation.agent.nodes ?? [], batches = nodes.filter((n) => n.kind === "batch"), done = batches.filter((n) => completed.has(n.id));
    return { selectedHistories: metadata.histories.length, completedHistories: metadata.histories.filter((h) => h.chunkCount === 0 && !!h.emptyReason || batches.some((n) => n.historyId === h.id) && batches.filter((n) => n.historyId === h.id).every((n) => completed.has(n.id))).length, emptyHistories: metadata.histories.filter((h) => h.chunkCount === 0 && !!h.emptyReason).length, eligibleMessages: metadata.eligibleMessages, completedMessages: done.filter((n) => n.historyId).reduce((s, n) => s + (n.eligibleMessages ?? 0), 0), eligibleBytes: metadata.eligibleBytes, completedBytes: done.filter((n) => n.historyId).reduce((s, n) => s + (n.eligibleBytes ?? 0), 0), completedBatches: done.length, totalBatches: metadata.batchCount };
  }
  async function recordAgentUnknowns(access, operation, lease) {
    const store = agentStore(access, operation);
    for (const row of (await store.state()).attempts.filter((row2) => !row2.receipt && row2.intent.workerEpoch === lease.epoch)) {
      await store.receipt({ schema: "pi-full-agent-attempt-receipt.v2", attemptId: row.intent.attemptId, nodeId: row.intent.nodeId, slot: row.intent.slot, requestHash: row.intent.requestHash, outcome: "unknown", sdkStopReason: "none", providerTerminalObserved: false, errorCode: "analysis-full-result-unknown" });
    }
  }
  async function runAgent(access, operation, signal, lease, verifyOnly = false) {
    const store = agentStore(access, operation), view = operation.adoption.agentJob, grant = view.grant;
    const assertLive = () => agentBoundary(access, operation, signal, lease, true, verifyOnly);
    await assertLive();
    const plan = await fullPlan(access, operation, signal), snapshot = await snapshotFor(access, operation), durableState = await store.state({ strict: true });
    const resolved = await findModel(grant.model.provider, grant.model.id);
    await assertLive();
    if ((await store.state()).authorization?.promptSchemaHash !== FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH) throw new Error("analysis-full-agent-prompt-changed");
    if (resolved.fingerprint !== operation.agent.modelFingerprint || plan.model.fingerprint !== resolved.fingerprint || plan.planHash !== grant.materialPlanHash || plan.planId !== grant.materialPlanId || plan.nodes.length !== grant.baseRequests || !resolved.loadAgentFactory) throw new Error("model-configuration-changed-new-consent-required");
    const agentFactory = await resolved.loadAgentFactory();
    await assertLive();
    const completed = /* @__PURE__ */ new Set();
    const result = await (deps.runFullHistoryAgent ?? runFullHistoryAgent)({ jobId: operation.adoption.id, workerEpoch: lease.epoch, grant, plan, resolved: { ...resolved, agentFactory }, signal, verifyOnly, getBudgetAuthorization: async () => {
      await assertLive();
      const value = await store.getBudgetAuthorization();
      await assertLive();
      return value;
    }, assertScope: assertLive, assertHistoryOwnership: async () => {
      await assertLive();
      await validateHistoryOwnership(access, snapshot);
      await assertLive();
    }, resolveCurrentModel: () => findModel(grant.model.provider, grant.model.id), readBatch: async (nodeId) => {
      await assertLive();
      const value = await (deps.readFullHistoryBatch ?? readFullHistoryBatch)({ privateDir: fullDirectory(access, operation), plan, nodeId, signal, revalidate: assertLive });
      await assertLive();
      return value;
    }, readAttempts: async (nodeId) => {
      await assertLive();
      const rows = durableState.attempts.filter((row) => row.intent.nodeId === nodeId);
      for (const row of rows) await store.verifyAttempt(row);
      await assertLive();
      return copy(rows);
    }, readCheckpoint: async (nodeId) => {
      await assertLive();
      const value = await store.readCheckpoint(nodeId, durableState.attempts);
      await assertLive();
      if (verifyOnly && !value) throw new Error("analysis-full-agent-completion-invalid");
      if (value) completed.add(nodeId);
      return value;
    }, onBeforeSend: async (draft) => {
      await assertLive();
      if (verifyOnly) throw new Error("analysis-full-agent-completion-invalid");
      const intent = await store.beforeSend(draft, lease);
      durableState.attempts.push({ intent });
      await assertLive();
      await refreshAgent(access, operation);
      await save(access, operation);
      await assertLive();
      return intent;
    }, onReceipt: async (receipt) => {
      try {
        await assertLive();
      } catch (error) {
        const { raw: _raw, rawHash: _rawHash, ...safe } = receipt;
        await store.receipt({ ...safe, outcome: receipt.outcome === "valid" ? "incomplete" : receipt.outcome });
        throw error;
      }
      const saved = await store.receipt(receipt);
      const row = durableState.attempts.find((row2) => row2.intent.attemptId === receipt.attemptId);
      if (row) row.receipt = copy(receipt);
      await assertLive();
      await refreshAgent(access, operation);
      return saved;
    }, onCheckpoint: async (checkpoint) => {
      await assertLive();
      if (verifyOnly) throw new Error("analysis-full-agent-completion-invalid");
      await store.checkpoint(checkpoint);
      await assertLive();
      completed.add(checkpoint.nodeId);
      operation.agent.checkpoints = [...completed];
      view.coverage = agentCoverage(operation, completed);
      operation.adoption.historyReview.coverage = copy(view.coverage);
      await save(access, operation);
      await assertLive();
    }, onProgress: async (progress) => {
      await assertLive();
      if (verifyOnly) return;
      view.phase = progress.phase;
      view.completedNodes = progress.completedNodes;
      view.reusedCheckpoints = progress.reusedCheckpoints;
      await refreshAgent(access, operation);
      await save(access, operation);
      await assertLive();
    } });
    await assertLive();
    if (result.outcome === "complete" && result.proposal) {
      await store.state({ strict: true });
      await assertLive();
      if (completed.size !== plan.nodes.length) throw new Error("analysis-full-agent-completion-invalid");
      if (verifyOnly) return result;
      await publish(access, operation.adoption.id, `history-review-${plan.planId}.proposal.json`, result.proposal, signal);
      await assertLive();
      operation.adoption.proposal = result.proposal;
      operation.adoption.proposalHash = (await backend()).sha256(result.proposal);
      operation.historyReview.completedProposalHash = operation.adoption.proposalHash;
      operation.historyReview.finalSources = result.sources;
      view.phase = "proposal-ready";
      view.coverage = agentCoverage(operation, completed);
      delete view.needsUserAction;
      operation.adoption.historyReview = { ...operation.adoption.historyReview, status: "complete", coverage: copy(view.coverage), canConfirm: true };
      operation.adoption.status = "proposal-ready";
      delete operation.adoption.error;
    } else {
      view.phase = "awaiting-user";
      view.needsUserAction = { reason: result.reason ?? "result-incomplete" };
      operation.adoption.status = "blocked";
      operation.adoption.historyReview.status = "interrupted";
    }
    await refreshAgent(access, operation);
    await assertLive();
    await save(access, operation);
    return result;
  }
  function launch(access, operation, action) {
    const controller = new AbortController();
    running.set(operation.adoption.id, { controller, operation });
    void action(controller.signal).catch(async (err) => {
      if (operation.adoption.status === "cancelled" || controller.signal.aborted || disposed) return;
      operation.adoption.status = "blocked";
      if (operation.agent && operation.adoption.agentJob) {
        const code = err?.message;
        operation.adoption.agentJob.phase = "awaiting-user";
        operation.adoption.agentJob.needsUserAction = { reason: code === "analysis-full-agent-authorization-expired" ? "authorization-expired" : code?.startsWith("model-") ? "model-changed" : code?.includes("access") || code?.includes("owner") ? "access-required" : "storage-unavailable" };
      }
      if (operation.adoption.historyReview?.status === "running") {
        operation.adoption.historyReview.status = err?.message?.startsWith("analysis-full-known-") ? "blocked" : "interrupted";
        operation.adoption.historyReview.canConfirm = false;
      }
      const message = err?.message ?? "";
      operation.adoption.error = /^(?:analysis-|model-|no-authorized-materials|material-snapshot-invalid)/.test(message) ? message : "adoption-failed-check-model-access-and-source-coverage";
      try {
        await save(access, operation);
      } catch {
      }
    }).finally(() => {
      controller.abort();
      if (running.get(operation.adoption.id)?.controller === controller) running.delete(operation.adoption.id);
    });
  }
  async function associateSelected(access, operation) {
    if (operation.participantsAttempted || !Array.isArray(operation.adoption.selectedHistories)) return;
    const failures = [];
    for (const selected of operation.adoption.selectedHistories) {
      if (!selected.registered || selected.kind !== "local") continue;
      try {
        await access.revalidate();
        if (!deps.joinParticipant) throw new ResWorkflowError(503, "participant-service-unavailable");
        await deps.joinParticipant(access, selected.sessionId, "adoption");
      } catch (err) {
        const code = err instanceof ResWorkflowError ? err.code : err.message;
        failures.push({ sessionId: selected.sessionId, reason: /^(?:participant|session|res-workflow|cwd|workspace)[a-z0-9-]{0,100}$/.test(code) ? code : "participant-association-failed" });
      }
    }
    operation.adoption.participantFailures = failures;
    operation.participantsAttempted = true;
  }
  const discover = (access, signal = new AbortController().signal) => discoverHistoryCandidates({
    cwd: access.cwd,
    history: deps.history(),
    historyRoots: deps.historyRoots(),
    signal,
    revalidate: () => access.revalidate(),
    canReadHistory: access.canReadHistory
  }, access.ownerKey);
  async function readConnectionUnlocked(access) {
    await access.revalidate();
    const adopted = await readJson(path.join(directory(access), "adopted.json"));
    const old = typeof adopted?.id === "string" && ID.test(adopted.id) ? await readJson(fileFor(access, adopted.id)) : null;
    return { cwd: access.cwd, adopted: adopted?.confirmed === true && !old?.detachedAt };
  }
  const service = {
    async charterBinding(access, sessionId) {
      if (sessionId !== void 0 && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new ResWorkflowError(400, "research-charter-binding-invalid-request");
      return locked(access, async () => {
        await access.revalidate();
        const native = await bindingBackend();
        await access.revalidate();
        let result = native.readResearchCharterBinding({ cwd: access.cwd, ownerKey: access.ownerKey, privateDir: deps.privateDir });
        if (sessionId) {
          const eligible = (row2) => row2.id === sessionId && row2.cwd === access.cwd && !!row2.sessionFile && !row2.originDeviceId && !row2.pluginHidden && !row2.archiveOnEnd && (!row2.principalOwner || JSON.stringify([row2.principalOwner.iss, row2.principalOwner.sub]) === access.ownerKey);
          const row = deps.history().find(eligible);
          let session = { sessionId, status: "not-joined", error: "research-workbench-session-not-joined" };
          if (row && (!access.canReadHistory || await access.canReadHistory(row))) {
            await access.revalidate();
            const current2 = deps.history().find((candidate) => eligible(candidate) && candidate.sessionFile === row.sessionFile);
            if (current2) {
              const inspection = native.inspect({ cwd: access.cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => current2.sessionFile } }, { privateDir: deps.privateDir, expectedOwnerKey: access.ownerKey });
              if (inspection.binding) result = inspection.binding;
              session = { sessionId, status: inspection.status === "ready" || inspection.status === "charter-stale" ? "joined" : inspection.status === "assignment-stale" ? "assignment-stale" : inspection.status === "not-joined" ? "not-joined" : "unavailable", ...inspection.error ? { error: inspection.error } : {} };
            }
          }
          result = { ...result, session };
        }
        if (!isResearchCharterBinding(result) || result.cwd !== access.cwd) throw new ResWorkflowError(503, "research-charter-binding-unavailable");
        return result;
      });
    },
    async updateCharterBinding(access, request) {
      if (access.write !== true) throw new ResWorkflowError(403, "research-charter-binding-write-required");
      if (!isResearchCharterBindingUpdate(request) || request.cwd !== access.cwd) throw new ResWorkflowError(400, "research-charter-binding-invalid-request");
      return locked(access, async () => {
        await access.revalidate();
        const native = await bindingBackend();
        await access.revalidate();
        if (disposed) throw new ResWorkflowError(503, "adoption-service-stopped");
        try {
          const result = native.updateResearchCharterBinding({ ...request, cwd: access.cwd, ownerKey: access.ownerKey, privateDir: deps.privateDir, write: true });
          if (!isResearchCharterBinding(result) || result.cwd !== access.cwd) throw new Error("invalid binding projection");
          return result;
        } catch (error) {
          const failure = error;
          if (typeof failure.code === "string" && /^research-charter-binding-[a-z-]+$/.test(failure.code)) throw new ResWorkflowError([400, 403, 409, 503].includes(failure.statusCode ?? 0) ? failure.statusCode : 409, failure.code);
          throw new ResWorkflowError(503, "research-charter-binding-unavailable");
        }
      });
    },
    async connection(access) {
      const context = transaction.getStore();
      if (context?.active && context.scope === scope(access)) {
        const result = await readConnectionUnlocked(access);
        if (context.active) return result;
      }
      return locked(access, () => readConnectionUnlocked(access));
    },
    async reconnect(access) {
      if (access.write !== true) throw new ResWorkflowError(403, "res-workflow-write-required");
      await access.revalidate();
      for (const live of running.values()) if (live.operation.ownerKey === access.ownerKey && live.operation.cwd === access.cwd) live.controller.abort();
      return locked(access, async () => {
        await access.revalidate();
        if (disposed) throw new ResWorkflowError(503, "adoption-service-stopped");
        const currentPointer = await readJson(path.join(directory(access), "current.json"));
        const adoptedPointer = await readJson(path.join(directory(access), "adopted.json"));
        const operations = /* @__PURE__ */ new Map();
        for (const live of running.values()) if (live.operation.ownerKey === access.ownerKey && live.operation.cwd === access.cwd) operations.set(live.operation.adoption.id, live.operation);
        if (!currentPointer?.id && adoptedPointer?.confirmed !== true && !operations.size) return { cwd: access.cwd, adopted: false };
        for (const id of [currentPointer?.id, adoptedPointer?.id]) {
          if (typeof id !== "string" || !ID.test(id) || operations.has(id)) continue;
          const value = await readJson(fileFor(access, id));
          if (!value) continue;
          const operation = value;
          if (operation.schema !== "pi-res-workflow-operation.v1" || operation.ownerKey !== access.ownerKey || operation.cwd !== access.cwd || operation.adoption?.id !== id || operation.adoption.cwd !== access.cwd) throw new ResWorkflowError(409, "private-operation-invalid");
          operations.set(id, operation);
        }
        const at = (/* @__PURE__ */ new Date()).toISOString();
        await access.revalidate();
        await writeJson(access, path.join(directory(access), `reconnect-${randomUUID()}.json`), { schema: "pi-res-workflow-reconnect.v1", at, ownerKey: access.ownerKey, cwd: access.cwd, current: currentPointer, adopted: adoptedPointer, operations: [...operations.values()].map((operation) => copy(operation)) });
        for (const operation of operations.values()) {
          if (operation.agent) {
            await agentStore(access, operation).cancel();
            operation.adoption.agentJob.phase = "cancelled";
            operation.adoption.agentJob.resumeRequired = false;
          }
          operation.detachedAt = at;
          if (operation.adoption.status !== "confirmed") operation.adoption.status = "cancelled";
          if (operation.adoption.historyReview) {
            operation.adoption.historyReview.status = "interrupted";
            operation.adoption.historyReview.canConfirm = false;
          }
          running.get(operation.adoption.id)?.controller.abort();
        }
        for (const operation of operations.values()) {
          await access.revalidate();
          await save(access, operation);
        }
        await access.revalidate();
        await writeJson(access, path.join(directory(access), "adopted.json"), { confirmed: false, reconnectedAt: at });
        await writeJson(access, path.join(directory(access), "current.json"), { id: null, reconnectedAt: at });
        return { cwd: access.cwd, adopted: false };
      });
    },
    async historyCandidates(access) {
      await access.revalidate();
      const { candidates, partial, skipped } = await discover(access);
      return { candidates, partial, skipped };
    },
    async joinParticipant(access, sessionId) {
      if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new ResWorkflowError(400, "real-session-id-required");
      return locked(access, async () => {
        await access.revalidate();
        if (!(await readConnectionUnlocked(access)).adopted) throw new ResWorkflowError(409, "res-workflow-not-connected");
        if (!deps.joinParticipant) throw new ResWorkflowError(503, "participant-service-unavailable");
        const result = await deps.joinParticipant(access, sessionId, "manual");
        const operation = await current(access);
        if (operation?.adoption.status === "confirmed" && operation.adoption.participantFailures?.some((failure) => failure.sessionId === sessionId)) {
          operation.adoption.participantFailures = operation.adoption.participantFailures.filter((failure) => failure.sessionId !== sessionId);
          await save(access, operation);
        }
        return result;
      });
    },
    async snapshot(access) {
      return locked(access, async () => {
        await access.revalidate();
        const research = await researchFiles(access);
        const [operation, connection] = await Promise.all([current(access), readConnectionUnlocked(access)]);
        return { cwd: access.cwd, adopted: connection.adopted, research, adoption: operation ? publicAdoption(operation) : null };
      });
    },
    async models(access) {
      await access.revalidate();
      return (deps.listModels ?? listAnalysisModels)();
    },
    async create(access, request, agentMode) {
      const selectedIds = historySelection(request.historySelection);
      if (agentMode && (!selectedIds.length || !validPhysicalModel(request.model) || request.consent !== void 0)) throw new ResWorkflowError(400, "analysis-full-agent-create-invalid");
      if (selectedIds.length && request.consent !== void 0) throw new ResWorkflowError(409, "full-history-plan-required");
      if (!validRequestId(request.requestId) || (selectedIds.length ? request.model !== void 0 && !validPhysicalModel(request.model) : (request.model !== void 0 || request.consent !== void 0) && !validAuthorization(request.model, request.consent))) throw new ResWorkflowError(400, "explicit-model-and-material-consent-required");
      if (request.model && !selectedIds.length) requireAgentConsent(request.consent);
      return locked(access, async () => {
        await access.revalidate();
        if (disposed) throw new ResWorkflowError(503, "adoption-service-stopped");
        const id = `adopt-${hash([access.ownerKey, access.cwd, request.requestId]).slice(0, 24)}`;
        const creationHash = hash({ model: request.model, consent: request.consent, historySelection: selectedIds, ...agentMode ? { agentMode } : {} });
        const existing = await operationFor(access, id, false);
        if (existing) {
          if (existing.detachedAt) throw new ResWorkflowError(409, "adoption-detached-explicit-new-adoption-required");
          if (existing.creationHash !== creationHash) throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(existing);
        }
        const latest = await current(access);
        if (latest && latest.adoption.status !== "cancelled" && running.has(latest.adoption.id)) throw new ResWorkflowError(409, "adoption-already-running");
        if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
        const discovered = selectedIds.length ? await discover(access) : { candidates: [], bindings: /* @__PURE__ */ new Map() };
        const selectedHistory = selectedIds.map((id2) => {
          const binding = discovered.bindings.get(id2);
          if (!binding) throw new ResWorkflowError(404, "history-source-unavailable");
          return binding;
        });
        const selectedHistories = selectedIds.map((id2) => discovered.candidates.find((candidate) => candidate.id === id2));
        await researchFiles(access);
        const at = (/* @__PURE__ */ new Date()).toISOString();
        const operation = { schema: "pi-res-workflow-operation.v1", ownerKey: access.ownerKey, cwd: access.cwd, requestId: request.requestId, creationHash, historySelection: selectedIds, adoption: {
          historySelection: copy(selectedIds),
          selectedHistories: copy(selectedHistories),
          id,
          cwd: access.cwd,
          status: "inventory",
          createdAt: at,
          updatedAt: at,
          partial: false,
          progress: { files: 0, sessions: 0, bytes: 0 },
          sources: [],
          skipped: [],
          charterHash: (await backend()).charterHash(access.cwd),
          ...request.model ? { model: copy(request.model) } : {}
        } };
        if (agentMode) {
          operation.agent = { schema: "pi-full-history-agent.v2", requests: [], bindings: copy(selectedHistory) };
          operation.adoption.agentJob = { mode: agentMode, phase: "preparing", authorized: false, workerActive: true, resumeRequired: false, coverage: emptyCoverage(selectedIds.length), budget: { baseRequests: 0, retryReserve: 0, maxRequests: 0, usedRequests: 0, baseUsed: 0, recoveryUsed: 0, remainingRequests: 0, inFlightRequests: 0, unknownRequests: 0 }, completedNodes: 0, reusedCheckpoints: 0 };
        }
        await save(access, operation);
        if (agentMode) await ensureProjectDirectory(deps.privateDir, [hash(access.ownerKey), hash(access.cwd), `${id}.agent-v2`]);
        await writeJson(access, path.join(directory(access), "current.json"), { id });
        const localLease = agentMode ? await agentStore(access, operation).acquire() : void 0;
        launch(access, operation, async (signal) => {
          try {
            let resolved;
            if (request.model) {
              try {
                resolved = await findModel(request.model.provider, request.model.id);
              } catch {
                throw new Error("model-unavailable-no-fallback");
              }
            }
            const inventory = await (deps.inventory ?? inventoryResearch)({
              // Selected histories use the complete material planner after model selection.
              // This initial inventory only freezes research files and trusted history bindings.
              cwd: access.cwd,
              history: [],
              historyRoots: [],
              signal,
              revalidate: () => check(access, operation, signal),
              canReadHistory: access.canReadHistory,
              readRetained: deps.readRetained,
              pool: deps.pool?.(),
              onProgress: (progress) => {
                operation.adoption.progress = progress;
              }
            });
            if (selectedIds.length) inventory.historyBindings = copy(selectedHistory);
            await check(access, operation, signal);
            operation.snapshotHash = hash(inventory);
            operation.adoption.sources = inventory.sources;
            operation.adoption.skipped = inventory.skipped;
            operation.adoption.partial = inventory.partial;
            operation.adoption.progress = inventory.progress;
            await writeJson(access, path.join(directory(access), `${id}.snapshot.json`), inventory);
            await publish(access, id, "manifest.json", { schema: "pi-research-adoption-manifest.v1", adoptionId: id, createdAt: at, historySelection: selectedIds, selectedHistories, sources: inventory.sources, skipped: inventory.skipped, partial: inventory.partial, progress: inventory.progress, unverified: true }, signal);
            await check(access, operation, signal);
            if (agentMode) {
              await save(access, operation);
              await prepareAgent(access, operation, signal, localLease);
            } else if (request.model && request.consent) {
              const analysisRequest = { cwd: access.cwd, requestId: request.requestId, model: request.model, consent: request.consent };
              operation.analysisRequest = { id: request.requestId, hash: hash(analysisRequest) };
              await analyze(access, operation, analysisRequest, signal, resolved?.fingerprint);
            } else {
              operation.adoption.status = "awaiting-model";
              await save(access, operation);
            }
          } finally {
            await localLease?.release();
          }
        });
        return copy(operation.adoption);
      });
    },
    async createAgent(access, request) {
      return service.create(access, request, "full-history-agent-v2");
    },
    async authorizeAgent(access, id, request) {
      if (access.write !== true) throw new ResWorkflowError(403, "res-workflow-write-required");
      if (!validRequestId(request.requestId) || !validPhysicalModel(request.model)) throw new ResWorkflowError(400, "analysis-full-agent-grant-required");
      if (request.budget !== void 0 && !validAgentBudgetChoice(request.budget)) throw new ResWorkflowError(400, "analysis-agent-budget-invalid");
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        await requireCurrent(access, operation);
        if (!operation.agent || operation.adoption.status === "cancelled" || operation.detachedAt) throw new ResWorkflowError(409, "analysis-full-agent-not-resumable");
        const view = operation.adoption.agentJob, g = view.grant, c = request.consent, requestHash = hash(request), prior = operation.agent.requests.find((r) => r.id === request.requestId);
        if (prior) {
          if (prior.hash !== requestHash || prior.kind !== "authorize") throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(operation);
        }
        if (!g || view.phase !== "awaiting-authorization" || view.authorized || !c || c.analysisMode !== "full-history-agent-v2" || c.scope !== "research-files-and-normal-messages" || c.includeUnpublished !== true || c.grantHash !== g.grantHash || c.policyId !== g.policy.id || c.unknownRetryMayBillAgain !== true || hash(request.model) !== hash(g.model)) throw new ResWorkflowError(409, "analysis-full-agent-grant-mismatch");
        if (running.has(id)) throw new ResWorkflowError(409, "adoption-already-running");
        if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
        const current2 = await findModel(g.model.provider, g.model.id);
        if (current2.fingerprint !== operation.agent.modelFingerprint) throw new ResWorkflowError(409, "model-configuration-changed-new-consent-required");
        const store = agentStore(access, operation), lease = await store.acquire();
        try {
          await check(access, operation, new AbortController().signal);
          await requireCurrent(access, operation);
          const at = Date.now(), authorizedAt = new Date(at).toISOString(), expiresAt = new Date(at + g.policy.grantLifetimeMs).toISOString();
          await store.authorize({ grant: g, modelFingerprint: current2.fingerprint, requestId: request.requestId, requestHash, authorizedAt, expiresAt, promptSchemaHash: FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH, nodeIds: operation.agent.nodes.map((n) => n.id), ...request.budget ? { initialBudget: copy(request.budget) } : {} });
          view.authorized = true;
          view.authorizedAt = authorizedAt;
          view.expiresAt = expiresAt;
          view.phase = "reviewing";
          delete view.needsUserAction;
          await refreshAgent(access, operation);
          operation.agent.requests.push({ id: request.requestId, hash: requestHash, kind: "authorize" });
          operation.adoption.status = "analyzing";
          operation.adoption.historyReview.status = "running";
          await save(access, operation);
          launch(access, operation, async (signal) => {
            try {
              await runAgent(access, operation, signal, lease);
            } finally {
              try {
                await recordAgentUnknowns(access, operation, lease);
              } finally {
                await lease.release();
              }
            }
          });
        } catch (error) {
          await lease.release();
          throw error;
        }
        return publicAdoption(operation);
      });
    },
    async updateAgentBudget(access, id, request) {
      if (access.write !== true) throw new ResWorkflowError(403, "res-workflow-write-required");
      if (request.cwd !== access.cwd || !validRequestId(request.requestId) || typeof request.grantHash !== "string" || !/^[a-f0-9]{64}$/.test(request.grantHash) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !validAgentBudgetChoice({ maxRequests: request.maxRequests, consent: request.consent })) throw new ResWorkflowError(400, "analysis-agent-budget-invalid");
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        await requireCurrent(access, operation);
        const view = operation.adoption.agentJob;
        if (!operation.agent || !view || operation.detachedAt || operation.adoption.status === "cancelled" || view.phase === "cancelled") throw new ResWorkflowError(409, "analysis-full-agent-not-resumable");
        if (!view.authorized || !view.grant || view.grant.grantHash !== request.grantHash) throw new ResWorkflowError(409, "analysis-agent-budget-grant-mismatch");
        if (view.phase === "proposal-ready" || operation.adoption.status === "confirmed") throw new ResWorkflowError(409, "analysis-agent-budget-completed");
        if (view.expiresAt && Date.now() >= Date.parse(view.expiresAt)) throw new ResWorkflowError(409, "analysis-full-agent-authorization-expired");
        if (operation.agent.requests.some((r) => r.id === request.requestId)) throw new ResWorkflowError(409, "request-id-conflict");
        await check(access, operation, new AbortController().signal);
        await requireCurrent(access, operation);
        try {
          await agentStore(access, operation).updateBudget({ ...request, requestHash: hash(request) });
        } catch (error) {
          const code = error?.message;
          if (["analysis-agent-budget-invalid", "analysis-agent-budget-grant-mismatch", "analysis-agent-budget-revision-conflict", "request-id-conflict", "analysis-full-agent-authorization-expired", "analysis-agent-worker-busy", "cancelled"].includes(code)) throw new ResWorkflowError(code === "analysis-agent-budget-invalid" ? 400 : 409, code);
          throw error;
        }
        await check(access, operation, new AbortController().signal);
        await requireCurrent(access, operation);
        await refreshAgent(access, operation);
        await save(access, operation);
        return publicAdoption(operation);
      });
    },
    async resumeAgent(access, id, request) {
      if (!validRequestId(request.requestId) || request.grantHash !== void 0 && typeof request.grantHash !== "string") throw new ResWorkflowError(400, "analysis-full-agent-resume-invalid");
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        await requireCurrent(access, operation);
        const view = operation.adoption.agentJob, g = view?.grant;
        if (!operation.agent || !view || operation.adoption.status === "cancelled" || view.phase === "cancelled" || operation.detachedAt) throw new ResWorkflowError(409, "analysis-full-agent-not-resumable");
        if (!view.authorized) {
          if (request.grantHash !== void 0 || view.plan || g) return publicAdoption(operation);
          if (view.phase !== "preparing") throw new ResWorkflowError(409, "analysis-full-agent-not-resumable");
          if (running.has(id)) return publicAdoption(operation);
          if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
          const lease2 = await agentStore(access, operation).acquire();
          launch(access, operation, async (signal) => {
            try {
              await agentBoundary(access, operation, signal, lease2, false);
              if (!operation.snapshotHash) {
                const inventory = await (deps.inventory ?? inventoryResearch)({ cwd: access.cwd, history: [], historyRoots: [], signal, revalidate: () => agentBoundary(access, operation, signal, lease2, false), canReadHistory: access.canReadHistory, readRetained: deps.readRetained, pool: deps.pool?.(), onProgress: (progress) => {
                  operation.adoption.progress = progress;
                } });
                await agentBoundary(access, operation, signal, lease2, false);
                inventory.historyBindings = copy(operation.agent.bindings ?? []);
                operation.snapshotHash = hash(inventory);
                operation.adoption.sources = inventory.sources;
                operation.adoption.skipped = inventory.skipped;
                operation.adoption.partial = inventory.partial;
                operation.adoption.progress = inventory.progress;
                await writeJson(access, path.join(directory(access), `${id}.snapshot.json`), inventory);
                await save(access, operation);
              }
              await prepareAgent(access, operation, signal, lease2);
            } finally {
              await lease2.release();
            }
          });
          return publicAdoption(operation);
        }
        if (!g || g.grantHash !== request.grantHash) throw new ResWorkflowError(409, "analysis-full-agent-not-resumable");
        const requestHash = hash(request), prior = operation.agent.requests.find((r) => r.id === request.requestId);
        if (prior) {
          if (prior.hash !== requestHash || prior.kind !== "resume") throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(operation);
        }
        if (running.has(id) || view.phase === "proposal-ready") return publicAdoption(operation);
        if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
        if (view.expiresAt && Date.now() >= Date.parse(view.expiresAt)) throw new ResWorkflowError(409, "analysis-full-agent-authorization-expired");
        const lease = await agentStore(access, operation).acquire();
        try {
          await agentBoundary(access, operation, new AbortController().signal, lease);
          const resolved = await findModel(g.model.provider, g.model.id);
          if (resolved.fingerprint !== operation.agent.modelFingerprint) throw new ResWorkflowError(409, "model-configuration-changed-new-consent-required");
          operation.agent.requests.push({ id: request.requestId, hash: requestHash, kind: "resume" });
          view.phase = "reviewing";
          delete view.needsUserAction;
          view.resumeRequired = false;
          operation.adoption.status = "analyzing";
          operation.adoption.historyReview.status = "running";
          await save(access, operation);
          launch(access, operation, async (signal) => {
            try {
              await runAgent(access, operation, signal, lease);
            } finally {
              try {
                await recordAgentUnknowns(access, operation, lease);
              } finally {
                await lease.release();
              }
            }
          });
        } catch (error) {
          await lease.release();
          throw error;
        }
        return publicAdoption(operation);
      });
    },
    async get(access, id) {
      return locked(access, async () => publicAdoption(await operationFor(access, id)));
    },
    async prepareHistoryReview(access, id, request) {
      if (!validRequestId(request.requestId) || !request.model || typeof request.model.provider !== "string" || !request.model.provider || typeof request.model.id !== "string" || !request.model.id) throw new ResWorkflowError(400, "explicit-model-required");
      const recovery = request.recovery;
      if (recovery !== void 0 && (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || Object.keys(recovery).some((key) => !["mode", "previousPlanId", "previousPlanHash"].includes(key)) || recovery.mode !== "new-plan" || typeof recovery.previousPlanId !== "string" || !/^hplan-[a-f0-9]{24}$/.test(recovery.previousPlanId) || typeof recovery.previousPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(recovery.previousPlanHash))) throw new ResWorkflowError(400, "analysis-full-recovery-request-invalid");
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        if (operation.agent) throw new ResWorkflowError(409, "analysis-full-agent-v2-route-required");
        await requireCurrent(access, operation);
        if (operation.adoption.status === "confirmed") throw new ResWorkflowError(409, "confirmed-adoption-cannot-be-reanalyzed");
        if (running.has(id)) throw new ResWorkflowError(409, "adoption-already-running");
        if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
        const requestHash = hash(request), previous = operation.historyReview?.prepareRequests.find((row) => row.id === request.requestId) ?? operation.historyReviewArchives?.flatMap((archive) => archive.review.prepareRequests).find((row) => row.id === request.requestId);
        if (previous) {
          if (previous.hash !== requestHash) throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(operation);
        }
        if (recovery) return prepareNewHistoryReviewAttempt(access, operation, request, requestHash);
        await rejectUntrackedFullIntents(access, operation);
        if (operation.historyReview?.authorization) return prepareCompletedPrefix(access, operation, request, requestHash);
        const selectedHistories = operation.adoption.selectedHistories ?? [];
        const selected = operation.historySelection ?? [];
        if (!selected.length || selectedHistories.length !== selected.length || selectedHistories.some((row) => !selected.includes(row.id))) throw new ResWorkflowError(409, "analysis-full-selected-history-bindings-required");
        const snapshot = await snapshotFor(access, operation);
        const bindings = snapshot.historyBindings ?? [];
        if (bindings.length !== selectedHistories.length || selectedHistories.some((row) => bindings.filter((binding) => binding.id === row.sessionId && (!!binding.originDeviceId ? "retained" : "local") === row.kind && binding.cwd === access.cwd).length !== 1)) throw new ResWorkflowError(409, "analysis-full-selected-history-bindings-required");
        const controller = new AbortController();
        running.set(id, { controller, operation });
        const priorDisclosure = operation.adoption.historyReview?.previousAttempt;
        operation.historyReview ??= { prepareRequests: [], checkpoints: [] };
        operation.historyReview.prepareRequests = [...operation.historyReview.prepareRequests, { id: request.requestId, hash: requestHash }];
        operation.adoption.historyReview = { status: "unprepared", coverage: { selectedHistories: selected.length, completedHistories: 0, eligibleMessages: 0, completedMessages: 0, eligibleBytes: 0, completedBytes: 0, completedBatches: 0, totalBatches: 0 }, canConfirm: false, ...priorDisclosure ? { previousAttempt: copy(priorDisclosure) } : {} };
        try {
          await save(access, operation);
          const resolved = await findModel(request.model.provider, request.model.id);
          const assertLive = async () => {
            await check(access, operation, controller.signal);
            await requireCurrent(access, operation);
          };
          const directorySources = snapshot.sources.filter((source) => source.kind === "file" || source.kind === "artifact");
          const prepared = await (deps.prepareFullHistoryMaterial ?? prepareFullHistoryMaterial)({ cwd: access.cwd, selectedHistories: selectedHistories.map((row) => ({ ...row })), historyBindings: bindings.map((binding) => ({ ...binding })), snapshotSources: directorySources, snapshotContent: Object.fromEntries(directorySources.map((source) => [source.id, snapshot.content[source.id]])), snapshotFingerprint: operation.snapshotHash, model: { provider: resolved.provider, id: resolved.id, fingerprint: resolved.fingerprint, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens }, privateDir: fullDirectory(access, operation), signal: controller.signal, revalidate: assertLive, canReadHistory: async (binding) => {
            await assertLive();
            return access.canReadHistory ? access.canReadHistory(binding) : true;
          }, readRetained: deps.readRetained });
          await assertLive();
          const metadata = prepared.publicPlan;
          if (metadata.maxRequests !== prepared.privatePlan.nodes.length || metadata.histories.length !== selected.length || metadata.histories.some((row) => !selected.includes(row.id))) throw new Error("analysis-full-plan-invalid");
          operation.historyReview.plan = copy(metadata);
          operation.historyReview.materialPlanHash = metadata.planHash;
          operation.historyReview.prepareRequests.at(-1).planId = metadata.planId;
          operation.adoption.historyReview = { status: metadata.blockers.length ? "blocked" : "prepared", plan: copy(metadata), coverage: { selectedHistories: selected.length, completedHistories: metadata.histories.filter((row) => row.chunkCount === 0 && !!row.emptyReason).length, emptyHistories: metadata.histories.filter((row) => row.chunkCount === 0 && !!row.emptyReason).length, eligibleMessages: metadata.eligibleMessages, completedMessages: 0, eligibleBytes: metadata.eligibleBytes, completedBytes: 0, completedBatches: 0, totalBatches: metadata.batchCount }, canConfirm: false, ...priorDisclosure ? { previousAttempt: copy(priorDisclosure) } : {} };
          if (metadata.blockers.length) operation.adoption.error = "analysis-full-preparation-blocked";
          else {
            delete operation.adoption.error;
            operation.adoption.status = operation.adoption.proposal ? "proposal-ready" : "awaiting-model";
          }
          await save(access, operation);
          return publicAdoption(operation);
        } catch (error) {
          operation.adoption.historyReview.status = "blocked";
          operation.adoption.historyReview.canConfirm = false;
          const code = error?.message ?? "";
          operation.adoption.error = /^(?:analysis-full-|full-history-|history-|source-owner-|no-authorized-materials|model-)[a-z0-9-]*$/.test(code) ? code : "analysis-full-preparation-failed";
          await save(access, operation);
          return publicAdoption(operation);
        } finally {
          if (running.get(id)?.controller === controller) running.delete(id);
        }
      });
    },
    async analyzeHistoryReview(access, id, request) {
      const consent = request.consent;
      if (!validRequestId(request.requestId) || !validAuthorization(request.model, consent) || consent.analysisMode !== "full-history-review-v1" || typeof consent.planId !== "string" || typeof consent.planHash !== "string" || consent.maxRequests !== void 0 && !Number.isSafeInteger(consent.maxRequests)) throw new ResWorkflowError(400, "analysis-full-plan-consent-required");
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        if (operation.agent) throw new ResWorkflowError(409, "analysis-full-agent-v2-route-required");
        await requireCurrent(access, operation);
        const review = operation.historyReview, metadata = review?.plan;
        const requestHash = hash(request);
        const previousAuthorization = review?.authorizations?.find((row) => row.requestId === request.requestId) ?? operation.historyReviewArchives?.flatMap((archive) => [...archive.review.authorizations ?? [], ...archive.review.authorization ? [archive.review.authorization] : []]).find((row) => row.requestId === request.requestId);
        if (previousAuthorization) {
          if (previousAuthorization.requestHash !== requestHash) throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(operation);
        }
        if (review?.authorization?.requestId === request.requestId) {
          if (review.authorization.requestHash !== requestHash) throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(operation);
        }
        if (running.has(id)) throw new ResWorkflowError(409, "adoption-already-running");
        if (operation.adoption.status === "confirmed" || !metadata || operation.adoption.historyReview?.status !== "prepared" || review?.authorization) throw new ResWorkflowError(409, "analysis-full-prepared-plan-required");
        if (metadata.planId !== consent.planId || metadata.planHash !== consent.planHash || metadata.model.provider !== request.model.provider || metadata.model.id !== request.model.id || metadata.blockers.length) throw new ResWorkflowError(409, "analysis-full-plan-consent-mismatch");
        if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
        const signal = new AbortController().signal, plan = await fullPlan(access, operation, signal);
        const resolved = await findModel(request.model.provider, request.model.id);
        if (plan.model.fingerprint !== resolved.fingerprint || plan.model.contextWindow !== resolved.contextWindow || plan.model.maxTokens !== resolved.maxTokens) throw new ResWorkflowError(409, "model-configuration-changed-new-consent-required");
        review.authorization = { at: (/* @__PURE__ */ new Date()).toISOString(), requestId: request.requestId, requestHash, planId: metadata.planId, planHash: metadata.planHash, modelFingerprint: resolved.fingerprint, consent: copy(consent) };
        operation.adoption.historyReview.status = "running";
        operation.adoption.historyReview.canConfirm = false;
        operation.adoption.status = "analyzing";
        operation.adoption.model = copy(request.model);
        delete operation.adoption.error;
        await save(access, operation);
        launch(access, operation, (runSignal) => analyzeFull(access, operation, request, runSignal));
        return publicAdoption(operation);
      });
    },
    async analyze(access, id, request) {
      if (!validRequestId(request.requestId) || !validAuthorization(request.model, request.consent)) throw new ResWorkflowError(400, "explicit-model-and-material-consent-required");
      requireAgentConsent(request.consent);
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        if (operation.agent) throw new ResWorkflowError(409, "analysis-full-agent-v2-route-required");
        await requireCurrent(access, operation);
        if ((operation.historySelection?.length ?? operation.adoption.selectedHistories?.length ?? 0) > 0) throw new ResWorkflowError(409, "full-history-plan-required");
        const requestHash = hash(request);
        if (operation.analysisRequest?.id === request.requestId) {
          if (operation.analysisRequest.hash !== requestHash) throw new ResWorkflowError(409, "request-id-conflict");
          return publicAdoption(operation);
        }
        if (running.has(id)) throw new ResWorkflowError(409, "adoption-already-running");
        if (operation.analysisIntent || !["awaiting-model", "blocked"].includes(operation.adoption.status) || !operation.snapshotHash) throw new ResWorkflowError(409, "explicit-new-adoption-required");
        if (running.size >= 2) throw new ResWorkflowError(429, "adoption-capacity-busy");
        operation.analysisRequest = { id: request.requestId, hash: requestHash };
        operation.adoption.model = copy(request.model);
        operation.adoption.status = "analyzing";
        delete operation.adoption.error;
        await save(access, operation);
        launch(access, operation, (signal) => analyze(access, operation, request, signal));
        return copy(operation.adoption);
      });
    },
    async cancel(access, id) {
      await access.revalidate();
      const live = running.get(id);
      if (live?.operation.ownerKey === access.ownerKey && live.operation.cwd === access.cwd) live.controller.abort();
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        if (operation.adoption.status === "confirmed") throw new ResWorkflowError(409, "confirmed-adoption-cannot-be-cancelled");
        if (operation.agent) {
          await agentStore(access, operation).cancel();
          operation.adoption.agentJob.phase = "cancelled";
          operation.adoption.agentJob.resumeRequired = false;
        }
        operation.adoption.status = "cancelled";
        if (operation.adoption.historyReview) {
          operation.adoption.historyReview.status = "interrupted";
          operation.adoption.historyReview.canConfirm = false;
        }
        running.get(id)?.controller.abort();
        await save(access, operation);
        return copy(operation.adoption);
      });
    },
    async confirm(access, id, request) {
      if (typeof request.objective !== "string" || !request.objective.trim() || request.objective.length > 4e3 || !Array.isArray(request.successCriteria) || !request.successCriteria.length || request.successCriteria.length > 20 || request.successCriteria.some((value) => typeof value !== "string" || !value.trim() || value.length > 1e3)) throw new ResWorkflowError(400, "objective-and-success-criteria-confirmation-required");
      return locked(access, async () => {
        let agentLease;
        try {
          const operation = await operationFor(access, id);
          await requireCurrent(access, operation);
          if (operation.adoption.status === "confirmed" && request.proposalHash === operation.adoption.proposalHash) return copy(operation.adoption);
          if (running.has(id) || operation.adoption.status !== "proposal-ready" || !operation.adoption.proposal || !request.proposalHash || request.proposalHash !== operation.adoption.proposalHash) throw new ResWorkflowError(409, "proposal-hash-or-status-conflict");
          const hasSelected = (operation.historySelection?.length ?? operation.adoption.selectedHistories?.length ?? 0) > 0;
          if (hasSelected && !publicAdoption(operation).historyReview?.canConfirm) throw new ResWorkflowError(409, "analysis-full-selected-histories-not-covered");
          let sources = (await snapshotFor(access, operation)).sources;
          if (hasSelected) {
            let checked;
            if (operation.agent) {
              agentLease = await agentStore(access, operation).acquire();
              checked = await runAgent(access, operation, new AbortController().signal, agentLease, true);
            } else {
              const authorization = operation.historyReview.authorization;
              checked = await fullRunner(access, operation, { cwd: access.cwd, requestId: authorization.requestId, model: operation.historyReview.plan.model, consent: authorization.consent }, new AbortController().signal, true);
            }
            if (hash(checked.proposal) !== hash(operation.adoption.proposal) || operation.historyReview.completedProposalHash !== operation.adoption.proposalHash) throw new ResWorkflowError(409, "analysis-full-completion-invalid");
            sources = checked.sources;
          }
          const input = { id, proposal: operation.adoption.proposal, proposalHash: request.proposalHash, sources, expectedCharterHash: operation.adoption.charterHash, objective: request.objective, successCriteria: request.successCriteria, autoRun: false };
          const research = await backend();
          await access.revalidate();
          try {
            operation.confirmationIntent = { hash: research.confirmationHash(input), at: (/* @__PURE__ */ new Date()).toISOString() };
          } catch {
            throw new ResWorkflowError(400, "objective-and-success-criteria-confirmation-required");
          }
          confirming.add(id);
          try {
            await save(access, operation);
            await ensureProjectDirectory(access.cwd, [".pi", "research-loop", "adoptions", id]);
            await access.revalidate();
            await agentLease?.assertCurrent();
            try {
              research.confirmAdoption(access.cwd, input);
            } catch {
              throw new ResWorkflowError(409, "charter-or-confirmation-conflict", "The research charter or proposal changed; reload and confirm the current target");
            }
            await writeJson(access, path.join(directory(access), "adopted.json"), { confirmed: true, id, confirmationHash: operation.confirmationIntent.hash });
            operation.adoption.status = "confirmed";
            await associateSelected(access, operation);
            await save(access, operation);
            return copy(operation.adoption);
          } finally {
            confirming.delete(id);
          }
        } finally {
          await agentLease?.release();
        }
      });
    },
    async source(access, id, sourceId) {
      return locked(access, async () => {
        const operation = await operationFor(access, id);
        const source = operation.adoption.sources.find((item) => item.id === sourceId);
        if (!source && operation.historyReview?.finalSources?.some((item) => item.id === sourceId)) {
          await snapshotFor(access, operation);
          const signal = new AbortController().signal, plan = await fullPlan(access, operation, signal);
          return (deps.readFullHistorySource ?? readFullHistorySource)({ privateDir: fullDirectory(access, operation), plan, sourceId, signal, revalidate: async () => {
            await access.revalidate();
            await requireCurrent(access, operation);
          } });
        }
        if (!source) throw new ResWorkflowError(404, "source-not-found");
        const snapshot = await snapshotFor(access, operation);
        await access.revalidate();
        return { source: copy(source), content: snapshot.content[sourceId] };
      });
    },
    dispose() {
      disposed = true;
      for (const live of running.values()) live.controller.abort();
    }
  };
  return service;
}
export {
  RES_WORKFLOW_AGENT_TIMEOUT_MS,
  ResWorkflowError,
  createResWorkflowService,
  resolveInstalledResearchLoopRoot
};
