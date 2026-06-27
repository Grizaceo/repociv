# RepoCiv MCP Server

RepoCiv expone su bridge HTTP como un [MCP server](https://modelcontextprotocol.io/) por **stdio**,
permitiendo a Claude Code, Cursor, Codex CLI y cualquier agente MCP-compatible operar el dashboard
sin curl-ear el bridge directamente.

## Instalación rápida

```bash
# 1. Asegúrate de que el venv tiene las dependencias
source .venv/bin/activate && pip install -r requirements.txt

# 2. Registra el MCP server en Claude Code (~/.claude.json):
```

```json
{
  "mcpServers": {
    "repociv": {
      "command": "python",
      "args": ["<absolute-path-to-repociv>/server/mcp_server.py"],
      "env": {
        "BRIDGE_PORT": "5274"
      }
    }
  }
}
```

El server lee `REPOCIV_TOKEN` de `~/.hermes/.env` o del `.env` del repo — no necesitas pasarlo explícitamente si ya está en alguno de esos archivos.

## Requisito previo

El bridge debe estar corriendo antes de usar las tools:

```bash
npm start                  # bridge en :5274 + vite en :5273
# o con MCP en background:
./scripts/dev-start.sh --with-mcp
```

Si el bridge no responde, todas las tools devuelven:
> `RepoCiv bridge no responde en :5274 — ejecuta npm start`

## Quick test (sin MCP client)

```bash
# Health check básico
curl http://127.0.0.1:5274/health

# Listar Maravillas registradas
curl http://127.0.0.1:5274/api/wonders

# Relaciones candidatas para un repo
curl "http://127.0.0.1:5274/api/graph-relations?repoId=repociv&limit=5"

# Perfil de un repo (requiere bridge activo)
curl "http://127.0.0.1:5274/api/foreign/repo-profile?repoPath=/path/to/workspace/repociv"
```

## Tools disponibles (44 tools, 15 dominios con tools MCP)

> Conteo verificado 2026-06-27 contra `server/mcp_server.py`: 44 funciones decoradas con `@mcp.tool()`. La sección "Subagents" abajo lista endpoints del bridge sin tools MCP dedicadas (no se cuenta como dominio MCP).

### Agents — estado del imperio
| Tool | Descripción |
|------|-------------|
| `agents_list` | Todos los agentes con status, heartbeat y queue depth |
| `agents_capabilities` | Matriz de capacidades por tipo (MAIN, WORKER, SCOUT, CLAUDE, CODEX, OPENCLAW; CURSOR según configuración) |
| `agents_health` | Health check: versión, GPU, comandos en cola |
| `agents_ready` | Readiness probe del bridge |

### Commands `[MUTATES]`
| Tool | Descripción |
|------|-------------|
| `command_submit(type, target, ...)` | Envía un comando al bus. `risk=high` → va a approvals primero |
| `command_cancel(id)` | Cancela un comando en cola |

**Types válidos:** `inspect_repo`, `read_file`, `run_tests`, `run_build`, `edit_file`, `create_branch`, `git_commit`, `delete_file`, `execute_agent`, `send_message`

### Missions — historial de ejecución
| Tool | Descripción |
|------|-------------|
| `missions_list` | Todas las misiones persistidas |
| `missions_log(n, type?)` | Últimos N eventos del event log |

### Approvals `[MUTATES parcial]`
| Tool | Descripción |
|------|-------------|
| `approvals_list` | Comandos esperando aprobación |
| `approval_approve(id)` | **[MUTATES]** Aprueba y despacha |
| `approval_reject(id)` | **[MUTATES]** Rechaza |

### Pending tasks `[MUTATES parcial]`
| Tool | Descripción |
|------|-------------|
| `pending_list` | Lista de tareas pendientes |
| `pending_add(title, priority)` | **[MUTATES]** Crea tarea |
| `pending_resolve(id)` | **[MUTATES]** Marca como resuelta |
| `pending_edit(id, ...)` | **[MUTATES]** Edita campos |
| `pending_state(id, state)` | **[MUTATES]** Cambia estado |
| `pending_delete(id)` | **[MUTATES]** Elimina tarea |

### Context / Fatiga XCOM
| Tool | Descripción |
|------|-------------|
| `context_fatigue` | Fatiga y áreas de descanso por unidad |

### Observabilidad
| Tool | Descripción |
|------|-------------|
| `gpu_status` | VRAM, temperatura (nvidia-smi) |
| `metrics_snapshot` | Throughput, latencia, circuitos abiertos |

### Self-improvement / SICA
| Tool | Descripción |
|------|-------------|
| `improve_reflect` | Patrones observados con confianza |
| `improve_proposals` | Propuestas de mejora pendientes |

### Providers & Harnesses `[MUTATES parcial]`
| Tool | Descripción |
|------|-------------|
| `providers_list` | Proveedores configurados + config de chat |
| `providers_live` | Alcanzabilidad en vivo de cada modelo |
| `harnesses_list` | 7 harnesses (incluye `claude-code-local`, `codex-local`) |
| `harness_recovery(harness_id, ...)` | **[MUTATES]** Plan de recovery para harness caído |

### Tasks P3 `[MUTATES parcial]`
| Tool | Descripción |
|------|-------------|
| `tasks_list` | Tareas de orquestación P3 activas |
| `task_get(repo, issue_id)` | Estado de tarea específica |
| `task_cancel(repo, issue_id)` | **[MUTATES]** Cancela tarea P3 |

### Directives `[MUTATES parcial]`
| Tool | Descripción |
|------|-------------|
| `directives_stats` | Estadísticas de directivas aprendidas |
| `directives_suggest(gesture, agent, ...)` | Sugerencias por gesto/agente |
| `directive_record(...)` | **[MUTATES]** Registra resultado de gesto |

### Events & WebSocket
| Tool | Descripción |
|------|-------------|
| `events_since(since_unix_ts)` | Replay del event store desde timestamp |
| `ws_info` | Metadata del WebSocket (URL, puerto) |

### Subagents (Swarm Civ) — lectura vía bridge HTTP

No hay tools MCP dedicadas aún; consultar el bridge directamente (o ampliar MCP en issue posterior):

| Endpoint | Descripción |
|----------|-------------|
| `GET /subagents?parentUnit=&parentMission=&active=1` | Subagentes activos o historial filtrado (DuckDB + fallback memoria) |
| `GET /missions/{missionId}/tree` | Árbol misión → subagentes para mission log UI |

Eventos SSE: `subagent_spawn`, `subagent_progress`, `subagent_complete`, `subagent_proposed`, `fog_reveal`.

Campos opcionales en `subagent_spawn`: `parentHarness`, `harness` (mismo harness que la misión padre salvo dispatch explícito futuro).

**Tracking por harness (pasivo, parse-only):**

| Harness | Detección Task | Notas |
|---------|----------------|-------|
| `cursor` | Sí (NDJSON `stream-json`) | Progress mid-flight ~1 Hz |
| `claude-code` | Sí con `--output-format stream-json` | `REPOCIV_SWARM_TRACK=0` desactiva |
| `hermes-cli` | Best-effort JSON/líneas en stdout | Sin formato estable → badge “limited” en UI |
| `hermes` HTTP | No | Sin SSE de subtareas aún |
| `openclaw` / `codex` | No | Solo etiqueta harness en UI si padre usa ese runner |

`subagent_dispatch` (comando bridge) está registrado pero devuelve `not_implemented` (fase 2).

## Política de approvals

`command_submit` con `risk=high` o `risk=destructive` **no se ejecuta inmediatamente** —
cae en `/approvals`. El agente debe:

1. Llamar `approvals_list` para ver el comando en cola
2. Llamar `approval_approve(id)` para liberarlo

Esto ocurre igual que si el comando viniera desde la UI del dashboard. El MCP no bypasea ninguna política.

## Tools `[MUTATES]` y tokens

Todas las tools marcadas `[MUTATES]` requieren que `REPOCIV_TOKEN` esté configurado. Si no está:

```
ValueError: REPOCIV_TOKEN no configurado — mutating tools requieren token
```

**Read-only tools y auth del bridge:** cuando el bridge tiene `REPOCIV_TOKEN` configurado, **todos** los GET autenticados (salvo `/health` y `/ready`) exigen el header `X-RepoCiv-Token`. El MCP server hoy solo envía token en tools `[MUTATES]`; las read-only tools pueden fallar con `401` si el token está activo. Comportamiento previsto (M2): el MCP enviará `X-RepoCiv-Token` en **todas** las llamadas cuando `REPOCIV_TOKEN` esté definido. Con token vacío (dev localhost), read-only funciona sin header — igual que el browser abriendo el dashboard.

### Wonders — Maravillas del mapa
| Tool | Descripción |
|------|-------------|
| `wonders_list` | Todas las Maravillas registradas con estado y configuración |
| `wonders_get(wonder_id)` | Manifiesto de una Maravilla por ID (bibliotheca, gaceta, institutum) |
| `wonder_health(wonder_id)` | Health check: iframe accesible, puerto activo, latencia |

### Graph Relations — grafo de repos
| Tool | Descripción |
|------|-------------|
| `graph_relations_list(repo_id, limit, min_score)` | Relaciones candidatas para un repo según señales de código |
| `graph_relations_evidence(source_id, target_id)` | Evidencia entre dos repos: imports, deps, entidades co-referenciadas |
| `graph_relations_stats` | Estadísticas del índice: repos indexados, total edges, última actualización |

### Foreign Relations — perfiles y reportes externos
| Tool | Descripción |
|------|-------------|
| `foreign_repo_profile(repo_path)` | Perfil de un repo: stack, tipo, entidades, señales de actividad |
| `foreign_reports_list(limit, offset)` | Lista reportes de relaciones externos guardados |
| `foreign_report_get(report_id)` | Reporte de relaciones externas por ID |

## Tests

```bash
source .venv/bin/activate
pytest server/test_mcp_server.py -v   # 39 tests, bridge mockeado
```

## Out of scope (alpha)

- Transport HTTP/SSE — solo stdio
- Streaming en vivo de `/events` por MCP — usa `events_since` con polling
- Auth multi-usuario — el alpha es single-user
