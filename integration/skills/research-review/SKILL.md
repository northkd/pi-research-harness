---
name: research-review
description: Keep Feynman internal evidence review separate from ARIS independent multi-round review.
argument-hint: "[artifact-or-scope]"
---

This is a thin integration entry, not a copy of either upstream skill.

1. Read and follow the bundled canonical ARIS workflow at `../../../vendor/skills/aris/research-review/SKILL.md` (relative to this skill directory) for external reviewer routing, model/effort pins, thread/trace records, author replies, and re-review. A separately installed `~/.agents/skills/research-review/SKILL.md` is an explicit local alternative, not a required undeclared dependency.
2. For the internal Feynman pass, read `<PI_CODING_AGENT_DIR>/npm/node_modules/@companion-ai/feynman/prompts/review.md` and preserve `outputs/.plans/<slug>-review-plan.md`, `outputs/.drafts/<slug>-review-evidence.md`, and `outputs/<slug>-review.md`.
3. Internal evidence notes are not external reviewer evidence. If no configured independent MCP or approved external route is actually available, report `blocked` or `provisional`; never turn internal or same-model text into `accepted`.
4. Use the `pi_research_fusion` tool for route diagnostics and review gates. Do not invoke `research-review` from this file or invent `mcp__codex__codex` when Pi has not registered a real reviewer tool.
