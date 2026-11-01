#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_RESEARCH_AGENT_DIR:-$HOME/.local/share/pi-research-harness/agent}"
DRY_RUN=false
CONFIG_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --with-dashboard|--with-dashboard-plugins|--with-browser|--with-bundled-skills|--enable-image-generation) CONFIG_ARGS+=("$arg") ;;
    *) echo 'Usage: scripts/install.sh [--dry-run] [--with-dashboard-plugins] [--with-browser] [--with-bundled-skills] [--enable-image-generation]' >&2; exit 2 ;;
  esac
done
if [[ "$DRY_RUN" == true ]]; then
  printf 'Repo: %s\nIsolated agent directory: %s\n' "$ROOT" "$AGENT_DIR"
  printf 'Would install locked Pi 1.3.0 into .runtime/pi, configure a fresh agent directory, install 13 locked packages and apply the released source patch.\n'
  PI_RESEARCH_AGENT_DIR="$AGENT_DIR" node "$ROOT/scripts/configure.mjs" --dry-run ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}
  exit 0
fi
command -v npm >/dev/null || { echo 'Node.js/npm required' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19)){throw Error("Node >=22.19 required for the pinned dashboard ecosystem")}'
if [[ -e "$AGENT_DIR/settings.json" ]]; then
  printf 'Refusing to overwrite existing settings: %s\nChoose a new PI_RESEARCH_AGENT_DIR.\n' "$AGENT_DIR" >&2
  exit 1
fi
mkdir -p "$ROOT/.runtime/pi"
cp "$ROOT/config/locks/pi/package.json" "$ROOT/.runtime/pi/package.json"
cp "$ROOT/config/locks/pi/package-lock.json" "$ROOT/.runtime/pi/package-lock.json"
npm ci --prefix "$ROOT/.runtime/pi" --no-audit --no-fund
PI_RESEARCH_AGENT_DIR="$AGENT_DIR" node "$ROOT/scripts/configure.mjs" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}
node "$ROOT/scripts/install-packages.mjs" "$AGENT_DIR"
node "$ROOT/scripts/apply-subagents-v020.mjs" "$AGENT_DIR"
printf '\nReady. Add %s/bin to PATH, run pi-research, then /login and /model.\n' "$ROOT"
printf 'Dashboard/browser/image/HPC are optional and require separate configuration.\n'
