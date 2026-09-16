# Agentic OS Integration — RepoCiv

> **Estado: DORMANT.** Este documento es el plan de integración futura de
> RepoCiv como consumidor del **event bus del Agentic OS**, junto con el
> código plugin ya listo y testeado en `server/agentic_os_bus/`.
>
> Nada de lo descrito aquí está activo hoy: no hay ruta HTTP, no hay tool
> MCP, no hay UI, y el bridge no importa el paquete. El plugin vive solo.

---

## Contexto

El sistema operativo (Omarchy 4.0.3) corre un **event bus JSONL canónico**
en `~/.hermes/workspace/LABS/agentic-os/`:

- **Schema:** `agentic-os.event.v1` — `EVENT_SCHEMA.json` (fuente de verdad:
  `LABS/agentic-os/PLAN_INTEGRAL.md` §5).
- **Estructura:** `events/inbox/*.jsonl` (pendientes), `events/archive/*.jsonl`
  (consumidos), `audit/events.jsonl` (mover eventos).
- **Producer actual:** Hermes/DAVI (el event bus emite `task.completed`,
  `domain.detected`, … durante sesiones).

**Rol pretendido de RepoCiv (A.3 del plan):** *"RepoCiv consume el
audit/event stream y muestra estado simple"* — es decir, RepoCiv como
**consumer** del bus: ver actividad del OS en el dashboard (control plane),
sin tocar el bus ni el core de RepoCiv.

**Evaluación 16-sep-2026 (ver PLAN_INTEGRAL.md §9):** RepoCiv es **CAPAZ
pero no CUMPLE hoy** — tiene `event_store.py` (JSONL propio), `GET /events`
y MCP `events_since`, pero el schema de sus eventos (command-lifecycle) es
distinto al del bus, no conoce la ruta del bus y no corre como servicio.

---

## Lo que ya está listo (este PR)

| Archivo | Qué es |
|---|---|
| `server/agentic_os_bus/__init__.py` | Paquete DORMANT, docstring con estado y rol |
| `server/agentic_os_bus/client.py` | Cliente fail-open: `bus_status()` (snapshot santé), `poll_bus(since, limit)`, `parse_timestamp()` (epoch + ISO-8601) |
| `server/agentic_os_bus/adapter.py` | Traducción de schema: `to_repociv_event()` → shape del `event_store` de RepoCiv |
| `server/test_agentic_os_bus.py` | 15 tests: fail-open (root/schema ausente), polling con filtro, ISO-8601, traducción, fallbacks |
| `docs/AGENTIC_OS_INTEGRATION.md` | Este plan |

**Contrato fail-open** (mismo patrón que `server/hermes_status.py`): si el
bus no existe o no responde, las llamadas devuelven `{available: False,
reason: ...}` — nunca crashean, nunca bloquean.

**Verificación contra el bus real (16-sep-2026):**
```
bus_status: {'available': True, 'schemaPresent': True,
             'schemaVersion': 'Agentic OS Event v1', 'inboxCount': 0, ...}
```

---

## Cómo activar (cuándo aplicar)

La activación NO es un cambio de código trivial: es una **decisión de
producto** (cuándo RepoCiv vuelve a correr como servicio systemd) + un
**cambio pequeño y quirúrgico** en el bridge. Pasos:

### Prerequisito (decisión de Cristóbal)
RepoCiv corre como servicio systemd user (`repociv-bridge.service` +
`repociv-vite.service`, ver `scripts/dev-start.sh` y
`references/server-lifecycle-systemd.md`). Sin servicio, no hay dashboard:
integrar el bus a un proceso dormido no aporta.

### 1. Ruta read-only (2 líneas, patrón `get_pending`)
En `server/routes/core.py`, registrar un handler que devuelva el snapshot:
```python
def get_agentic_os_status(ctx: "RouteContext") -> tuple[int, Any]:
    from server.agentic_os_bus import bus_status  # import local, DORMANT
    return 200, bus_status().to_dict()
```
Re-exportar en `server/http_routes.py` (`from server.routes.core import
get_agentic_os_status`) y registrar en la tabla de rutas del bridge
(patrón de `get_pending` — sin auth, read-only; o con auth si se prefiere
consistencia con `/events`).

### 2. Ingesta opcional en el event_store
Para que el dashboard muestre los eventos del bus junto a los de comandos:
- Poller en `scheduler.py` (cada 5 min, `poll_bus(since_ts=last_seen)`,
  `to_repociv_event()` por evento, `event_store.append(...)`).
- Mantener un watermark (`~/.repociv/agentic_os_watermark.json`).
- El `event_store` ya es append-only y dual-write DuckDB: no requiere
  migración de schema.

### 3. UI (opcional, fase 2)
Un panel "Agentic OS" en la capital: health badge (bus up/down →
`available`), contadores inbox/archive, últimos eventos. Consume el endpoint
del paso 1; sin WebSocket (polling simple).

### Regla de superficie
NO se toca `/usr/share/omarchy/` ni el core de Hermes. El bus sigue siendo
la fuente de verdad; RepoCiv solo lee (y opcionalmente re-publica eventos
propios vía `event_store`, que ya es su canal).

---

## Riesgos y decisiones abiertas

- **Doble fuente de eventos:** RepoCiv tendrá su `events.jsonl` (comandos)
  y eventos del bus traducidos con `type: AgenticOsEvent`. La UI debe
  distinguir el origen (`data.source`) — no mezclar como si fueran iguales.
- **Watermark:** el poller debe ser idempotente; ante fallo, reintentar sin
  perder `since_ts` (persistir antes de procesar).
- **Volumen:** el bus es de un solo operador (DAVI + Cristóbal); un poller
  de 5 min es más que suficiente. No construir colas ni workers.
- **Desactivar:** basta con no registrar la ruta y no arrancar el poller;
  el paquete DORMANT no tiene efectos secundarios en import.

---

## Referencias

- `LABS/agentic-os/PLAN_INTEGRAL.md` — Fase A.3, §5 (schema), §9 (evaluación).
- `LABS/agentic-os/EVENT_SCHEMA.json` — schema canónico `agentic-os.event.v1`.
- `server/event_store.py` — event store de RepoCiv (target de ingesta).
- `server/hermes_status.py` — patrón fail-open que inspiró el cliente.
