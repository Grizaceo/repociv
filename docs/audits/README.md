# Auditorías — índice

> Esta carpeta guarda **snapshots fechados**. Un audit describe lo que se
> observó y se decidió en su fecha; no se reescribe cuando el código avanza.
> Si un audit contradice el código actual, pierde el audit (misma regla que
> [`../README.md`](../README.md) § "Regla de oro"), y la reconciliación se
> registra en un documento nuevo, no editando el viejo.

## Estado vigente de los hallazgos P1

| Documento | Fecha | Qué es |
|---|---|---|
| [`p1-closure-2026-10-24.md`](p1-closure-2026-10-24.md) | 2026-10-24 (rev. 2026-10-25) | **Estado vigente**: R01–R16 cerrados, con commits y evidencia. La revisión adversarial del 2026-10-25 reabrió R01 por una pérdida en el fallo de claim; el cierre documenta el arreglo y la regresión |
| [`p1-implementation-2026-10-13.json`](p1-implementation-2026-10-13.json) | 2026-10-13 | Plan inicial. Su `implementation_status: "pending"` es el snapshot previo al trabajo, no el estado de hoy |
| [`p1-review-r01-r05.md`](p1-review-r01-r05.md) | 2026-10-13 | Revisión adversarial que bloqueó el primer cierre (2 bloqueadores P1) |
| [`p1-r01-r05-evidence.md`](p1-r01-r05-evidence.md) | 2026-10-13 | Evidencia ejecutada de R01/R05 |
| [`p1-r02-evidence.md`](p1-r02-evidence.md) | 2026-10-13 | Evidencia de R02 (validator fail-closed) |
| [`p1-r04-r06-evidence.md`](p1-r04-r06-evidence.md) | 2026-10-13 | Evidencia de R04/R06 |
| [`p1-r16-evidence.md`](p1-r16-evidence.md) | 2026-10-13 | Evidencia de R16 (confinamiento de paths) |

## Otros audits

| Documento | Fecha | Qué es |
|---|---|---|
| [`2026-09-27-end-to-end.md`](2026-09-27-end-to-end.md) | 2026-09-27 | Evaluación end-to-end |
| [`2026-09-27-local-view-activity-prompt.md`](2026-09-27-local-view-activity-prompt.md) | 2026-09-27 | Vista local y prompt de actividad |
| [`terrain-2026-07-27.md`](terrain-2026-07-27.md) | 2026-07-27 | Terreno y relieve |

Los artefactos fuera de esta carpeta con fecha en el nombre
(`docs/ROADMAP-E2E-2026-10-14.html`, por ejemplo) siguen la misma regla:
conservan las cifras de su fecha aunque hoy hayan cambiado.
