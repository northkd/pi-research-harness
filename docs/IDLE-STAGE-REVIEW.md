# Idle stage review daemon

Status: opt-in implementation. Nothing in this document installs, starts or enables the daemon, and no external model request is made by the test suite.

## Purpose

`extensions/research-loop/src/idle-stage-review.mjs` classifies which of the five
workflow stages a project is entering **only while the entire project is idle**.
It is deliberately narrower than a reviewer:

- it does not review scientific quality, accept or reject claims, publish,
  rewrite research, or create sessions / dashboard cards / chat messages;
- its only model output is `{"stage":"<one of the five ids>"}` (or an explicit
  `insufficient` result);
- it writes a source-labelled stage event through the shared
  `recordObservedStage` contract after re-checking the exact charter hash and
  confirming the project is still idle.

Allowed stages: `1-idea`, `2-experiment`, `3-review`, `4-summary`, `5-writing`.

## Idle definition and fail-closed rules

A project is reviewable only when **all** of these hold:

1. Every top-level session in the project (joined or not) has dashboard status `idle`
   or `ended`, no `currentTool`, no `awaitingFileAccess`, no `compacting`, and
   no newer `lastRunStartedAt` than `lastSettledAt`.
2. The loopback workbench-sync proxy reports `coverage.partial === false`,
   `coverage.reasons` empty, a fresh `heartbeatAt`, and matching
   `cwd` / `adoptionId` / `charterHash`.
3. `coverage.parentSessions` equals the daemon's joined-session count.
4. Every execution row (including native subagents) is terminal or idle, has no
   active tool, and has a known status.
5. Host pressure is not reported as `degraded` or `unresponsive`.

Any missing dashboard status, unknown execution status, stale workbench
heartbeat, partial coverage, malformed response, or scope mismatch aborts the
review. Transcript/file mtime is never used as an idle signal: long inference
can run without producing output.

The model call is never made on a fixed tick alone. The daemon also requires:

- an idle threshold (`idleAfterMs`) since the project was first observed idle;
- a content fingerprint different from the last classified fingerprint;
- cooldown and per-project daily request limits, retained across charter/adoption changes;
- no active exponential backoff;
- one request at a time across all projects.

After the model responds, dashboard sessions, workbench observation, packet
fingerprint, the discovered scope and the charter hash are re-read. If anything
changed, the result is discarded and audited, and the continuous idle window restarts.
A telemetry heartbeat alone is not a material change and cannot trigger repeat billing.
The `recordObservedStage` call uses the request's source time so a newer manual stage
selection is not overwritten by a late reply. The call is
synchronous and happens after the last `await`; the daemon never holds a
scientific-record lock across network I/O.

## Configuration

The daemon reads one private JSON file (mode `0600`, owned by the service
user), passed as `--config ABSOLUTE_PATH`. Unknown fields are ignored.

Required when `enabled` is true:

| Field | Meaning |
| --- | --- |
| `stateDir` | Private daemon state, singleton lock, per-project counters and audit log. |
| `adoptionRoot` | Existing private dashboard res-workflow adoption directory used by `discoverWorkbenchScopes({adoptionRoot})`. |
| `dashboardOrigin` | Loopback origin only, e.g. `http://127.0.0.1:8000`. |
| `dashboardAuthFile` | Private JSON with `{ "headers": { "cookie": "..." } }`, `{ "authorization": "..." }` or `{ "x-pi-local-token": "..." }` / `{ "localToken": "..." }`. Missing auth means an observable skip, not an anonymous request. |
| `workbench.syncOrigin` | Loopback workbench-sync proxy origin, e.g. `http://127.0.0.1:18767`. |
| `workbench.tokenFile` | Private file holding the workbench-sync transport token. |
| `provider` | Currently only `openai-compatible`. |
| `model` | Exact model id. |
| `modelBaseUrl` | Loopback-only proxy base URL, e.g. `http://127.0.0.1:11434/v1`. Non-loopback URLs are rejected at config load. A loopback URL is transport, not export permission. |
| `modelUpstreamHost` | Exact external upstream host the proxy routes to, e.g. `api.example.com`. Must equal `authorization.upstreamHost`. |
| `modelEndpoint` | Optional, default `/chat/completions`. |
| `apiKeyFile` or `apiKeyEnv` | Runtime credential source. Values are never logged. Environment wins if both are set. |
| `authorization` | Explicit material authorization, see below. |
| `packet.mode` | `metadata` (default) or `approved-extracts`. |
| `projectAllowlist` | Required when enabled. Must contain exactly the one project named in `authorization.project`; it never defaults to every adoption. |

