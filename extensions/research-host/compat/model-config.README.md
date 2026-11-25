`createModelConfigApi(options)` exposes local model discovery and native Pi settings storage.

Mount `api.handle(request)` before the generic router. It returns `{statusCode,body}` or `null` and supports:

- `GET /api/models[?annotated=1|true]`: deployed `{object:"list",data:[...]}` projection, stored-credential filtering, OAuth exclusions, no `enabledModels` filter.
- `GET /api/providers`: local custom-provider definitions with masked keys and environment-reference resolution. Health starts empty, as the legacy in-memory cache does after restart.
- `GET /api/pi-settings`, `PUT /api/pi-settings`, `PUT /api/pi-settings/raw`, `POST /api/pi-settings/sync-defaults`: original typed/raw validation, ETags, shared Pi lock, merge preservation and managed-default restoration. The raw body limit is 256 KiB.

Options include `agentDir`, `managedInstallRoot`, `defaultsFile` or synchronous `readDefaults` plus `writeDefaults`, `authorize(request)`, `getSession(id)`, `authorizeSession(row,principal)`, `command(id,message)`, `refreshSessionModelRegistry(row,{allowNetwork:false})`, `reloadConnectedSessions()`, and `scanThemes()`.

Use `getDefaults()` and `setDefaults(partial)` inside the normal `/api/config` handler; this module intentionally does not return a partial configuration document for that route. `setDefaults` persists host defaults first, then mirrors provider/model/thinking into the global Pi settings with the deployed writer. Empty defaults retain the original mirror behavior. Keep `defaultModel` and `defaultThinkingLevel` when migrating the host config.

Use `sessionModels(id,principal)` to answer the old `request_models` message with `{type:"models_list",sessionId,models}`. It reads the real native session registry, applies global `enabledModels` with the original matcher, and projects names, reasoning, vision, context and supported thinking levels. ACP uses its actual published model choices. Global catalogue and session choices remain separate; the default-model picker previously merged their union, with session rows winning collisions.

The actual Pi 1.3.0 RPC `get_available_models` returns a snapshot. The refresh hook must refresh `ctx.modelRegistry` locally before that read to preserve the legacy picker’s refresh-on-open behavior. The settings reload hook must use a real extension/session reload path; native RPC has no `reload` command. Omitted hooks expose genuine current snapshots and report the missing capabilities in `migrationGates()`.

Read safety differs from the old raw editor when credentials are embedded in settings: known secret fields and credential-bearing URLs are masked, malformed raw source is omitted, and a whole-file raw overwrite refuses while existing values are redacted. Typed patches still preserve them. Current machine settings contain no legacy credential fields. The optional theme scanner can return global/package themes; without it, the original degraded fallback `dark`, `light`, `system` is returned.

The installed native ModelRuntime is selected by the independent managed Pi current-version file. Creation uses a read-only credential store, `modelsPath:null`, `refreshOnCreate:false`, `allowModelNetwork:false`; native model definitions are registered locally. Configured command values are rejected. No model stream, credential refresh, remote catalogue or provider probe runs during reads.

Remaining API migration gates:

- `PUT /api/providers`, `PATCH|DELETE /api/providers/:name`, `POST /api/providers/:name/refresh`, `POST /api/providers/test`: original writes trigger provider reload, registry refresh and health probes. These are not simulated here.
- Provider-auth status/catalogue and OAuth flow routes, `PUT /api/provider-auth/api-key`, `DELETE /api/provider-auth/:provider`, Radius MCP configuration: require the original credential locks, delegated native login flow and fanout.
- `POST /api/pi-settings/legacy-credentials`: requires coordinated settings/auth credential migration.
- Custom endpoint catalogue discovery from `providers.json` requires explicit provider network requests. Native `models.json` models work offline.

Current read-only findings: `providers.json` is absent; `models.json` has 25 cliproxy models and an openai-codex override; auth stores cliproxy, openai and deepseek API-key credentials plus openai-codex OAuth. The current native and former Dashboard defaults agree. The new global catalogue lists 80 models: cliproxy 25, openai 44, openai-codex 9, deepseek 2. A fetch-blocked smoke check found the selected default and confirmed unchanged SHA-256 for settings, models and auth. The available Dashboard log contains no matching route or settings-write records, so it does not establish historical endpoint usage.

Validation: `node compat/model-config.test.mjs` runs eight offline tests, including the real selected native SDK with synthetic credentials and a fetch interceptor. Other tests cover wire shapes, OAuth exclusions, scoped session choices, actual settings writes in temporary directories, ETag conflicts, managed defaults, raw limits and secret redaction. `model-config.source.json` and `model-config.LICENSE` record bundled upstream sources and licenses. Exclude `model-config-build.mjs` and tests from the installed runtime.
