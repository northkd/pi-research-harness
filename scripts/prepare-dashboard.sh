#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${PI_RESEARCH_DASHBOARD_SOURCE:-$ROOT/.runtime/dashboard-source}"
[[ "$DEST" == /* ]] || { echo "Use an absolute PI_RESEARCH_DASHBOARD_SOURCE path." >&2; exit 2; }
PIN=65dc4558c7b07ef755ee4f0eda89d9f63e7e76e0
TAG=v0.10.0
if [[ "${1:-}" == "--dry-run" ]]; then
  printf 'Would clone Dashboard %s at %s and apply the verified 0.20 source overlay.\n' "$TAG" "$PIN"
  printf 'Would run pnpm install --frozen-lockfile and build; destination: %s\n' "$DEST"
  printf 'Would register the bundled speed-monitor under resources/plugins without changing user settings.\n'
  printf 'No automatic server start, reload or restart.\n'
  exit 0
fi
if [[ $# -ne 0 ]]; then echo 'Usage: scripts/prepare-dashboard.sh [--dry-run]' >&2; exit 2; fi
command -v git >/dev/null
command -v pnpm >/dev/null || { echo 'Install pnpm 11.15.1 before preparing this snapshot.' >&2; exit 1; }
[[ ! -e "$DEST" ]] || { echo 'Refusing to overwrite existing dashboard checkout.' >&2; exit 1; }
mkdir -p "$(dirname -- "$DEST")"
git clone --depth 1 --branch "$TAG" --filter=blob:none --sparse https://github.com/BlackBeltTechnology/pi-agent-dashboard.git "$DEST"
git -C "$DEST" sparse-checkout set packages scripts patches public
actual="$(git -C "$DEST" rev-parse HEAD)"
[[ "$actual" == "$PIN" ]] || { printf 'Unexpected upstream tag commit: %s\n' "$actual" >&2; exit 1; }
node "$ROOT/scripts/apply-dashboard-v020.mjs" "$DEST"
node "$ROOT/scripts/register-dashboard-extras.mjs" "$DEST"
(cd "$DEST" && pnpm install --frozen-lockfile && pnpm run build)
node "$ROOT/scripts/install-demo-entry.mjs" "$DEST/packages/client/dist"
node "$ROOT/scripts/apply-dashboard-v020.mjs" "$DEST" --verify
printf 'Dashboard prepared. Add its packages/extension path to your isolated agent settings.\n'
printf 'This command did NOT start, reload or restart any service.\n'
