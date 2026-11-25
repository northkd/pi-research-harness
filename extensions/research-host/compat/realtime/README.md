`createRealtimeAdapter` attaches the new host's `/ws` upgrade handler to an existing Node HTTP server. It reuses the session host's durable event journal and sequence numbers.

Pass `server`, `authenticate(request)`, `sessions` and the host's `authorizeSession(request, row, write)` callback. Authorization is checked before every read page, snapshot and command. The fallback admission permits unowned local sessions and the two historical local owner aliases. Named foreign owners and remote-device histories require an explicit host policy.

The factory returns `mintTicket(request, { scope: 'browser' })`, `publish(sessionId)` and `dispose()`. Mount `mintTicket` behind `POST /api/ws-ticket` with the ordinary authenticated HTTP request. It issues a short-lived, single-use ticket bound to request address, Host and Origin. A browser then opens `/ws?ticket=...`. Header-authenticated local clients can open `/ws` directly. Browser Origin must match Host.

Clients receive `host_capabilities`, then send `subscribe {sessionId,lastSeq?}`. Durable records arrive as `event_replay {sessionId,events:[{seq,event}],isLast}` and continue as `event {sessionId,seq,event}`. `session_updated` and `session_snapshot` provide the current native state and pending dialogs after replay. `resync` repeats this operation at the supplied cursor, and `unsubscribe` ends the subscription. Future cursors fail explicitly. Byte-bounded replay groups preserve large native records, which can occupy one larger frame within the journal's maximum record size.

`send_prompt` accepts `sessionId`, `text`, optional images, `delivery`, and a stable `promptId` or `requestId`. It uses the keeper's exact prompt receipt and emits `prompt_result` after native acceptance. `delivery` defaults to `followUp`. Model completion remains observable through later native events.

Supported dialogs use native `select`, `confirm`, `input` and `editor` requests. The browser receives `extension_ui_request {sessionId,requestId,method,params}`. It answers with the same request ID plus boolean `result`/`confirmed`, string `result`/`value`, or `cancelled:true`. The keeper verifies that the original native request is still pending. Resolution emits `ui_dismiss`. Existing string-array widgets and notices remain available as raw native events. Terminal component factories need a native terminal.

Additional business handlers use `handleExtraMessage(message, context)`. Return `true` only for a handled message, and use the feature's own owner/cwd checks for messages without a session ID. The stable `context` has `request`, object-valued `send`, `sessionId`, and `socket`. The socket wrapper provides native string-valued `send`, `readyState`, `bufferedAmount`, `principal` and `principalExpiresAt`, suitable for the existing science viewer. `onDisconnect(context)` receives the same socket wrapper for cleanup. Pass `extraMessageTypes` to advertise enabled extensions. Unknown commands return an explicit error.

`publish(sessionId)` wakes a durable read. Events must enter the session host journal before publication. This avoids separate HTTP and WebSocket event sequences. A one-second fallback scan also catches appended records if a notification was missed.

The vendored `ws` 8.22.0 source comes from the deployed dependency, with its MIT license and `VENDOR-MANIFEST.json`. Fixture tests use actual WebSocket handshake and masked frame parsing over in-memory Duplex streams. Session actions use synthetic implementations and the real durable journal. Live Pi process and frontend integration belong to the host's end-to-end checks.

```sh
node compat/realtime/index.test.mjs
```
