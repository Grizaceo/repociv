#!/usr/bin/env bash
# scripts/e2e-ci-sim.sh — reproduce the CI e2e conditions locally.
#
# CI (.github/workflows/ci.yml) seeds a synthetic workspace state before the
# Playwright run, because a fresh machine has no active map root and no repo
# selection — the UI would open the picker wizard and most specs would fail on
# missing elements. This script recreates exactly that environment:
#
#   * demo-workspace as REPOCIV_MAP_ROOT / WORKSPACE_ROOT / REPOCIV_REPOS_ROOT
#   * a seeded state file (same node block as the CI step)
#   * isolated XDG_STATE_HOME and REPOCIV_CONFIG_DIR, and no local .env (bridge
#     stores and ledger writes stay out of the live ~/.repociv)
#   * ports 5373-5375 (CI-equivalent, never the live dev stack on 5273-5275)
#
# Resource discipline: this is a local helper, not CI. It pins the run to two
# CPUs at the lowest priority and one Playwright worker by default, so a dev
# machine (or a machine also running the live dashboard) stays usable. Use
# E2E_SIM_FULL=1 for the CI shape (every CPU, two workers); E2E_SIM_CPUS,
# E2E_SIM_WORKERS and E2E_SIM_NICE override the frugal defaults.
#
# Usage:
#   scripts/e2e-ci-sim.sh                          # full suite, like CI
#   scripts/e2e-ci-sim.sh e2e/repociv.spec.ts      # one spec
#   scripts/e2e-ci-sim.sh e2e/render-mode-parity.spec.ts --repeat-each=3
#   E2E_SIM_FULL=1 scripts/e2e-ci-sim.sh           # CI shape (heavy)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

TMP="${REPOCIV_E2E_SIM_DIR:-/tmp/e2e-ci-sim}"
ROOT="${REPO_ROOT}/demo-workspace"

if [[ ! -d "${ROOT}" ]]; then
  echo "demo-workspace not found at ${ROOT}" >&2
  exit 1
fi

rm -rf "${TMP}"
mkdir -p "${TMP}"

# Same seed as the "Seed demo workspace state for e2e" CI step.
DEMO_ROOT="${ROOT}" STATE_FILE="${TMP}/state.json" node -e '
  const fs = require("node:fs");
  const root = process.env.DEMO_ROOT;
  const repos = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => `${root}/${d.name}`)
    .sort();
  const now = new Date().toISOString();
  fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({
    version: 1,
    activeRoot: root,
    roots: { [root]: { selectedRepoPaths: repos, addedAt: now, lastSeen: now } },
  }, null, 2));
'

export REPOCIV_MAP_ROOT="${ROOT}"
export WORKSPACE_ROOT="${ROOT}"
export REPOCIV_REPOS_ROOT="${ROOT}"
export REPOCIV_STATE_FILE="${TMP}/state.json"
export XDG_STATE_HOME="${TMP}/xdg"
# Every bridge store resolves under REPOCIV_CONFIG_DIR (server/state_paths.py);
# without this the spawned bridge would write the live ~/.repociv. The local
# .env is skipped too (it may carry the live token and REPOCIV_CONFIG_DIR).
export REPOCIV_CONFIG_DIR="${TMP}/repociv"
export REPOCIV_SKIP_DOTENV=1
export REPOCIV_PORT=5373 VITE_PORT=5373 BRIDGE_PORT=5374 BRIDGE_WS_PORT=5375

# CI has no Hermes harness, so the app shows the degraded-mode banner (and the
# banner's fixed strip covers the top bar). E2E_SIM_NO_HERMES=1 reproduces that
# condition locally by pointing the bridge probe at a dead port.
if [[ "${E2E_SIM_NO_HERMES:-0}" == "1" ]]; then
  export HERMES_URL=http://127.0.0.1:9/v1
fi

if [[ "${E2E_SIM_FULL:-0}" == "1" ]]; then
  echo "e2e-ci-sim: root=${ROOT} state=${TMP}/state.json ports=5373-5375 (CI shape: all CPUs, 2 workers)"
  exec npx playwright test "$@" --reporter=list
fi

CPUS="${E2E_SIM_CPUS:-0,1}"
WORKERS="${E2E_SIM_WORKERS:-1}"
NICE="${E2E_SIM_NICE:-19}"
echo "e2e-ci-sim: root=${ROOT} state=${TMP}/state.json ports=5373-5375 cpus=${CPUS} workers=${WORKERS} nice=${NICE}"
exec nice -n "${NICE}" taskset -c "${CPUS}" npx playwright test "$@" --reporter=list --workers="${WORKERS}"
