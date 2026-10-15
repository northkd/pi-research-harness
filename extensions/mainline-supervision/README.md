# Stage-checkpoint mainline supervision

This is the portable source export of the locally deployed proportional/stage-cadence extension. It records authorized project evidence and runs one read-only, fresh, async direction review at a meaningful research checkpoint, not on every test completion or cleanup turn.

- `policyVersion: 2`: direction (`verdict`) and scientific support (`science`) are independent; risk, missing context, infrastructure failure and historical gaps do not globally halt development.
- `reviewCadence.version: 1`, `mode: stage-checkpoints`: evidence accumulates within a stage. New material **and** an unattempted conceptual checkpoint are required for automatic dispatch. Same-core/stage/kind is deduplicated across sessions; pending nodes merge.
- Only OFF_TRACK restrictions grounded in exact authorized paths and material runtime events pause those file branches. Human `decision` can release exact restrictions without erasing the result/history or authorizing publication.
- `ask_user` stays available even when evidence state is damaged. Existing task permissions, data safety, model/egress authorization, resource limits and irreversible operations remain independent.
- The parent identifies genuine plan/method, scope, stage acceptance or concrete drift nodes; this is **not** an automatic semantic classifier or OS sandbox. Routine edits/tests/notes/capture/final notifications must not be relabeled using new timestamp/turn IDs.

## Configure locally

The root package explicitly registers `src/index.ts`; no second user extension entry is required. New isolated configurations receive `research-mainline-supervisor` through `scripts/configure.mjs`. Existing installations should review/copy that role to their own agent directory without overwriting personal model choices or project state, then reload only their own idle Pi sessions.

Set an exact authenticated model **before starting Pi**, for example:

```bash
export PI_RESEARCH_SUPERVISOR_MODEL='your-provider/your-model:high'
pi-research
```

No author's account/provider/model is embedded. The env value is fixed for that process; a recorded state must match it. Do not change the env to rebind an existing project silently; review core/scope and re-consent explicitly. Missing/invalid model configuration refuses project setup and does not spawn a fallback model.

In the research project, the main agent first reads `mainline_supervision({action:"status"})`. If unconfigured, register the user's actual agreed core/minimal evidence scope with `configure` and `authorized:true`; a direct UI prompt names the model and exact evidence scope. Only that consent permits future background packet reviews. Package installation does not authorize private transcripts, raw research data, full source trees or credentials.

```json
{"action":"configure","coreText":"The user's confirmed research target, success criteria and constraints.","approvedPaths":["notes/plan.md","src/method.py"],"authorized":true}
```

Only real research nodes merit a checkpoint:

```json
{"action":"checkpoint","stageId":"cpu-method-A","kind":"stage_complete"}
```

Other kinds: `plan_change`, `scope_change`, `drift_signal`. A successful subprocess or final reply is not automatically a full-stage acceptance. Stage acceptance can conclude failure or pivot; direction review is not scientific certification.

`mainline_supervision({action:"check"})` only reconciles the exact existing run or dispatches an already registered checkpoint. A human `/mainline-supervision check` may explicitly request one review of new material; it does not replay old failed attempts. Other commands are `status`, `pause`, `resume` and bounded JSON `checkpoint`, `capture`, `allow_operation`, `decision`.

## Safety and evidence boundaries

- Runtime evidence is project-local under `.pi/mainline-supervision/` (0700/0600) and is never committed here. Approved file snapshots, hash-bound segmented event journals, incremental windows and consented capture fragments distinguish runtime sources from declarations.
- Fixed capture accepts exact approved local Git files, optional fixed host implementation and exact known review run artifacts. Git helpers/transports/lazy fetching/filters are denied; full UTF-8 fragments are bounded/hash-bound. Declined UI consent does not publish outputs or widen scope.
- Missing source/journal integrity prevents the affected review, not all safe work. Historical omissions stay UNVERIFIED; a new current ON_TRACK does not repair missing history or retroactively grant permission.
- Bounded visible Python/Node checks (<=120 s, exact safe local file arguments, no opaque inline/preload/compound/network/destructive invocation) retain existing task permissions. `allow_operation` binds directly confirmed exact input/file versions/core for scoped repair checks; it is not arbitrary script analysis or a sandbox.
- Human `decision` releases/holds exact current-core restriction IDs, appends a receipt and keeps old results. It is not scientific acceptance, publication permission or a durable workflow-wide override against future new findings. That latter capability is **not implemented**.
- New model calls require >=2 GiB MemAvailable. This is a snapshot, not a cross-session resource reservation. Native pi-subagents single-child default timeout still applies; no infinite model process or paid polling timer is added.
- Foreground state and background review activity are independent. One native completion wake is possible; cleanup does not cascade a new review.

## Reproduce tests

Dependency-free local synthetic checks (no model/auth/runtime install):

```bash
npm run test:supervision
```

After installing the pinned Pi host and pi-subagents, run the actual public RPC / adapter and SDK no-model gates:

```bash
npm run test:supervision:host
npm run test:supervision:sdk
```

Default paths follow this repository's `.runtime/pi` and the isolated agent's `npm/` directory. `PI_RESEARCH_HOST_ROOT`, `PI_RESEARCH_SUBAGENTS_ROOT` and optionally `PI_RESEARCH_JITI_ROOT` explicitly select an existing install. Missing dependencies fail rather than silently skip or install. These checks set only `fixture/reviewer:max`, use mocks/seeded verdicts, and never dispatch a real model. SDK checks load only their explicit extensions; they do not start/restart production services or reload another session.

The portable host gate drops the original machine's direct dashboard-source assertion; actual SDK checks separately verify foreground idle. Original machine-specific smoke/verification scripts bound to private task paths/runs are intentionally not published. Public source provenance/checksums and limitations are in `config/mainline-supervision-source.json` and `docs/VALIDATION.md`. No raw private task log or transcript is part of this export.
