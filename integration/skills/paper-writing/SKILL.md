---
name: paper-writing
description: Compose Feynman evidence/draft work with the ARIS paper-writing pipeline without treating Markdown as a PDF.
argument-hint: "[topic-or-report]"
---

This is a thin integration entry, not a copy of either upstream skill.

1. Read and follow the canonical ARIS workflow at `~/.agents/skills/paper-writing/SKILL.md` for the rigorous report-to-plan/LaTeX/PDF/audit stage.
2. If the user explicitly requests a Markdown draft first, read the Feynman prompt at `<PI_CODING_AGENT_DIR>/npm/node_modules/@companion-ai/feynman/prompts/draft.md` and preserve its outputs: `outputs/.plans/<slug>.md`, `papers/<slug>.md`, and the `Sources` appendix.
3. Treat the Feynman draft as input evidence only. ARIS outputs remain `PAPER_PLAN.md`, `paper/*.tex`, `paper/main.pdf`, and applicable audit JSON; do not claim that the Markdown draft is a compiled submission.
4. Use the `pi_research_fusion` tool only for explicit artifact mapping or source-tool observations. Do not invoke `paper-writing` from this file, and do not silently replace an unavailable reviewer backend.
