# RepoCiv — Línea de tiempo del proyecto

> Narrativa cronológica condensada de cómo nació, mutó y se consolidó RepoCiv.
>
> **Para qué sirve este documento:** entender por qué el proyecto tomó las decisiones
> que tomó, sin tener que leer 22 planes intermedios. Cada hito cita los documentos
> originales que lo encarnaron — la mayoría ya fue borrada en el merge del
> 2026-05-01, pero queda preservada en la historia de git si alguna vez se
> necesita recuperarla (`git log --all -- docs/archive/<archivo>.md`).
>
> **Documentos-germen aún vivos en `docs/archive/`** (conservados porque tienen
> valor de referencia independiente, no solo histórico):
>
> - `CIV5_DESIGN_PLAN.md` — biblia visual Civilization V
> - `CIV5_UI_ANALYSIS.md` — paleta exacta + tipografía + iconografía Civ V
> - `ROADMAP_RIMWORLD_FROSTPUNK.md` — visión 2-paradigmas + capa XCOM, condición
>   explícita para diferir Frostpunk
> - `VISUAL_WORKFLOW_IDEATION.md` — tabla de paradigmas evaluados (qué se
>   decidió implementar vs qué se descartó y por qué)
> - `PLAN_AGENTCRAFT_PARITY.md` — gap analysis vs AgentCraft (referencia útil
>   para la futura branch multi-device)

---

## 2026-04-27 · Génesis

Cristóbal define la metáfora núcleo: visualizar `~/.hermes/workspace/repos/`
como un mapa hexagonal estilo Civilization V donde cada repo es una ciudad,
cada agente es una unidad, y cada proceso de background es un edificio en
construcción. La idea no es decorativa — es operacional: usar la representación
espacial para *condicionar* las decisiones del usuario sobre el ecosistema de
agentes (no para "transferir capacidades" al modelo, distinción explícita en
documentos posteriores).

- 📄 `DESIGN.md` v1.0 — tabla de mapeos Civ V ↔ sistema (tiles, ciudades,
  unidades, recursos, fog of war, ruinas).
- 📄 `SPRINTS.md` + `TASKBOARD.md` — 118 tareas en 10 sprints (Hex math,
  Camera, Map gen, Terrain, Cities, Units, Buildings, HUD, Bridge, Polish,
  Multi-agent).

---

## 2026-04-28 · Auditoría inicial y consolidación visual

DAVI hace la primera audit end-to-end. Veredicto: "beta funcional, deudas
de mantenibilidad". Los problemas detectados (bridge fingiendo éxito en modo
offline, validación de eventos ausente, CORS abierto, parser frágil de
`PENDING_TRACKER.md`, cero tests) se vuelven el roadmap de cierre técnico
de los siguientes días.

La sesión de planificación crashea por context window, lo que motiva el
primer **handoff post-crash** y, más importante, el patrón "documentar para
sobrevivir al crash" que se replicará después en el A2O Sentinel File.

En paralelo se cierra el debate de **qué paradigmas visuales adoptar**:

| Paradigma | Decisión | Razón |
|---|---|---|
| **Civ V (RTS macro)** | ✅ Implementado | Vista global del workspace |
| **RimWorld (micro local)** | ✅ Roadmapped (Phase 6-7) | Zoom-in al repo como grid de habitaciones |
| **XCOM (fatiga)** | ✅ Capa económica única | Saturación de contexto stateful |
| **Frostpunk (economía tokens)** | ⏸ Diferido | Espera tracking real de tokens desde OpenClaw |
| Factorio / Zachtronics / Slay-the-Spire | ❌ Descartados | Compiten con el IDE o con el sistema de prioridades |

- 📄 `CONTEXT_ROADMAP.md` — audit detallada SOBRA / MERGE / FALTA.
- 📄 `CAPITULO_0_HANDOFF.md` — recovery de la sesión crashada, instrucciones
  de arranque para el siguiente agente.
- 📄 `INTEGRATED_PLAN.md` — items R1-R8 del cierre técnico, todos ✅ el
  mismo día.
- 📄 `PLAN_EJECUCION.md` — A* pathfinding real + costos por unidad + tween
  animado entre hexes.
- 📄 `VISUAL_WORKFLOW_IDEATION.md` ⭐ — la tabla de paradigmas (conservada
  en `archive/`).
- 📄 `ROADMAP_RIMWORLD_FROSTPUNK.md` ⭐ — roadmap maestro Civ macro + RimWorld
  micro + XCOM fatiga (conservada en `archive/`).
