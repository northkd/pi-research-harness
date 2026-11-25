The proxy serves one authenticated origin for the new static frontend, HTTP API and WebSocket transport. Generate its Caddyfile with `createCaddyCutoverTemplate({ publicAddress, upstreamPort, frontendRoot, accessLog })` from `proxy.mjs`. Production addresses use HTTPS; the upstream is fixed to `127.0.0.1`.

Every frontend, API, ticket and WebSocket request passes Basic Auth. Incoming Authorization, cookies and caller-supplied host credentials are removed before the API or WebSocket reaches the host. The proxy injects the separate host token from its private environment. `/internal`, `/mcp` and their children are refused after authentication. Encoded traversal paths are refused as well. The existing `/api/res-workflow/workbench-sync` path uses the same new host as every other API path.

The template references three environment values and contains their variable names.

- `PI_RESEARCH_UI_USER` is the public interface's Basic Auth user.
- `PI_RESEARCH_UI_PASSWORD_HASH` is its bcrypt hash. Existing approved Basic Auth credentials can retain their current hash.
- `PI_RESEARCH_HOST_TOKEN` is the freshly initialized local host token, separate from the public password.

Validate these values with `validateProxyEnvironment` before installing a private `host-proxy.env` file. The service template expects this file at `~/.config/pi-research/host-proxy.env`; use mode `0600`. Use the host's actual initialized token. Keep credentials out of command arguments and generated frontend assets.

Both access logging and the default HTTP error logger remove complete request headers and URI fields. The access file uses mode `0600`. URI removal covers single-use browser ticket values in `/ws?ticket=...`.

`pi-research-proxy.service.in` is an installation template. Substitute the exact independent Caddy binary, Caddyfile and deployment directory. Preserve the existing Caddy data/config storage when keeping its internal CA and certificate trust. Place the binary and new Caddyfile outside directories selected for Dashboard deletion. The host service is a separate prerequisite.

The fixture test starts an isolated Caddy instance on temporary loopback ports with synthetic credentials and a synthetic local host. It checks authenticated frontend/API access, the existing sync route, rejection of spoofed credentials, private-route and traversal refusal, ticket issuance, WebSocket replay and a prompt accepted into a real fixture file. It also checks that access logs omit the fixture password, Authorization, host token and WebSocket ticket. Its fixture instance uses HTTP and has the admin API disabled; production HTTPS and the existing CA still need deployment checks.

```sh
PI_RESEARCH_TEST_CADDY=/absolute/path/to/caddy node deploy/proxy.test.mjs
```

Before production cutover, verify the frontend `index.html`, independent host/binary paths, new credentials and private file modes. Stop the old proxy's listener, then start the new proxy on the existing public address. Verify HTTPS trust, anonymous refusal, authenticated API access, a ticket-based WebSocket round trip and the real sync endpoint. The old Caddyfile and service definition remain the rollback input until the new route and process checks pass.

The prepared files perform no production service or configuration changes.
