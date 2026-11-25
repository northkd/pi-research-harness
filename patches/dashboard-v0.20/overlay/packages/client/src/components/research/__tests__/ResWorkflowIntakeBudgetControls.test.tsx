import assert from "node:assert/strict";
import type { ResWorkflowAdoption as Adoption } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ApiContext, setGlobalApiBase } from "../../../lib/api/api-context.js";
import { ResWorkflowIntakeAgent } from "../ResWorkflowIntakeAgent.js";
import { zhCNCatalog } from "../../../lib/i18n/i18n-zh-CN.js";

const CWD = "/isolated/intake-authorization";
const MODEL = { provider: "proxy", id: "test-model" };
function job(authorized = false): Adoption {
  const policy = { id: "bounded-intake-v2", maxNodeAttempts: 3, maxJsonRepairsPerNode: 1, maxUnknownRetriesPerNode: 1, maxLengthEscalationsPerNode: 1, unknownRetryMayBillAgain: true, grantLifetimeMs: 86400000, initialOutputTokens: 4096, maxOutputTokens: 8192 };
  const grant = { analysisMode: "full-history-agent-v2", grantHash: "grant-one", materialPlanId: "plan-one", materialPlanHash: "hash-one", model: MODEL, historySelection: [], baseRequests: 2, retryReserve: 1, maxRequests: 3, policy };
  return { id: "adopt-one", cwd: CWD, status: authorized ? "analyzing" : "awaiting-model", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), partial: false, progress: { files: 0, sessions: 0, bytes: 0 }, sources: [], skipped: [], charterHash: "none", model: MODEL, historySelection: [],
    agentJob: { mode: "full-history-agent-v2", phase: authorized ? "reviewing" : "awaiting-authorization", authorized, ...(authorized ? { authorizedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() } : {}), workerActive: authorized, resumeRequired: false, grant,
      plan: { planId: "plan-one", planHash: "hash-one", model: MODEL, contextWindow: 32000, maxTokens: 8192, maxRequests: 2, batchCount: 1, mergeCallCount: 1, histories: [], eligibleMessages: 0, eligibleBytes: 0, blockers: [] },
      coverage: { selectedHistories: 0, completedHistories: 0, eligibleMessages: 0, completedMessages: 0, eligibleBytes: 0, completedBytes: 0, completedBatches: 0, totalBatches: 0 },
      budget: { baseRequests: 2, retryReserve: 1, maxRequests: 3, effectiveMaxRequests: 3, revision: 0, editable: authorized, policy: "original-bounded", usedRequests: authorized ? 2 : 0, baseUsed: authorized ? 1 : 0, recoveryUsed: authorized ? 1 : 0, remainingRequests: authorized ? 1 : 3, inFlightRequests: authorized ? 1 : 0, unknownRequests: authorized ? 1 : 0 }, completedNodes: 0, reusedCheckpoints: 0 },
  } as Adoption;
}

