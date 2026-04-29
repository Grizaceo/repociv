#!/usr/bin/env bash
# ─── RepoCiv — Healthcheck ────────────────────────────────────────────────────
# Exit 0 = healthy, 1 = unhealthy.
# Usage: ./scripts/healthcheck.sh [--quiet]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$REPO_ROOT/.env" | grep -v '^$' | xargs)
fi

BRIDGE_PORT="${BRIDGE_PORT:-5274}"
REPOCIV_PORT="${REPOCIV_PORT:-5273}"
CONFIG_DIR="${REPOCIV_CONFIG_DIR:-$HOME/.repociv}"
LOCKFILE="$CONFIG_DIR/repociv.lock"
QUIET="${1:-}"

_ok()   { [[ "$QUIET" != "--quiet" ]] && echo "  ✔ $*"; }
_fail() { [[ "$QUIET" != "--quiet" ]] && echo "  ✗ $*"; }

PASS=0
FAIL=0

# ─── Lockfile ────────────────────────────────────────────────────────────────
if [[ -f "$LOCKFILE" ]]; then
  BRIDGE_PID=$(grep '^BRIDGE_PID=' "$LOCKFILE" | cut -d= -f2 || true)
  VITE_PID=$(grep   '^VITE_PID='   "$LOCKFILE" | cut -d= -f2 || true)

  if kill -0 "${BRIDGE_PID:-0}" 2>/dev/null; then
    _ok "Bridge proceso vivo (PID $BRIDGE_PID)"
    ((PASS+=1))
  else
    _fail "Bridge proceso muerto (PID ${BRIDGE_PID:-?})"
    ((FAIL+=1))
  fi

  if kill -0 "${VITE_PID:-0}" 2>/dev/null; then
    _ok "Vite proceso vivo (PID $VITE_PID)"
    ((PASS+=1))
  else
    _fail "Vite proceso muerto (PID ${VITE_PID:-?})"
    ((FAIL+=1))
  fi
else
  _fail "Lockfile no encontrado — ¿está RepoCiv arriba?"
  ((FAIL+=1))
fi

# ─── Bridge HTTP ─────────────────────────────────────────────────────────────
if HEALTH=$(curl -sf --max-time 3 "http://localhost:$BRIDGE_PORT/health" 2>/dev/null); then
  if echo "$HEALTH" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    _ok "Bridge /health → ok"
    ((PASS+=1))
  else
    _fail "Bridge /health responde pero no ok: $HEALTH"
    ((FAIL+=1))
  fi
else
  _fail "Bridge /health no responde en localhost:$BRIDGE_PORT"
  ((FAIL+=1))
fi

# ─── Bridge readiness ────────────────────────────────────────────────────────
if READY=$(curl -sf --max-time 3 "http://localhost:$BRIDGE_PORT/ready" 2>/dev/null); then
  if echo "$READY" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    _ok "Bridge /ready → ok"
    ((PASS+=1))
  else
    _fail "Bridge /ready no ok: $READY"
    ((FAIL+=1))
  fi
else
  _fail "Bridge /ready no responde"
  ((FAIL+=1))
fi

# ─── Metrics health ──────────────────────────────────────────────────────────
if METRICS=$(curl -sf --max-time 5 "http://localhost:$BRIDGE_PORT/metrics" 2>/dev/null); then
  HEALTH_FIELD=$(echo "$METRICS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('health','?'))" 2>/dev/null || echo "?")
  case "$HEALTH_FIELD" in
    ok)       _ok "Métricas → SANO"; ((PASS+=1)) ;;
    degraded) _fail "Métricas → DEGRADADO"; ((FAIL+=1)) ;;
    critical) _fail "Métricas → CRÍTICO"; ((FAIL+=1)) ;;
    *)        _fail "Métricas → sin respuesta válida"; ((FAIL+=1)) ;;
  esac
else
  _fail "Bridge /metrics no responde"
  ((FAIL+=1))
fi

# ─── Vite UI ─────────────────────────────────────────────────────────────────
if curl -sf --max-time 3 "http://localhost:$REPOCIV_PORT" > /dev/null 2>&1; then
  _ok "Vite UI → responde en localhost:$REPOCIV_PORT"
  ((PASS+=1))
else
  _fail "Vite UI → no responde en localhost:$REPOCIV_PORT"
  ((FAIL+=1))
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
if [[ "$QUIET" != "--quiet" ]]; then
  echo ""
  if [[ "$FAIL" -eq 0 ]]; then
    echo "✔ Sistema SANO — $PASS/$TOTAL checks OK"
  else
    echo "✗ Sistema DEGRADADO — $PASS/$TOTAL OK, $FAIL fallos"
  fi
fi

[[ "$FAIL" -eq 0 ]]
