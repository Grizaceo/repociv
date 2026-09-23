# Evidencia: Fase 5 — Canal proceso-owned de Claude Code (implementación)

**Fecha**: 2026-09-23
**Rama**: `feat/external-agents-chat`
**Base**: evidencia de investigación `2026-09-21-claude-code-channel-research.md` (PROBE-L)
**Método**: TDD (tests primero), smoke real contra la CLI, gate completo `scripts/check.sh`.

## Alcance implementado

El diseño cerrado pedía cuatro piezas; las cuatro están en el árbol:

| Pieza | Dónde | Qué hace |
|---|---|---|
| Manager proceso-owned | `server/claude_live.py` (nuevo, 363 líneas) | spawn/send/stop de procesos `claude` stream-json; serializa envíos por sesión |
| Fuente del tracker | `server/claude_live.py` → `ClaudeLiveSource` | publica las sesiones propias; declara `live` directamente (es dueña del pid) |
| Adaptador real | `server/live_session_chat.py` → `ClaudeLiveChatAdapter` | resuelve por `agent`; capability fail-closed fuera del canal propio |
| Endpoints | `server/routes/core.py` + `registry.py` + `http_routes.py` | `POST /api/claude-live/spawn`, `POST /api/claude-live/stop` |

### Invariante de liveness (el punto delicado)

`ExternalAgentTracker._with_liveness` (línea ~702 de `suvadu_tracker.py`) pisaba
`live` incondicionalmente con el probe aproximado de `/proc`. El proceso
stream-json **no lleva el session-id en el cmdline**, así que ese probe jamás lo
encontraría. Fix: `_with_liveness` **respeta un `live` ya declarado por la
fuente**; solo anota las observaciones que traen `live is None`. Test dedicado:
`test_source_declared_live_survives_the_process_probe`.

### Anti-duplicación

Cada spawn registra su id vía `claude_sessions.record_owned` (nuevo), así el
escaneo de Suvadu lo salta y la fila del canal propio es la única unidad — no
aparecen sesiones duplicadas por el envío.

## Verificación empírica (smoke real, sin fakes)

`/home/gris96/.hermes/cache/scratch/phase5/smoke_claude_live.py` contra la CLI
real (`/home/gris96/.local/bin/claude`, 2.1.278), cwd en scratch:

```
claude_bin: /home/gris96/.local/bin/claude
spawned: {"nativeId": "d45b1851-…", "sessionId": "claude-live-d45b1851-…", …}
turns: 2
reply: 'pong'          ← turno del asistente leído del stream stdout
sessions: [{..., "alive": true}]
stopped: d45b1851-…
SMOKE_EXIT=0
```

Secuencia completa: spawn (argv PROBE-L + `redact_env_for_spawn`) → send
(stream-json por stdin) → `result` (reader thread) → stop. Limpieza verificada:
`claude agents --json --all` solo muestra la sesión interactiva del usuario.

## Gate

`bash scripts/check.sh` → **All checks green** (exit 0):

- tsc, eslint (max-warnings 0), prettier, vitest (1014 passed), vite build, budgets — verdes;
- ruff server/ y scripts/ — verdes (vía la resolución a `.venv/bin/ruff` nueva en `check.sh`);
- pytest: **1188 passed, 2 skipped**, cobertura 81.35% (piso 50%);
  `server/claude_live.py` 78%, `server/test_claude_live.py` 95%.

Tests nuevos TDD: 12 en `server/test_claude_live.py` + 3 del adaptador en
`server/test_live_session_chat.py` (21 pasan en el par).

## Notas de operación

- `check.sh` resolvía `ruff` del PATH; en shell no-interactivo no existe aunque
  el binario esté en `.venv`. Ahora resuelve como pytest (`.venv` primero, PATH
  después) y falla honestamente si no está.
- El proceso hijo no hereda secretos: `redact_env_for_spawn`; la autenticación
  de Claude vive en su config en disco (HOME se conserva).
- Nunca se degrada a `--resume`: una sesión de terminal del usuario queda
  observable y **no** direccionable (`claude_live_not_running`).
