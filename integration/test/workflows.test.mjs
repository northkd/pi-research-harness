import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const names = ["evidence-to-aris.js", "adversarial-review.js", "derivation-jury.js"];

async function executeWorkflow(name, runs, args = {}) {
  const source = await readFile(path.join(root, "workflows", name), "utf8");
  const factory = new Function("args", "runs", `return (async () => {\n${source}\n})();`);
  return factory(args, runs);
}

test("native workflow scripts use only Pi runs APIs", async () => {
  const sources = await Promise.all(names.map((name) => readFile(path.join(root, "workflows", name), "utf8")));
  const all = sources.join("\n");
  for (const source of sources) assert.doesNotThrow(() => new Function("args", "runs", `return (async () => {\n${source}\n})();`));
  assert.match(all, /runs\.run/);
  assert.match(all, /runs\.all/);
  assert.doesNotMatch(all, /ctx\.subagents\.start|routeFallback|run\.result|dispose\(/);
  assert.doesNotMatch(all, /mcp__codex__codex/);
  assert.match(sources[0], /report\.ok/);
  assert.match(sources[0], /draft\.ok/);
  assert.match(sources[0], /dispatchCount/);
  assert.match(sources[0], /Feynman/);
  assert.match(sources[0], /ARIS/);
  assert.match(sources[1], /provisional/);
  assert.match(sources[2], /runs\.all/);
  assert.match(sources[2], /full derivation text/i);
  assert.match(sources[2], /counterexample\.ok/);
  assert.match(sources[2], /majority vote is not a proof/i);
});

test("evidence workflow stops on failed or cancelled predecessors", async () => {
  const failedCalls = [];
  const failed = await executeWorkflow("evidence-to-aris.js", { run: async (key) => { failedCalls.push(key); return { ok: false, state: "cancelled" }; }, all: async () => [] });
  assert.deepEqual(failedCalls, ["evidence"]);
  assert.equal(failed.status, "blocked");
  assert.equal(failed.dispatchCount, 1);
  const draftCalls = [];
  const draftFailed = await executeWorkflow("evidence-to-aris.js", { run: async (key) => { draftCalls.push(key); return key === "evidence" ? { ok: true, output: "evidence" } : { ok: false, state: "failed" }; }, all: async () => [] });
  assert.deepEqual(draftCalls, ["evidence", "feynman-draft"]);
  assert.equal(draftFailed.failedStep, "feynman-draft");
  const successCalls = [];
  const complete = await executeWorkflow("evidence-to-aris.js", { run: async (key) => { successCalls.push(key); return { ok: true, output: key }; }, all: async () => [] });
  assert.deepEqual(successCalls, ["evidence", "feynman-draft", "aris-paper-stage"]);
  assert.equal(complete.status, "completed");
  assert.equal(complete.dispatchCount, 3);
});

test("derivation workflow passes real outputs and blocks missing bodies", async () => {
  const calls = [];
  const complete = await executeWorkflow("derivation-jury.js", { all: async () => [{ ok: true, output: "DERIVATION A" }, { ok: true, output: "DERIVATION B" }], run: async (key, spec) => { calls.push({ key, task: spec.task }); return { ok: true, output: key }; } });
  assert.equal(complete.status, "provisional");
  assert.equal(calls.length, 2);
  assert.match(calls[0].task, /DERIVATION A/);
  assert.match(calls[0].task, /DERIVATION B/);
  const missing = await executeWorkflow("derivation-jury.js", { all: async () => [{ ok: true, output: "" }, { ok: true, output: "DERIVATION B" }], run: async () => { throw new Error("must not dispatch"); } });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.failedStep, "fresh-derivations");
  const failedCalls = [];
  const failed = await executeWorkflow("derivation-jury.js", { all: async () => [{ ok: false, state: "failed" }, { ok: true, output: "DERIVATION B" }], run: async (key) => { failedCalls.push(key); return { ok: true }; } });
  assert.equal(failed.status, "blocked");
  assert.equal(failedCalls.length, 0);
  const cancelledCalls = [];
  const cancelled = await executeWorkflow("derivation-jury.js", { all: async () => [{ ok: true, output: "DERIVATION A" }, { ok: false, state: "cancelled" }], run: async (key) => { cancelledCalls.push(key); return { ok: true }; } });
  assert.equal(cancelled.status, "blocked");
  assert.equal(cancelledCalls.length, 0);
});
