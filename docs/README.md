# RepoCiv — Documentación

> Mapa de docs activos. Si llegaste aquí buscando el estado actual del
> proyecto, el orden de lectura recomendado es:
>
> 1. [`../README.md`](../README.md) — visión, arranque, hotkeys, tests
> 2. [`SCOPE.md`](SCOPE.md) — qué es y qué no es el proyecto
> 3. [`GETTING_STARTED.md`](GETTING_STARTED.md) — instalación y primer uso
> 4. [`DATA_SOURCES.md`](DATA_SOURCES.md) — fuentes de verdad del sistema
> 5. [`implementation_plan.md`](implementation_plan.md) — implementación del Agent OS

## Documentos vivos

| Documento | Para qué |
|---|---|
| [`SCOPE.md`](SCOPE.md) | Alpha de un solo usuario; multi-device en branch paralela; lista explícita de lo que NO se hace |
| [`EVOLUTION.md`](EVOLUTION.md) | Línea de tiempo cronológica del proyecto, con citas a documentos originales |
| [`implementation_plan.md`](implementation_plan.md) | Plan maestro v2.0 — Fases 0-5 cerradas con Gates verificables |
| [`DATA_SOURCES.md`](DATA_SOURCES.md) | Fuentes de verdad: Event Store (JSONL) ↔ Ledger (DuckDB) ↔ Workspace Issues ↔ Sessions |
| [`AUDIT_DELTA_ADDENDUM.md`](AUDIT_DELTA_ADDENDUM.md) | Patrones avanzados (eBPF, Landlock, P2P mesh) — explícitamente bloqueados por SCOPE hasta el dogfooding |

## Guías y referencia

| Documento | Para qué |
|---|---|
| [`GETTING_STARTED.md`](GETTING_STARTED.md) | Tutorial paso a paso |
| [`DOCKER.md`](DOCKER.md) | Instalación y operación con Docker |
| [`API.md`](API.md) | Referencia completa de endpoints |
| [`MCP.md`](MCP.md) | MCP server — 42 tools, ejemplos |
| [`HARNESS_HOOKS.md`](HARNESS_HOOKS.md) | Hooks de posición: tu CLI como unidad en el mapa |
| [`REMOTE_ACCESS.md`](REMOTE_ACCESS.md) | Acceso remoto via Tailscale |

## Snapshots (no editar después de creados)

| Documento | Para qué |
|---|---|
| [`REVIEW_v2.0_CLOSE.md`](REVIEW_v2.0_CLOSE.md) | Revisión externa de cierre v2.0 (2026-05-01). Re-leer durante el alpha-test cuando aparezcan impulsos de "agregar más" o "competir con AgentCraft otra vez". |

## Histórico

| Documento o carpeta | Contenido |
|---|---|
| [`archive/`](archive/) | Planes, audits, cierres de fase y notas de sesión conservados. El mapa del archivo está en [`archive/README.md`](archive/README.md); el resto del histórico vive en git. |
| [`archive/ROADMAP_IMPERIAL_WORKSHOP.md`](archive/ROADMAP_IMPERIAL_WORKSHOP.md) | Canon post-alpha histórico: legibilidad, Maravillas y Gaceta. Incluye Bibliotheca y LabHub, retiradas; no es el alcance vigente. |
| [`archive/PHASE_1_VERIFICATION.md`](archive/PHASE_1_VERIFICATION.md) | Verificación histórica de los gates de Fase 1. |

## Regla de oro

Si algún documento histórico contradice [`../README.md`](../README.md),
[`SCOPE.md`](SCOPE.md) o los tests actuales, el histórico **pierde**.
