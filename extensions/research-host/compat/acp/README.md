Standalone ACP driver using the deployed adapter's v1/v2 JSONRPC protocol and event normalization.

```js
const acp = createAcpHost({
  stateDir: path.join(config.stateDir, 'acp'),
  agents: config.acpAgents,
  settings: config.acp,
  onDiagnostic,
});
const sessions = createAcpSessionFacade({ native: nativeSessions, acp });
const spawnAutomation = createAutomationSpawner({
  createSession: sessions.createSession,
  spawnAcp: sessions.startAcp,
  authorizeCwd,
});
```

The normal host router admits CWD and identity before calling this local driver. Optional `authorize(action, resource, principal)` is a synchronous fail-closed hook; an asynchronous hook is rejected. The public agent list contains only `{id,name}`. Agent commands, arguments and environment remain in private configuration.

`start({agent|agentId,cwd,sessionId?,spawnToken?})` resolves an actual ready session after `initialize` and `session/new`. `getSession`, `listSessions`, `prompt`, `cancel`, `send`, `stop`, `reconnect`, `readEvents`, `updateSession`, `deleteArchivedSession`, and `onEvent((sessionId,bridgeMessage)=>...)` expose real driver state. `sendMessage` returns the transport receipt; prompt acceptance requires the original `prompt_received` frame. Prompt ids bind a content hash; an ambiguous acknowledgement never causes an automatic resend.

The native facade merges session inventory and routes native `command`, `respondUI`/`respondUi`, `abort`, `terminate`, `deliverPrompt`, metadata, event subscriptions and event paging by driver. `startAcp`/`spawnAcp` returns the native spawn-result shape. Automation's `prompt` is delivered once after readiness; the former REST endpoint can omit it as before. ACP metadata updates return promises, including updates to archive state. The facade projects ACP permission requests as native select requests while retaining original bridge frames.

Non-durable agents keep their original host-process lifetime. On Linux, durable agents run under an independent detached worker, with a mode-0700 state directory, mode-0600 authenticated Unix socket and per-worker capability. A host restart reconnects the same process, replays genuine logged events with `replay:true`, and reissues pending permission dialogs. `dispose()` stops non-durable sessions and disconnects durable sessions. `dispose({stopDurable:true})` stops both. Normal server shutdown should await `acp.dispose()` separately from native host close.

Existing ACP `.meta.json` files restore as ended ACP sessions; the registered `.jsonl` path is a metadata key and is not a Pi transcript. ACP session/load, Pi fork, transcript, filesystem/terminal RPC access, retry and Pi-only controls retain explicit refusal. Tool and artifact output is the deployed `tool_execution_*` event content, including actual tool content and raw output. The driver does not invent an artifact catalogue. The legacy ACP wire client name remains `pi-dashboard` to preserve its handshake identity; there is no Dashboard runtime import.

`SOURCE-MANIFEST.json` records the 13 transformed upstream modules and SHA-256 hashes; `LICENSE.upstream` retains their license. `build-from-deployed.mjs` is a one-time generation tool and must be excluded from the installed runtime. Runtime dependencies are Node built-ins and the standalone host's private-file and event-journal helpers.

Offline regression command:

```sh
node --test compat/acp/test/acp.test.mjs compat/acp/test/facade.test.mjs
```

Tests launch only local synthetic ACP and Pi peers. They cover real stdio handshakes, v1/v2 state and acknowledgements, echo suppression, genuine tool/artifact output, permission answers/cancellation, queued prompts, hashed duplicate receipts, startup failure, durable host restart, socket capability rejection, legacy restore/archive, native facade and Automation initial-prompt deduplication. The execution sandbox must permit Node child processes and Unix sockets; default restricted subprocess execution can return EPERM.
