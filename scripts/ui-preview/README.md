# Isolated UI validation

Requires **Node >= 22.19**, a prepared Dashboard checkout with its final client build, and Playwright available in that checkout. Linux is supported; the native bridge uses its loopback TCP option. Install or select a Playwright browser before running.

```bash
node scripts/ui-preview/launcher.mjs run \
  --runtime /absolute/path/to/dashboard-checkout \
  --output /absolute/path/to/new-ui-qa-output
```

`PI_UI_PREVIEW_RUNTIME` and `PI_UI_QA_OUTPUT` can supply the two paths instead. The browser script defaults to `scripts/ui-preview/browser-qa.mjs`; select another local script with `--browser-script /absolute/path/check.mjs` or a positional script after `run`. The launcher resolves its own repository from `import.meta.url`.

Use a fresh output directory for each run. The launcher creates `synthetic-demo` inside it and refuses to reuse or overwrite an existing project. It invokes the repository's `create-demo-project.mjs` and `register-dashboard-extras.mjs`, then seeds **three ended, clearly labelled synthetic transcripts** in a new temporary HOME. Their model is `demo/ui-fixture-unpriced`; no price or money fields are invented. Authenticated API checks must confirm ended-session discovery, unpriced statistics and a zero recorded monetary total before browser checks start.

The server uses the native CLI, unchanged `setup-home.ts` isolation tripwire, and native one-time browser proof. It binds only `127.0.0.1`, disables tunnels and mDNS, and refuses to run while port **18767** is occupied. It sets `PI_RESEARCH_LOOP_ROOT` to this checkout's `extensions/research-loop`, matching the portable Dashboard launcher. Credentials, local storage and native private state stay in the temporary HOME, which is removed after the owned processes stop. The handoff URL is passed to the browser child in its environment and is never saved. The launcher does not start model tasks or connect to a user's existing project.

Both children receive an explicit environment allowlist. If Chromium is installed outside the prepared checkout, supply `PLAYWRIGHT_BROWSERS_PATH` or the browser script's `PI_UI_BROWSER_EXECUTABLE`; no user cache location is hardcoded or inherited. `CI`, locale and certificate settings are also forwarded. Provider keys and existing Dashboard/agent overrides are not forwarded.

All generated reports, screenshots and demo files belong under the requested output directory. The launcher writes `server.log`, `browser-process.log`, `synthetic-read-smoke.json` and `launcher-summary.json`. The browser script receives:

| Variable | Value |
|---|---|
| `PI_UI_QA_OUTPUT` | Canonical output directory; write reports and screenshots here |
| `PI_UI_PREVIEW_RUNTIME` | Prepared Dashboard checkout |
| `PI_UI_PREVIEW_URL` | This run's loopback server URL |
| `PI_UI_DEMO_CWD` | Output directory's `synthetic-demo` project |
| `PI_UI_DEMO_SESSIONS` | JSON array of three synthetic ended sessions |
| `PI_UI_LOGIN_URL` | Short-lived native browser handoff; never persist or print |

Custom browser scripts must keep output in `PI_UI_QA_OUTPUT`, redact authentication URLs from errors, and exit nonzero if a check fails. The launcher forwards that failure and stops its own browser/server processes. `Ctrl-C` also stops the owned processes; no PID from an earlier invocation is reused.

The included browser check exercises the real app, including typing an unsaved Markdown edit, switching primary views, returning through old routes, usage details, all research tabs, and 1920/1440/1100/768/360px plus dark mode. It also checks three levels of recorded collaboration, parent navigation, inline stacked-subagent expansion, reduced motion, explicit details, and the long-task authorization editor. Native scrollbars stay painted for visual review. Install a Chinese font such as Noto Sans CJK on the screenshot host for readable Chinese labels. The default fixture document is `README-演示.md`.

The collaboration simulator supplies four artificial sessions and eight artificial child executions. Its permission API is an in-memory **simulation**: approve/revoke affects only the labelled demo state and never forwards a grant to the server. Browser coverage of this editor is therefore UI evidence, while authorization, inheritance, revocation and real file-gate decisions require the separate backend/extension tests. No browser result is evidence of paid-model execution or a ten-hour research run. The mobile scenario enters Agents through mobile navigation after the existing responsive shell remount; it does not assert that the desktop selection survives that remount.

The report distinguishes expected negative contracts from failures: the browser plugin must first report disabled and its absent API must be directly verified; Vault and Flows 404s are accepted only for this run's ended synthetic IDs and exact error codes. Monaco may emit its precise `Canceled` cancellation while disposing the Markdown editor on return to Preview. That event is classified only by its exact name/message, Monaco cancel/dispose stack and the specific edit check phase, and retained in `cancellations`. Other page errors and unexpected API failures make the check fail. No application-level error handler is changed.
