# Pi Research Harness — AI Agent 自动化部署与配置指南

> **Audience**: LLM Coding Assistants / Autonomous Deployment Agents (Claude Code, Codex CLI, Cursor, Pi, Antigravity, etc.).  
> If a human user pasted this document or its URL to you, follow every phase below **in order**.  
> For human-readable user manuals, see [README](../README.md), [doc/subagents.md](subagents.md), and [doc/multi-agents.md](multi-agents.md).

---

## Agent Execution Contract (Read First)

1. **Preflight before writing**: Inspect OS, runtimes, ports, and existing config paths read-only before running installers or editing config files.
2. **Respect refuse-to-overwrite guards**:
   - `scripts/install.sh` and `scripts/configure.mjs` **refuse** to overwrite an existing `settings.json` inside `PI_RESEARCH_AGENT_DIR`.
   - `scripts/prepare-dashboard.sh` **refuses** to overwrite an existing `.runtime/dashboard-source` directory.
   - `scripts/install-packages.mjs` **refuses** incomplete non-empty `npm/node_modules` directories.
   - **Never** bypass these checks by deleting user files without explicit confirmation.
3. **Never touch personal credentials or unrelated services**: Never copy `~/.pi/agent/auth.json`, browser cookies, or SSH keys. Never store plaintext API keys inside JSON config files or Git repos (use env references such as `"$PI_RESEARCH_PROXY_API_KEY"` or `"${RESEARCH_API_KEY}"`).
4. **Loopback by default**: Keep Dashboard (`127.0.0.1:8000`), Workbench Sync (`127.0.0.1:18767`), and Host (`127.0.0.1:18768`) bound to loopback unless the user explicitly asks for reverse proxy setup.
5. **Confirm decisions once, then execute cleanly**: Ask the user all blocking configuration questions in **one single concise message** (Step 1) before installing.

---

## Step 0 — Read-Only Environment Preflight

Run this read-only diagnostic command first to discover what already exists on the target machine:

```bash
echo "=== OS & Tooling ==="
uname -srm
command -v git python3 node npm pnpm curl || true
node -v 2>/dev/null || true
npm -v 2>/dev/null || true
pnpm -v 2>/dev/null || true

echo "=== Target Defaults ==="
DEFAULT_AGENT_DIR="${PI_RESEARCH_AGENT_DIR:-$HOME/.local/share/pi-research-harness/agent}"
echo "AGENT_DIR=$DEFAULT_AGENT_DIR"
[ -e "$DEFAULT_AGENT_DIR/settings.json" ] && echo "WARN: settings.json already exists at $DEFAULT_AGENT_DIR" || echo "OK: fresh AGENT_DIR"
[ -e "$DEFAULT_AGENT_DIR/extensions/subagent/config.json" ] && echo "INFO: subagent config.json exists" || echo "INFO: no subagent config.json yet"

echo "=== Ports & Optional Local Tools ==="
for p in 8000 18767 18768 8317; do
  (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null || true) | grep -E "[:.]$p\b" && echo "PORT $p IN USE" || echo "PORT $p free"
done
[ -x "$HOME/.local/bin/agy" ] && echo "INFO: agy binary found at $HOME/.local/bin/agy" || echo "INFO: agy binary not present (optional)"
```

**Version requirements**:
- Linux (primary supported platform)
- `git`, `python3`
- `node >= 22.19.0` and `npm`
- `pnpm` (project targets `11.15.1` for Dashboard frontend build; only skipped with `--host-only`)

If `node < 22.19` or `pnpm` is missing (when installing Dashboard), stop and tell the user exactly what prerequisite needs installing or offer to install the missing toolchain if allowed.

---

## Step 1 — Mandatory User Confirmation (Ask Before Mutating)

Ask the user to confirm the following items in **one consolidated question** (do not proceed with guessing secrets or overwriting existing configs):

