#!/usr/bin/env bash
# ─── RepoCiv — Clean shutdown ─────────────────────────────────────────────────
# Reads the lockfile, kills bridge + vite, removes lockfile.
# Safe to run even if processes are already dead.
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

CONFIG_DIR="${REPOCIV_CONFIG_DIR:-$HOME/.repociv}"
CONFIG_DIR="${CONFIG_DIR/#\~/$HOME}"
LOCKFILE="$CONFIG_DIR/repociv.lock"
REPOCIV_PORT="${REPOCIV_PORT:-${VITE_PORT:-5273}}"

_kill() {
  local pid="$1" label="$2"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "  ⏹ Deteniendo $label (PID $pid)…"
    kill "$pid" 2>/dev/null || true
    # Give it 3 s to exit cleanly, then SIGKILL
    for _ in 1 2 3; do
      sleep 1
      kill -0 "$pid" 2>/dev/null || return 0
    done
    echo "  ✗ $label no terminó — forzando SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "  ℹ $label (PID ${pid:-?}) ya no existe"
  fi
}

if [[ ! -f "$LOCKFILE" ]]; then
  echo "⚠ No se encontró lockfile en $LOCKFILE — nada que detener."
  # Still try to kill anything on the ports
  for PORT in "${BRIDGE_PORT:-5274}" "${REPOCIV_PORT:-5273}"; do
    PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    [[ -n "$PID" ]] && kill "$PID" 2>/dev/null && echo "  ⏹ Puerto $PORT liberado (PID $PID)"
  done
  exit 0
fi

BRIDGE_PID=$(grep '^BRIDGE_PID=' "$LOCKFILE" | cut -d= -f2 || true)
VITE_PID=$(grep   '^VITE_PID='   "$LOCKFILE" | cut -d= -f2 || true)

echo "⏹ Deteniendo RepoCiv…"
_kill "${BRIDGE_PID:-}" "bridge"
_kill "${VITE_PID:-}"   "vite"

rm -f "$LOCKFILE"
echo "✔ Lockfile eliminado."
echo "✔ RepoCiv detenido."