Authorization object fields:

```json
{
  "approved": true,
  "approvedBy": "<user identity>",
  "approvedAt": "2026-11-04T00:00:00.000Z",
  "purpose": "stage-classification",
  "provider": "openai-compatible",
  "model": "<must equal top-level model>",
  "upstreamHost": "<must equal modelUpstreamHost>",
  "project": "<absolute path, the only projectAllowlist entry>",
  "materialMode": "metadata",
  "materialPaths": ["<absolute file paths; required for approved-extracts>"],
  "maxCallsPerDay": 12
}
```

Changing provider, model, upstream host, project, material mode or material
paths requires updating this object; a mismatch produces an observable
`authorization-*` skip and no request. `maxCallsPerDay`, when present, caps
`maxRequestsPerProjectPerDay`; a higher configured limit is rejected.

Optional controls (defaults in parentheses): `idleAfterMs` (5 min),
`cooldownMs` (60 min), `maxRequestsPerProjectPerDay` (8), `requestTimeoutMs`
(60 s), `dashboardTimeoutMs` (8 s), `tickIntervalMs` (30 s), `backoffMs`
(60 s), `maxBackoffMs` (60 min), `maxPromptChars` (12000), `maxPacketChars`
(8000), `maxResponseBytes` (256 KiB), `maxResponseChars` (4000),
`skipAuditIntervalMs` (10 min), `workbench.heartbeatMaxAgeMs` (120 s).

### Packet content

`metadata` mode sends only a project digest, charter hash, current stage,
session/execution counts and idle timestamps. It cannot semantically judge
paper content; the model is prompted to return `insufficient` when metadata is
not enough.

`approved-extracts` mode sends the configured absolute files
(`packet.extractFiles: [{label,file,maxChars}]`). It does **not** discover or
read joined task context, session transcripts, assistant or tool output,
research directories or result bodies on its own; there is no implicit file
discovery. The operator must prepare an extract file that contains only the
material the user approved (for example, a few recent de-identified user task
summaries and explicitly permitted artifact names) and list every file path in
`authorization.materialPaths`. The configured paths and the authorized paths
must be the same set; `approved: true` alone is never export permission. The one
exception is the explicitly configured generated summary described below: it is
still an exact authorized path, not implicit discovery.

Each extract is redacted for common secret patterns, stripped of control
characters and bounded by `maxChars`, `maxPacketChars` and the prompt limit.
No raw logs, full transcripts, source/paper/result bodies, credentials or
unapproved files are forwarded.

### Generated task summaries (`kind: "stage-task-summary"`)

`extensions/research-loop/src/stage-task-summary.mjs` can keep a small, private,
project-local record of recent task intents. It is deterministic extraction, not
a model summarizer: it takes only the actual current user prompt (never the
injected system prompt, assistant text, tool output or stored transcript),
removes code fences, Markdown tables, attachments and result bodies, extracts
one actionable sentence, refuses secret/credential payloads and redacts email,
phone and absolute paths. Redaction is best-effort and not a guarantee; prompts
should never carry credentials. It keeps at most 4 summaries of at most 240
characters each in a file capped at 8 KiB:

```
<project>/.pi/research-loop/stage-task-summary.json
```

