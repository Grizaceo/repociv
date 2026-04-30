# Handoff: Sprint de Cierre — Gaps Fases 1-8

**Repo:** `~/.hermes/workspace/repos/repociv`
**Commit de partida:** `67ab00c` (T5: Fase 9 completada)
**Tests:** 245 verdes (174 TS + 71 Py) — NO ROMPER
**Auditoría completa:** `docs/PERMANENT_AGENT_CONSOLE_PLAN.md`

---

## CONTEXTO

Acabo de completar T5 (Fase 9 — Directives learning layer). Hice una
auditoría de las fases 1-8 y encontré 7 gaps. Las fases 1-7 están
sustancialmente implementadas (85-95%) pero NUNCA se marcaron como
completadas en el plan. Este handoff documenta los 3 sprints necesarios
para cerrar todos los gaps.

---

## SPRINT 1 — Seguridad + documentación (~15 min)

### S1.1 — Crear `.env.example`

**Archivo:** `.env.example` (raíz del repo)

```
# RepoCiv Bridge
REPOCIV_PORT=5273
BRIDGE_PORT=5274
# Dejar vacío = dev mode (auth bypass). En producción: token aleatorio de 32+ chars.
REPOCIV_TOKEN=
REPOCIV_CONFIG_DIR=~/.repociv
```

### S1.2 — Documentar token vacío en README

En `README.md` (o crear `SECURITY.md`), agregar sección:

```
### Security

In development mode, leave REPOCIV_TOKEN empty — the bridge accepts all
requests from localhost without authentication. For production, set
REPOCIV_TOKEN to a random 32+ character string and configure your
frontend's VITE_BRIDGE_TOKEN accordingly.
```

Referencia: `server/bridge.py` línea 70.

### S1.3 — Marcar Fases 1-7 como completadas en el plan

**Archivo:** `docs/PERMANENT_AGENT_CONSOLE_PLAN.md`

Cada fase que dice "Objetivo: ..." debe llevar `✅ COMPLETADA` con fecha
estimada `2026-04-15`. Es deuda de documentación pura: el código YA está
en producción. Las fases son:

- Fase 1 — Hardening P0
- Fase 2 — Event sourcing y replay
- Fase 3 — Command Bus + Policy Engine
- Fase 4 — Scheduler real de agentes
- Fase 5 — Spatial directives
- Fase 6 — Agent capability model
- Fase 7 — Observabilidad operacional

---

## SPRINT 2 — Funcionalidad faltante (~30 min)

### S2.1 — Implementar los 2 gestos espaciales faltantes

**Archivo base:** `src/spatialDirectives.ts` (236 líneas, ya tiene 4/6 gestos)

Gestos faltantes:

a) **"Drag unit → file/workbench local"**
   - Cuando arrastras un agente a un archivo (no repo/city)
   - Debe producir `cmdType=read_file` o `edit_file`
   - Nueva función: `interpretUnitToFileDrag()`
   - Misma estructura que `interpretUnitDrag()`

b) **"Drop command card sobre unit: asignar directiva"**
   - Cuando sueltas un CommandCard sobre una unidad
   - Nueva función: `interpretCardDropOnUnit()`
   - Devolver `SpatialDirective` con `confidence=1` (ya es explícito)

Agregar 2-4 tests. Si no existe `spatialDirectives.test.ts`, crearlo.

### S2.2 — Verificar integración de fatigue en scheduler

**Archivo:** `server/scheduler.py`

El plan dice que fatigue/context budget afecta scheduling. Revisar si
`_priority_score()` debería consultar fatigue state. El frontend tiene
`src/fatigue.ts` pero el backend no tiene modelo de fatiga propio.

Si no es trivial integrarlo ahora, documentar por qué en un comentario
y marcarlo como `deferred to T6`.

---

## SPRINT 3 — Métricas + automatización (~20 min)

### S3.1 — Agregar cost/model usage tracking a metrics

**Archivo:** `server/metrics.py`

Agregar campo `modelUsage` en `compute_metrics()`:

```python
# Estructura esperada (array vacío si no hay datos aún):
"modelUsage": [
    {"model": str, "tokensIn": int, "tokensOut": int, "costEstimate": float}
]
```

Si los eventos del event store no tienen esta data todavía, devolver
array vacío. La estructura debe existir para que el frontend la renderice
cuando haya datos.

### S3.2 — Automatizar backup con systemd timer

Crear `~/.config/systemd/user/repociv-backup.service`:
```
[Unit]
Description=RepoCiv event store backup

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'mkdir -p %h/.repociv/backups && cp %h/.repociv/events.jsonl %h/.repociv/backups/events-$(date -Iminutes).jsonl'
```

Crear `~/.config/systemd/user/repociv-backup.timer`:
```
[Unit]
Description=RepoCiv backup every 6 hours

[Timer]
OnCalendar=*-*-* 00/6:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Activar: `systemctl --user enable --now repociv-backup.timer`

Alternativa simple si systemd no es práctico: cronjob con `cronjob` tool.

---

## CIERRE

**Commit final:**
```
git add -A
git commit -m "Sprint cierre: Fases 1-8 gaps cerrados (auditoría post-T5)"
```

**Verificación:**
- `npm test` — debe dar >= 174 TS tests verdes
- `pytest server/ -q` — debe dar >= 71 Py tests verdes
- `git log --oneline -5` — verificar que `67ab00c` es ancestro

**Plan:** todas las fases 1-8 deben tener `✅ COMPLETADA` en
`docs/PERMANENT_AGENT_CONSOLE_PLAN.md`.

---

## Comandos rápidos

```
npm test              # 174+ TS tests
pytest server/ -q     # 71+ Py tests
cd server && python bridge.py  # levantar bridge
git log --oneline -5
```
