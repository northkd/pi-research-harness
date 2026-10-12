const artifact = typeof args?.artifact === "string" ? args.artifact : "the supplied research artifact";
const internal = await runs.run("internal", {
  agent: "reviewer", context: "fresh",
  task: `Run the Feynman internal evidence review for ${artifact}. Read <PI_CODING_AGENT_DIR>/npm/node_modules/@companion-ai/feynman/prompts/review.md. Keep its plan, evidence and final review artifacts separate from any external review.`,
});
if (!internal?.ok || typeof internal.output !== "string" || !internal.output.trim()) return { status: "blocked", failedStep: "internal", internal };
const external = await runs.run("external", {
  agent: "codex-exec", context: "fresh",
  task: `Advisory external challenge of ${artifact}. This code-owned external-cli profile cannot receive a native model/effort override or resume thread. Report the actual terminal/model identity if observed, preserve failure diagnostics, and never emit an accepted verdict without the independent reviewer contract. Internal review:\n${internal.output}`,
});
if (!external?.ok || typeof external.output !== "string" || !external.output.trim()) return { status: "blocked", failedStep: "external", internal, external };
const author = await runs.run("author-response", {
  agent: "worker", context: "fresh",
  task: `Prepare an evidence-linked author response to the internal and external observations. Do not erase blocked or provisional findings. Internal:\n${internal.output}\nExternal:\n${external.output}`,
});
if (!author?.ok || typeof author.output !== "string" || !author.output.trim()) return { status: "blocked", failedStep: "author-response", internal, external, author };
const rereview = await runs.run("external-rereview", {
  agent: "codex-exec", context: "fresh",
  task: `Fresh advisory re-review of ${artifact} after the author response. The external-cli route has no guaranteed thread resume or ARIS ultra pin; report provisional/blocked when those are absent. Check every original finding against the author's response; an omitted finding remains unresolved. Internal review:\n${internal.output}\nOriginal external review:\n${external.output}\nAuthor response:\n${author.output}`,
});
if (!rereview?.ok || typeof rereview.output !== "string" || !rereview.output.trim()) return { status: "blocked", failedStep: "external-rereview", internal, external, author, rereview };
return { status: "provisional", internal, external, author, rereview, acceptance: "not-certified-by-external-cli" };
