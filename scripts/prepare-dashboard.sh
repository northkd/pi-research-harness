#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${PI_RESEARCH_DASHBOARD_SOURCE:-$ROOT/.runtime/dashboard-source}"
MANIFEST="$ROOT/config/dashboard-v020.json"
[[ "$DEST" == /* ]] || { printf 'Dashboard destination must be absolute.\n' >&2; exit 2; }
if [[ "$#" == 1 && "$1" == --dry-run ]]; then
  printf 'Would build Pi Research Dashboard in %s using the pinned upstream and verified overlay.\n' "$DEST"
  exit 0
fi
[[ "$#" == 0 ]] || { printf 'Usage: scripts/prepare-dashboard.sh [--dry-run]\n' >&2; exit 2; }
[[ ! -e "$DEST" && ! -L "$DEST" ]] || { printf 'Refusing to overwrite existing Dashboard checkout: %s\n' "$DEST" >&2; exit 1; }
command -v pnpm >/dev/null || { printf 'Install pnpm 11.15.1 (or enable its Corepack shim).\n' >&2; exit 1; }
HOST_MODULE="$(dirname -- "$DEST")/research-host"
if [[ -e "$HOST_MODULE" || -L "$HOST_MODULE" ]]; then
  [[ "$HOST_MODULE" -ef "$ROOT/extensions/research-host" ]] || { printf 'Conflicting research-host path: %s\n' "$HOST_MODULE" >&2; exit 1; }
fi
PIN="$(node -p 'require(process.argv[1]).upstreamCommit' "$MANIFEST")"
TAG="$(node -p 'require(process.argv[1]).upstreamTag' "$MANIFEST")"
mkdir -p "$(dirname -- "$DEST")"
git clone --depth 1 --branch "$TAG" --filter=blob:none --sparse https://github.com/BlackBeltTechnology/pi-agent-dashboard.git "$DEST"
[[ "$(git -C "$DEST" rev-parse HEAD)" == "$PIN" ]] || { printf 'Dashboard upstream tag does not match the release manifest.\n' >&2; exit 1; }
git -C "$DEST" sparse-checkout set packages scripts patches public
node "$ROOT/scripts/apply-dashboard-v020.mjs" "$DEST"
# The Dashboard server imports the harness services as a sibling of its checkout.
if [[ ! -e "$HOST_MODULE" ]]; then ln -s "$ROOT/extensions/research-host" "$HOST_MODULE"; fi
node "$ROOT/scripts/register-dashboard-extras.mjs" "$DEST"
(
  cd "$DEST"
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
  # The client prepare hook builds and compresses the production web assets.
  pnpm install --frozen-lockfile
  npm run build:app --workspace=@blackbelt-technology/pi-dashboard-team-plugin
  test -s packages/client/dist/index.html
)
node "$ROOT/scripts/apply-dashboard-v020.mjs" "$DEST" --verify
