# Research working agreement

Define the question, success criteria, time/compute budget and allowed material before acting. Main agent owns evidence indexing and final judgment.

- Establish claim/source/location/conditions records; summaries are not substitutes for decisive primary evidence.
- For independent derivations use fresh contexts and the same assumptions; keep first-pass answers separate. Do not claim independence from model labels alone.
- Treat review as advisory unless model identity, evidence and obligations support acceptance. Majority vote is not a proof.
- Record numerical inputs, environment, commands, seed, raw outputs and exits. Never invent experiment results.
- Delegate only within current user/project authorization and when there is independent value. Do not create extra reviews for routine cleanup or already equivalently verified facts. On a small-memory host, start no new child below 2GiB available; keeping at most three active reasoning processes is an operator coordination target, not an enforced cross-session cap. A per-run concurrency limit is not a machine-wide reservation.
- Controlled nesting is limited to research-theory/literature/numerics/critic/web-oracle, within the installed depth and explicit task budget. Use fresh, async contexts and keep an answering parent alive. SSH, model-assessor, mainline-supervisor and external agy are leaves. Ordinary children must not dispatch the mainline supervisor, transfer remote-write permission or select a new provider themselves. Preserve first-pass answer isolation; supervisor discussions are for methods/assumptions/checks, not leaking candidate answers.
- Native async tasks notify on completion; do not poll or sleep merely to wait. Stop on infrastructure failure rather than silently changing execution protocol/provider.
- Credentials, private papers and original data are not export-authorized by installation. Obtain explicit external-provider and material-scope permission.
- Remote writes, job submission/termination and large compute require explicit target/resource/time authorization. Never train on an HPC login node.
- Browser research uses a dedicated profile and loopback CDP. Human login is required; never copy cookies or unrelated chats. Verify the actual webpage model before sending scientific material.
- Last-message withdrawal changes the active conversation branch, not previously executed file/command effects. Stop model/tools first.

## Proportional, stage-checkpoint mainline supervision

The released extension remains dormant until a project is configured. Select an authenticated exact local model via `PI_RESEARCH_SUPERVISOR_MODEL`; a role template or package installation is not project-material export permission. For a research project, first inspect existing `mainline_supervision status`; never replace frozen core/scope or historical permissions silently. If no configuration exists, the main agent should establish the user-confirmed core and minimal approved evidence paths and request direct human consent once. Do not make the user repeatedly remind the agent.

- Direction is separate from scientific acceptance. ON_TRACK can coexist with science.UNVERIFIED. Risk, missing evidence, review failure/timeout/network or historical log gaps do not globally freeze research. Only an exactly grounded OFF_TRACK file branch pauses; authorized safe development and bounded tests may continue. Preserve limitations and old failures; no unsupported publication or retrospective permission.
- Ask-user and human-decision channels remain available. A user can release exact branch restrictions through the confirmed decision action; it is permission to continue, not proof of scientific success. Persistent workflow-wide human override against future new restrictions is **not implemented**.
- Evidence capture is not a model-call trigger. Do not review every edit/test return, progress note, capture, completion notification or post-stage packaging. Only a genuine new research method/key assumption, substantive scope change, full-stage acceptance or concrete drift signal merits `checkpoint` with a stable conceptual `stageId` and `kind: plan_change|scope_change|stage_complete|drift_signal`. The parent owns this semantic judgment; no extra model classifier is needed.
- The same frozen core + stageId + kind is deduplicated across sessions; merge pending checkpoints into one async review after foreground settlement. Never create per-turn/timestamp stages for cleanup. Tool check consumes existing runs/checkpoints; a human slash check can explicitly request one new-material review. Old state reload does not replay accumulated work. Pending evidence is not falsely marked reviewed.
- The supervisor is fresh/async/read-only, reads only its fixed authorized packet, and does not interview the main agent or ask for repeated relevance essays. A completed foreground can be idle while a real background review remains separately visible. Native completion may wake the parent once, not trigger a cascade.
- Raw-data/credential/egress/resource/irreversible-operation boundaries remain independent; mainline direction does not authorize publication. See `docs/SUPERVISION.md` for setup, limitations and verification.

External models, optional agy, ARIS skills, images and scheduler adapters must be configured and authorized locally. Their presence is not a verified live backend.
