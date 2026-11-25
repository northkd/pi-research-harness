Standalone Provider configuration, probes and catalogue discovery.

`createProviderApi({agentDir,port,notifySessions,invalidateRegistry,authorize?,fetch?,env?,catalogueFile?})` returns:

- `handle({method,url|pathname,body,principal,...})`: `{statusCode,body}` or `null`.
- `readProviders()`: trusted server-only definitions, including saved keys. Never expose this accessor through HTTP.
- `getDiscoveredModels()`: genuine discovered model rows, with `metadataSource:"endpoint"|"fallback"`.
- `refreshRegistry()` / `discover()`: perform selected saved providers' real model-list requests, persist their catalogue, and invalidate the host registry.
- `whenIdle()`, `dispose()`: settle detached work and abort active requests.
- `nativeConfigs(modelsDocument)`: SDK provider configs built from saved providers, discovered models and native authored overrides.

Both host hooks are required. `notifySessions(message)` receives the original `credentials_updated` message. `invalidateRegistry({generation,models,phase})` first receives `phase:"configuration"` after a stored configuration change and then `phase:"catalogue"` after discovery. Root should drop its native ModelRuntime cache and merge these actual model rows; the catalogue-phase hook should refresh running native sessions after the new snapshot is available. Auth/OAuth changes use the same root invalidation and native refresh path, while their credential storage remains separate.

Mount before `createModelConfigApi.handle`, so `GET /api/providers` reports this module's live health cache. Routes retain deployed shapes and timing:

- `GET /api/providers`: `{success:true,providers,health}`, masked saved keys, `$ENV` resolution flags.
- `PUT /api/providers`: replace only the providers map, preserve roles/presets/other document fields, keep `***` keys, await saved-provider health probes.
- `PATCH /api/providers/:name`: upsert one provider; omitted fields and `***` preserve saved values; health work runs detached.
- `DELETE /api/providers/:name`: remove only that provider; deleting an absent name rewrites nothing.
- `POST /api/providers/:name/refresh`: refresh the real server catalogue, notify native sessions, await fresh health.
- `POST /api/providers/test`: test literal, `$ENV`, or saved `***` credentials without saving; return real HTTP status, model count and bounded sample.

Configuration mutations use `providers.json.lock` through proper-lockfile, a private atomic replacement and fsync. Corrupt input is copied byte-for-byte beside the file and writes return 409. Invalid map/entry shapes, blank or prototype-sensitive names, unsafe URLs and self-recursive provider origins are refused. Probe errors redact submitted and recognizable echoed credentials. Responses are bounded; the timeout covers the response body; redirects fail without forwarding keys elsewhere.

Discovery uses the upstream four API-specific model-list builders and capability mapper. Every adopted field comes from provider metadata or the original API-specific floor; provenance identifies fallback values. Native `models.json` capability overrides remain authoritative. Reads do not probe, and construction does not contact providers.

The default persisted snapshot is `<agentDir>/provider-models-cache.json` (override with `catalogueFile`). It contains model metadata and SHA-256 config fingerprints, no saved keys, and is written mode 0600. Fingerprints include resolved environment credentials. Restart restores model IDs without egress; key/config rotation invalidates stale entries immediately.

`native.mjs` is suitable for the native extension:

```js
const configs = loadNativeProviderConfigs({ agentDir, catalogueFile });
const result = await applyNativeProviderConfigs({ pi, ctx, configs, previous });
previous = result.registered;
// Inspect result.errors and result.refresh.errors before reporting completion.
```

This reads local providers/models/snapshot only, unregisters removed or changed extension providers, registers real `ProviderConfigInput` values and awaits `ctx.modelRegistry.refresh({allowNetwork:false})`. A failure for one provider is returned in `errors` and leaves other providers eligible for registration. API keys preserve `$ENV` references and escape literal `$`/`!` using native Pi semantics. Optional registry models supply fallback fields for known discovered/authored IDs; they never broaden the endpoint's model ID set. No keys need to travel through a public host API. Session list projection can overlay discovery provenance, because the native SDK does not retain the Dashboard's metadata-source badge field.

Validation: `node --test research-host/compat/providers/test/providers.test.mjs` runs ten isolated tests with a loopback HTTP provider, synthetic keys and temporary files. Tests cover CRUD and real probes, all four API request formats, health, lock contention, corruption preservation, refusals, secret redaction, body timeout, redirect refusal, restart snapshots and registration into the actual installed Pi SDK. No production configuration or real provider endpoint is touched.

`SOURCE-MANIFEST.json` and licenses record the deployed source port. Exclude `build-from-deployed.mjs` and `test/` from installation.
