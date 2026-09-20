#!/usr/bin/env bash
# ─── RepoCiv — desktop app launcher ───────────────────────────────────────────
# What the .desktop entry runs (installed with `omarchy webapp install`).
#
# RepoCiv is not a hosted site: the window is useless without the local stack,
# so this brings the stack up first and only then opens (or focuses) the window.
#
#   · already running  → just focus the existing window
#   · not running      → start scripts/dev-start.sh detached, wait, then open
#
# Detached on purpose: dev-start.sh traps EXIT and kills Vite along with the
# bridge, so it must not be a child of this short-lived launcher (see the
# lockfile it writes at ~/.repociv/repociv.lock).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${REPOCIV_PORT:-${VITE_PORT:-5273}}"
URL="http://localhost:$PORT"
WINDOW_PATTERN="localhost:$PORT"
LOG_DIR="${REPOCIV_CONFIG_DIR:-$HOME/.repociv}/logs"
BOOT_TIMEOUT=45

up() { curl -sf --max-time 2 "$URL" >/dev/null 2>&1; }

notify() {
  command -v notify-send >/dev/null 2>&1 && notify-send -a RepoCiv "RepoCiv" "$1"
}

if ! up; then
  notify "Levantando el stack…"
  mkdir -p "$LOG_DIR"
  setsid nohup bash "$REPO_ROOT/scripts/dev-start.sh" \
    >>"$LOG_DIR/dev-start.nohup.log" 2>&1 </dev/null &
  disown 2>/dev/null || true

  for _ in $(seq "$BOOT_TIMEOUT"); do
    up && break
    sleep 1
  done

  if ! up; then
    notify "No arrancó en ${BOOT_TIMEOUT}s. Mirá $LOG_DIR/dev-start.nohup.log"
    exit 1
  fi
fi

exec omarchy-launch-or-focus-webapp "$WINDOW_PATTERN" "$URL"
