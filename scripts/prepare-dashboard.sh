#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.runtime/dashboard-source"
PIN=04985091706cb77d5e2f73bbf8b906966e9d97c7
if [[ "${1:-}" == "--dry-run" ]]; then
  printf 'Would clone https://github.com/BlackBeltTechnology/pi-agent-dashboard.git\n'
  printf 'Checkout %s, apply 4 release patches, pnpm install --frozen-lockfile and pnpm run build.\n' "$PIN"
  printf 'Would add content-hashed text-containment CSS and a bounded-preview toggle module after building (no existing JavaScript replacement).\n'
  printf 'Destination: %s\nNo automatic server start/reload/restart.\n' "$DEST"
  exit 0
fi
if [[ $# -ne 0 ]]; then echo 'Usage: scripts/prepare-dashboard.sh [--dry-run]' >&2; exit 2; fi
command -v git >/dev/null
command -v pnpm >/dev/null || { echo 'Install pnpm 11.15.1 separately before preparing this snapshot.' >&2; exit 1; }
[[ ! -e "$DEST" ]] || { echo 'Refusing to overwrite existing dashboard checkout.' >&2; exit 1; }
mkdir -p "$ROOT/.runtime"
git clone https://github.com/BlackBeltTechnology/pi-agent-dashboard.git "$DEST"
git -C "$DEST" checkout --detach "$PIN"
for patch in "$ROOT/patches/dashboard/0001-deployed-frontend.patch" "$ROOT/patches/dashboard/0002-deployed-native-bridge.patch" "$ROOT/patches/dashboard/0003-deployed-runtime-config.patch" "$ROOT/patches/dashboard/0004-current-development.patch"; do
  git -C "$DEST" apply --check "$patch"
  git -C "$DEST" apply "$patch"
done
node "$ROOT/scripts/verify-dashboard.mjs" "$DEST"
(cd "$DEST" && pnpm install --frozen-lockfile && pnpm run build)
node "$ROOT/scripts/apply-dashboard-layout.mjs" "$DEST/packages/client/dist" --apply
printf 'Dashboard prepared. Before starting, add its packages/extension path to your isolated agent settings.\n'
printf 'See docs/INSTALL.md. This command did NOT start, reload or restart any service.\n'
