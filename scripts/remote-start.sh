#!/usr/bin/env bash
# ─── RepoCiv — Remote startup via Tailscale ───────────────────────────────────
# Usage:
#   REPOCIV_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))")
#   ./scripts/remote-start.sh
#
# Requires:
#   1. Tailscale installed and connected
#   2. REPOCIV_TOKEN set (either in .env or as env var)
#
# This script starts both services (bridge + Vite) bound to 0.0.0.0,
# making them accessible from any device on your Tailscale network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ─── Load .env ────────────────────────────────────────────────────────────────
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BRIDGE_PORT="${BRIDGE_PORT:-5274}"
REPOCIV_PORT="${REPOCIV_PORT:-${VITE_PORT:-5273}}"
export VITE_PORT="${VITE_PORT:-$REPOCIV_PORT}"
CONFIG_DIR="${REPOCIV_CONFIG_DIR:-$HOME/.repociv}"
CONFIG_DIR="${CONFIG_DIR/#\~/$HOME}"
LOCKFILE="$CONFIG_DIR/repociv-remote.lock"
LOG_DIR="$CONFIG_DIR/logs"

mkdir -p "$CONFIG_DIR" "$LOG_DIR"

# ─── Validate: token is required ──────────────────────────────────────────────
if [[ -z "${REPOCIV_TOKEN:-}" ]]; then
  echo "✗ ERROR: REPOCIV_TOKEN is required for remote mode."
  echo ""
  echo "  Generate one:"
  echo "    python3 -c \"import secrets; print(secrets.token_hex(32))\""
  echo ""
  echo "  Then either:"
  echo "    export REPOCIV_TOKEN=the_generated_token"
  echo "    # or add to .env:"
  echo "    echo 'REPOCIV_TOKEN=the_generated_token' >> .env"
  exit 1
fi

# Check length (min 32 chars)
if [[ ${#REPOCIV_TOKEN} -lt 32 ]]; then
  echo "✗ ERROR: REPOCIV_TOKEN must be at least 32 characters. Got ${#REPOCIV_TOKEN}."
  exit 1
fi

# ─── Detect Tailscale IP ──────────────────────────────────────────────────────
TAILSCALE_IP=""
if command -v tailscale &>/dev/null; then
  TAILSCALE_IP=$(tailscale status --self 2>/dev/null | head -1 | awk '{print $1}' || true)
fi
if [[ -z "$TAILSCALE_IP" ]]; then
  # Try alternative method
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
fi

# ─── Export remote mode ───────────────────────────────────────────────────────
export REPOCIV_REMOTE=true

# ─── Kill any existing services ───────────────────────────────────────────────
_kill_stale() {
  local pid="$1" label="$2"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "  → Terminando proceso $label anterior (PID $pid)…"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}

if [[ -f "$LOCKFILE" ]]; then
  echo "⚠ Lockfile encontrado: $LOCKFILE"
  PREV_BRIDGE=$(grep '^BRIDGE_PID=' "$LOCKFILE" | cut -d= -f2 || true)
  PREV_VITE=$(grep '^VITE_PID='   "$LOCKFILE" | cut -d= -f2 || true)
  _kill_stale "${PREV_BRIDGE:-}" "bridge"
  _kill_stale "${PREV_VITE:-}"   "vite"
  rm -f "$LOCKFILE"
fi

for PORT in "$BRIDGE_PORT" "$REPOCIV_PORT"; do
  PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [[ -n "$PID" ]]; then
    echo "  → Puerto $PORT ocupado por PID $PID — terminando…"
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
done

# ─── Python venv ──────────────────────────────────────────────────────────────
if [[ ! -d "$REPO_ROOT/.venv" ]]; then
  echo "▶ Creando entorno virtual Python (.venv)…"
  python3 -m venv "$REPO_ROOT/.venv"
fi
# shellcheck disable=SC1091
source "$REPO_ROOT/.venv/bin/activate"

# ─── Start bridge (remote mode) ───────────────────────────────────────────────
echo "▶ Iniciando bridge en modo REMOTE (puerto $BRIDGE_PORT)…"
python3 -m server.bridge \
  >> "$LOG_DIR/bridge-remote.log" 2>&1 &
BRIDGE_PID=$!

# ─── Start Vite dev server (already binds 0.0.0.0 via host: true) ────────────
echo "▶ Iniciando Vite (puerto $REPOCIV_PORT)…"
npm run dev \
  >> "$LOG_DIR/vite-remote.log" 2>&1 &
VITE_PID=$!

# ─── Write lockfile ───────────────────────────────────────────────────────────
cat > "$LOCKFILE" <<EOF
BRIDGE_PID=$BRIDGE_PID
VITE_PID=$VITE_PID
BRIDGE_PORT=$BRIDGE_PORT
REPOCIV_PORT=$REPOCIV_PORT
TAILSCALE_IP=${TAILSCALE_IP:-unknown}
STARTED_AT=$(date +%s)
EOF
echo "  → Lockfile: $LOCKFILE"

# ─── Graceful cleanup ─────────────────────────────────────────────────────────
_cleanup() {
  echo ""
  echo "⏹ Deteniendo RepoCiv (remote)…"
  kill "$BRIDGE_PID" 2>/dev/null || true
  kill "$VITE_PID"   2>/dev/null || true
  rm -f "$LOCKFILE"
  echo "✔ Limpieza completa."
}
trap _cleanup SIGINT SIGTERM EXIT

# ─── Wait for bridge ──────────────────────────────────────────────────────────
echo "⏳ Esperando que el bridge esté listo…"
READY=0
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$BRIDGE_PORT/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" -eq 0 ]]; then
  echo "✗ Bridge no respondió en 10s. Ver $LOG_DIR/bridge-remote.log"
  exit 1
fi
echo "✔ Bridge listo."

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╭─ RepoCiv — REMOTE ───────────────────────────────────╮"
echo "│                                                       │"
if [[ -n "$TAILSCALE_IP" ]]; then
  echo "│  Tailscale:  $TAILSCALE_IP                                  │"
  echo "│  UI:         http://${TAILSCALE_IP}:${REPOCIV_PORT}                 │"
  echo "│  Bridge:     http://${TAILSCALE_IP}:${BRIDGE_PORT}               │"
  echo "│  WebSocket:  ws://${TAILSCALE_IP}:5275                 │"
else
  echo "│  ⚠ Tailscale no detectado                              │"
  echo "│  UI:         http://<tailscale-ip>:$REPOCIV_PORT           │"
  echo "│  Bridge:     http://<tailscale-ip>:$BRIDGE_PORT         │"
fi
echo "│                                                       │"
echo "│  Logs:       $LOG_DIR                │"
echo "│  PIDs:       bridge=$BRIDGE_PID  vite=$VITE_PID          │"
echo "│  Ctrl+C para detener                                  │"
echo "╰───────────────────────────────────────────────────────╯"

# ─── Keep alive ───────────────────────────────────────────────────────────────
while true; do
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "✗ Bridge (PID $BRIDGE_PID) murió — revisa $LOG_DIR/bridge-remote.log"
    exit 1
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "✗ Vite (PID $VITE_PID) murió — revisa $LOG_DIR/vite-remote.log"
    exit 1
  fi
  sleep 5
done
