const topic = typeof args?.topic === "string" ? args.topic : "the supplied research question";
const draftPath = typeof args?.draftPath === "string" ? args.draftPath : "papers/research-draft.md";
const report = await runs.run("evidence", {
  agent: "researcher", context: "fresh",
  task: `Find source-backed evidence for ${topic}. Use only Pi tools that are actually available. Preserve URLs, responseId, provider and fallback diagnostics; do not claim a paper was read from a summary.`,
});
if (!report || report.ok !== true) return { status: "blocked", failedStep: "evidence", dispatchCount: 1, order: ["evidence"], evidence: report, conversion: "Markdown draft is not a compiled PDF or submission audit." };
const draft = await runs.run("feynman-draft", {
  agent: "worker", context: "fresh", output: draftPath,
  task: `Using this evidence packet, follow the Feynman draft contract at <PI_CODING_AGENT_DIR>/npm/node_modules/@companion-ai/feynman/prompts/draft.md. Write a Markdown draft with a Sources appendix and mark unsupported results tentative. Evidence packet:\n${report.output}`,
});
if (!draft || draft.ok !== true) return { status: "blocked", failedStep: "feynman-draft", dispatchCount: 2, order: ["evidence", "feynman-draft"], evidence: report, draft, conversion: "Markdown draft is not a compiled PDF or submission audit." };
const aris = await runs.run("aris-paper-stage", {
  agent: "worker", context: "fresh",
  task: `Treat the Feynman Markdown draft as input, not as a PDF. Follow the canonical ARIS paper-writing skill at ~/.agents/skills/paper-writing/SKILL.md and produce its plan/LaTeX/PDF/audit stages only when their prerequisites exist. Preserve the conversion boundary and report blocked prerequisites. Draft result:\n${draft.output}`,
});
return { status: aris?.ok === true ? "completed" : "blocked", failedStep: aris?.ok === true ? undefined : "aris-paper-stage", dispatchCount: 3, order: ["evidence", "feynman-draft", "aris-paper-stage"], evidence: report, draft, aris, conversion: "Markdown draft is not a compiled PDF or submission audit." };
