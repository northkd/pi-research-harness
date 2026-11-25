# Mainline supervision: configure once, review research stages

The bundled `extensions/mainline-supervision/` adds project-persistent evidence collection and proportional background direction review. It is registered by the root Pi package, dormant until explicit project consent, and has no hardcoded author provider/model. This release includes policy v2 and stage cadence v1.

See the [module guide](../extensions/mainline-supervision/README.md) for exact setup, actions, evidence boundaries and test commands.

## Activate safely

1. Configure/authenticate your own provider/model in your isolated agent directory. Do not copy the author's account or export credentials.
2. Set `PI_RESEARCH_SUPERVISOR_MODEL='your-provider/your-model:high'` before launching `pi-research`. The extension pins the exact nonempty setting; missing/mismatched values refuse configuration rather than select a fallback.
3. Ensure `research-mainline-supervisor` from the released `agents/` exists in that agent directory. Fresh configuration copies roles automatically. Existing installations should review/copy new roles without replacing personal configuration, history or research state.
4. In each intended project, inspect `mainline_supervision({action:"status"})` first. If already configured, preserve its core/scope and history; do not reset it to activate a new release.
5. For a new project, register the user-confirmed research target/constraints and minimal approved evidence paths using `configure`. The direct human UI states the exact model/scope; no review is authorized until consent. Do not include full transcripts, credentials or unrelated research.
6. For already-running sessions, let foreground work finish and run `/reload` in that session, then `/mainline-supervision status`. A new session loads the updated package automatically. No service restart is required for the extension; reload does not authorize a new scope. Do not issue `check` merely to verify installation.

## What is a meaningful checkpoint?

The main agent owns research semantics; there is no hidden extra classifier model. Ask whether an action changes **what is researched next, under which key assumptions, or what the collected evidence supports**, rather than simply executing/packaging a decided plan.

| Real research decision | Kind |
|---|---|
| New method/route or key assumption | `plan_change` |
| Substantive object/evaluation/authorized research scope change | `scope_change` |
| Complete-stage evidence assessment: continue, pivot, reject, or advance | `stage_complete` |
| Specific evidence of goal substitution/unrelated work | `drift_signal` |

Use a stable conceptual `stageId`, e.g. `cpu-method-A`, not a timestamp, tool call or turn ID. Same core + stage + kind is reviewed at most once; distinct pending decisions merge. A method decision and later full-stage acceptance can each be legitimate. A test failure alone is not a checkpoint; a method decision caused by that failure can be.

Ordinary bugfixes/refactors, test returns, same-plan parameters, progress reports, whitelist evidence capture, archiving and final notifications accumulate evidence **without** new model calls. Source capture/checkpoint declarations are not execution proof. The extension structurally deduplicates IDs but cannot recognize every semantic attempt to relabel cleanup.

`agent_settled` is only a safe dispatch boundary. Automatic review requires new material **and** an unattempted checkpoint. Errors do not automatically replay the same attempt; old state reload does not dispatch an accumulated backlog. Tool `check` consumes exact current runs/registered nodes. A human `/mainline-supervision check` can explicitly request one new-material review.

## Human decisions and limitations

Direction ON_TRACK does not mean scientific support, successful experiments or publication permission. Risks, missing context, failed models, network errors and historical gaps remain visible but do not freeze the project. Only grounded OFF_TRACK evidence can restrict exact authorized file branches; other authorized low-risk work can continue.

A human can release current exact restrictions using `decision` with `restrictionIds` and `effect:"release_branch"` through direct UI confirmation. It records scoped permission, not reviewer agreement or scientific acceptance; old results and gaps remain. New egress, large compute, raw-data replacement and irreversible actions still need separate authorization. **Persistent workflow-wide human adjudication overriding future repeated restrictions is not implemented.**

Tool permissions are not an OS sandbox; arbitrary scripts/unknown tools are not fully analyzed. Memory checks are snapshots, not global reservations. Native single-child timeout behavior remains. A foreground session can be idle while a real background review is separately active; this is not an infinite running model or a timer-driven paid loop.

## Validation scope

Use `npm test` for offline synthetic checks. `npm run test:supervision:host` loads the actual installed public RPC adapter with a mock executor; `npm run test:supervision:sdk` loads the actual SDK with explicit synthetic fixtures/consent and no real model. Runtime dependencies must already be installed; missing ones fail visibly rather than auto-download or silently skip. None of these commands establishes scientific support or a live provider/model review.
