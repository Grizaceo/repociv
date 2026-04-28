# RepoCiv Roadmap — Civ Global + RimWorld Local + XCOM Fatigue

**Fecha:** 2026-04-28
**Estado:** Revisión DAVI aprobada. Frostpunk (Phase 8) diferido.
**Decisión de alcance:** Solo dos paradigmas visuales (Civ macro + RimWorld micro). Phase 8 (Frostpunk) postergada indefinidamente hasta que se valide tracking real de tokens en OpenClaw. Sobre el nivel RimWorld se monta una sola capa económica inspirada en XCOM (fatiga de contexto). Factorio, Zachtronics y Offworld descartados.

---

## 1. Visión consolidada

RepoCiv tiene **dos niveles de zoom** y **una capa económica** sobre el nivel local:

| Nivel | Metáfora | Qué se ve | Qué se decide |
|---|---|---|---|
| **Macro (Civ)** | Civilization V | Workspace `~/.hermes/workspace/repos/` como mapa hexagonal de ciudades-repo | Misiones de alto nivel, asignación de héroes a repos, salud global |
| **Local (RimWorld)** | RimWorld / Prison Architect | Un repo como grid 2D top-down: carpetas = habitaciones, archivos = workbenches | Prioridades de agentes, asignación de tareas, deuda técnica visible |
| **Capa (XCOM)** | Fatiga de soldados | Barra de saturación de contexto en agentes stateful | Cuándo resetear DAVI/LEXO, cuándo delegar a stateless |

**Principio rector:** las capas económicas son **espaciales y siempre visibles**, no widgets de esquina. El usuario ve la economía igual que ve a los agentes.

**Lo que se difiere:** El generador Frostpunk (presupuesto de tokens proyectado como calor) se retomará solo cuando OpenClaw exponga tracking real de tokens por sesión. Sin tracking real, la mecánica sería un widget decorativo sin valor de decisión.

---

## 2. Estado actual (baseline)

Lo construido en Phases 1–5 (ver `project_repociv.md`):

- ✅ Vista Civ macro con hex grid, ciudades-repo, A* pathfinding
- ✅ Roster: DAVI/WORKER/SCOUT/LEXO/OPENCLAW con stateful/stateless flags
- ✅ Bridge.py + openclaw transport, multi-spawn, chat streaming
- ✅ HUD con VRAM, pending tracker, quest board, side panel (Chat/Git/Files)
- ✅ Skill health, session tint, sound FX, screenshots, 37 tests pasando

**Lo que falta y este roadmap aborda:** el zoom-in al repo, los agentes haciéndose ver dentro del repo, y la fatiga de contexto como mecánica visible.

---

## 3. Roadmap por fases

### Phase 6 — Transición Civ → RimWorld (zoom-in al repo)

**Objetivo:** al hacer click en una ciudad-repo, la cámara transiciona a una vista 2D top-down ortogonal del repositorio.

**Tareas:**

- **6.1 — Cámara y modo de vista**
  - Estado global `viewMode: 'macro' | 'local'` en `game.ts`
  - Transición animada (zoom + fade ~400ms) al hacer doble-click en hex-repo
  - Esc o tecla `,` (coma, "zoom out") regresa a macro
  - Persistir cuál repo está activo en local mode

- **6.2 — Generación del grid local**
  - Nuevo módulo `src/localMap.ts`: convierte estructura de carpetas (`/api/files/:repo`) en grid 2D
  - Algoritmo: BFS por carpetas, asigna a cada carpeta una **habitación rectangular** dimensionada por # archivos, separada por "muros" finos (1 tile)
  - Archivos = tiles "workbench" dentro de su habitación, ordenados por extensión (agrupar `.ts` juntos, `.test.ts` en zona aparte, etc.)
  - Cap: 200 archivos / depth ≤ 3 (ya viene del API existente)

- **6.3 — Renderer 2D ortogonal**
  - Nuevo `src/localRenderer.ts` — Canvas 2D pero con grid cuadrado, no hexagonal
  - Sprites placeholder: habitación (suelo + label de carpeta), workbench (icono por extensión), muros, puertas
  - Reusar la cámara/pan/zoom del macro renderer

- **6.4 — Mini-test del salto**
  - `src/localMap.test.ts`: verificar que un mock de file tree se traduce a habitaciones sin solapamiento
  - Smoke test: doble-click en repo dispara `viewMode = 'local'`

**Criterio de done:** doble-click en `repociv` (la propia ciudad) abre una vista 2D donde se ven `src/`, `docs/`, `public/` como habitaciones distintas con sus archivos como tiles.

---

### Phase 7a — Agentes peones en el grid local (core)

**Objetivo:** los agentes ya spawneados en macro aparecen también en local y caminan entre habitaciones para ejecutar misiones simples.checkpoint de valor intermedio mínimo viable.

**Tareas:**

