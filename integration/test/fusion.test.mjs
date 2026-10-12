import test from "node:test";
import assert from "node:assert/strict";
import { derivationGate, fetchEvidence, reviewGate, searchEvidence } from "../src/fusion.mjs";
import { artifactPaths, buildManifest } from "../src/artifacts.mjs";

function fakeTools() {
  const calls = [];
  return {
    calls,
    async executeTool(name, request) {
      calls.push({ name, request });
      if (name === "web_search") return { content: [{ type: "text", text: "source summary" }], details: { testOnly: true, responseId: "search-1", urls: ["https://example.test/paper"], queryProviders: [{ query: request.queries[0], providers: ["fake-provider"] }], fallbackDiagnostics: [] } };
      if (name === "fetch_content") return { content: [{ type: "text", text: "full page" }], details: { testOnly: true, responseId: "fetch-1", urls: request.urls, provider: "fake-fetch" } };
      if (name === "feynman_science_database_search") return { content: [{ type: "text", text: "database record" }], details: { testOnly: true, source: request.source, query: request.query, results: [{ url: "https://example.test/record" }] } };
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

test("chain 1 preserves source observations and Markdown-to-ARIS boundary", async () => {
  const ctx = fakeTools();
  const search = await searchEvidence(ctx, { queries: ["thin adapters"], numResults: 2 }, undefined);
  const fetch = await fetchEvidence(ctx, { urls: search.urls }, undefined);
  const paths = artifactPaths("/tmp/research", "Thin adapters evidence");
  const manifest = buildManifest(paths.root, paths.slug, [
    { name: "feynman-evidence", status: search.status, output: search.responseId, artifacts: [search.details] },
    { name: "feynman-draft", status: "completed", output: paths.feynman.draft },
    { name: "aris-paper-stage", status: "planned", input: paths.feynman.draft, output: paths.aris.plan },
  ]);
  assert.equal(ctx.calls[0].name, "web_search");
  assert.equal(search.responseId, "search-1");
  assert.equal(search.details.testOnly, true);
  assert.equal(search.observed, undefined);
  assert.deepEqual(search.urls, ["https://example.test/paper"]);
  assert.equal(fetch.responseId, "fetch-1");
  assert.equal(fetch.actualProvider, "fake-fetch");
  assert.equal(manifest.conversion.equivalent, false);
  assert.equal(manifest.stages[2].input, paths.feynman.draft);
});

test("chain 2 blocks absent reviewer and marks fake independent evidence provisional", () => {
  const blocked = reviewGate({ backend: "mcp", alias: "codex", responses: [] });
  assert.equal(blocked.verdict, "blocked");
  const executor = {
    registeredTools: ["mcp.review.real"],
    mcpReviewTools: { codex: "mcp.review.real" },
    reviewerObservation: { modelId: "gpt-6-astra", family: "family-review", effort: "ultra" },
    authorObservation: { modelId: "author-model", family: "family-author" },
  };
  const accepted = reviewGate({ testOnly: true, backend: "mcp", alias: "codex", executor, requiredRounds: 2, responses: [
    { status: "completed", ok: true, state: "completed", threadId: "thread-1", responseId: "review-1", verdict: "accepted", text: "review one" },
    { status: "completed", ok: true, state: "completed", threadId: "thread-1", responseId: "review-2", verdict: "accepted", text: "review two" },
  ] });
  assert.equal(accepted.verdict, "provisional");
  assert.equal(accepted.acceptanceCandidate, true);
  assert.equal(accepted.testOnly, true);
  const sameFamily = reviewGate({ backend: "mcp", alias: "codex", executor: { ...executor, authorObservation: { modelId: "other", family: "family-review" } }, responses: [{ status: "completed", threadId: "t", verdict: "accepted" }] });
  assert.equal(sameFamily.verdict, "blocked");
});

test("review gate rejects incomplete or self-asserted reviewer results", () => {
  const executor = { registeredTools: ["mcp.review.real"], mcpReviewTools: { codex: "mcp.review.real" }, reviewerObservation: { modelId: "gpt-6-astra", family: "review-family", effort: "ultra" }, authorObservation: { modelId: "author", family: "author-family" } };
  const result = reviewGate({ testOnly: true, backend: "mcp", alias: "codex", executor, responses: [{ threadId: "thread", verdict: "accepted", text: "reviewer says accepted", isError: true, ok: false, state: "pending" }] });
  assert.equal(result.verdict, "blocked");
  assert.ok(result.diagnostics.some((item) => /status completed/.test(item)));
  assert.ok(result.diagnostics.some((item) => /isError|ok is false|state is pending/.test(item)));
  const manual = reviewGate({ backend: "manual", alias: "manual", executor: { ...executor, mcpReviewTools: { manual: "mcp.manual.real" }, registeredTools: ["mcp.manual.real"], reviewerObservation: { modelId: "actual-model", family: "review-family", effort: "high" } }, responses: [{ status: "completed", ok: true, state: "completed", threadId: "thread", text: "Reviewer-Model: claimed-model", content: "review" }] });
  assert.equal(manual.verdict, "blocked");
  const forged = reviewGate({ backend: "mcp", alias: "codex", executor: { registeredTools: ["mcp.review.real"], mcpReviewTools: { codex: "mcp.review.real" }, authorObservation: executor.authorObservation }, responses: [{ status: "completed", ok: true, state: "completed", threadId: "thread", verdict: "accepted", text: "complete", observed: { modelId: "gpt-6-astra", family: "review-family", effort: "ultra", source: "executor-result" } }] });
  assert.equal(forged.verdict, "blocked");
});

test("chain 3 preserves fresh derivations, counterexample and unresolved obligations", () => {
  const executor = { reviewerObservation: { modelId: "jury", family: "jury-family" }, authorObservation: { modelId: "author", family: "author-family" } };
  const provisional = derivationGate({ testOnly: true, executor, derivations: [{ context: "fresh", body: "A" }, { context: "fresh", body: "B" }], counterexample: { status: "completed", output: "no counterexample found" }, unresolvedObligations: [] });
  assert.equal(provisional.verdict, "provisional");
  assert.equal(provisional.testOnly, true);
  assert.equal(provisional.majorityIsNotProof, true);
  const blocked = derivationGate({ executor, derivations: [{ context: "fresh" }, { context: "fresh" }], counterexample: { status: "completed" }, unresolvedObligations: ["prove boundedness"] });
  assert.equal(blocked.verdict, "blocked");
  assert.match(blocked.diagnostics.join(" "), /unresolved proof obligations/);
});

test("Feynman database adapter uses its exact schema", async () => {
  const ctx = fakeTools();
  await searchEvidence(ctx, { source: "feynman", databaseSource: "openalex", query: "topic", limit: 3, sort: "relevance" });
  assert.deepEqual(ctx.calls[0], { name: "feynman_science_database_search", request: { source: "openalex", query: "topic", limit: 3, sort: "relevance" } });
});
