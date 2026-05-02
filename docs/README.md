# RepoCiv — Documentación

> Mapa de docs activos. Si llegaste aquí buscando el estado actual del
> proyecto, el orden de lectura recomendado es:
>
> 1. [`../README.md`](../README.md) — visión, arranque, hotkeys, tests
> 2. [`SCOPE.md`](SCOPE.md) — qué es y qué no es el proyecto
> 3. [`EVOLUTION.md`](EVOLUTION.md) — cómo llegamos hasta acá
> 4. [`implementation_plan.md`](implementation_plan.md) — plan vivo del Agent OS

## Documentos vivos

| Documento | Para qué |
|---|---|
| [`SCOPE.md`](SCOPE.md) | Alpha de un solo usuario; multi-device en branch paralela; lista explícita de lo que NO se hace |
| [`EVOLUTION.md`](EVOLUTION.md) | Línea de tiempo cronológica del proyecto, con citas a documentos originales |
| [`implementation_plan.md`](implementation_plan.md) | Plan maestro v2.0 — Fases 0-5 cerradas con Gates verificables |
| [`DATA_SOURCES.md`](DATA_SOURCES.md) | Fuentes de verdad: Event Store (JSONL) ↔ Ledger (DuckDB) ↔ Workspace Issues ↔ Sessions |
| [`PHASE_1_VERIFICATION.md`](PHASE_1_VERIFICATION.md) | Audit detallada de los Gates de Fase 1 |
| [`AUDIT_DELTA_ADDENDUM.md`](AUDIT_DELTA_ADDENDUM.md) | Patrones avanzados (eBPF, Landlock, P2P mesh) — explícitamente bloqueados por SCOPE hasta el dogfooding |

## Snapshots (no editar después de creados)

| Documento | Para qué |
|---|---|
| [`REVIEW_v2.0_CLOSE.md`](REVIEW_v2.0_CLOSE.md) | Revisión externa de cierre v2.0 (2026-05-01). Re-leer durante el alpha-test cuando aparezcan impulsos de "agregar más" o "competir con AgentCraft otra vez". |

## Histórico

| Carpeta | Contenido |
|---|---|
| [`archive/`](archive/) | 5 documentos-germen conservados por valor de referencia (CIV5 visual + AgentCraft parity + roadmap RimWorld/Frostpunk + ideación de paradigmas). El resto del histórico vive en git. |

## Regla de oro

Si algún documento histórico contradice [`../README.md`](../README.md),
[`SCOPE.md`](SCOPE.md) o los tests actuales, el histórico **pierde**.