- 📄 `CIV5_DESIGN_PLAN.md` ⭐ y `CIV5_UI_ANALYSIS.md` ⭐ — biblia visual
  (paleta dorado-pizarra, tipografía, ornamentos, terrenos como degradados)
  (conservadas en `archive/`).

---

## 2026-04-29 · Consola permanente

El proyecto deja de ser "dashboard que enciendo cuando quiero" y pasa a
"consola operacional siempre encendida". Esto introduce los requisitos no
funcionales que dominarán el resto del proyecto: token auth, systemd units,
backup, replay, observabilidad y recovery.

- 📄 `PERMANENT_AGENT_CONSOLE_PLAN.md` — define los principios no
  negociables (seguridad local primero, todo audita, todo es reversible,
  estado fuera de la UI).
- 📄 `handoff-sprint-cierre.md` — auditoría revela 7 gaps en fases 1-8,
  organizados en 3 sprints de cierre.

Materialización en código actual:
- `server/bridge.py` — token auth, rate limit, body size guard, CORS restrictivo.
- `deploy/systemd/` — units para bridge, frontend, backup y target compuesto.
- `scripts/healthcheck.sh` + `smoke-test.sh` + `backup-events.sh`.
- `server/event_store.py` (JSONL append-only) + `server/recovery.py`.

---

## 2026-04-30 · Industrialización (paridad AgentCraft + absorción de orquestadores)

Tres líneas paralelas. Primero, gap analysis contra **AgentCraft** (producto
comercial RTS para agentes): se identifican 22 brechas, se priorizan las que
preservan la ventaja diferencial de RepoCiv (hex grid + fatiga + priority
matrix) sin perseguir paridad cosmética (race skins, achievements).

Segundo, auditoría profunda de 12 repos de orquestación (paperclip, openfang,
opengoat, sortie, parallel-code, bernstein, symphony, subtask, etc.) para
extraer **primitives operativas** sin copiar productos. Resultado: el
proyecto converge a 5 capas explícitas (UI spatial / control plane / runtime
adapters / persistence / security).

Tercero, sprints de cierre técnico: arreglos puntuales del bridge, refactor
del renderer, rediseño de UI.

- 📄 `PLAN_AGENTCRAFT_PARITY.md` ⭐ — la matriz comparativa (conservada en
  `archive/` para la futura branch multi-device).
- 📄 `PLAN_ABSORCION_ORCHESTRATORS.md` — qué tomar de Paperclip/OpenFang/
  OpenGoat (adapter registry, canonical session, provider abstraction).
- 📄 `PLAN_IMPLEMENTACION_ABSORCION_GLOBAL.md` — síntesis final de los 12
  repos auditados.
- 📄 `PLAN_ARREGLOS.md` + `PLAN_ARREGLOS_DETALLADO.md` + `PLAN_POST_ARREGLOS.md`
  — tres iteraciones del mismo set de arreglos (todos ejecutados).
- 📄 `REFACTOR_PLAN.md` — items R1-R8 (split renderer, separar
  responsabilidades).
- 📄 `UI_DESIGN_PLAN.md` — rediseño dark-gold con marco ornamental, hero
  bar mejorada, side panel reorganizado.

---

## 2026-05-01 · Agent OS Industrial — `implementation_plan.md` v2.0

Cristóbal escribe el manifiesto: convertir RepoCiv en el primer sistema que
implementa el paradigma "Agent OS" (MemGPT) con el rigor de control de
LangGraph y la especialización de roles de CrewAI. El plan incorpora SOTA
externo (SICA, MemGPT, A2A, FrugalGPT, Darwin Gödel Machine) y patrones
internos del workspace `.hermes` (ART research_ledger, LexO tensor_umj,
Cybersecurity-Lab scanners, Homeostatic-Runtime policy, etc.).

Resultado: 6 fases ejecutadas en 1 día (sí, en 1 día, no 10 semanas como
estimaba el plan original). Todas las Gates F0-F5 marcadas ✓ y verificables
con `pytest server/`.

