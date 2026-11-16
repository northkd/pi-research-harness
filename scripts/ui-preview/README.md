# Isolated UI validation

Requires **Node >= 22.19**, a prepared Dashboard checkout with its final client build, and Playwright available in that checkout for browser mode. Linux is supported; the native bridge uses its loopback TCP option. Install or select a Playwright browser before running visual checks; `--api-only` needs no browser.

```bash
node scripts/ui-preview/launcher.mjs run \
  --runtime /absolute/path/to/dashboard-checkout \
  --output /absolute/path/to/new-ui-qa-output
```

`PI_UI_PREVIEW_RUNTIME` and `PI_UI_QA_OUTPUT` can supply the two paths instead. The default is the real collaboration fixture and `scripts/ui-preview/collaboration-browser-qa.mjs`; `--collaboration-fixture` remains an explicit-compatible spelling of that default. Select another local script with `--browser-script /absolute/path/check.mjs` or a positional script after `run`. The launcher resolves its own repository from `import.meta.url`.

Use a fresh output directory for each run. The launcher creates `synthetic-demo` inside it and refuses to reuse or overwrite an existing project. It invokes the repository's `create-demo-project.mjs` and `register-dashboard-extras.mjs`, then seeds **seven ended, clearly labelled synthetic transcripts** in a new temporary HOME. Their model is `demo/ui-fixture-unpriced`; no price or money fields are invented. Authenticated API checks compare against the complete generated catalog, confirm every ended session, verify unpriced statistics and a zero recorded monetary total before browser checks start. The optional legacy fixture contains three transcripts instead.

The server uses the native CLI, unchanged `setup-home.ts` isolation tripwire, and native one-time browser proof. It binds only `127.0.0.1`, disables tunnels and mDNS, and refuses to run while port **18767** is occupied. It sets `PI_RESEARCH_LOOP_ROOT` to this checkout's `extensions/research-loop`, matching the portable Dashboard launcher. Credentials, local storage and native private state stay in the temporary HOME, which is removed after the owned processes stop. The handoff URL is passed to the automated browser child in its environment and is never saved to QA output. The launcher does not start model tasks or connect to a user's existing project.

For an authorized external browser controller, select `--browser-script scripts/ui-preview/manual-browser.mjs`. This helper launches no browser. It keeps the same isolated server running for up to 30 minutes and writes `manual-browser-ready.json` into the QA directory. That metadata contains the loopback address, synthetic project/session IDs and paths to a private handoff file and a stop marker; it contains no credential value. The one-time login link lives only in a mode-0600 file within a mode-0700 directory in the temporary HOME. Consume it directly with the authorized browser, never print it, copy it into a report, or commit it. Create the indicated stop marker when review finishes; the helper deletes its private files, then the launcher stops the server and removes the temporary HOME. A successful launcher exit in this manual mode confirms preview lifecycle and API smoke only, **not** visual or interaction validation; record those observations separately from the external browser.

Both children receive an explicit environment allowlist. If Chromium is installed outside the prepared checkout, supply `PLAYWRIGHT_BROWSERS_PATH` or the browser script's `PI_UI_BROWSER_EXECUTABLE`; no user cache location is hardcoded or inherited. `CI`, locale and certificate settings are also forwarded. Provider keys and existing Dashboard/agent overrides are not forwarded.

All generated reports, screenshots and demo files belong under the requested output directory. The launcher writes `server.log`, `browser-process.log`, `synthetic-read-smoke.json` and `launcher-summary.json`. The browser script receives:

| Variable | Value |
|---|---|
| `PI_UI_QA_OUTPUT` | Canonical output directory; write reports and screenshots here |
| `PI_UI_PREVIEW_RUNTIME` | Prepared Dashboard checkout |
| `PI_UI_PREVIEW_URL` | This run's loopback server URL |
| `PI_UI_DEMO_CWD` | Output directory's `synthetic-demo` project |
| `PI_UI_DEMO_SESSIONS` | Complete generated catalog: seven ended synthetic sessions by default, three in legacy mode |
| `PI_UI_COLLABORATION_FIXTURE` | Current/historical tenure IDs, four sibling IDs and synthetic queue metadata in the default mode |
| `PI_UI_LOGIN_URL` | Short-lived native browser handoff; never persist or print |

Custom browser scripts must keep output in `PI_UI_QA_OUTPUT`, redact authentication URLs from errors, and exit nonzero if a check fails. The launcher forwards that failure and stops its own browser/server processes. `Ctrl-C` also stops the owned processes; no PID from an earlier invocation is reused.

