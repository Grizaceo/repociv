# RepoCiv — Data Sources & Truth Boundaries

**Versión:** 1.0 · **Fecha:** 2026-05-01 · **Fase:** 0 (prerequisito para DuckDB Ledger)

---

## Principio rector

RepoCiv tiene **4 stores de persistencia**. Cada uno tiene un propósito distinto y
es la fuente de verdad **solo para su dominio**. La DuckDB Ledger es una **vista
materializada** del Event Store, no una fuente independiente.

> **Invariante crítico:** si DuckDB se corrompe o diverge, se reconstruye desde JSONL.
> Nunca al revés. El Event Store (JSONL) es el audit trail canónico e inmutable.

---

## Tabla de fuentes

| Store | Módulo | Fuente de verdad para | Formato | Mutabilidad | Gana cuando diverge |
|---|---|---|---|---|---|
| **Event Store** | `server/event_store.py` | Auditoría — log inmutable de todo lo que ocurrió (CommandCreated, CommandStarted, CommandCompleted, CommandFailed, AgentOutputChunk, etc.) | Append-only JSONL (`~/.repociv/events.jsonl`) | **Inmutable** (append-only) | **Siempre** — es el audit trail definitivo |
| **DuckDB Ledger** | `server/research_ledger.py` | Queries analíticas — believability, cost, latency, agent performance, token budgets | SQL tables en `~/.repociv/ledger.duckdb` | Derivada del Event Store | **Nunca** — se reconstruye desde JSONL con `rebuild_ledger` |
| **Workspace Issues** | `server/workspace_issue.py` | Estado operacional por issue — spec, plan, artifacts, outputs | Filesystem (Markdown + JSON en `~/.repociv/issues/<id>/`) | Mutable (el issue evoluciona) | Para estado actual del issue en curso |
| **Sessions + RunState** | `server/sessions.py` + `server/run_state.py` | Sesiones activas + snapshots resumibles de agents en vuelo | JSONL transcripts + JSON snapshots en `~/.repociv/sessions/` | Volátil (purgar en restart controlado) | Para recuperación de crash inmediato |

---

## Flujo de escritura (dual-write)

```
Command lifecycle event
  │
  ├─► event_store._append()   ← SIEMPRE. Primero. Síncrono.
  │       └─ events.jsonl (append-only)
  │
  └─► research_ledger.ingest_event()   ← Best-effort. Si falla, no bloquea el pipeline.
          └─ ledger.duckdb (missions, agent_predictions, subagent_runs tables)
```

El dual-write se realiza en `event_store.record_completed()` y `event_store.record_failed()`.
Si DuckDB lanza excepción, se loguea un warning pero la operación principal no falla.

---

## Reconstrucción del Ledger

Si el DuckDB diverge o se corrompe:

```bash
python -m server.rebuild_ledger
# Lee events.jsonl desde el inicio y reproduce cada evento en DuckDB.
# Operación idempotente — usa INSERT OR REPLACE / ON CONFLICT DO UPDATE.
```

El script está en `server/rebuild_ledger.py` — reconstruye `missions` y `subagent_runs` desde JSONL.

### Tabla `subagent_runs` (Swarm Civ)

Registra delegaciones Task tool detectadas en streams (cursor, claude-code, hermes-cli best-effort):

| Columna | Descripción |
|---|---|
| `id` | `sub-{uuid8}` |
| `parent_mission_id` | misión del agente padre |
| `parent_unit_id` | unidad padre (ej. DAVI) |
| `kind` / `label` | tipo y descripción del Task |
| `status` | proposed / running / complete / failed |
| `risk` | low … destructive (ver `subagent_risk.py`) |
| `ephemeral_unit_id` | unidad efímera en mapa |
| `parent_harness` | harness resuelto de la misión padre al spawn |
| `harness` | harness efectivo del subagente (default = parent) |

Eventos JSONL: `SubagentSpawned`, `SubagentCompleted` (antes del dual-write DuckDB).

---

## Propietarios de estado por tipo de query

| Pregunta | Consultar | NO consultar |
|---|---|---|
| "¿Qué comandos se ejecutaron hoy?" | Event Store (JSONL) | DuckDB (podría estar desactualizado) |
| "¿Cuánto costó el agente WORKER este mes?" | DuckDB `missions` table | Event Store (no tiene agregaciones) |
| "¿Qué tan confiable es SCOUT históricamente?" | DuckDB `agent_predictions.believability()` | Ninguno más |
| "¿En qué fase está el issue #42?" | Workspace Issues (`~/.repociv/issues/42/`) | Sessions (solo tiene transcript) |
| "¿El agent PID X está corriendo?" | RunState (`~/.repociv/run_state/`) | Event Store (no tiene estado live) |
| "¿Qué escribió LEXO en el paso 3?" | Sessions transcript JSONL | Event Store (chunks truncados a 2048) |

---

## Campos canónicos de un evento de misión

Todos los eventos del Event Store contienen:

```json
{
  "id": "<12-char uuid slice>",
  "commandId": "<mission_id>",
  "type": "CommandCompleted | CommandFailed | ...",
  "timestamp": 1746100000.0,
  "actor": "<unit_id> | system",
  "data": {
    "model": "claude-sonnet-4-5",
    "tokensIn": 1200,
    "tokensOut": 450,
    "costEstimate": 0.00185,
    "result": "<últimos 1024 chars del output>",
    "finishedAt": 1746100045.0
  }
}
```

Los campos `model`, `tokensIn`, `tokensOut`, `costEstimate` son opcionales en eventos
legacy (antes de Fase 0). El DuckDB Ledger los trata como 0 si están ausentes.

---

## Presupuesto de tokens

El `TokenLedger` (`server/token_ledger.py`) mantiene un acumulador **en memoria + JSON**
separado de DuckDB para respuestas de latencia ultrabaja (presupuesto real-time):

```
TokenLedger (in-memory + ~/.repociv/token_usage.json)
  ├─ Acumulación: log_usage(model, prompt_tokens, completion_tokens)
  ├─ Budget check: check_budget_violation(limit) → bool
  └─ get_budget_used_pct(limit) → float  ← usado por FrugalGPT router (Fase 2)
```

El DuckDB Ledger tiene la versión histórica completa; el TokenLedger tiene la versión
operacional de alta velocidad. Ambos son correctos dentro de su scope.

---

## Reglas de no-destrucción

1. **Nunca truncar o rotar events.jsonl** sin archivarlo primero (usar `backup-events.sh`).
2. **Nunca eliminar ledger.duckdb** sin antes exportar a JSONL o verificar que events.jsonl
   está completo.
3. **Sessions y RunState** pueden purgarse en maintenance window con `--dry-run` primero.
4. **Workspace Issues** son propiedad del usuario — nunca borrar sin confirmación explícita.
