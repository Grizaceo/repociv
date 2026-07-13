#!/usr/bin/env bash
# Blocking security audit: dependency vulnerabilities, tracked/history secrets,
# authorization/CORS/WS behavior, and selected-repository path containment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

printf '\n== npm dependency audit (high+) ==\n'
npm audit --audit-level=high

printf '\n== Python dependency audit ==\n'
python -m pip_audit --progress-spinner=off

printf '\n== tracked files + Git history secret scan ==\n'
python scripts/scan_git_secrets.py

printf '\n== frontend selected-repo and transport security ==\n'
env -u VITE_BRIDGE_URL -u VITE_BRIDGE_TOKEN -u VITE_REPOCIV_TOKEN -u REPOCIV_TOKEN \
  npx --no-install vitest run \
  vite-plugins/repociv.security.test.ts \
  src/bridge.test.ts \
  src/websocket.test.ts

printf '\n== backend auth, traversal, symlink, CORS and WebSocket security ==\n'
env -u REPOCIV_TOKEN -u REPOCIV_REMOTE -u REPOCIV_CORS_ORIGINS \
  -u REPOCIV_PORT -u BRIDGE_PORT -u BRIDGE_WS_PORT \
  pytest -q \
  server/test_security.py \
  server/test_security_harness.py \
  server/test_command_security.py \
  server/test_bridge_browser_security.py \
  server/test_http_routes_files.py \
  server/test_foreign_route_security.py \
  server/test_bridge_cors.py \
  server/test_websocket_handler.py

printf '\nSecurity audit green.\n'
