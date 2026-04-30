#!/usr/bin/env bash
# ─── RepoCiv — Permanent dev startup ──────────────────────────────────────────
# Usage:
#   ./scripts/dev-start.sh          # start bridge + vite
#   ./scripts/dev-start.sh --tmux   # start inside a named tmux session
#
# Criterion (Fase 8): one command from a cold WSL restart → system ready.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ─── Load .env ────────────────────────────────────────────────────────────────
if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

BRIDGE_PORT="${BRIDGE_PORT:-5274}"
REPOCIV_PORT="${REPOCIV_PORT:-5273}"
CONFIG_DIR="${REPOCIV_CONFIG_DIR:-$HOME/.repociv}"
CONFIG_DIR="${CONFIG_DIR/#\~/$HOME}"
LOCKFILE="$CONFIG_DIR/repociv.lock"
LOG_DIR="$CONFIG_DIR/logs"

mkdir -p "$CONFIG_DIR" "$LOG_DIR"

# ─── tmux mode ────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--tmux" ]]; then
  SESSION="repociv"
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "⚡ Adjuntando a sesión tmux '$SESSION' existente…"
    exec tmux attach -t "$SESSION"
  fi
  echo "⚡ Creando sesión tmux '$SESSION'…"
  tmux new-session -d -s "$SESSION" -n bridge "bash $REPO_ROOT/scripts/dev-start.sh; exec bash"
  tmux new-window   -t "$SESSION" -n vite    "bash -c 'sleep 3 && npm run dev --prefix $REPO_ROOT'; exec bash"
  tmux select-window -t "$SESSION:bridge"
  exec tmux attach -t "$SESSION"
fi

# ─── Lockfile check ───────────────────────────────────────────────────────────
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
  echo "  → Lockfile limpiado."
fi

# ─── Kill anything still on the ports ─────────────────────────────────────────
for PORT in "$BRIDGE_PORT" "$REPOCIV_PORT"; do
  PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [[ -n "$PID" ]]; then
    echo "  → Puerto $PORT ocupado por PID $PID — terminando…"
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
done

# ─── Start bridge ─────────────────────────────────────────────────────────────
echo "▶ Iniciando bridge (puerto $BRIDGE_PORT)…"
python3 -m server.bridge \
  >> "$LOG_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

# ─── Start Vite dev server ────────────────────────────────────────────────────
echo "▶ Iniciando Vite (puerto $REPOCIV_PORT)…"
npm run dev \
  >> "$LOG_DIR/vite.log" 2>&1 &
VITE_PID=$!

# ─── Write lockfile ───────────────────────────────────────────────────────────
cat > "$LOCKFILE" <<EOF
BRIDGE_PID=$BRIDGE_PID
VITE_PID=$VITE_PID
BRIDGE_PORT=$BRIDGE_PORT
REPOCIV_PORT=$REPOCIV_PORT
STARTED_AT=$(date +%s)
EOF
echo "  → Lockfile: $LOCKFILE"

# ─── Graceful cleanup on exit ─────────────────────────────────────────────────
_cleanup() {
  echo ""
  echo "⏹ Deteniendo RepoCiv…"
  kill "$BRIDGE_PID" 2>/dev/null || true
  kill "$VITE_PID"   2>/dev/null || true
  rm -f "$LOCKFILE"
  echo "✔ Limpieza completa."
}
trap _cleanup SIGINT SIGTERM EXIT

# ─── Wait for bridge to be ready ─────────────────────────────────────────────
echo "⏳ Esperando que el bridge esté listo…"
READY=0
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$BRIDGE_PORT/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" -eq 0 ]]; then
  echo "✗ Bridge no respondió en 10s. Ver $LOG_DIR/bridge.log"
  exit 1
fi
echo "✔ Bridge listo."

# ─── Smoke test ───────────────────────────────────────────────────────────────
echo "▶ Ejecutando smoke test…"
if bash "$REPO_ROOT/scripts/smoke-test.sh" > /dev/null 2>&1; then
  echo "✔ Smoke test OK."
else
  echo "⚠ Smoke test falló — el sistema puede estar degradado."
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╭─ RepoCiv ─────────────────────────────────────────╮"
echo "│  UI:      http://localhost:$REPOCIV_PORT               │"
echo "│  Bridge:  http://localhost:$BRIDGE_PORT             │"
echo "│  Logs:    $LOG_DIR"
echo "│  PIDs:    bridge=$BRIDGE_PID  vite=$VITE_PID"
echo "│  Ctrl+C para detener                              │"
echo "╰───────────────────────────────────────────────────╯"

# ─── Keep alive — monitor child processes ────────────────────────────────────
while true; do
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "✗ Bridge (PID $BRIDGE_PID) murió — revisa $LOG_DIR/bridge.log"
    exit 1
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "✗ Vite (PID $VITE_PID) murió — revisa $LOG_DIR/vite.log"
    exit 1
  fi
  sleep 5
done
