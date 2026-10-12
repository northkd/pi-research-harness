import path from "node:path";

export function slugify(value) { return String(value ?? "research").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, 5).join("-") || "research"; }

export function artifactPaths(root, topic) {
  const base = path.resolve(root || "."); const slug = slugify(topic);
  return { root: base, slug, feynman: { plan: path.join(base, "outputs", ".plans", `${slug}.md`), draft: path.join(base, "papers", `${slug}.md`), reviewPlan: path.join(base, "outputs", ".plans", `${slug}-review-plan.md`), reviewEvidence: path.join(base, "outputs", ".drafts", `${slug}-review-evidence.md`), review: path.join(base, "outputs", `${slug}-review.md`) }, aris: { plan: path.join(base, "PAPER_PLAN.md"), tex: path.join(base, "paper", "*.tex"), pdf: path.join(base, "paper", "main.pdf"), audits: path.join(base, "paper", ".aris", "*.json") }, conversion: { from: "feynman-markdown-draft", to: "aris-submission-paper", equivalent: false, note: "Markdown draft is input evidence, not a compiled PDF or submission audit." } };
}
export function buildManifest(root, topic, stages = []) { const paths = artifactPaths(root, topic); return { schema: "pi-research-fusion.manifest.v1", slug: paths.slug, root: paths.root, stages: stages.map((stage) => ({ name: stage.name, status: stage.status ?? "planned", input: stage.input, output: stage.output, backend: stage.backend, model: stage.model, runId: stage.runId, threadId: stage.threadId, artifacts: stage.artifacts ?? [], diagnostics: stage.diagnostics ?? [] })), paths, conversion: paths.conversion }; }