- **7a.1 — Pathfinding 2D**
  - Adaptar `pathfinding.ts` para grid cuadrado (4 u 8 vecinos). Reutilizar A* core.
  - Costos: suelo de habitación = 1, puerta = 1, muro = ∞, "escombros" (deuda técnica) = 3

- **7a.2 — Estados de agente local**
  - Extender `Unit.state`: añadir `walking_to_workbench`, `working_on_file`, `idle_in_room`, `resting`
  - Cada misión asignada a un archivo → el agente camina a esa habitación → al workbench → trabaja con animación (pulso del tile)
  - Sistema de cola simple: el primer agente disponible toma la siguiente misión de la cola

- **7a.3 — Missions reales a habitaciones**
  - Missions de macro que apuntan a un repo tienen un target `file_path` o `folder_path`
  - Al entrar a local view, la misión se traduce a: "camina a habitación X, trabaja en tile Y"
  - El agente sigue su estado natural (walking → working → done)

**Criterio de done:** spawneas un WORKER en macro, le das misión "revisar src/main.ts", entras al repo en local view, lo ves caminar a `src/`, pararse en `main.ts`, y el tile muestra animación de trabajo.

---

### Phase 7b — Sistema de prioridades y deuda técnica

**Objetivo:** agregar la matriz de prioridades estilo RimWorld y deuda técnica visible como escombros.

**Tareas:**

- **7b.1 — Priority Matrix UI**
  - Panel "Priority Matrix" (hotkey `P`): tabla agentes × tipos-de-tarea (Bugfix / Refactor / Feature / Docs / Test)
  - Por agente, números 1–4 (1 = crítico, 4 = solo si nada más). Default por tipo: WORKER prioriza Bugfix, SCOUT prioriza Docs/Test, DAVI/LEXO prioriza Feature/Refactor
  - Persistir matriz en `~/.repociv/priorities.json`

- **7b.2 — Lógica de asignación por prioridad**
  - Cuando llega una misión: el agente disponible con mayor prioridad (número más bajo) para ese tipo de tarea la toma
  - Resolución de conflictos: si dos agentes tienen igual prioridad, el que tiene menos misiones activas gana; si persiste, primero en tiempo
  - WORKER stateless toma Bugfix antes que DAVI stateful (costo/beneficio)

- **7b.3 — Tech Debt endpoint y visualización**
  - `/api/tech-debt/:repo` nuevo endpoint en bridge.py: scan rápido (TODO, FIXME, archivos > 500 líneas, tests faltantes en archivos `.ts` sin `.test.ts`)
  - En el grid local: aparece como tiles con textura "escombros" sobre el workbench afectado
  - Agentes con prioridad de Bugfix/Refactor consumen escombros como cualquier otra misión

**Criterio de done:** spawneas un WORKER en macro, le das misión "fix lint en src/", entras al repo en local view, lo ves caminar a `src/`, pararse en un archivo con TODO, y ese tile pasa de "escombros" a limpio. La Priority Matrix responde a cambios de tipo de tarea en tiempo real.

---

### Phase 8 — Capa Frostpunk: generador de tokens ⚠️ DEFERIDA

**Estado:** POSTERGADA hasta que se valide tracking real de tokens desde OpenClaw.

**Razón:** Sin tracking real (no estimación por longitud), el generador sería un widget decorativo que no refleja la realidad del consumo. Genera *false confidence*.

**Condiciones para retomar:**
1. OpenClaw expone `chat_chunk` tokens usados por sesión O un endpoint equivalente
2. Se valida que el número correlaciona con el billing real
3. Spike confirmando que bridge.py puede leer ese dato sin polling costoso

**Criterio de done (cuando se desbloquee):** en local view se ve el generador con halo de calor; spawneas 4 DAVIs en una misión grande, el halo se contrae visiblemente, los DAVIs más lejanos hacen downgrade automático a Sonnet, y aparece la alerta de tormenta.

---

### Phase 9 — Capa XCOM: fatiga de contexto

**Objetivo:** agentes stateful (DAVI, LEXO, OPENCLAW) acumulan saturación de contexto. Visible y accionable.

**Tareas:**

- **9.1 — Tracking de contexto**
  - Bridge.py reporta por agente stateful: `contextUsedTokens / contextLimitTokens`
  - Para openclaw: parsear output (ya hay tracking interno) o estimar por longitud acumulada de session
  - Stateless: siempre 0% (el flag stateless ya existe en `AGENT_CONFIGS`)

- **9.2 — Barra de fatiga en hero bar**
  - Sobre cada portrait de agente stateful: barra horizontal verde→amarillo→rojo
  - 0–60%: verde (fresco). 60–80%: amarillo. 80–100%: rojo, ícono de "Z" parpadeando
  - Tooltip muestra tokens exactos y sugerencia ("Considera /clear o delegar a WORKER")

