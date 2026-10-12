#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_RESEARCH_AGENT_DIR:-$HOME/.local/share/pi-research-harness/agent}"
if [[ "${1:-}" == "--dry-run" ]]; then
  printf 'Repo: %s\nIsolated agent directory: %s\n' "$ROOT" "$AGENT_DIR"
  printf 'Would install Pi 1.0.0 into .runtime/pi, configure a fresh agent directory, then resolve pinned Pi packages.\n'
  PI_RESEARCH_AGENT_DIR="$AGENT_DIR" node "$ROOT/scripts/configure.mjs" --dry-run
  exit 0
fi
if [[ $# -ne 0 ]]; then echo 'Usage: scripts/install.sh [--dry-run]' >&2; exit 2; fi
command -v npm >/dev/null || { echo 'Node.js/npm required' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19)){throw Error("Node >=22.19 required for the pinned dashboard ecosystem")}'
if [[ -e "$AGENT_DIR/settings.json" ]]; then
  printf 'Refusing to overwrite existing settings: %s\nChoose a new PI_RESEARCH_AGENT_DIR.\n' "$AGENT_DIR" >&2
  exit 1
fi
mkdir -p "$ROOT/.runtime/pi"
printf '{"private":true,"dependencies":{"@earendil-works/pi-coding-agent":"1.0.0"}}\n' > "$ROOT/.runtime/pi/package.json"
npm install --prefix "$ROOT/.runtime/pi" --no-audit --no-fund
PI_RESEARCH_AGENT_DIR="$AGENT_DIR" node "$ROOT/scripts/configure.mjs"
PI_CODING_AGENT_DIR="$AGENT_DIR" "$ROOT/.runtime/pi/node_modules/.bin/pi" update --extensions
printf '\nReady. Add %s/bin to PATH, run pi-research, then /login and /model.\n' "$ROOT"
printf 'Dashboard/browser/image/HPC are optional and require separate configuration.\n'
