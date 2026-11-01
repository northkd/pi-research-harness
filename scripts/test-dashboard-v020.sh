#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DASHBOARD="${PI_RESEARCH_DASHBOARD_SOURCE:-$ROOT/.runtime/dashboard-source}"
[[ -f "$DASHBOARD/packages/shared/src/platform/native-ts-register.mjs" ]] || { echo 'Prepare the dashboard source first.' >&2; exit 1; }
cd "$ROOT"
PI_RESEARCH_DASHBOARD_SOURCE="$DASHBOARD" node --import "$DASHBOARD/packages/shared/src/platform/native-ts-register.mjs" --test tests/dashboard-route-isolation.integration.mjs
