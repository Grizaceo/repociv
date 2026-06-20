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
run_step "ruff check scripts/"            ruff check scripts/
run_step "pytest -q"                      pytest -q

# Asset budget: the 3 terrain atlas PNGs must stay under 6MB combined.
# (The Blender/numpy generators can silently fatten them; tracked binaries
# bloat every clone.)
check_asset_budget() {
  local total
  total=$(find public/assets/3d -name '*.png' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')
  local limit=$((6 * 1024 * 1024))
  if (( total > limit )); then
    echo "terrain atlas PNGs total $((total / 1024 / 1024))MB > 6MB budget"
    return 1
  fi
  echo "terrain atlas PNGs total: $((total / 1024))KB (budget 6MB)"
}
run_step "asset budget (atlas ≤6MB)"      check_asset_budget

# Prop glTF budget: low-poly props (public/assets/3d/props/*.glb) have
# their own 1.5MB envelope, separate from the atlas PNGs.
check_props_budget() {
  local total
  total=$(find public/assets/3d/props -name '*.glb' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')
  local limit=$((1536 * 1024))
  if (( total > limit )); then
    echo "prop glbs total $((total / 1024))KB > 1.5MB budget"
    return 1
  fi
  echo "prop glbs total: $((total / 1024))KB (budget 1.5MB)"
}
run_step "asset budget (props ≤1.5MB)"    check_props_budget

# Eager-bundle budget: the JS the browser downloads on first paint (the app
# defaults to the 2D 'flat' renderer) must stay lean. Three.js (vendor-three,
# ~157KB gzip) MUST stay lazy — it only loads for ?renderer=webgl / hotkey 3.
# This guards against a regression like the static-import leak that pulled
# Three into the eager graph (fixed 2026-06). Reuses the dist/ from the
# `vite build` step above.
check_eager_bundle_budget() {
  local index="dist/index.html"
  if [[ ! -f "${index}" ]]; then
    echo "dist/index.html missing — vite build must run first"
    return 1
  fi
  # Three must never be in the eager (modulepreload/entry) set.
  if grep -q 'vendor-three' "${index}"; then
    echo "vendor-three is referenced by index.html — Three.js leaked into the eager 2D bundle"
    return 1
  fi
  # Sum gzip sizes of every /assets/*.js the entry eagerly pulls.
  local total=0 path f gz
  while IFS= read -r path; do
    f="dist${path}"
    [[ -f "${f}" ]] || continue
    gz=$(gzip -c "${f}" | wc -c)
    total=$((total + gz))
  done < <(grep -oE '/assets/[A-Za-z0-9_.-]+\.js' "${index}" | sort -u)
  local limit=$((185 * 1024))
  local kb=$((total / 1024))
  if (( total > limit )); then
    echo "eager JS ${kb}KB gzip > 185KB budget — something heavy entered the initial 2D load"
    return 1
  fi
  echo "eager JS: ${kb}KB gzip (budget 185KB; Three.js stays lazy)"
}
run_step "bundle budget (eager JS ≤185KB)" check_eager_bundle_budget

# Tooling (non-blocking: report only)
log "knip (report only)"
if npx --no-install knip --exclude duplicates 2>&1; then
  printf "\033[1;32m[OK]\033[0m   knip\\n"
else
  printf "\033[1;33m[INFO]\033[0m knip found items (non-blocking)\\n"
fi

# Summary
if (( ${#failures[@]} > 0 )); then
  printf "\n\033[1;31m%d check(s) failed:\033[0m\n" "${#failures[@]}"
  for f in "${failures[@]}"; do
    printf "  - %s\n" "${f}"
  done
  exit 1
fi

printf "\n\033[1;32mAll checks green.\033[0m\n"