let root: Root, host: HTMLDivElement, latest: Adoption, calls: { url: string; body: any }[], accepted: Adoption[];
let reply: (body: any, url: string) => Promise<Response>;
let apiBase = "";
const originalFetch = globalThis.fetch;
const response = (adoption: Adoption) => new Response(JSON.stringify({ adoption }), { headers: { "content-type": "application/json" } });
const find = <T extends HTMLElement = HTMLElement>(id: string): T => { const node = host.querySelector<T>(`[data-testid="${id}"]`); assert.ok(node, `missing ${id}`); return node; };
const absent = (id: string) => assert.equal(host.querySelector(`[data-testid="${id}"]`), null);
async function click(id: string) { await act(async () => { find(id).click(); }); }
async function draw(next: Adoption = latest) {
  latest = next;
  await act(async () => { root.render(<ApiContext.Provider value={apiBase}><ResWorkflowIntakeAgent cwd={next.cwd} job={next} onRefresh={() => {}} onJob={value => { accepted.push(value); latest = value; }} /></ApiContext.Provider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
function authorizedReply(source = latest) {
  const next = structuredClone(source);
  next.status = "analyzing";
  Object.assign(next.agentJob!, { authorized: true, workerActive: true, phase: "reviewing", authorizedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  return next;
}

beforeEach(async () => {
  await import("../ResWorkflowIntakeBudgetControls.js");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  latest = job(); calls = []; accepted = []; apiBase = ""; setGlobalApiBase("");
  reply = async (_body, url) => {
    const next = url.endsWith("/authorize") ? authorizedReply() : structuredClone(latest);
    if (url.endsWith("/resume")) {
      Object.assign(next.agentJob!, { workerActive: true, resumeRequired: false });
      delete next.agentJob!.needsUserAction;
    }
    return response(next);
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body }); return reply(body, String(url)); }) as typeof fetch;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setGlobalApiBase(""); globalThis.fetch = originalFetch; });

describe("intake authorization without research caps", () => {
  it("requires model/material consent, with no budget editor or cap authorization payload", async () => {
    await draw();
    assert.equal(calls.length, 0);
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-authorize").disabled, true);
    absent("res-workflow-intake-budget-edit"); absent("res-workflow-intake-budget-limit"); absent("res-workflow-intake-budget-unlimited");
    assert.doesNotMatch(host.textContent!, /budget|request cap|remaining|reserve/i);
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/agent\/authorize$/);
    assert.equal("budget" in calls[0].body, false);
    assert.equal("maxRequests" in calls[0].body.consent, false);
    assert.deepEqual(calls[0].body.model, MODEL);
    assert.deepEqual(calls[0].body.consent, { analysisMode: "full-history-agent-v2", scope: "research-files-and-normal-messages", includeUnpublished: true, grantHash: "grant-one", policyId: "bounded-intake-v2", unknownRetryMayBillAgain: true });
    assert.equal(accepted.length, 1);
  });

  it("accepts large material plans and does not require old quota metadata to match or be positive", async () => {
    const large = job(), agent = large.agentJob!;
    agent.plan!.batchCount = 199; agent.plan!.maxRequests = 200; agent.grant!.baseRequests = 200;
    agent.grant!.maxRequests = 0; agent.grant!.retryReserve = 0;
    Object.assign(agent.budget, { maxRequests: 0, effectiveMaxRequests: 0, remainingRequests: 0 });
    await draw(large);
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1); assert.equal("maxRequests" in calls[0].body.consent, false);
    assert.equal(accepted.length, 1);
  });

  it("keeps consent through accounting updates but requires fresh consent for a different grant", async () => {
    await draw(); await click("res-workflow-intake-consent");
    const polled = structuredClone(latest);
    Object.assign(polled.agentJob!.budget, { revision: 5, effectiveMaxRequests: 0, usedRequests: 4 });
    await draw(polled);
    assert.equal(find<HTMLInputElement>("res-workflow-intake-consent").checked, true);
    polled.agentJob!.grant!.grantHash = "grant-two";
    await draw(polled);
    assert.equal(find<HTMLInputElement>("res-workflow-intake-consent").checked, false);
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-authorize").disabled, true);
    assert.equal(calls.length, 0);
  });

  it("preserves actual call, recovery, in-flight, unknown-result and checkpoint accounting", async () => {
    await draw(job(true));
    assert.match(find("res-workflow-intake-usage").textContent!, /Actual calls 2.*first attempts 1.*recovery attempts 1.*in flight 1.*result unknown 1/);
    assert.ok(find("res-workflow-intake-checkpoints")); assert.ok(find("res-workflow-intake-coverage"));
    assert.match(host.textContent!, /4096.*8192.*tokens per request/);
    absent("res-workflow-intake-budget-edit");
    assert.equal(calls.length, 0);
  });

  it("still resumes unfinished local preparation without authorizing a model request", async () => {
    const preparing = job(); const agent = preparing.agentJob!;
    agent.phase = "preparing"; agent.resumeRequired = true; delete agent.plan; delete agent.grant;
    await draw(preparing);
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/agent\/resume$/);
    assert.equal("grantHash" in calls[0].body, false); assert.equal("consent" in calls[0].body, false);
  });

  for (const reason of ["budget-exhausted", "node-attempt-limit", "result-incomplete"] as const) {
    it(`continues a ${reason} pause only on request, without editing a zero cap`, async () => {
      const blocked = job(true), agent = blocked.agentJob!;
      agent.phase = "awaiting-user"; agent.workerActive = false; agent.resumeRequired = true; agent.needsUserAction = { reason };
      Object.assign(agent.budget, { maxRequests: 0, effectiveMaxRequests: 0, usedRequests: 400, remainingRequests: 0 });
      await draw(blocked);
      assert.equal(calls.length, 0); assert.ok(find("res-workflow-intake-resume"));
      assert.doesNotMatch(host.textContent!, /budget|exhausted|attempt limit|request cap/i);
      await click("res-workflow-intake-resume");
      assert.equal(calls.length, 1); assert.match(calls[0].url, /\/agent\/resume$/);
      assert.equal(calls[0].body.grantHash, "grant-one"); assert.equal("budget" in calls[0].body, false);
    });
  }

  it("preserves expiry, model/material/access/storage blockers and cancellation", async () => {
    for (const reason of ["authorization-expired", "model-changed", "access-required", "material-invalid", "storage-unavailable"] as const) {
      const blocked = job(true), agent = blocked.agentJob!;
      agent.phase = "awaiting-user"; agent.workerActive = false; agent.resumeRequired = true; agent.needsUserAction = { reason };
      await draw(blocked); absent("res-workflow-intake-resume"); absent("res-workflow-intake-authorize");
    }
    const expired = job(true); expired.agentJob!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expired.agentJob!.workerActive = false; expired.agentJob!.resumeRequired = true;
    await draw(expired); absent("res-workflow-intake-resume");
    const cancelled = job(true); cancelled.status = "cancelled"; cancelled.agentJob!.workerActive = false; cancelled.agentJob!.resumeRequired = true;
    await draw(cancelled); absent("res-workflow-intake-resume");
    assert.equal(calls.length, 0);
  });

  it("rejects a mismatched model, material plan, selection or invalid output limit before authorization", async () => {
    for (const change of [
      (candidate: Adoption) => { candidate.agentJob!.grant!.model = { ...MODEL, id: "other-model" }; },
      (candidate: Adoption) => { candidate.agentJob!.grant!.materialPlanHash = "another-plan"; },
      (candidate: Adoption) => { candidate.agentJob!.grant!.historySelection = ["unselected-history"]; },
      (candidate: Adoption) => { candidate.agentJob!.grant!.policy.maxOutputTokens = 0; },
    ]) {
      const invalid = job(); change(invalid); await draw(invalid);
      absent("res-workflow-intake-authorize"); assert.ok(find("res-workflow-intake-agent").querySelector('[role="alert"]'));
    }
    assert.equal(calls.length, 0);
  });

  it("ignores late replies across directory and server switches", async () => {
    await draw(); await click("res-workflow-intake-consent");
    let finish!: (value: Response) => void;
    const old = authorizedReply(); reply = () => new Promise(resolve => { finish = resolve; });
    await click("res-workflow-intake-authorize");
    const other = job(); other.cwd = "/isolated/other"; apiBase = "https://other.invalid"; setGlobalApiBase(apiBase); await draw(other);
    await act(async () => finish(response(old)));
    assert.equal(accepted.length, 0); assert.equal(calls.length, 1);
  });

  it("never submits authorization twice while pending or after an uncertain result", async () => {
    await draw(); await click("res-workflow-intake-consent");
    let finish!: (value: Response) => void; reply = () => new Promise(resolve => { finish = resolve; });
    await click("res-workflow-intake-authorize"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1);
    await act(async () => finish(new Response(JSON.stringify({ error: "PRIVATE MODEL OUTPUT AND HISTORY" }), { status: 503, headers: { "content-type": "application/json" } })));
    assert.equal(host.textContent!.includes("PRIVATE MODEL OUTPUT"), false);
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-authorize").disabled, true);
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1); assert.equal(accepted.length, 0);
  });

  it("does not adopt a mismatched authorization response", async () => {
    await draw(); reply = async () => { const next = authorizedReply(); next.model = { ...MODEL, id: "different" }; return response(next); };
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(accepted.length, 0); assert.match(host.textContent!, /authorization result could not be confirmed/i);
  });

  it("does not roll back newer polled accounting or a completed proposal with a slow reply", async () => {
    await draw(); await click("res-workflow-intake-consent");
    let finish!: (value: Response) => void; const delayed = authorizedReply(); reply = () => new Promise(resolve => { finish = resolve; });
    await click("res-workflow-intake-authorize");
    const polled = structuredClone(delayed); polled.agentJob!.budget.usedRequests = 4; polled.agentJob!.completedNodes = 2; polled.agentJob!.phase = "proposal-ready";
    await draw(polled); await act(async () => finish(response(delayed)));
    assert.equal(accepted.length, 0); assert.match(find("res-workflow-intake-usage").textContent!, /Actual calls 4/);
  });

  it("Chinese labels preserve authorization and usage without quota prompts", () => {
    for (const key of ["research.intakeConsent", "research.intakeNeedsAuthorization", "research.intakePlanFirst", "research.intakeReadyToContinue", "research.intakeResumeExplicit", "research.intakeUsage", "research.intakeLegacyPause", "research.intakeResultIncomplete"]) {
      assert.ok(zhCNCatalog[key]); assert.doesNotMatch(zhCNCatalog[key], /预算|额度|耗尽|请求上限|次数上限/);
    }
    assert.match(zhCNCatalog["research.intakeConsent"], /所选研究材料/);
    assert.match(zhCNCatalog["research.intakeUsage"], /实际累计调用/);
  });
});
