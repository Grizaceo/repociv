# `docs/archive/` — Documentos conservados

Esta carpeta ya no es un cementerio. Conserva dos grupos: (1) los documentos
**de referencia independiente** que pueden volver a consultarse aunque ya no
representen la operación diaria, y (2) **cierres de fase y audits** ya
superados, archivados a medida que se completan (no se borran porque registran
cómo se verificó cada gate).

### Referencia independiente

| Documento | Por qué se conserva |
|---|---|
| `CIV5_DESIGN_PLAN.md` | Biblia visual: paleta dorado-pizarra, ornamentos, terrenos como degradados, animaciones. Sigue siendo la referencia de diseño cuando se tocan estilos. |
| `CIV5_UI_ANALYSIS.md` | Análisis técnico de la UI de Civilization V (paleta exacta de recursos, tipografía, iconografía). Útil cuando se agreguen nuevos elementos visuales. |
| `ROADMAP_RIMWORLD_FROSTPUNK.md` | Visión de los 2 paradigmas (Civ macro + RimWorld micro) + capa XCOM. Define **explícitamente** la condición para reanimar Frostpunk (tracking real de tokens desde OpenClaw). Importante para la futura branch multi-device. |
| `VISUAL_WORKFLOW_IDEATION.md` | Tabla de paradigmas evaluados: qué se decidió implementar, qué se descartó y por qué. Memoria de decisión, evita re-debate. |
| `PLAN_AGENTCRAFT_PARITY.md` | Gap analysis original vs AgentCraft. Referencia útil cuando se abra la branch multi-device, para no perseguir paridad cosmética. |

### Cierres de fase y audits (superados)

| Documento | Qué fue |
|---|---|
| `FASE1_CLOSURE.md` | Cierre de Fase 1. |
| `PHASE_1_VERIFICATION.md` | Audit detallada de los gates de Fase 1. |
| `AUDIT_RECOMMENDATIONS.md` | Recomendaciones de un audit previo, ya aplicadas o re-evaluadas. |
| `AUDIT_2026-06-19.md` | Auditoría general (build/seguridad/arquitectura/deuda). P0-P1 + P2.3/P2.4 + governance aplicados; P2.1 (hex-core + route registry) cerrado 2026-06. |
| `local_view_beautification_plan.md` | Plan de embellecimiento de la vista local, ya ejecutado. |
| `onboarding-repo-selection.md` | Plan del onboarding de selección de repos, ya implementado. |

### Planes implementados (`plans/`)

Planes de implementación fechados cuyo trabajo ya está en `main`, movidos desde
`docs/plans/`. Se conservan como registro de cómo se construyó cada feature.

| Plan | Feature |
|---|---|
| `2026-05-06-repociv-corrected-master-plan.md` | Plan maestro corregido (dirección original). |
| `2026-05-06-repociv-surgical-file-changes.md` | Cambios quirúrgicos de archivos del plan maestro. |
| `2026-05-11-agent-auto-discovery.md` | Auto-descubrimiento de agentes. |
| `2026-05-21-phase3-remaining.md` | Cierre de los pendientes de la Fase 3. |
| `2026-05-24-capital-wonder-gaceta-implementation.md` | Maravilla capital + Gaceta. |
| `2026-05-24-gaceta-improvements.md` | Mejoras de la Gaceta. |
| `2026-06-17-wonders-generic-iframe-catalog.md` | Catálogo genérico de Maravillas vía iframe. |
| `SWARM_CIV_FOLLOWUP.md` | Follow-up del swarm Civ. |
| `city_builder_drag_drop_refactor.md` | Refactor drag-and-drop del city builder. |

> Siguen **vivos** en `docs/plans/` (no archivados): `2026-06-16-wonder-autostart-and-3d.md`
> (faltan F5/F6, citado por `server/wonder_launcher.py`) y `rivers-plan.md`
> (citado por `src/three/Rivers3D.ts`).

## Lo que se borró (y dónde encontrarlo)

17 documentos previos quedaron condensados como narrativa cronológica en
[`../EVOLUTION.md`](../EVOLUTION.md). Cada hito en ese archivo cita los
documentos originales por nombre. Si alguna vez se necesita recuperar la
versión completa de uno de ellos:

```bash
git log --all --oneline -- docs/archive/<nombre>.md
git show <sha>:docs/archive/<nombre>.md > /tmp/<nombre>.md
```

Documentos condensados (todos en git history):

- `DESIGN.md` v1.0 — primera tabla de mapeos Civ V → sistema (2026-04-27)
- `SPRINTS.md` + `TASKBOARD.md` — sprint plan de 118 tareas (2026-04-27)
- `CONTEXT_ROADMAP.md` — primera audit DAVI end-to-end (2026-04-28)
- `CAPITULO_0_HANDOFF.md` — recovery de sesión crashada (2026-04-28)
- `INTEGRATED_PLAN.md` — items R1-R8 cerrados (2026-04-28)
- `PLAN_EJECUCION.md` — A* + animación tween (2026-04-28)
- `PERMANENT_AGENT_CONSOLE_PLAN.md` — principios consola permanente (2026-04-29)
- `handoff-sprint-cierre.md` — gaps fases 1-8 (2026-04-29)
- `PLAN_ABSORCION_ORCHESTRATORS.md` — Paperclip/OpenFang/OpenGoat (2026-04-30)
- `PLAN_IMPLEMENTACION_ABSORCION_GLOBAL.md` — síntesis 12 repos (2026-04-30)
- `PLAN_ARREGLOS.md` + `PLAN_ARREGLOS_DETALLADO.md` + `PLAN_POST_ARREGLOS.md` — sprints técnicos (2026-04-30)
- `REFACTOR_PLAN.md` — split renderer R1-R8 (2026-04-30)
- `UI_DESIGN_PLAN.md` — rediseño UI dark-gold (2026-04-30)
- `PROPOSED_IMPROVEMENTS_REPOCIV.md` — manifiesto Agent OS (semilla del implementation_plan.md vivo, 2026-05-01)

## Regla de oro

Si este archivo contradice `../../README.md`, `../implementation_plan.md` o
los tests actuales, este histórico **pierde**. Para operar el repo hoy:

1. `../../README.md` — visión y arranque.
2. `../implementation_plan.md` — plan vivo de Agent OS.
3. `../EVOLUTION.md` — narrativa de cómo llegamos hasta acá.
4. `../SCOPE.md` — qué es y qué no es el proyecto.