| Fase | Entregable | Líneas | Tests |
|---|---|---|---|
| F0 | DuckDB Ledger + Token Ledger + StrEnum phases | ~800 | 23 |
| F1 | TensorContext + repociv_hooks YAML + worktrees + sentinel A2O | ~900 | 35 |
| F1.5 | Security Harness 3 capas (gate / audit / runtime) | ~770 | 30 |
| F2 | FrugalGPT Router + SignalExtractor + Agent Cards | ~700 | 53 |
| F3 | Swarm Engine ConsensusEngine | ~270 | 11 |
| F4 | World Model shadow→active | ~450 | 18 |
| F5 | SICA Self-Improvement + Container Runtime + Dockerfile.agent | ~900 | 25 |

- 📄 `PROPOSED_IMPROVEMENTS_REPOCIV.md` — manifiesto inicial (semilla del
  plan vivo).
- 📄 `docs/implementation_plan.md` ← **plan vivo** (no archivado).

---

## 2026-05-01 (tarde) · Sprint de Consolidación

Tras una revisión externa de fin de día se acepta que el proyecto cruzó el
punto de retornos decrecientes. Se ejecuta un sprint corto de **cierre,
no de expansión**:

- `server/checkpoint.py` ahora soporta `init(store_dir)` y respeta
  `REPOCIV_DATA_DIR` / `REPOCIV_CONFIG_DIR` (antes era hardcoded a
  `~/.repociv/checkpoints` y rompía tests bajo sandbox).
- `requirements.txt` documenta explícitamente `duckdb` y `PyYAML`
  (antes faltaban; el ledger se "deshabilitaba" en silencio).
- `server/rebuild_ledger.py` cierra el invariante de `DATA_SOURCES.md`:
  si el DuckDB se corrompe, se reconstruye desde `events.jsonl` con
  `python -m server.rebuild_ledger`. Idempotente.
- SICA self-improvement queda **dormido pero accesible**: `GET /improve/
  reflect` y `GET /improve/proposals` (read-only) lo exponen para que el
  alpha tester los inspeccione manualmente. La ruta de aplicación
  automática no se conecta hasta que la calidad de las propuestas se
  haya observado en uso real.
- 22 documentos de `docs/archive/` se condensan en este `EVOLUTION.md` +
  5 documentos-germen conservados. El historial completo sigue disponible
  en git.
- Se crea `docs/SCOPE.md` — alpha de un solo usuario; multi-device es
  branch paralela, no expansión del trunk; 3D queda permitido pero
  experimental y aislado.

Marca de fin del v2.0: el proyecto se declara "listo para alpha-test diario"
y se congela el scope hasta que el dogfooding dicte qué expandir.

---

## ¿Qué sigue?

El roadmap operacional vive en `docs/implementation_plan.md` (las 6 fases
ya cerradas + métricas de éxito) y `execplan/repociv-harness-control-plane.md`
(plan ejecutable día a día). El roadmap *de visión* (multi-device, 3D, mesh
discovery, eBPF, Linux Landlock) vive en `docs/AUDIT_DELTA_ADDENDUM.md`
pero está explícitamente bloqueado por el dogfooding según `docs/SCOPE.md`.

Si en algún momento se quiere recuperar un documento borrado:

```bash
git log --all --oneline -- docs/archive/<nombre>.md
git show <sha>:docs/archive/<nombre>.md
```

---

## Visión v3.0 (Post-v2.0 Gate F5)

Esta sección registra la evolución de RepoCiv basada en el uso diario y la expansión hacia orquestación multi-agente avanzada.

### 1. Módulo de Agentes Administradores (Repo-Local)
Módulo de diseño de agentes simplificado para asignar un "administrador de repo" a proyectos grandes (CARCOSA, SAIR, Financial Lab, etc.). El agente tendrá conocimiento especializado y prioritario sobre su repositorio asignado para tareas de mantención autónoma.

### 2. El "Hall de Agentes" (Consejo Técnico)
Infraestructura para reuniones activables entre Agentes Administradores, DAVI, LEXO-Alpha y el Usuario.
- **Formato:** Diálogo abierto con rondas de presentación de estado, comentarios cruzados y generación de propuestas de mejora para cada repositorio.
- **Rol de DAVI:** Director del Consejo para facilitar handovers entre agentes locales de un repo y el sistema de orquestación general.
- **Participación:** El usuario tiene entrada libre al diálogo para toma de decisiones en tiempo real.

### 3. Optimización de Infraestructura (SAIR Legacy)
Trasladar las metodologías probadas en el proyecto SAIR (lograr que modelos más económicos/pequeños respondan bien en tareas complejas de lógica y matemáticas) hacia los mecanismos de optimización y razonamiento de la infraestructura general de RepoCiv.