- **9.3 — Comportamiento de agente fatigado**
  - >80%: el agente sigue funcionando pero al iniciar misión pregunta en chat: "Mi contexto está al X%, ¿reseteo o continúo?"
  - >95%: rechaza misiones nuevas, sugiere otro agente o reset
  - Reset = nueva session-id de openclaw, hereda system prompt del `AGENT_CONFIGS` pero pierde historial

- **9.4 — Visualización en local view**
  - Agentes fatigados caminan más lento (anim) y emiten partículas de "cansancio"
  - Tile "cama" / "rest area" auto-generado en una habitación: agente fatigado en idle camina ahí y restaura contexto (= /clear automático tras N segundos sin tarea)

**Criterio de done:** trabajas 30 min con un DAVI en misiones largas, su barra llega al 85%, parpadea, te avisa en chat, y al ponerlo en idle camina solo a un "rest area" para resetearse.

**Nota:** Esta fase puede ejecutarse en paralelo a Phase 7b una vez 7a esté mergeada. La implementación de tracking de contexto es independiente del sistema de prioridades.

---

### Phase 10 — Polish y coherencia

- **10.1 — Tutoriales contextuales:** primera vez que entras a local view, tooltip explica habitaciones/workbenches. Primera vez que un agente alcanza 80% fatiga, tooltip explica la barra.
- **10.2 — Settings panel:** umbrales de fatiga, modelos permitidos, toggle "skip animations".
- **10.3 — Tests:**
  - `localMap.test.ts` (Phase 6)
  - `priority.test.ts` para lógica de asignación y resolución de conflictos (Phase 7b)
  - `fatigue.test.ts` para transiciones de estado (Phase 9)
  - Target: 60+ tests totales (vs 37 actuales)
- **10.4 — Screenshot showcase:** F12 captura tanto macro como local. Generar GIF demo del flujo completo.
- **10.5 — Documentación de handover:** README actualizado con el flujo completo macro→local y cómo agregar un nuevo tipo de agente.

---

## 4. Orden de ejecución sugerido

```
Phase 6 → Phase 7a → Phase 7b → Phase 9
  │          │           │         │
  │          │           │         └── puede ir en paralelo a 7b
  │          │           └── checkpoint de valor: matriz + tech debt visible
  │          └── checkpoint mínimo: agentes caminando en grid
  └── fundación del nivel RimWorld
```

**Nota sobre Phase 8:** No aparece en la secuencia activa. Se desbloquea solo cuando el spike de tracking real de tokens confirme viabilidad.

**Recomendación:** Phase 6 + 7a son el corazón y deben ir juntas (no tiene sentido un grid local sin agentes vivos en él). 7b entrega el sistema completo. Phase 9 puede ir en paralelo a 7b si hay ancho de banda.

---

## 5. Riesgos y trade-offs

| Riesgo | Mitigación |
|---|---|
| El grid local se ve vacío en repos pequeños | Tamaño mínimo de habitación + decoración procedural (estanterías, plantas) |
| La Phase 7b (prioridades) es más compleja de lo que parece | Split 7a/7b da checkpoint intermedio; si 7b explota, 7a ya funciona |
| La barra de fatiga estresa innecesariamente al usuario | Defaults conservadores (umbral 80%), settings para silenciar, rest area automático |
| Phase 9 agrega carga cognitiva sin que el core esté maduro | Hacer Phase 6+7a+7b sólidas antes de empezar 9 |
| Sobre-mapping juego→ingeniería puede dar fricción ("¿por qué mi agente camina?") | Toggle "skip animations" para usuarios pragmáticos |

---

## 6. Lo que explícitamente NO está en este roadmap

- **Factorio / flujo de datos:** descartado por baja accionabilidad en repos estáticos.
- **Zachtronics / vista AST:** descartado; compite con el IDE real sin diferenciarse.
- **Mercados de APIs (Offworld Trading):** descartado; los precios reales no fluctúan lo suficiente.
- **Slay-the-Spire deckbuilding:** descartado; compite con la metáfora RimWorld de prioridades.
- **Frostpunk / generador de tokens (Phase 8):** POSTERGADO; se desbloquea con tracking real de tokens.
- **Integración 3rd party (Claude/Gemini/Codex como agentes propios):** después de consolidar el roster propio (decisión registrada en `project_repociv_roster.md`).

---

## 7. Definición de "Roadmap completo"

Este documento se considera completo cuando:

- Phase 6 + 7a mergeadas y demo del salto Civ → RimWorld con agentes caminando funciona end-to-end
- Phase 7b mergeada y la Priority Matrix es visible y editable; escombros visibles en deuda técnica
- Phase 9 mergeada y al menos DAVI tiene barra de fatiga funcional con rest area
- Phase 10 mergeada y hay tutorial + tests (60+) + showcase

A partir de ahí, el siguiente roadmap puede abordar Phase 8 (Frostpunk si se desbloqueó el tracking), 3rd parties, o multi-workspace.
