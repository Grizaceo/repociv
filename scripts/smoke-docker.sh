#!/usr/bin/env bash
# scripts/smoke-docker.sh — End-to-end verification of the Docker stack
# (audit Fase 2 / 2.3). A third party can run this after `docker compose up`
# to confirm the dashboard is reachable, the bridge serves repos, and the
# Hermes fallback (audit 1.1) reports the correct status.
#
# Usage:
#   bash scripts/smoke-docker.sh                  # uses default ports 5273/5274
#   PORT_PREFIX=57 bash scripts/smoke-docker.sh  # shifted host ports
#
# Exit codes:
#   0   all checks passed
#   1   one or more checks failed
#   2   docker / docker compose not available
#   3   container not running (run `docker compose up` first)
#
# What this does NOT do:
#   - Doesn't build the image. Run `docker compose build` first or
#     `docker compose up --build`.
#   - Doesn't clean up. Use `docker compose down` to stop.
#   - Doesn't require Hermes to be running. The "fallback" half of the
#     audit's check ("dashboard funcional con fallback") is exactly this:
#     the dashboard should work even when Hermes is absent.

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────────
PORT_PREFIX="${PORT_PREFIX:-52}"  # 5273/5274/5275 by default
VITE_PORT="${PORT_PREFIX}73"
BRIDGE_PORT="${PORT_PREFIX}74"
BRIDGE_WS_PORT="${PORT_PREFIX}75"
PROXY_PREFIX="/bridge"  # Vite dev server proxy prefix for the bridge

CONTAINER_NAME="${CONTAINER_NAME:-repociv}"
CURL_OPTS=(--max-time 5 --silent --show-error --fail)
HEALTH_OK=0
CHECKS_TOTAL=0
CHECKS_FAILED=0

red()   { printf "\033[31m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
yel()   { printf "\033[33m%s\033[0m" "$1"; }
bold()  { printf "\033[1m%s\033[0m" "$1"; }

# ─── Pre-flight ────────────────────────────────────────────────────────────
echo "$(bold 'RepoCiv Docker smoke test')"
echo "  ports: VITE=$VITE_PORT  BRIDGE=$BRIDGE_PORT  WS=$BRIDGE_WS_PORT"
echo

command -v docker >/dev/null 2>&1 || {
    echo "$(red 'ERROR'): docker CLI not found"; exit 2
}
docker info >/dev/null 2>&1 || {
    echo "$(red 'ERROR'): docker daemon not reachable"; exit 2
}

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "$(red 'ERROR'): container '${CONTAINER_NAME}' is not running"
    echo "  Start it with:  docker compose up -d"
    echo "  Then re-run:    bash scripts/smoke-docker.sh"
    exit 3
fi

# ─── Checks ────────────────────────────────────────────────────────────────
check() {
    local name="$1"; shift
    local cmd=("$@")
    CHECKS_TOTAL=$((CHECKS_TOTAL + 1))
    printf "  [%s] %-40s " "$(yel '...')" "$name"
    if "${cmd[@]}" >/dev/null 2>&1; then
        printf "%s\n" "$(green 'OK')"
    else
        printf "%s\n" "$(red 'FAIL')"
        CHECKS_FAILED=$((CHECKS_FAILED + 1))
    fi
}

echo "$(bold '1. Container health')"
check "container '${CONTAINER_NAME}' is running" \
    bash -c "docker ps --format '{{.Names}}' | grep -q '^${CONTAINER_NAME}$'"

echo
echo "$(bold '2. Dashboard UI reachable')"
check "Vite UI HTTP 200 (http://localhost:$VITE_PORT/)" \
    curl "${CURL_OPTS[@]}" "http://localhost:$VITE_PORT/"

echo
echo "$(bold '3. Workspace scan + bridge HTTP')"
# /api/repos is served by the Vite plugin (dev-time workspace scanner,
# NOT by the bridge). This is the path the browser actually uses to
# populate the city picker. The bridge equivalent /bridge/api/repos
# doesn't exist as a bridge route — Vite handles it.
check "GET /api/repos returns a JSON array" \
    bash -c "out=\$(curl ${CURL_OPTS[*]} http://localhost:$VITE_PORT/api/repos); echo \"\$out\" | grep -qE '^\[.*\]$'"

# /bridge/health goes through the Vite proxy to the bridge. This
# path is the actual round-trip the frontend takes for /api/hermes/status,
# /api/repos (post-bridge), and every other bridge route.
check "GET /bridge/health returns ok=true" \
    bash -c "curl ${CURL_OPTS[*]} http://localhost:$VITE_PORT${PROXY_PREFIX}/health | grep -q '\"ok\": *true'"

echo
echo "$(bold '4. Hermes degraded-mode fallback (audit 1.1)')"
# /api/hermes/status should return a structured object. When Hermes
# is absent (the default in this smoke test), available=false and the
# error mentions a network / connection failure. The frontend renders
# the banner from this object.
check "GET /bridge/api/hermes/status returns valid JSON" \
    bash -c "curl ${CURL_OPTS[*]} http://localhost:$VITE_PORT${PROXY_PREFIX}/api/hermes/status | grep -q '\"available\"'"

check "available=false is the expected state when Hermes is absent" \
    bash -c "out=\$(curl ${CURL_OPTS[*]} http://localhost:$VITE_PORT${PROXY_PREFIX}/api/hermes/status); echo \"\$out\" | grep -q '\"available\": *false'"

check "error field is populated (not null)" \
    bash -c "out=\$(curl ${CURL_OPTS[*]} http://localhost:$VITE_PORT${PROXY_PREFIX}/api/hermes/status); echo \"\$out\" | grep -q '\"error\": *\"[^\"]'"

echo
echo "$(bold '5. Frontend entrypoint intact')"
# The Vite dev server returns the index.html shell with the main module
# script. If the bundle is broken, you'd get a 500 or a different shell.
check "Index HTML references /src/main.ts" \
    bash -c "curl ${CURL_OPTS[*]} http://localhost:$VITE_PORT/ | grep -q 'src/main.ts'"

# ─── Summary ───────────────────────────────────────────────────────────────
echo
if [ "$CHECKS_FAILED" -eq 0 ]; then
    echo "$(green 'OK')  All $CHECKS_TOTAL checks passed."
    echo "  Dashboard is live at: http://localhost:$VITE_PORT/"
    echo "  Hermes banner will show automatically if Hermes is not running."
    exit 0
else
    echo "$(red 'FAIL')  $CHECKS_FAILED of $CHECKS_TOTAL checks failed."
    echo "  Check the container logs:  docker logs $CONTAINER_NAME"
    exit 1
fi
