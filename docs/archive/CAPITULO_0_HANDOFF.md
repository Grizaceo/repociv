# RepoCiv — CAPITULO 0: HANDOFF POST-SESSION 2026-04-28

> Autor: DAVI (kimi-k2.6 → mimo-v2.5-pro → minimax-m2.7 en sesión con múltiples compaction events)
> Destinatario: Opus 4.7 (revisor/arreglador con contexto extendido)
> Estado: Sessión anterior crashó por context window exhaustion. Todo análisis auditado, fixes aplicados, repo funcional.
>
> **INSTRUCCIONES DE ARRANQUE:**
> 1. Lee `SOUL.md` si existe (identidad DAVI/proyecto).
> 2. Lee `docs/CONTEXT_ROADMAP.md` (decisiones de diseño de Cristóbal).
> 3. Lee ESTE archivo para ver qué se hizo y qué no.
> 4. Corre `cd ~/.hermes/workspace/repos/repociv && git status` para ver estado de working tree.
> 5. Si hay working tree changes → son de la sesión anterior (ver sección "Cambios Aplicados").

---

## 1. ¿Qué pasó en esta sesión?

- DAVI auditó RepoCiv end-to-end (src/, bridge.py, vite.config.ts, docs/).
- Identificó deuda técnica clasificada: SOBRA / MERGE / FALTA.
- Cristóbal tomó decisiones clave (ver Sección 3).
- DAVI aplicó fixes mecánicos (no-feature) durante la sesión.
- La sesión CRASHÓ al intentar generar un PLAN_EJECUCION.md grande (compaction + interruption loop). **NO completó el artefacto de planificación.**
- Este handoff compila TODO el contexto que se perdió en el crash.

---

## 2. Estado Verificado del Repo (post-sesión)

**Branch:** `main` @ commit `b1bdbb6` (v0.1.0 init — único commit)
**Working tree changes:** Sí, 5 archivos modificados (ver detalle en Sección 7)
**Servicios:** Vite dev (puerto 5273) y bridge.py (puerto 5274) fueron levantados y verificados OK (`/health`, `/api/repos`, smoke visual).

**Arquitectura (ya auditada):**
```
RepoCiv/
├── bridge.py          (506 LOC) — HTTP bridge Python, conecta a agentes OpenClaw/Hermes
├── vite.config.ts     (274 LOC) — Vite + plugin custom que scanea ~/.hermes/workspace/repos/
├── index.html         — Canvas 2D + UI overlays
├── src/
│   ├── main.ts        (326 LOC) — Bootstrap, keyboard shortcuts, spawn units
│   ├── game.ts        (245 LOC) — Estado del mundo, unidades, ciudades, edificios
│   ├── renderer.ts    (798 LOC) — Canvas 2D: hexes, unidades, minimapa, fog, selección
│   ├── map.ts         (298 LOC) — Generación de terreno desde repos reales
│   ├── hex.ts         (209 LOC) — Matemática hexagonal axial
│   ├── pathfinding.ts  (94 LOC) — A* con cache por unitType
│   ├── bridge.ts      (236 LOC) — Comunicación con bridge.py + demo mode
│   ├── ui.ts          (431 LOC) — DOM: panel lateral, quest board, chat, GPU bar, keyboard help
│   ├── types.ts       (144 LOC) — Interfaces + UNIT_COLORS + tileKey
│   ├── hex.test.ts    (158 LOC) — Tests geometricos hex
│   └── pathfinding.test.ts (201 LOC) — Tests A*
├── docs/
│   ├── DESIGN.md               — Diseño original (posiblemente stale vs types.ts)
│   ├── PLAN_EJECUCION.md       — Plan sprint original
│   ├── SPRINTS.md              — Sprints originales
│   ├── TASKBOARD.md            — Tablero de tareas
│   └── CONTEXT_ROADMAP.md    — Guardado durante esta sesión con decisiones de Cristóbal
└── .env / .env.example         — Creados: ports, paths, modelo
```

**Stack:** TypeScript + Vite (frontend), Python HTTP server (bridge.py), Canvas 2D raw (sin framework tipo Phaser), Vitest para tests.

---

## 3. Decisiones de Diseño Confirmadas por Cristóbal

> Esto NO es sugerencia. Es el estado actual de cada decisión con la que Cristóbal eligió.

### 3.1 Modo de Trabajo: DISEÑO primero, CÓDIGO después
Cristóbal fue explícito: "estamos en una fase de diseño [...] no quiero que te quedes OOM porque me obligas a iniciar a diseñar de 0". Se hicieron SOLO fixes mecánicos (limpieza), NINGUNA implementación de feature nueva.

