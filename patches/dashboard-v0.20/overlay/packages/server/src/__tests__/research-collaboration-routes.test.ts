import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerResWorkflowResearchSessionRoutes } from "../routes/res-workflow-research-session-routes.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-api-")); roots.push(root);
  const cwd = path.join(root, "project"), runtime = path.join(root, "research-loop");
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(runtime, "src"), { recursive: true });
  const charterHash = "sha256:" + "a".repeat(64), adoptionId = "adopt-" + "b".repeat(24);
  fs.writeFileSync(path.join(runtime, "src", "workbench-context.mjs"), `export function inspectWorkbenchRecordContext(context) { return {status:'ready', ownerKey:'["host","inert-operator"]', context:{sessionId:context.sessionManager.getSessionId(), charterHash:${JSON.stringify(charterHash)}, adoptionId:${JSON.stringify(adoptionId)}}}; }`);
  const rows: any[] = ["main-a", "main-b", "ordinary"].map(id => {
    const sessionFile = path.join(root, `${id}.jsonl`); fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id, cwd }) + "\n");
    return { id, cwd, sessionFile, status: "idle", name: id, ...(id === "ordinary" ? {} : { resWorkflow: { canonicalCwd: cwd, joinedAt: new Date().toISOString(), via: "manual" } }) };
  });
  let accessAllowed = true, writable = true, sent = true;
  const detached: string[] = [], prompts: string[] = [];
  const app = Fastify();
  registerResWorkflowResearchSessionRoutes(app, {
    networkGuard: async () => {},
    privateDir: path.join(root, "private"), researchLoopRoot: runtime,
    sessionManager: { get: (id: string) => rows.find(row => row.id === id), listAll: () => rows } as never,
    history: () => rows,
    accessFor: async (requested, identity) => {
      if (requested !== cwd || !accessAllowed) { const error = new Error("workspace-not-found") as any; error.statusCode = 404; throw error; }
      return { cwd, ownerKey: '["host","inert-operator"]', write: writable && identity.write, revalidate: async () => {}, canReadHistory: async row => row.cwd === cwd && !row.originDeviceId };
    },
    connection: async () => ({ adopted: true }),
    joinParticipant: async (_access, id) => { rows.find(row => row.id === id).resWorkflow = { canonicalCwd: cwd, joinedAt: new Date().toISOString(), via: "manual" }; },
    detachParticipant: async (_access, id) => { detached.push(id); delete rows.find(row => row.id === id).resWorkflow; },
    prepareSpawn: async () => ({}) as never,
    pendingPluginRefRegistry: { file: () => true, remove: () => {} },
    pendingPrincipalOwnerRegistry: { file: () => true, remove: () => {} },
    initialPrompts: { enqueue: () => true }, spawn: async () => ({ success: true }) as never,
    isResolverActive: () => false,
    notifyParent: async (_id, _text, promptId) => { prompts.push(promptId); return sent; },
  });
  await app.ready();
  const get = () => app.inject({ method: "GET", url: `/api/res-workflow/collaboration?cwd=${encodeURIComponent(cwd)}` });
  const post = (body: any) => app.inject({ method: "POST", url: "/api/res-workflow/collaboration", payload: { cwd, ...body } });
  const native = (body: any) => app.inject({ method: "POST", url: "/api/res-workflow/collaboration/native", payload: body });
  return { app, cwd, rows, get, post, native, detached, prompts, readOnly: () => { writable = false; }, refuseSend: () => { sent = false; } };
}

describe("server-authoritative collaboration routes", () => {
  it("starts unselected, persists one explicit main and enforces revision and host concurrency bounds", async () => {
    const f = await setup();
    try {
      const initial = (await f.get()).json(); expect(initial.currentMainSessionId).toBeNull();
      const selected = await f.post({ action: "select-main", sessionId: "main-a", expectedRevision: initial.revision });
      expect(selected.statusCode).toBe(200); const state = selected.json(); expect(state.currentMainSessionId).toBe("main-a");
      const changed = await f.post({ action: "limits", expectedRevision: state.revision, maxMultiAgents: 6, maxSubagents: 5 });
      expect(changed.statusCode).toBe(200); expect(changed.json().limits).toEqual({ maxMultiAgents: 6, maxSubagents: 5 });
      expect((await f.post({ action: "limits", expectedRevision: state.revision, maxMultiAgents: 2, maxSubagents: 2 })).statusCode).toBe(409);
      expect((await f.post({ action: "limits", expectedRevision: changed.json().revision, maxMultiAgents: 9, maxSubagents: 3 })).statusCode).toBe(400);
      expect((await f.get()).json().currentTenureId).toBe(state.currentTenureId);
    } finally { await f.app.close(); }
  });

  it("rejects read-only mutation, unknown body/query fields and invented sessions", async () => {
    const f = await setup();
    try {
      expect((await f.app.inject({ method: "GET", url: `/api/res-workflow/collaboration?cwd=${encodeURIComponent(f.cwd)}&owner=other` })).statusCode).toBe(400);
      expect((await f.post({ action: "limits", expectedRevision: 0, maxMultiAgents: 4, maxSubagents: 3, ownerKey: "forged" })).statusCode).toBe(400);
      expect((await f.post({ action: "select-main", expectedRevision: 0, sessionId: "invented" })).statusCode).toBe(404);
      f.readOnly(); expect((await f.post({ action: "select-main", expectedRevision: 0, sessionId: "main-a" })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });

  it("targets main-task submission on the server and never reports delivery success for an unsent prompt", async () => {
    const f = await setup();
    try {
      const selected = (await f.post({ action: "select-main", sessionId: "main-a", expectedRevision: 0 })).json();
      const command = { action: "send-main-task", sessionId: "main-a", requestId: "same-command", text: "Check the evidence", expectedRevision: selected.revision };
      const first = await f.post(command); expect(first.statusCode).toBe(200); expect(first.json().promptReceipt.transmitted).toBe(true);
      expect((await f.post(command)).json().promptReceipt.promptId).toBe(first.json().promptReceipt.promptId); expect(f.prompts.length).toBe(1);
      f.refuseSend(); const refused = await f.post({ ...command, requestId: "other-command" }); expect(refused.statusCode).toBe(409); expect(refused.json().success).toBe(false);
    } finally { await f.app.close(); }
  });

  it("native leases are session-derived; ordinary sessions are unmanaged but removed participants cannot bypass policy", async () => {
    const f = await setup();
    try {
      const request = { sessionId: "ordinary", action: "subagent-acquire", requestId: "native-first", attemptId: "native-attempt", role: "review" };
      expect((await f.native(request)).json().status).toBe("unmanaged");
      expect((await f.native({ ...request, cwd: "/forged" })).statusCode).toBe(400);
      const selected = (await f.post({ action: "select-main", sessionId: "main-a", expectedRevision: 0 })).json();
      const lease = await f.native({ ...request, sessionId: "main-a" }); expect(lease.statusCode).toBe(200); expect(lease.json().status).toBe("acquired");
      const before = (await f.get()).json();
      const removed = await f.post({ action: "detach", sessionId: "main-a", tenureId: selected.currentTenureId, expectedRevision: before.revision });
      expect(removed.statusCode).toBe(200); expect(f.detached).toEqual(["main-a"]);
      expect((await f.native({ ...request, sessionId: "main-a", requestId: "native-second" })).statusCode).toBe(409);
      expect((await f.native({ ...request, sessionId: "main-a", action: "subagent-release", leaseToken: lease.json().leaseToken })).json().status).toBe("released");
    } finally { await f.app.close(); }
  });
});