These are truncated task intents, not semantic summaries of the full research
work. Collection starts only after this native extension is deployed; no
backfill or transcript mining occurs. The helper returns
`{recorded: true, tasks, path}` or an observable `{recorded: false, reason}` and
never throws into the surrounding research turn. Once the new extension is loaded,
verified joined sessions collect these local task intents automatically; this is not
a model call. The separate daemon is disabled by default, and the summary producer
exports nothing on its own.

The parent hook must call it only after `readWorkbenchRecordContext` verified the
exact joined session and current charter, passing the user's current prompt:

```js
import { readWorkbenchRecordContext } from './workbench-context.mjs';
import { recordStageTaskSummary } from './stage-task-summary.mjs';

pi.on('before_agent_start', (event, ctx) => {
  const context = readWorkbenchRecordContext(ctx);
  if (!context || event?.messageType !== 'user') return;
  const result = recordStageTaskSummary(ctx.cwd, context, event.prompt);
  // {recorded:true,...} or {recorded:false,reason:"secret-payload"|...}
});
```

The file is never automatic authorization. To forward it, configure it as an
explicit `approved-extracts` entry and list the same absolute path in
`authorization.materialPaths`:

```json
"packet": {
  "mode": "approved-extracts",
  "extractFiles": [{
    "label": "recent-task-summaries",
    "file": "<absolute-path-to-approved-project>/.pi/research-loop/stage-task-summary.json",
    "kind": "stage-task-summary",
    "maxChars": 800
  }]
},
"authorization": {
  "materialMode": "approved-extracts",
  "materialPaths": ["<the exact same absolute file path>"]
}
```

Before forwarding, the daemon enforces the schema
`pi-research.stage-task-summary.v1`, the exact current `charterHash`, a positive
integer `charterRevision`, 1-4 tasks, per-task length limits and the absence of
secrets, email/phone values or absolute paths. Only reconstructed bullet lines
are sent; unknown fields, padding and arbitrary file text are ignored or make
the whole file invalid (`stage-task-summary-invalid`). Entries without `kind`
remain legacy operator-written extracts and are unchanged.

## Stage event contract

On a verified result the daemon calls:

```js
recordObservedStage(cwd, {
  stage,
  source: 'idle-stage-review',
  // Bounded string references, matching stage-observer's evidence validator.
  evidence: [
    'idle-stage-review:request:<uuid>',
    'packet-fingerprint:<sha256:...>',
    'material-mode:metadata',
    'model:<provider>/<model>',
    'joined-sessions:<n>',
    'executions:<n>',
    'idle-since:<ISO timestamp>',
  ],
  expectedCharterHash: '<sha256:...>',
  at, // ISO timestamp
})
```

The shared implementation owns locking and persistence; this module does not
edit `stage-observer.mjs` and does not write research state directly.

## Audit and observability

`stateDir/audit.jsonl` (mode `0600`, rotated at 8 MiB) records model, provider,
usage, timestamps, packet fingerprint, source references, stage, errors and
skip reasons. It never stores prompts, responses, API keys, cookies or raw
research extracts. Records are local only; the daemon creates no UI messages,
sessions or cards.

## Singleton, shutdown and service template

A `daemon.lock` file enforces one instance per `stateDir`. `SIGTERM`/`SIGINT`
stops the timer and releases the lock. A portable template lives at
`extensions/research-loop/config/pi-idle-stage-review.service.in` and a
unusable placeholder example at
`extensions/research-loop/config/idle-stage-review.example.json`; replace
`@REPO@` / `%h` placeholders, review paths/user, then install it as a user unit
manually. This repository does not install or start it.

## Authorization still required from the user

Before enabling, obtain explicit confirmation for:

- the exact external upstream host, provider and model id;
- the loopback proxy/base URL and who operates its upstream;
- the material scope (`metadata` or the exact approved extract file paths);
- the one project in `projectAllowlist` and `authorization.project`;
- the daily request and cost expectations.

A loopback URL by itself is not export permission. Without this authorization,
leave `enabled: false` or omit the `authorization` object; the daemon reports a
skip and performs no external request.
