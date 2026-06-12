#!/usr/bin/env bash
# RepoCiv Docker entrypoint.
#
# Starts the Python bridge in the background, waits until /health responds,
# then runs the Vite dev server in the foreground. Both processes share this
# container's network namespace, so Vite's proxy at localhost:5274 and the
# frontend's WebSocket at ws://localhost:5275 both resolve to the same
# bridge process. No docker networking tricks required.
#
# Stop: SIGTERM/SIGINT to PID 1 → trap forwards signal to the bridge,
# waits for Vite to exit, then exits with the same code.

set -euo pipefail

# ─── Config (env-overridable) ────────────────────────────────────────────────
BRIDGE_PORT="${BRIDGE_PORT:-5274}"
BRIDGE_WS_PORT="${BRIDGE_WS_PORT:-5275}"
VITE_PORT="${VITE_PORT:-5273}"
BRIDGE_HEALTH_TIMEOUT="${BRIDGE_HEALTH_TIMEOUT:-30}"  # seconds

# Inside the container we always want the bridge listening on 0.0.0.0 so the
# port mapping (-p 5274:5274) is reachable from the host. Override by setting
# BRIDGE_HOST=127.0.0.1 in the environment if you want the dev default.
export BRIDGE_HOST="${BRIDGE_HOST:-0.0.0.0}"

# ─── Pretty banner (matches the Python bridge's own banner) ─────────────────
cat <<'BANNER'
┌──────────────────────────────────────────────────────────────┐
│  RepoCiv — Docker stack (bridge + Vite)                      │
└──────────────────────────────────────────────────────────────┘
BANNER
echo "  Bridge HTTP:    http://localhost:${BRIDGE_PORT}"
echo "  Bridge WS:      ws://localhost:${BRIDGE_WS_PORT}"
echo "  Vite (UI):      http://localhost:${VITE_PORT}"
echo "  MAP_ROOT:       ${REPOCIV_MAP_ROOT:-(not set; using built-in fallback)}"
echo

# ─── Start bridge in the background ──────────────────────────────────────────
echo "[entrypoint] starting bridge (python -m server.bridge)…"
python3 -m server.bridge &
BRIDGE_PID=$!

# Cleanup handler: forward termination signals to both children, wait cleanly.
cleanup() {
    echo
    echo "[entrypoint] received signal — shutting down"
    if kill -0 "$BRIDGE_PID" 2>/dev/null; then
        kill -TERM "$BRIDGE_PID" 2>/dev/null || true
        wait "$BRIDGE_PID" 2>/dev/null || true
    fi
    if kill -0 "$VITE_PID" 2>/dev/null; then
        kill -TERM "$VITE_PID" 2>/dev/null || true
        wait "$VITE_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGTERM SIGINT

# ─── Wait for bridge health endpoint ─────────────────────────────────────────
echo "[entrypoint] waiting for bridge to come up on :${BRIDGE_PORT}…"
for i in $(seq 1 "$BRIDGE_HEALTH_TIMEOUT"); do
    if curl -fsS "http://localhost:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
        echo "[entrypoint] bridge healthy after ${i}s"
        break
    fi
    # Bail early if the bridge died on its own
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
        echo "[entrypoint] bridge process exited unexpectedly" >&2
        wait "$BRIDGE_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

if ! curl -fsS "http://localhost:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
    echo "[entrypoint] bridge failed health check within ${BRIDGE_HEALTH_TIMEOUT}s" >&2
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    exit 1
fi

# ─── Start Vite in the foreground ────────────────────────────────────────────
echo "[entrypoint] starting Vite dev server on :${VITE_PORT}…"
exec npm run dev -- --host 0.0.0.0 --port "${VITE_PORT}" --strictPort
