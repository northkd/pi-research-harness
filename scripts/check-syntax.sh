#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
while IFS= read -r -d '' file; do bash -n "$file"; done < <(find "$ROOT/bin" "$ROOT/scripts" -type f \( -name '*.sh' -o -path "$ROOT/bin/*" \) -print0)
while IFS= read -r -d '' file; do node --check "$file"; done < <(find "$ROOT/integration" "$ROOT/scripts" "$ROOT/tests" "$ROOT/extensions/mainline-supervision" "$ROOT/extensions/research-loop" "$ROOT/patches/dashboard" "$ROOT/patches/dashboard-v0.20" -type f \( -name '*.mjs' -o -name '*.cjs' \) -print0)
printf 'Shell and ESM syntax checks passed. Workflow statement bodies are covered by npm test.\n'
