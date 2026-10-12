# Compatibility matrix (contract inventory)

This is a route/dependency inventory, not runtime proof. The ARIS catalog and upstream skills remain unchanged.

| Skill | Route | Status | Reason |
|---|---|---|---|
| `arxiv` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `alphaxiv` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `deepxiv` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `semantic-scholar` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `openalex` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `exa-search` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `web-debug-search` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `gemini-search` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `research-lit` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `comm-lit-review` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `idea-creator` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `idea-discovery` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `idea-discovery-robot` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `novelty-check` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `research-refine` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `research-refine-pipeline` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `research-wiki` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `wiki-enrich` | Pi Skill plus actual web/database tool adapter | contract-ready; runtime dependency unverified | Uses only tools actually registered in the Pi session; URLs/provider/responseId must be preserved. |
| `research-pipeline` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `research-review` | thin canonical wrapper | contract-ready; not activated | Feynman internal evidence review remains separate from ARIS independent multi-round review. |
| `auto-review-loop` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `auto-review-loop-llm` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `auto-review-loop-minimax` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `kill-argument` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `formula-derivation` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `proof-writer` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `proof-checker` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `proof-orchestrator` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `experiment-plan` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `experiment-bridge` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `research-implement-feature` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `experiment-queue` | skill-loader/native tools | blocked-until-dependency | SSH/queue backend is not activated |
| `run-experiment` | skill-loader/native tools | blocked-until-dependency | compute execution requires explicit local/SSH/cloud approval |
| `monitor-experiment` | skill-loader/native tools | blocked-until-dependency | execution backend is not activated |
| `analyze-results` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `training-check` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `system-profile` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `dse-loop` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `qzcli` | skill-loader/native tools | blocked-until-dependency | qzcli platform is not part of this integration |
| `vast-gpu` | skill-loader/native tools | blocked-until-dependency | Vast.ai access is not part of this integration |
| `serverless-modal` | skill-loader/native tools | blocked-until-dependency | Modal access is not part of this integration |
| `experiment-audit` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `result-to-claim` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `ablation-planner` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-writing` | thin canonical wrapper | contract-ready; not activated | Feynman Markdown draft can precede ARIS plan/LaTeX/PDF/audits; outputs are not equivalent. |
| `paper-plan` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-write` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-compile` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-figure` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `citation-audit` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `paper-claim-audit` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `integrity-forensics` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `auto-paper-improvement-loop` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `writing-systems-papers` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `specification-writing` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `overleaf-sync` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `render-html` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-illustration` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-illustration-image2` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `figure-spec` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `mermaid-diagram` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `pixel-art` | skill-loader/native tools | blocked-until-dependency | image generation is outside this integration |
| `paper-poster` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-poster-html` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-slides` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `paper-talk` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `slides-polish` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `rebuttal` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `resubmit-pipeline` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `grant-proposal` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `patent-pipeline` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `invention-structuring` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `claims-drafting` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `embodiment-description` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `figure-description` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `jurisdiction-format` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `patent-review` | native skill + explicit reviewer route | blocked-or-provisional-without-qualified-backend | Do not substitute internal or same-model text for an independent reviewer. |
| `prior-art-search` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `patent-novelty-check` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `meta-optimize` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `meta-apply` | skill-loader/native tools | blocked-until-dependency | skill-corpus mutation is outside this integration |
| `feishu-notify` | skill-loader/native tools | blocked-until-dependency | notification backend is not part of this integration |
| `interview-cheatsheet` | Pi Skill loader | discoverable; runtime dependency unverified | No duplicate implementation is added here; follow the original ARIS skill contract. |
| `material-research-pipeline` | ARIS skill loader | contract-ready; compute blocked | Literature/planning can be skill-driven; expensive compute remains dry-run/approval gated. |
