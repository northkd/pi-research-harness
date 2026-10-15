#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
while IFS= read -r -d '' file; do bash -n "$file"; done < <(find "$ROOT/bin" "$ROOT/scripts" -type f \( -name '*.sh' -o -path "$ROOT/bin/*" \) -print0)
while IFS= read -r -d '' file; do node --check "$file"; done < <(find "$ROOT/integration" "$ROOT/scripts" "$ROOT/tests" "$ROOT/extensions/mainline-supervision" "$ROOT/patches/dashboard" -type f -name '*.mjs' -print0)
printf 'Shell and ESM syntax checks passed. Workflow statement bodies are covered by npm test.\n'