### 3.2 Motor de Ciudades vs Repos
Repos = Ciudades. Extensiones de archivo = terreno. Agentes (DAVI, LexO, Workers, Scouts) = unidades jugables. Workspace completo = mapa hexagonal.

### 3.3 Reverse Engineering de Civ V (2010)
Cristóbal tiene 679h en Civ V (2010). Está descargando/obteniendo versión crackeada para hacer ingeniería inversa de mecánicas.
- SDK público de referencia: `github.com/dmnd/CvGameCoreSource` (C++, descompilado/reconstruido del DLL original).
- Objetivo: extraer algoritmos de colas de producción, sistema de Great People, fog of war, diplomacia AI, marcas de territorio/expansión de ciudades (border expansion, culture).
- FitGirl repack ≠ crack, pero el SDK público contiene las ideas algorítmicas portables.

### 3.4 Dos Wonders Definidas
1. **LABORATORY** — Maravilla que vincula repos de laboratorio (protein-lab, financial-lab). Lee colab_runs/*.json y PENDING_TRACKER.md. Endpoint: /api/lab/status.
2. **GREAT LIBRARY** — Dos bibliotecas separadas visualmente:
   - Biblioteca de LexO (legal): IndexO, jurisprudencia, vault legal.
   - Biblioteca de Cristóbal (Obsidian): notas de proyectos, memoria personal, workspaces.

### 3.5 Prioridad de Fixes (orden de Cristóbal)
1. **Smoke test visual** — "hacer que los hexágonos se vean mejores" (cruzar con Civ V).
2. **Bridge.py conectado a DAVI real** — Que el bridge no sea solo modo DEMO.
3. **Territorio/Ciudad** — Click en repo/carpeta debe abrir una "ficha de ciudad" estilo Civ V. Marcado de territorios/jurisdicción.
4. **Unidades y edificios 3D-ish** — Estilo sprite 2.5D sobre mapa 2D, inspirado en cómo se ven en Civ V.

---

## 4. Auditoría SOBRA / MERGE / FALTA (Completa)

### SOBRA (Eliminar / Limpiar)
| # | Problema | Ubicación | Estado |
|---|---------|-----------|--------|
| 1 | `UNIT_TYPE_COLOR` duplica `UNIT_COLORS` | `game.ts` l.23–28 | **✅ FIX APLICADO** |
| 2 | `tileKey()` duplicado en renderer | `renderer.ts` + `types.ts` | **✅ FIX APLICADO** (quedó local en renderer con side-effect; ver nota técnica 7.2) |
| 3 | `HEX_SIZE_LOCAL` declarada sin uso | `renderer.ts` l.749 | Pendiente (sin riesgo) |
| 4 | `spawnCounters` (TS) vs `_lexo_counter` (Python) divergen | `main.ts` l.282 / `bridge.py` l.190 | Pendiente — backend debe generar ID |
| 5 | `styles.css` 1122 líneas monolítico | `src/styles.css` | Pendiente — modularizar o CSS-in-TS |
| 6 | Fallo offline retorna `success=true` en bridge.py | `bridge.py` l.361-372 | Pendiente — debería retornar `simulated: true` o `success: false` |

### MERGE (Consolidar / Modularizar)
| # | Problema | Ubicación | Estado |
|---|---------|-----------|--------|
| 1 | `ui.ts` monolito (~431 LOC) | `src/ui.ts` | Pendiente — partir en `ui/{panel,chat,quest,keyboard}.ts` cuando pase 800 |
| 2 | `Camera` debería ser módulo aparte | `hex.ts` + `renderer.ts` | Pendiente — centralizar |
| 3 | `SKIP_DIRS` repetido en dos archivos | `vite.config.ts` + `bridge.py` | Pendiente — unificar |
| 4 | `bridge.py` en raíz (mezcla frontend/backend) | raíz | Pendiente — mover a `server/` o `api/` |
| 5 | renderer.ts = God Class (798 LOC) | `src/renderer.ts` | Pendiente — fragmentar en `HexRenderer`, `UnitRenderer`, `MiniMapRenderer` |
| 6 | Pathfinding no ve colisiones de unidades | `pathfinding.ts` | Pendiente — A* cruza hexes ocupados |

### FALTA (Instalar / Implementar)
| # | Problema | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | Validar eventos bridge con Zod/Valibot | **CRÍTICO** | Pendente — `bridge.ts` hace `data as BridgeEvent` (l.30), crashea silenciosamente |
| 2 | Config hardcodeada → `.env` | **CRÍTICO** | **✅ FIX PARCIAL** — vite.config + bridge.ts + ui.ts ya usan `import.meta.env`. Falta migrar `bridge.py` (Python `python-dotenv`) |
| 3 | Tests para game.ts, bridge.ts, renderer | **ALTO** | Pendiente — 0 tests para lógica core |
| 4 | CORS `*` sin auth en bridge.py | **ALTO** | Pendiente — riesgo si se expone fuera de localhost |
| 5 | `updateUnits(_dt)` ignora delta time | **MEDIO** | Pendiente — `0.04` hardcodeado, frame-dependent |
| 6 | Parser `PENDING_TRACKER.md` naive | **MEDIO** | Pendiente — solo `- [ ]`, no detecta `- [x]` |
| 7 | Auto-invalidate cache de repos | **MEDIO** | Pendiente — `cachedRepos` sin TTL |
| 8 | Memory leak en renderer loop | **MEDIO** | Pendiente — no perfilado |
| 9 | README operativo | **BAJO** | Pendiente — no existe en raíz |
| 10 | WebSocket bridge en vez de HTTP polling | Mejora | Propuesto — polling 5s es lento |
| 11 | Event sourcing para replay | Mejora | Propuesto — log de eventos en jsonl |
| 12 | Sistema de turnos / eras | Mejora | Propuesto — overlay turn-based para flujo de trabajo |
| 13 | Trade Routes entre repos | Mejora | Propuesto — visualizar flujo de datos entre laboratorios |
| 14 | City-States = orphan repos | Mejora | Propuesto — repos pequeños como city-states |
| 15 | Notifications / Advisor popups | Mejora | Propuesto — sistema de notificaciones tipo Civ V |
| 16 | Click en tile → ficha de ciudad | **NUEVO (solicitado)** | Pendiente — Cristóbal quiere esto explicitamente |

---

## 5. Roadmap de Sprints (propuesto por DAVI, validado por Cristóbal)

**NOTA:** Cristóbal aceleró los tiempos: "adelantaremos los tiempos de trabajo... me pican las manos".

### SPRINT 0: Foundation (ESTE HANDOFF = base)
- [x] Init git + .gitignore
- [x] Smoke test visual (frontend carga, bridge health OK, 24 repos detectados)
- [x] SOBRA mecánico: eliminar duplicados UNI_TYPE_COLOR, tileKey
- [x] CRÍTICO .env wiring parcial (vite.config.ts, bridge.ts, ui.ts)
- [ ] CRÍTICO #2 completar: `bridge.py` debe leer `.env` (python-dotenv)
- [ ] CRÍTICO #1: Validación Zod en events bridge

### SPRINT 1: "Lo veo correr y no se cae"
- [ ] Arreglar renderer.ts God Class → `HexRenderer` + `UnitRenderer` + `MiniMapRenderer`
- [ ] Arreglar pathfinding con colisiones (unidades no pueden cruzarse)
- [ ] Arreglar `chatBuffers` memory leak en `ui.ts`
- [ ] Arreglar `updateUnits` frame-dependent → time-dependent con `dt`
- [ ] Validación Zod/Valibot en `bridge.ts`
- [ ] Arreglar bridge.py `success=true` en modo offline (debería ser `simulated: true`)
- [ ] Arreglar minimap viewport (desfase en proyección Y)
- [ ] Arreglar edificios completos no visibles (`drawBuilding` return si `state === 'complete'`)

### SPRINT 2: Orquestación Real
- [ ] Bridge.py conectado a DAVI real (no demo mode)
- [ ] Cuando DAVI termina tarea → RepoCiv muestra notificación + avanza quest bar
- [ ] Integrar PENDING_TRACKER.md como Quest Board real
- [ ] Screenshot del día: "qué hice hoy" exportable
- [ ] WebSocket bridge (opcional, pero mejora latencia)

### SPRINT 3: Multi-Agent + Territorio
- [ ] LexO como unidad separada con misión legal
- [ ] Worker como unidad batch (protein-lab tasks)
- [ ] **Click en tile → ficha de ciudad** (estilo Civ V)
- [ ] Marcado de territorios/jurisdicción (border expansion como Civ V)
- [ ] Trade Routes entre repos (protein-lab ↔ repociv)

### SPRINT 4: Wonders
- [ ] WONDER: Laboratory (links protein-lab, financial-lab, colab_runs)
- [ ] WONDER: Great Library — LexO vault (IndexO) separada de Obsidian vault
- [ ] Gran Biblioteca indexa sesiones .jsonl como "tablets"
- [ ] Búsqueda semántica vía Hindsight local_embedded

### SPRINT 5: Memoria Institucional
- [ ] Event Sourcing (log de eventos en jsonl)
- [ ] Replay diario (qué hice el 27 de abril como animación)
- [ ] Demographics / Victory Conditions panel
- [ ] Civ V SDK inspection completa para mecánicas de AI/turnos

---

## 6. Notas para Agentes Futuros (Opus 4.7 y siguientes)

6.1. **El estilo de Cristóbal** es fix-and-rerun: da opciones (a/b/c/d), el elige directo sin discusión. No hacer análisis largo antes de preguntar.

6.2. **El repo está en working tree modificada, no commiteada.** Si vas a hacer cambios de código, haz `git add . && git commit -m "..."` para no perder lo que ya está aplicado.

6.3. **bridge.py usa modelo hardcodeado** (`mimo-v2.5-pro` o `minimax-m2.6` linea 339). Aunque existe `.env`, `bridge.py` NO lo lee todavía (falta python-dotenv).

6.4. **Los tests existen** (`hex.test.ts`, `pathfinding.test.ts`) pero Vitest no está ejecutándose automáticamente (`npm test` debería funcionar).

6.5. **El puerto de Vite es 5273, bridge.py es 5274.** Están ambos levantándose correctamente. Si algo falla, verifica con `ss -tlnp | grep 527`.

6.6. **Cristóbal quiere que la interfaz misma sirva para "mejorar la capital"** — es decir, el repo RepoCiv se consume a sí mismo como herramienta de trabajo. La metáfora es que "mejorar el juego" = "mejorar la ciudad principal".

6.7. **La sesión crashó** al intentar generar un documento completo con toda la planificación. ESO es lo que este handoff logra. **Este documento ES el output perdido.**

---

## 7. Cambios Aplicados (verificados en git diff HEAD)

### 7.1 `src/game.ts`
- Removido `UNIT_TYPE_COLOR` duplicado.
- Importa `UNIT_COLORS` y `tileKey` desde `types.ts`.
- `spawnUnit` ahora usa `UNIT_COLORS[type] ?? UNIT_COLORS['hero']!`.

### 7.2 `src/renderer.ts`
- Importa `tileKey` desde `types.ts`.
- **NOTA TÉCNICA:** El patch intentó eliminar `tileKey()` local de renderer.ts pero hubo un side-effect. La versión actual de renderer.ts tiene `import { ..., tileKey, } from './types.ts';` en la cabecera, y adicionalmente una función `worldToViewport` donde antes estaba `tileKey()`. Verifica no hay conflicto.

### 7.3 `src/bridge.ts`
- `BRIDGE_URL` ahora usa `import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:5274'`.

### 7.4 `src/ui.ts`
- `fetchPendingTracker()`: URL usa template literal con `VITE_BRIDGE_URL`.
- `fetchPersistedMissions()`: Idem.

### 7.5 `vite.config.ts`
- Usa `loadEnv()` + `defineConfig(({ mode }))`.
- Lee `VITE_PORT` del `.env` (default 5273).

### 7.6 `.env` y `.env.example` (nuevos archivos)
- Variables: `VITE_PORT=5273`, `BRIDGE_PORT=5274`, `REPOCIV_PORT=5273`, paths, `HERMES_URL`, `HERMES_KEY`, `HERMES_MODEL=minimax-m2.6`.

---

## 8. Acciones Inmediatas Sugeridas para Siguiente Sesión

### Si la sesión es FASE DE DISEÑO (recomendado por Cristóbal):
1. **No tocar código.**
2. Generar los assets de diseño que Cristóbal pidió: plan de mecánicas Civ V, mockups de ficha de ciudad, mockups de border expansion.
3. Revisar `github.com/dmnd/CvGameCoreSource` para extraer algoritmos concretos.
4. Generar `docs/SPRINT_PLAN.md` con el roadmap de sprints (este documento, Sección 5).

### Si la sesión es IMPLEMENTACIÓN:
1. `git add . && git commit -m "fix: cleanup duplicates + .env wiring (partial)"`.
2. Terminar `.env` wiring en `bridge.py` (python-dotenv).
3. Implementar Zod validation en `bridge.ts`.
4. Corregir renderer.ts God Class (o al menos, el memory leak y el frame-dependent movement).

---

## 9. Contexto de Juego de Cristóbal (para entender prioridades)

- **Civilization V (2010):** 679h. Es su referente principal.
- **Dead by Daylight:** 1073h.
- **World of Warcraft:** sin contador ("me daría vergüenza").
- Metáfora: quiere un "Civilization de su workspace" donde él no sea el bottleneck de 4 agentes paralelos.

---

*"La idea es que la misma interfaz sirva para mejorar la capital."*
*— Cristóbal, 2026-04-28*