1. **Repository path & Agent config dir**:
   - Confirm target clone path (e.g. `./pi-research-harness`) and `PI_RESEARCH_AGENT_DIR` (default `$HOME/.local/share/pi-research-harness/agent`).
   - If preflight reported `WARN: settings.json already exists`, require choosing a **new** `PI_RESEARCH_AGENT_DIR` path (or explicitly confirm leaving existing files untouched).
2. **Deployment mode**:
   - **Full Dashboard + Subagents + Multi-Agents** (default, runs `bash scripts/install.sh`)
   - **Headless CLI + Standalone Host only** (`bash scripts/install.sh --host-only`, no `pnpm`/frontend)
   - Optional installer flags only if needed: `--with-browser`, `--with-bundled-skills`, `--enable-image-generation`
3. **Model Provider & 3-Tier Policy Mapping**:
   - **Path A (Local CLIProxyAPI at `127.0.0.1:8317`)**: User sets `PI_RESEARCH_PROXY_API_KEY` in shell and confirms whether `--set-default` should update `settings.json`, plus whether `extensions/research-loop/model-policy.json` IDs match available proxy models.
   - **Path B (Custom OpenAI-compatible Endpoint / `models.json`)**: Ask user for `baseUrl`, env var name for API key (e.g. `RESEARCH_API_KEY`), and exact model IDs to place into `$AGENT_DIR/models.json` **AND** `extensions/research-loop/model-policy.json` (`intelligence`, `commander`, `worker`).
   - **Path C (Interactive `/login` after install)**: User will run `./bin/pi-research` and `/login` + `/model` manually, and supply exact `provider/model-id` strings for `extensions/research-loop/model-policy.json`.
4. **Runtime Launch Preference**:
   - Start background daemons now (`./bin/pi-research-dashboard` + `./bin/pi-research-workbench-sync`) vs install-only and return launch commands.
   - Optionally create a zero-cost demo project (`scripts/create-demo-project.mjs`)?

---

## Step 2 — Deterministic Dry-Run, Clone & Installation

Replace `<REPO_DIR>` and `<AGENT_DIR>` with the confirmed absolute paths:

```bash
export PI_RESEARCH_AGENT_DIR="<AGENT_DIR>"

# 1. Clone if not already inside the repository
git clone --branch main https://github.com/northkd/pi-research-harness.git "<REPO_DIR>"
cd "<REPO_DIR>"

# 2. Mandatory dry-run inspection before mutating anything
bash scripts/install.sh --dry-run   # add --host-only or optional flags if chosen

# 3. Execute idempotent installation
bash scripts/install.sh             # add --host-only or optional flags if chosen
```

### Verify Installation Integrity

Run all applicable post-install verification checks (must exit `0`):

```bash
node scripts/install-packages.mjs "$PI_RESEARCH_AGENT_DIR" --check-only
node scripts/apply-subagents-v020.mjs "$PI_RESEARCH_AGENT_DIR" --check-only

# Only when Full Dashboard mode was installed (skip for --host-only):
node scripts/apply-dashboard-v020.mjs "$PWD/.runtime/dashboard-source" --verify
```

**Expected `install.sh` outputs**:
- Isolated Pi runtime in `.runtime/pi`
- Configured `$PI_RESEARCH_AGENT_DIR/{settings.json,mcp.json,models.example.json,AGENTS.md,agents/*.md,npm/}`
- Patched `pi-subagents@0.79.2` with catalog capacity `MAX_ADVERTISED_AGENTS = 25` / `MAX_CATALOG_BYTES = 20_480`
- Initialized standalone host config under `.runtime/host` (override via `PI_RESEARCH_HOST_DIR`)
- Unless `--host-only`, built Dashboard under `.runtime/dashboard-source` and registered bridges inside `settings.json`

---

## Step 3 — Configure Models & 3-Tier Dispatch Policy

Execute **whichever branch** the user chose in Step 1:

### Option A — Local CLIProxyAPI (`127.0.0.1:8317`)

