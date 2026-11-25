import test from "node:test";
import assert from "node:assert/strict";
import register, { executeResearchAction } from "../index.mjs";

test("Pi extension entry registers one thin tool without external startup", async () => {
  const tools = [];
  register({ registerTool(tool) { tools.push(tool); } });
  assert.deepEqual(tools.map((tool) => tool.name), ["pi_research_fusion"]);
  const result = await tools[0].execute("call-1", { action: "route", backend: "mcp", alias: "codex" }, undefined, undefined, { tools: [{ name: "research-browser.search" }] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /reviewer-backend-unavailable/);
});

test("entry route diagnostics use executor-owned tool shape", async () => {
  const result = await executeResearchAction({ action: "route", backend: "native", role: "author", model: "cliproxy/gpt-6-astra" }, { tools: [] });
  assert.equal(result.status, "ready");
  assert.equal(result.request.model, "cliproxy/gpt-6-astra");
});