Native scrollbars stay painted for visual review. Install a Chinese font such as Noto Sans CJK on the screenshot host for readable Chinese labels. The default fixture document is `README-演示.md`.

## Retained legacy workspace scenarios

`--legacy-workspace-fixture` explicitly selects the older three-transcript fixture and `browser-qa.mjs`. That broader regression script retains unsaved Markdown/draft checks, primary-view switching, old routes, usage details, research tabs, dark mode and the separate collaboration simulator. Its older main-agent-selection and collapsed-layout assumptions predate the server-authoritative tenure contract. It is retained for targeted migration, **not the default or release acceptance for this change**; do not make ended sessions selectable or weaken production protections to satisfy an old scenario. Use the default real-native acceptance below for the new functionality.

The collaboration simulator supplies four artificial sessions and eight artificial child executions. Its permission API is an in-memory **simulation**: approve/revoke affects only the labelled demo state and never forwards a grant to the server. Browser coverage of this editor is therefore UI evidence, while authorization, inheritance, revocation and real file-gate decisions require the separate backend/extension tests. No browser result is evidence of paid-model execution or a ten-hour research run. The mobile scenario enters Agents through mobile navigation after the existing responsive shell remount; it does not assert that the desktop selection survives that remount.

The report distinguishes expected negative contracts from failures: the browser plugin must first report disabled and its absent API must be directly verified; Vault and Flows 404s are accepted only for this run's ended synthetic IDs and exact error codes. Monaco may emit its precise `Canceled` cancellation while disposing the Markdown editor on return to Preview. That event is classified only by its exact name/message, Monaco cancel/dispose stack and the specific edit check phase, and retained in `cancellations`. Other page errors and unexpected API failures make the check fail. No application-level error handler is changed.

## Current / historical collaboration acceptance

For the tenure-separated collaboration UI and its live concurrency entry, use:

```bash
node scripts/ui-preview/launcher.mjs run \
  --runtime /absolute/path/to/dashboard-checkout \
  --output /absolute/path/to/new-collaboration-qa-output \
  --collaboration-fixture
```

This selects `collaboration-browser-qa.mjs`, which is also the default without
the flag. The richer fixture
creates seven **ended, clearly labelled synthetic sessions**, two recorded main
tenures, four sibling Multi-agents, four completed native child records, one
four-task DAG queue and a native waiting queue. It invokes the actual lifecycle
and dispatch services to persist their normal private ledgers; it does not
intercept browser HTTP or WebSocket responses. Native authentication, project
adoption and session scanning stay enabled. No model process is launched.

The checker saves actual rendered screenshots at 1920, 1440, 1100, 768 and 360px,
plus the concurrency dialog and workbench goal/constraints section. It verifies
model/source visibility, sibling ownership, independent history, dependency
blocking, default 100% zoom and page overflow. The concurrency editor writes to
the real HTTP API and verifies the saved limits without a reload. A nonzero
exit and `collaboration-browser-report.json` identify any failed check.

Ended fixture parents cannot execute tasks. In particular, these screenshots
are **not** evidence that a queued task launched or a model produced a result.
The actual dispatcher may correctly block their waiting plan after its native
recovery grace period; this is recorded as a fixture limitation, never hidden
by resetting the scheduler. Launch admission, drag/start races, live cap
increases and shared subagent occupancy are verified by the independent backend
and component tests. The fixture-only in-memory catalog used while recording
old selections is discarded before the server starts.

To run only the native server/API acceptance, without launching a browser:

```bash
node scripts/ui-preview/launcher.mjs run \
  --runtime /absolute/path/to/dashboard-checkout \
  --output /absolute/path/to/new-collaboration-api-output \
  --collaboration-fixture --api-only
```

This verifies native authenticated reads, real live-limit writes and revision
conflicts, historical-main cascading removal that leaves the current family
untouched, and current-main cascading removal that preserves transcript files.
It writes `collaboration-api-smoke.json` and explicitly reports
`visualVerification: "not-performed"`. No browser handoff is minted in this mode.
For an external browser controller, combine `--collaboration-fixture` with the
existing `--browser-script scripts/ui-preview/manual-browser.mjs` instead.

If the host forbids Chromium creation or the external browser is in a separate
loopback namespace, report that limitation. Do not disable native security,
publish this private repository to a third party or expose the fixture publicly
to obtain a screenshot. Run the same command on an authorized local machine
with a normal browser installation for the outstanding visual checks.