Never embed the literal API key in any file or command history if the user already exported `PI_RESEARCH_PROXY_API_KEY`:

```bash
node scripts/sync-cliproxy.mjs "$PI_RESEARCH_AGENT_DIR" --set-default
```

Then cross-check `models.json` against `extensions/research-loop/model-policy.json`:

```bash
node -e '
const fs = require("node:fs");
const models = JSON.parse(fs.readFileSync(process.env.PI_RESEARCH_AGENT_DIR + "/models.json", "utf8"));
const have = new Set((models.providers?.cliproxy?.models ?? []).map(m => "cliproxy/" + m.id));
const policy = JSON.parse(fs.readFileSync("extensions/research-loop/model-policy.json", "utf8"));
for (const tier of ["intelligence", "commander", "worker"]) {
  const list = [...policy.tiers[tier].models, ...(policy.tiers[tier].fallbackChain ?? [])];
  const matched = list.filter(id => have.has(id));
  console.log(tier, "matched:", matched.length, "/", list.length, matched);
}
'
```

If any tier reports `matched: 0`, inspect `models.json` and update `extensions/research-loop/model-policy.json` (only replacing missing model IDs with verified available ones after confirming with the user).

### Option B — Custom OpenAI-Compatible `models.json`

Create `$PI_RESEARCH_AGENT_DIR/models.json` with restrictive `0600` permissions, referencing an **environment variable** (never a literal secret):

```bash
umask 077
cat > "$PI_RESEARCH_AGENT_DIR/models.json" <<'EOF'
{
  "providers": {
    "custom": {
      "baseUrl": "<USER_BASE_URL>",
      "api": "openai-completions",
      "apiKey": "${RESEARCH_API_KEY}",
      "models": [
        { "id": "<INTELLIGENCE_MODEL_ID>" },
        { "id": "<COMMANDER_MODEL_ID>" },
        { "id": "<WORKER_MODEL_ID>" }
      ]
    }
  }
}
EOF
```

### Option B & C Shared Step — Align `extensions/research-loop/model-policy.json`

Generic utility subagents (`scout`, `researcher`, `worker`, `delegate`, `reviewer`, `oracle`, `evidence-auditor`) pick dynamic `provider/model-id` strings from `extensions/research-loop/model-policy.json`. If the machine does **not** use `cliproxy/...` IDs, update `extensions/research-loop/model-policy.json` tiers (`intelligence`, `commander`, `worker`, and keep `heavy` consistent if modified) with the user's confirmed `provider/model-id` values and validate JSON syntax:

```bash
python3 -m json.tool extensions/research-loop/model-policy.json > /dev/null
```

---

## Step 4 — Enable Eager Subagent Activation (Recommended)

`scripts/install.sh` does not generate runtime subagent extension preferences. Unless `$PI_RESEARCH_AGENT_DIR/extensions/subagent/config.json` already exists with user customizations, create it so `subagent` is immediately available on turn 1 (`toolActivation: "eager"`) with bounded concurrency:

```bash
if [ ! -e "$PI_RESEARCH_AGENT_DIR/extensions/subagent/config.json" ]; then
  mkdir -p "$PI_RESEARCH_AGENT_DIR/extensions/subagent"
  cat > "$PI_RESEARCH_AGENT_DIR/extensions/subagent/config.json" <<'EOF'
{
  "globalConcurrencyLimit": 3,
  "maxActiveAsyncRunsPerSession": 8,
  "maxSubagentSpawnsPerRun": 24,
  "maxSubagentSpawnsPerSession": 48,
  "maxSubagentDepth": 2,
  "toolActivation": "eager"
}
EOF
else
  echo "SKIP: $PI_RESEARCH_AGENT_DIR/extensions/subagent/config.json already exists; inspect before editing."
fi
```

*(Optional `agy` check: if the user explicitly enabled `agy-advisor`, run `"${AGY_BIN:-$HOME/.local/bin/agy}" models` read-only to verify `agy` is authenticated. Do **not** run inference or change `agents/agy-advisor.md` without user confirmation.)*

