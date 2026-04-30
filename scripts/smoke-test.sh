#!/usr/bin/env bash
# ─── RepoCiv — Smoke test ─────────────────────────────────────────────────────
# Runs after dev-start.sh to confirm the system accepts traffic.
# Exit 0 = all checks pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$REPO_ROOT/.env" | grep -v '^$' | xargs)
fi

BRIDGE_PORT="${BRIDGE_PORT:-5274}"
TOKEN="${REPOCIV_TOKEN:-}"
BASE="http://localhost:$BRIDGE_PORT"

PASS=0
FAIL=0

_check() {
  local label="$1" result="$2" expect="$3"
  if echo "$result" | grep -q "$expect"; then
    echo "  ✔ $label"
    ((PASS+=1))
  else
    echo "  ✗ $label (respuesta: ${result:0:120})"
    ((FAIL+=1))
  fi
}

_curl() {
  local args=("$@")
  if [[ -n "$TOKEN" ]]; then
    curl -sf --max-time 5 -H "X-RepoCiv-Token: $TOKEN" "${args[@]}" 2>/dev/null || echo ""
  else
    curl -sf --max-time 5 "${args[@]}" 2>/dev/null || echo ""
  fi
}

_curl_status_body() {
  local args=("$@")
  if [[ -n "$TOKEN" ]]; then
    curl -s --max-time 5 -H "X-RepoCiv-Token: $TOKEN" -w '\nHTTP_STATUS:%{http_code}' "${args[@]}" 2>/dev/null || echo "HTTP_STATUS:000"
  else
    curl -s --max-time 5 -w '\nHTTP_STATUS:%{http_code}' "${args[@]}" 2>/dev/null || echo "HTTP_STATUS:000"
  fi
}

echo "▶ Smoke test RepoCiv → $BASE"

# 1. Health
HEALTH=$(_curl "$BASE/health")
_check "GET /health → ok" "$HEALTH" '"ok"[[:space:]]*:[[:space:]]*true'

# 2. Ready
READY=$(_curl "$BASE/ready")
_check "GET /ready → ok" "$READY" '"ok"[[:space:]]*:[[:space:]]*true'

# 3. Events endpoint
EVENTS=$(_curl "$BASE/events")
_check "GET /events → array" "$EVENTS" '^\[' || _check "GET /events → ok" "$EVENTS" '\[\]'

# 4. Agents endpoint
AGENTS=$(_curl "$BASE/agents")
_check "GET /agents → has queueDepth" "$AGENTS" '"queueDepth"'

# 5. Capabilities endpoint
CAPS=$(_curl "$BASE/agents/capabilities")
_check "GET /agents/capabilities → has DAVI" "$CAPS" '"DAVI"'

# 6. Metrics endpoint
METRICS=$(_curl "$BASE/metrics")
_check "GET /metrics → has health field" "$METRICS" '"health"'

# 7. POST /commands — schema validation without enqueueing/executing a real agent.
# Use an invalid payload intentionally: this exercises auth + request parsing + schema
# rejection while avoiding smoke pollution in the operational queue/event health.
CMD_BODY='{"payload":{"smoke":true}}'
CMD_RESP=$(_curl_status_body -X POST "$BASE/commands" -H "Content-Type: application/json" -d "$CMD_BODY")
_check "POST /commands malformed → 400" "$CMD_RESP" 'HTTP_STATUS:400'
_check "POST /commands malformed → schema error" "$CMD_RESP" '"error"'

# 8. POST /commands — rejected without token (only if token is set)
if [[ -n "$TOKEN" ]]; then
  NO_AUTH=$(curl -s --max-time 5 -X POST "$BASE/commands" \
    -H "Content-Type: application/json" \
    -d "$CMD_BODY" -w '\nHTTP_STATUS:%{http_code}' 2>/dev/null || echo 'HTTP_STATUS:000')
  _check "POST /commands sin token → 401" "$NO_AUTH" 'HTTP_STATUS:401'
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
  echo "✔ Smoke test OK — $PASS/$TOTAL checks"
  exit 0
else
  echo "✗ Smoke test FALLÓ — $PASS/$TOTAL OK, $FAIL fallos"
  exit 1
fi
