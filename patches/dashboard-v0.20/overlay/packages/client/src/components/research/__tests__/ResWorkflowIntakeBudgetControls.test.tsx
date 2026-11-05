import assert from "node:assert/strict";
import type { ResWorkflowAdoption as Adoption } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ApiContext, setGlobalApiBase } from "../../../lib/api/api-context.js";
import { ResWorkflowIntakeBudgetApiError, updateResWorkflowAgentBudget } from "../../../lib/api/res-workflow-api.js";
import { ResWorkflowIntakeAgent } from "../ResWorkflowIntakeAgent.js";

const CWD = "/isolated/intake-budget";
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
async function click(id: string) { await act(async () => { find(id).click(); }); }
async function input(value: string) {
  await act(async () => {
    const node = find<HTMLInputElement>("res-workflow-intake-budget-limit");
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function draw(next: Adoption = latest) {
  latest = next;
  await act(async () => { root.render(<ApiContext.Provider value={apiBase}><ResWorkflowIntakeAgent cwd={next.cwd} job={next} onRefresh={() => {}} onJob={value => { accepted.push(value); latest = value; }} /></ApiContext.Provider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

beforeEach(async () => {
  // Await the lazy module before asserting synchronous controls in this unit harness.
  await import("../ResWorkflowIntakeBudgetControls.js");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  latest = job(); calls = []; accepted = []; apiBase = ""; setGlobalApiBase("");
  reply = async (body, url) => {
    const next = structuredClone(latest);
    if (url.endsWith("/authorize")) {
      Object.assign(next.agentJob!, { authorized: true, workerActive: true, phase: "reviewing", authorizedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (body.budget) Object.assign(next.agentJob!.budget, { effectiveMaxRequests: body.budget.maxRequests, revision: 1, policy: body.budget.maxRequests === null ? "unlimited" : "total-requests", ...(body.budget.maxRequests === null ? { unlimited: true } : {}) });
    }
    return response(next);
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body }); return reply(body, String(url)); }) as typeof fetch;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setGlobalApiBase(""); globalThis.fetch = originalFetch; });

describe("intake budget editing", () => {
  it("keeps the default authorization contract when the budget is only opened", async () => {
    await draw(); await click("res-workflow-intake-budget-edit");
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1); assert.equal("budget" in calls[0].body, false);
  });

  it("binds fresh initial consent to the chosen cap and submits it with one authorization", async () => {
    await draw(); await click("res-workflow-intake-consent");
    await click("res-workflow-intake-budget-edit"); await input("8");
    assert.equal(find<HTMLInputElement>("res-workflow-intake-consent").checked, false);
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-authorize").disabled, true);
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/agent\/authorize$/);
    assert.equal(calls[0].body.consent.maxRequests, 3);
    assert.equal(calls[0].body.budget.maxRequests, 8);
    assert.deepEqual(calls[0].body.budget.consent, { scope: "this-job", budgetMayIncreaseCharges: true, unknownRetryMayBillAgain: true });
    assert.equal(accepted[0].agentJob!.budget.effectiveMaxRequests, 8);
  });

  it("supports initial unlimited selection and clears an earlier finite-cap consent", async () => {
    await draw(); await click("res-workflow-intake-budget-edit"); await input("7"); await click("res-workflow-intake-consent");
    await click("res-workflow-intake-budget-unlimited");
    assert.equal(find<HTMLInputElement>("res-workflow-intake-consent").checked, false);
    await click("res-workflow-intake-consent"); await click("res-workflow-intake-authorize");
    assert.equal(calls.length, 1); assert.equal(calls[0].body.budget.maxRequests, null);
    assert.equal(accepted[0].agentJob!.budget.effectiveMaxRequests, null);
  });

  it("still resumes unfinished local preparation without authorizing a paid request", async () => {
    const preparing = job(); const agent = preparing.agentJob!;
    agent.phase = "preparing"; agent.resumeRequired = true; delete agent.plan; delete agent.grant;
    await draw(preparing);
    assert.equal(calls.length, 1); assert.match(calls[0].url, /\/agent\/resume$/);
    assert.equal("grantHash" in calls[0].body, false); assert.equal("consent" in calls[0].body, false);
  });

  it("keeps polling drafts, supports finite to unlimited to below-used finite, and never resumes on save", async () => {
    await draw(job(true)); await click("res-workflow-intake-budget-edit"); await input("9");
    const polled = structuredClone(latest); polled.agentJob!.budget.usedRequests = 3; await draw(polled);
    assert.equal(find<HTMLInputElement>("res-workflow-intake-budget-limit").value, "9");
    await click("res-workflow-intake-budget-unlimited");
    reply = async body => {
      const next = structuredClone(latest); const budget = next.agentJob!.budget;
      budget.effectiveMaxRequests = body.maxRequests; budget.revision = (budget.revision ?? 0) + 1; budget.policy = body.maxRequests === null ? "unlimited" : "total-requests";
      if (body.maxRequests === null) budget.unlimited = true; else delete budget.unlimited;
      next.agentJob!.workerActive = false; next.agentJob!.resumeRequired = true; return response(next);
    };
    await click("res-workflow-intake-budget-save-consent"); await click("res-workflow-intake-budget-save");
    assert.equal(calls.length, 1); assert.equal(calls[0].body.maxRequests, null); assert.equal(calls[0].body.expectedRevision, 0);
    assert.equal(accepted.length, 1); await draw(accepted[0]);
    await click("res-workflow-intake-budget-edit"); await click("res-workflow-intake-budget-unlimited"); await input("0");
    await click("res-workflow-intake-budget-save-consent"); await click("res-workflow-intake-budget-save");
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.url.endsWith("/agent/budget")));
    assert.equal(calls[1].body.maxRequests, 0); assert.equal(calls[1].body.expectedRevision, 1);
    assert.equal(accepted[1].agentJob!.budget.usedRequests, 3);
  });

  it("preserves a draft on revision conflict and requires explicit reload and fresh save consent", async () => {
    await draw(job(true)); await click("res-workflow-intake-budget-edit"); await input("7");
    await click("res-workflow-intake-budget-save-consent");
    const next = structuredClone(latest); next.agentJob!.budget.revision = 1; next.agentJob!.budget.effectiveMaxRequests = 5; next.agentJob!.budget.policy = "total-requests";
    await draw(next);
    assert.equal(find<HTMLInputElement>("res-workflow-intake-budget-limit").value, "7");
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-budget-save").disabled, true);
    assert.equal(find<HTMLInputElement>("res-workflow-intake-budget-save-consent").checked, false);
    await click("res-workflow-intake-budget-reload");
    assert.equal(find<HTMLInputElement>("res-workflow-intake-budget-limit").value, "5");
    assert.equal(calls.length, 0);
  });

  it("ignores late replies across directory and server switches", async () => {
    await draw(job(true)); await click("res-workflow-intake-budget-edit"); await input("6");
    let finish!: (value: Response) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    await click("res-workflow-intake-budget-save-consent"); await click("res-workflow-intake-budget-save");
    const old = structuredClone(latest); old.agentJob!.budget.revision = 1; old.agentJob!.budget.effectiveMaxRequests = 6;
    const other = job(true); other.cwd = "/isolated/other"; apiBase = "https://other.invalid"; setGlobalApiBase(apiBase); await draw(other);
    await act(async () => finish(response(old)));
    assert.equal(accepted.length, 0); assert.equal(calls.length, 1);
  });

  it("saves a blocked job without dispatch, then continues only after an explicit click", async () => {
    const blocked = job(true); blocked.agentJob!.phase = "awaiting-user"; blocked.agentJob!.workerActive = false;
    blocked.agentJob!.needsUserAction = { reason: "budget-exhausted" };
    await draw(blocked); await click("res-workflow-intake-budget-edit"); await input("10");
    reply = async (body, url) => {
      const next = structuredClone(latest);
      if (url.endsWith("/budget")) {
        next.agentJob!.budget.revision = 1; next.agentJob!.budget.effectiveMaxRequests = 10; next.agentJob!.budget.policy = "total-requests";
        next.agentJob!.resumeRequired = true;
      } else next.agentJob!.workerActive = true;
      return response(next);
    };
    await click("res-workflow-intake-budget-save-consent"); await click("res-workflow-intake-budget-save"); await draw(accepted[0]);
    assert.equal(calls.length, 1); assert.ok(find("res-workflow-intake-resume"));
    await click("res-workflow-intake-resume");
    assert.equal(calls.length, 2); assert.match(calls[1].url, /\/agent\/resume$/);
    assert.equal(calls[1].body.grantHash, "grant-one"); assert.equal("budget" in calls[1].body, false);
  });

  it("does not roll back newer polled accounting or a completed proposal with a slow save reply", async () => {
    await draw(job(true)); await click("res-workflow-intake-budget-edit"); await input("6");
    let finish!: (value: Response) => void; reply = () => new Promise(resolve => { finish = resolve; });
    await click("res-workflow-intake-budget-save-consent"); await click("res-workflow-intake-budget-save");
    const delayed = structuredClone(latest); delayed.agentJob!.budget.revision = 1; delayed.agentJob!.budget.effectiveMaxRequests = 6; delayed.agentJob!.budget.policy = "total-requests";
    const polled = structuredClone(delayed); polled.agentJob!.budget.usedRequests = 4; polled.agentJob!.completedNodes = 2; polled.agentJob!.phase = "proposal-ready";
    await draw(polled); await act(async () => finish(response(delayed)));
    assert.equal(accepted.length, 0); assert.match(find("res-workflow-intake-budget").textContent!, /used 4/);
  });

  it("keeps server failure text private and never retries uncertain saves", async () => {
    await draw(job(true)); await click("res-workflow-intake-budget-edit"); await input("11");
    reply = async () => new Response(JSON.stringify({ error: "PRIVATE MODEL OUTPUT AND HISTORY" }), { status: 503, headers: { "content-type": "application/json" } });
    await click("res-workflow-intake-budget-save-consent"); await click("res-workflow-intake-budget-save");
    assert.equal(calls.length, 1); assert.equal(host.textContent!.includes("PRIVATE MODEL OUTPUT"), false);
    assert.equal(find<HTMLInputElement>("res-workflow-intake-budget-limit").value, "11");
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-budget-save").disabled, true);
  });

  it("refuses negative caps and preserves expiry without exposing expired editing", async () => {
    await draw(job(true)); await click("res-workflow-intake-budget-edit"); await input("-1");
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-budget-save").disabled, true); assert.equal(calls.length, 0);
    const expired = job(true); expired.agentJob!.expiresAt = new Date(Date.now() - 1000).toISOString(); expired.agentJob!.budget.editable = false;
    await draw(expired);
    assert.equal(find<HTMLButtonElement>("res-workflow-intake-budget-save").matches(":disabled"), true);
    assert.equal(host.querySelector('[data-testid="res-workflow-intake-resume"]'), null);
  });

  it("rejects invalid requests before fetch and sanitizes non-JSON error responses", async () => {
    const body = { cwd: CWD, requestId: "one-request", grantHash: "grant-one", expectedRevision: 0, maxRequests: -1, consent: { scope: "this-job" as const, budgetMayIncreaseCharges: true as const, unknownRetryMayBillAgain: true as const } };
    await assert.rejects(updateResWorkflowAgentBudget("adopt-one", body), ResWorkflowIntakeBudgetApiError); assert.equal(calls.length, 0);
    reply = async () => new Response("PRIVATE PROXY CONTENT", { status: 502, headers: { "content-type": "text/html" } });
    await assert.rejects(updateResWorkflowAgentBudget("adopt-one", { ...body, maxRequests: 4 }), error => {
      assert.ok(error instanceof ResWorkflowIntakeBudgetApiError); assert.equal(error.status, 502); assert.equal(error.message.includes("PRIVATE"), false); return true;
    });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/res-workflow/adoptions/adopt-one/agent/budget");
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["consent", "cwd", "expectedRevision", "grantHash", "maxRequests", "requestId"]);
  });
});
