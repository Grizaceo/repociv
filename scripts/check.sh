#!/usr/bin/env bash
# scripts/check.sh — single source of truth for the "is the build green?" gate.
#
# Runs all checks that the project considers blocking:
#   1. tsc --noEmit          (TypeScript types)
#   2. eslint --max-warnings=0 (TS/TSX lint, zero warnings)
#   3. vitest run            (TS unit tests)
#   4. vite build            (production bundle smoke)
#   5. ruff check server/    (Python lint)
#   6. pytest -q             (Python unit tests)
#
# Exit code is the first failure (or 0 on full green). Designed to be
# idempotent and safe to run repeatedly. No `set -e` global because we
# want to keep going through earlier checks and report all failures —
# callers that want fast-fail can pipe through `head` or check $?.

set -u
set -o pipefail

# Resolve repo root from this script's location (works under CI and locally).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

failures=()
log() { printf "\n\033[1;34m== %s ==\033[0m\n" "$1"; }
warn() { printf "\033[1;31m[FAIL]\033[0m %s\n" "$1"; }

run_step() {
  local name="$1"; shift
  log "${name}"
  if "$@"; then
    printf "\033[1;32m[OK]\033[0m   %s\n" "${name}"
  else
    warn "${name}"
    failures+=("${name}")
  fi
}

# Frontend
run_step "tsc --noEmit"                   npx --no-install tsc --noEmit
run_step "eslint (max-warnings=0)"       npm run -s lint
run_step "vitest run"                     npx --no-install vitest run
run_step "vite build"                     npx --no-install vite build

# Backend
run_step "ruff check server/"             ruff check server/
run_step "pytest -q"                      pytest -q

# Summary
if (( ${#failures[@]} > 0 )); then
  printf "\n\033[1;31m%d check(s) failed:\033[0m\n" "${#failures[@]}"
  for f in "${failures[@]}"; do
    printf "  - %s\n" "${f}"
  done
  exit 1
fi

printf "\n\033[1;32mAll checks green.\033[0m\n"