---

## Step 5 — Launch Services & Verify Health

Follow the **exact process startup dependency order**:

1. **Terminal / Process 1 — Dashboard Server** (creates `~/.pi/dashboard/local/token` on startup; skip if `--host-only` and instead inspect `./bin/pi-research host help`):
   ```bash
   cd "<REPO_DIR>"
   export PI_RESEARCH_AGENT_DIR="<AGENT_DIR>"
   ./bin/pi-research-dashboard
   ```
   Wait until HTTP health & token creation succeed:
   ```bash
   curl -fsS -o /dev/null -w 'dashboard_http=%{http_code}\n' http://127.0.0.1:8000/
   test -f "$HOME/.pi/dashboard/local/token" && echo "OK: dashboard local token ready"
   ```

2. **Terminal / Process 2 — Workbench Sync** (must share the **exact same** `HOME`, `PI_RESEARCH_AGENT_DIR`, and `PI_DASHBOARD_PORT`):
   ```bash
   cd "<REPO_DIR>"
   export PI_RESEARCH_AGENT_DIR="<AGENT_DIR>"
   ./bin/pi-research-workbench-sync --dry-run
   ./bin/pi-research-workbench-sync
   ```
   Both services bind loopback only (`127.0.0.1:8000` and `127.0.0.1:18767`).

3. **Run Offline Verification Suite** (verifies local harness + scripts):
   ```bash
   cd "<REPO_DIR>"
   python3 scripts/check-release.py
   node scripts/run-tests.mjs
   ```

4. **Optional Zero-Cost Demo Workspace** (only if user requested a demo; path **must not exist yet** and its basename **must** contain `demo` or `演示`):
   ```bash
   node scripts/create-demo-project.mjs /tmp/pi-research-demo
   ```

---

## Step 6 — Troubleshooting & Final Report Format

### Common Failure Fixes for Agents

| Error / Symptom | Root Cause | Remediation |
| --- | --- | --- |
| `Refusing to overwrite existing settings` | Existing `$PI_RESEARCH_AGENT_DIR/settings.json` | Ask user for a new `PI_RESEARCH_AGENT_DIR` directory; never delete existing user state silently |
| `Install pnpm 11.15.1 before preparing this snapshot` | `pnpm` missing from `PATH` | Install `pnpm@11.15.1` (or switch to `--host-only` with user approval) |
| `private dashboard token required` when running sync | Sync started before Dashboard created `~/.pi/dashboard/local/token`, or mismatched `HOME` | Start `./bin/pi-research-dashboard` first, wait for HTTP 200, then launch `./bin/pi-research-workbench-sync` |
| `Locked repair requires a fresh empty managed npm directory` | Interrupted earlier `install-packages.mjs` | Inspect `$AGENT_DIR/npm`, archive/clean only if safe & confirmed, then re-run `install-packages.mjs` |
| `Standalone host tests are enabled after scripts/install.sh` | Running tests before `.runtime/pi` exists | Complete `bash scripts/install.sh`, then re-run `node scripts/run-tests.mjs` |

### Final Summary to Return to the User

Report only facts directly observed in tool outputs:
- Repository path, branch (`main`), and commit SHA
- `PI_RESEARCH_AGENT_DIR` path and files created/verified
- Model setup path chosen (`sync-cliproxy`, `models.json`, or pending `/login` + `/model`) and whether `extensions/research-loop/model-policy.json` was customized
- Whether `extensions/subagent/config.json` (`"toolActivation": "eager"`) is in place
- Running status / commands for `./bin/pi-research-dashboard` (`http://127.0.0.1:8000/`) and `./bin/pi-research-workbench-sync`, plus SSH forwarding tip (`ssh -L 8000:127.0.0.1:8000 <host>`) if remote
- Exact results of `--check-only` / `--verify` / `node scripts/run-tests.mjs` (or any skipped/pending human steps such as `/login` or `agy`)
