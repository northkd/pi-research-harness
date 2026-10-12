import test from "node:test";
import assert from "node:assert/strict";
import { ARIS_REVIEW_PIN, normalizeModelPin, resolveRoute, independentModelCheck, EXTERNAL_PROFILES } from "../src/routes.mjs";

test("keeps ARIS reviewer pin without claiming registry support", () => {
  assert.deepEqual(ARIS_REVIEW_PIN, { model: "gpt-6-astra", effort: "ultra", identity: "unverified" });
  assert.equal(normalizeModelPin("cliproxy/gpt-6-astra").pin.requested, "cliproxy/gpt-6-astra");
});

test("accepts only explicit per-run model data", () => {
  const route = resolveRoute({ backend: "native", role: "author", model: "provider/model:label" });
  assert.equal(route.status, "ready");
  assert.equal(route.requestedModel.requested, "provider/model:label");
  assert.equal(route.requestedModel.observed, undefined);
  assert.equal(route.modelSource, "explicit-per-run");
});

test("does not infer independence from request labels", () => {
  assert.equal(independentModelCheck({}).status, "unknown");
  assert.equal(independentModelCheck({
    reviewerObservation: { modelId: "same", family: "f1" },
    authorObservation: { modelId: "same", family: "f2" },
  }).status, "blocked");
  assert.equal(independentModelCheck({
    reviewerObservation: { modelId: "a", family: "f1" },
    authorObservation: { modelId: "b", family: "f1" },
  }).status, "blocked");
  assert.equal(independentModelCheck({
    reviewerObservation: { modelId: "a", family: "f1" },
    authorObservation: { modelId: "b", family: "f2" },
  }).status, "independent");
});

test("separates dispatch preflight from native jury acceptance and SSH", () => {
  assert.equal(resolveRoute({ backend: "mcp", model: "gpt-6-astra" }).status, "blocked");
  const jury = resolveRoute({ backend: "native", role: "jury" });
  assert.equal(jury.status, "ready");
  assert.equal(jury.acceptance, "blocked-until-observation");
  assert.equal(resolveRoute({ backend: "ssh" }).code, "ssh-route-not-activated");
});

test("blocks unsupported native ultra without silent downgrade", () => {
  const route = resolveRoute({ backend: "native", role: "author", model: { model: "provider/model", effort: "ultra" } });
  assert.equal(route.code, "native-effort-unsupported");
});

test("external route is profile-only and provisional", () => {
  const route = resolveRoute({ backend: "external-cli", profile: "codex-exec" });
  assert.equal(route.status, "provisional");
  assert.deepEqual(route.profile, EXTERNAL_PROFILES["codex-exec"]);
  assert.equal(resolveRoute({ backend: "external-cli", profile: "codex-exec", model: "x/y" }).code, "external-model-override-unsupported");
});

test("MCP route uses executor-owned mapping and blocks unavailable Codex", () => {
  const route = resolveRoute({ backend: "mcp", alias: "codex" }, { registeredTools: ["research-browser.search"], mcpReviewTools: {} });
  assert.equal(route.status, "blocked");
  assert.equal(route.code, "reviewer-backend-unavailable");
});

test("MCP route preserves the original ARIS pin only with observed support", () => {
  const executor = { registeredTools: ["mcp.review.real"], mcpReviewTools: { codex: "mcp.review.real" }, reviewerObservation: { modelId: "gpt-6-astra", family: "review-family", effort: "ultra" }, authorObservation: { modelId: "author", family: "author-family" } };
  const supported = resolveRoute({ backend: "mcp", role: "externalReviewer", alias: "codex" }, executor);
  assert.equal(supported.status, "ready");
  assert.equal(supported.requiredPin.model, ARIS_REVIEW_PIN.model);
  assert.equal(supported.observedPin.status, "eligible");
  const wrongModel = resolveRoute({ backend: "mcp", role: "externalReviewer", alias: "codex" }, { ...executor, reviewerObservation: { ...executor.reviewerObservation, modelId: "wrong" } });
  assert.equal(wrongModel.observedPin.status, "blocked");
  const unsupportedEffort = resolveRoute({ backend: "mcp", role: "externalReviewer", alias: "codex" }, { ...executor, reviewerObservation: { ...executor.reviewerObservation, effort: "max" } });
  assert.equal(unsupportedEffort.observedPin.status, "blocked");
});
