# RepoCiv Roadmap — Civ Global + RimWorld Local + XCOM Fatigue

**Fecha:** 2026-04-28
**Estado:** Diseño aprobado. Frostpunk (Phase 8) diferido con condiciones explícitas.
**Decisión de alcance:** Dos paradigmas visuales únicamente (Civ macro + RimWorld micro). Phase 8 postergada hasta que OpenClaw exponga tracking real de tokens. Sobre local view se monta una sola capa económica: fatiga de contexto estilo XCOM. Factorio, Zachtronics y mercados de APIs descartados.

---

## 1. Visión consolidada

RepoCiv tiene **dos niveles de zoom** y **una capa económica** sobre el nivel local:

| Nivel | Metáfora | Qué se ve | Qué se decide |
|---|---|---|---|
| **Macro (Civ)** | Civilization V | Workspace `~/.hermes/workspace/repos/` como mapa hexagonal | Misiones largas, asignación de héroes a repos, salud global |
| **Local (RimWorld)** | RimWorld / Prison Architect | Un repo como grid 2D: carpetas = habitaciones, archivos = workbenches | Prioridades de agentes, asignación de tareas, deuda técnica |
| **Capa (XCOM)** | Fatiga de soldados | Barra de saturación de contexto en agentes stateful | Cuándo resetear DAVI/LEXO, cuándo delegar a WORKER/SCOUT |

**Principio rector:** los indicadores económicos son espaciales y siempre visibles, no widgets de esquina. El usuario ve la economía igual que ve a los agentes.

**Decisión Frostpunk:** Se retomará solo cuando OpenClaw exponga tokens por sesión de forma estructurada. Sin ese dato, el generador sería decoración sin valor de decisión real.

---

## 2. Estado actual (baseline — Phases 1–5 completas)

- ✅ Vista Civ macro con hex grid, ciudades-repo, A* pathfinding
- ✅ Roster: DAVI/WORKER/SCOUT/LEXO/OPENCLAW con stateful/stateless flags en `AGENT_CONFIGS`
- ✅ Bridge.py + openclaw transport, multi-spawn, chat streaming por chunks
- ✅ HUD con VRAM bar, pending tracker, quest board, side panel (Chat/Git/Files)
- ✅ Skill health, session tint, sound FX, screenshots F12, 37 tests pasando

**Lo que falta:** zoom-in al repo con grid local, agentes caminando entre habitaciones, y fatiga de contexto visible en el hero bar.

---

## 3. Decisiones de diseño fijas (no revisar en implementación)

Antes de entrar a las fases, estas decisiones están cerradas:

1. **`UnitState` no se extiende** — los estados del bridge wire (`idle | moving | working | sleeping | building`) quedan intactos para no romper `bridge.ts`, `bridgeSchema.ts` ni `bridge.py`. La vista local usa un enum paralelo `LocalUnitState` que vive solo en el frontend.

2. **Double-click → local view** — el renderer actual despacha en `mouseup`. El salto a local view se implementa con `dblclick` nativo, que no colisiona con el single-click de ciudad. No se usa timer/setTimeout.

3. **3D mode incompatible con local view** — mientras `viewMode === 'local'`, el botón de 3D toggle queda deshabilitado. Al salir de local, el 3D vuelve a estar disponible. No hay local view en Three.js.

4. **Mission-to-file binding** — cuando una misión corre en bridge.py y menciona un path (parseado del `questName` con regex simple `/([a-zA-Z0-9_\-./]+\.[a-z]{1,5})/`), el evento `mission_start` incluye un campo opcional `filePath?: string`. El local renderer usa ese campo para enviar al agente al workbench correcto.

5. **Token tracking en Phase 9** — OpenClaw no expone counts estructurados en stdout. La primera implementación usa **longitud acumulada de `chat_chunk` por session-id** como proxy (rough estimate: 4 chars ≈ 1 token). Se etiqueta como estimación en la UI; el tracking real se agrega cuando esté disponible.

6. **Persistencia de prioridades** — `~/.repociv/priorities.json`. Bridge.py lo lee al arrancar y en cada `unit_command` para saber qué agente tomar si la lógica de auto-asignación está activa. El frontend escribe directamente al archivo vía un nuevo endpoint `POST /api/priorities`.

---

## 4. Roadmap por fases

### Phase 6 — Transición Civ → RimWorld

**Objetivo:** doble-click en una ciudad abre una vista 2D top-down del repositorio.

#### 6.1 — Modo de vista y navegación

- `viewMode: 'macro' | 'local'` y `activeRepo: string | null` se añaden a `GameState`.
- `Renderer` expone `getCamera()` (ya existe por el 3D toggle) — reutilizar para leer posición al transicionar.
- Transición: fade-out canvas (opacity 0, 300ms), swap renderer, fade-in (300ms). Sin Three.js implicado.
- **Entrada:** `dblclick` en hex con ciudad → `state.enterLocalView(city.id)`.
- **Salida:** `Escape` o tecla `,` → `state.exitLocalView()`.
- En local mode: deshabilitar botón 3D toggle (add `disabled` + tooltip "No disponible en vista de repo").
- Teclas de spawn (Q/W/E/L/O) y hero bar siguen funcionales en local view.

#### 6.2 — Generación del grid local (`src/localMap.ts`)

Contrato de entrada/salida:

```typescript
// Input
type FileList = string[]  // rutas relativas, ej. ["src/main.ts", "docs/DESIGN.md"]

// Output
interface LocalWorld {
  width: number
  height: number
  grid: LocalTile[][]     // [y][x], origen top-left
  rooms: Room[]
  repoName: string
}

interface Room {
  id: string        // = nombre del folder top-level
  name: string
  x: number         // top-left en grid
  y: number
  width: number     // incluye paredes (interior + 2)
  height: number
}

type LocalTileType = 'floor' | 'workbench' | 'wall' | 'door' | 'rest_area' | 'debris'

interface LocalTile {
  x: number
  y: number
  type: LocalTileType
  roomId?: string
  fileName?: string   // solo workbench
  filePath?: string   // ruta relativa desde repo root
  techDebt?: boolean  // overlay de escombros
}
```

Algoritmo de layout:
1. Agrupar archivos por carpeta top-level. Archivos en root van a habitación `(root)`.
2. Ordenar rooms por cantidad de archivos (desc).
3. Calcular dimensiones de cada room: `innerW = ceil(sqrt(n))`, `innerH = ceil(n / innerW)`, mínimo 3×3.
4. Colocar rooms en grid: `cols = ceil(sqrt(numRooms))`. Separación entre rooms = 2 tiles de suelo (corredor, no muro).
5. Init grid: todo suelo. Pintar paredes solo en el perímetro de cada room.
6. Workbenches: primeros `innerW * innerH` archivos, ordenados por extensión (`.test.ts` al final).
7. Puerta: 1 tile gap en la pared sur de cada room, centrado.
8. Rest area: 1 tile especial en la primera room (esquina NW del interior).

Fuente: `GET /api/files/:repo` (ya existe, devuelve `string[]`, max 200 archivos, depth ≤ 3).

#### 6.3 — Renderer local (`src/localRenderer.ts`)

- `TILE_SIZE = 20` (px). Camera: pan + rueda = zoom idéntico a macro renderer.
- **Render passes:**
  1. Fondo `#0a0a0a`.
  2. Suelo: `#1a1a1a` (corredor) / `#1e1c18` (interior room).
  3. Paredes: `#2a2520` con borde `#3a3228`.
  4. Workbenches: `#2d2518` con ícono de extensión (1–2 chars, ej. `.ts`, `.py`, `.md`).
  5. Doors: gap visual, suelo ligeramente más claro.
  6. Rest area: `#1a2a1a` con símbolo `🛌` centrado.
  7. Debris overlay: patrón de cruces rojas semitransparentes sobre el tile.
  8. Room labels: `Cinzel` 11px, centrado en el techo de la habitación.
  9. Agentes locales (ver Phase 7a).
  10. Hover tile outline: `#c8a84b60`.
  11. Vignette radial igual que macro renderer.
- La minimap sigue mostrando la vista macro. En local view, la minimap muestra el grid local (versión miniaturizada, mismo algoritmo, colores sólidos).

#### 6.4 — Tests (`src/localMap.test.ts`)

Casos mínimos:
- `groupByFolder`: archivos sin carpeta van a `(root)`.
- `roomDimensions`: 25 archivos → innerW=5, innerH=5.
- `buildGrid`: rooms no se solapan (todos los tiles son únicos por coordenada).
- `buildGrid`: cada workbench tile tiene `filePath` correcto.
- `buildGrid`: hay exactamente 1 `rest_area` en el grid.

**Criterio de done de Phase 6:** doble-click en el hex `repociv` abre vista 2D donde se ven `src/`, `docs/`, `public/` como rooms separadas con sus archivos como workbenches. Esc vuelve al mapa Civ.

---

### Phase 7a — Agentes en el grid local (MVP)

**Objetivo:** los agentes spawneados en macro aparecen en local y caminan a workbenches cuando tienen misiones activas.

#### 7a.1 — Tipos locales (`src/types.ts`)

```typescript
// Estados de agente en local view — NO usan el bridge wire, son solo frontend
type LocalUnitState = 'idle_in_room' | 'walking' | 'working_on_file' | 'resting'

interface LocalUnit {
  unitId: string          // mismo id que Unit en GameState
  x: number               // posición en grid local (tile coords)
  y: number
  targetX?: number
  targetY?: number
  localPath: Array<{x: number, y: number}>
  pathIndex: number
  pathProgress: number    // 0–1 tween
  localState: LocalUnitState
  workingFile?: string    // filePath del tile workbench actual
}
```

`LocalUnit` es paralelo a `Unit` — no reemplaza ni extiende el tipo existente.

#### 7a.2 — Pathfinding 2D (`src/localPathfinding.ts`)

- A* idéntico al de `pathfinding.ts` pero sobre `LocalTile[][]` en lugar de `Map<string, Tile>`.
- Vecinos: 4-direccionales (arriba/abajo/izq/der). Sin diagonales para que se vea más RimWorld.
- Costos: `floor = 1`, `door = 1`, `workbench = 1` (se puede caminar sobre ellos), `wall = Infinity`, `debris = 3`.
- Cache: `Map<string, GridCoord[]>` keyed `"x,y→x,y"`. Invalidar al cambiar el grid.

#### 7a.3 — LocalGameState (`src/localGame.ts`)

- Clase `LocalGameState` que encapsula `LocalWorld` + `Map<string, LocalUnit>`.
- Al entrar a local view: todos los `Unit` del `GameState` que tienen `mission` con `filePath` parseable reciben un `LocalUnit` en la rest area (spawn point inicial).
- Cada tick: `LocalUnit` con `localState = 'walking'` avanza `pathProgress += 0.05`. Al llegar, transiciona a `working_on_file` y pulsa el tile (animación en renderer).
- Misión → workbench: el campo `filePath` se obtiene del evento `mission_start` (bridge.py lo incluye si detecta path en el `questName`). Si no hay `filePath`, el agente queda en `idle_in_room`.
- `LocalGameState` se crea en `main.ts` al entrar a local view y se destruye al salir.

#### 7a.4 — Bridge.py: filePath en mission_start

En `bridge.py`, dentro de `run_agent()`, antes de emitir `mission_start`:
```python
import re
PATH_RE = re.compile(r'([a-zA-Z0-9_\-./]+\.[a-z]{1,6})')
match = PATH_RE.search(mission)
file_path = match.group(1) if match else None
# Añadir file_path al evento mission_start si lo encontró
```

**Criterio de done de Phase 7a:** WORKER con misión "revisar src/main.ts" → en local view camina de la rest area a la habitación `src/`, se para en el tile `main.ts`, y ese tile pulsa en verde mientras la misión corre.

---

### Phase 7b — Prioridades y deuda técnica

**Objetivo:** matriz de prioridades editable por el usuario + deuda técnica visible como escombros.

#### 7b.1 — Priority Matrix UI (`src/ui/priorityMatrix.ts` + `index.html`)

- Panel `#priority-matrix` (hotkey `P`), overlay similar al quest board.
- Tabla: filas = agentes activos, columnas = tipos de tarea (`bugfix | refactor | feature | docs | test`).
- Celdas: valor 1–4 (click/scroll para cambiar). 1 = crítico, 4 = solo si no hay otra cosa.
- Defaults por agent type:

| Agente | bugfix | refactor | feature | docs | test |
|---|---|---|---|---|---|
| DAVI | 2 | 2 | 1 | 3 | 3 |
| WORKER | 1 | 3 | 3 | 4 | 2 |
| SCOUT | 3 | 4 | 4 | 1 | 1 |
| LEXO | 2 | 1 | 2 | 3 | 3 |

- Al editar: `POST /api/priorities` body `{ unitId, taskType, priority }`. Vite plugin escribe `~/.repociv/priorities.json`.
- Bridge.py lee `priorities.json` al arrancar y en cada restart. **No lo lee en hot-path** (por rendimiento) — la lógica de auto-asignación es frontend-driven.

#### 7b.2 — Lógica de asignación

La asignación manual (usuario selecciona agente + escribe misión) no cambia. La lógica de prioridades se activa solo en el **modo auto**: si el usuario no selecciona agente y manda una misión, el frontend elige el agente con menor número de prioridad para ese tipo de tarea.

Resolución de conflictos: igual prioridad → menor `activeMissions.length` → primero en `getAllUnits()`.

**Decisión de diseño:** WORKER stateless tiene ventaja implícita en bugfix porque su `stateful=false` lo hace más barato (sin contexto que preservar). El sistema de prioridades lo refleja con defaults.

#### 7b.3 — Tech Debt (`vite.config.ts` + `src/localRenderer.ts`)

Nuevo endpoint Vite `GET /api/tech-debt/:repo`:
```typescript
// Response
interface TechDebtReport {
  items: Array<{
    filePath: string   // relativa al repo
    reasons: string[] // ["TODO", "archivo >500 líneas", "sin test"]
  }>
}
```

Detección (en el plugin Vite, no en bridge.py):
- Archivos con `TODO` o `FIXME` en contenido (grep primeros 500 chars).
- Archivos `.ts` sin `.test.ts` equivalente.
- Archivos > 500 líneas (via `wc -l` o conteo de `\n`).
- Cap: max 50 items por repo.

En `localMap.ts`: al generar el grid, hacer `GET /api/tech-debt/:repo` en paralelo y marcar `tile.techDebt = true` en los workbenches correspondientes.

En `localRenderer.ts`: tiles con `techDebt = true` dibujan un overlay de escombros (patrón de rayas rojas semitransparentes).

**Criterio de done de Phase 7b:** La Priority Matrix es editable y persiste. Un archivo con TODO aparece con overlay de escombros en el grid local.

---

### Phase 8 — Frostpunk: generador de tokens ⚠️ DIFERIDA

**Estado:** POSTERGADA. No se implementa hasta cumplir las tres condiciones:

1. OpenClaw expone `tokens_used` por sesión en stdout o vía endpoint.
2. Se valida correlación con billing real en al menos 5 misiones.
3. Spike confirma que bridge.py puede leer ese dato sin polling > 1 req/s.

**Por qué diferir:** sin datos reales, el generador sería un gauge que miente. "False confidence" es peor que no tener el dato.

**Referencia de diseño cuando se retome:** `VISUAL_WORKFLOW_IDEATION.md` §Frostpunk + este doc §Phase 8 original en git history.

---

### Phase 9 — XCOM: fatiga de contexto

**Objetivo:** agentes stateful (DAVI, LEXO, OPENCLAW) acumulan saturación de contexto. Visible y accionable.

**Puede ejecutarse en paralelo a Phase 7b** — no tiene dependencias sobre la Priority Matrix.

#### 9.1 — Tracking (proxy por longitud)

Bridge.py mantiene por session-id: `context_chars: int` = suma de caracteres de todos los `chat_chunk` emitidos.

Proxy de tokens: `estimated_tokens = context_chars / 4` (rough 4 chars/token).
Límite asumido: `context_limit_tokens = 200_000` (modelo Opus 4.x).
Porcentaje: `pct = estimated_tokens / context_limit_tokens * 100`.

Nuevo evento bridge: `context_update`:
```python
{ "type": "context_update", "unit": unit_id, "pct": pct, "estimated_tokens": int }
```

Se emite cada vez que un `chat_chunk` actualiza el acumulador (throttled: solo si cambió ≥ 2%).

Stateless (WORKER, SCOUT): siempre `pct = 0`, no emiten este evento.

La UI muestra claramente "estimado" hasta que haya tracking real.

#### 9.2 — BridgeEvent + schema

Añadir a `BridgeEvent` en `types.ts`:
```typescript
| { type: 'context_update'; unit: string; pct: number; estimatedTokens: number }
```

Añadir schema en `bridgeSchema.ts`. Handle en `bridge.ts:handleBridgeEvent` → llama a `updateFatigue(unitId, pct)` en `ui/panel.ts`.

#### 9.3 — Barra de fatiga en hero bar (`src/ui/panel.ts`)

- Barra horizontal debajo de cada portrait en `#hero-bar-slots`, visible solo en agentes stateful.
- Colores: 0–60% verde `#3a7a3a`, 60–80% amarillo `#8a7a2a`, 80–100% rojo `#7a2a2a`.
- Animación pulso en rojo cuando ≥ 85%.
- Tooltip: "Contexto estimado: X% (~N tokens). Considera /clear o delegar a WORKER."

#### 9.4 — Comportamiento de agente fatigado

- ≥ 80%: al enviar misión, bridge.py antepone al system prompt: `[AVISO: contexto al X%. Sé conciso.]`.
- ≥ 95%: bridge.py rechaza la misión y devuelve `chat_chunk` con mensaje predefinido: "Mi contexto está casi lleno. Resetea con /clear o delega esta tarea a WORKER."
- Reset: el usuario puede escribir `/clear` en el chat input. Bridge.py interpreta este comando: crea nueva session-id para ese agente, resetea `context_chars = 0`, emite `context_update` con `pct = 0`.

#### 9.5 — Visualización en local view

- Agentes con fatiga ≥ 80%: sprite parpadea en rojo tenue (multiplicador de opacidad + animTime).
- Rest area: agente en `idle_in_room` con fatiga ≥ 60% camina automáticamente a la rest area. Al llegar, `localState = 'resting'`. Tras 10 segundos en resting sin nueva misión: auto-reset (equivalente a `/clear`).

**Criterio de done:** DAVI con misiones largas llega al 85%, su barra parpadea en rojo, el tooltip lo explica, y al quedar idle camina solo a la rest area.

---

### Phase 10 — Polish y cierre

- **10.1 Tutoriales contextuales:** primera entrada a local view → tooltip "Habitaciones = carpetas, workbenches = archivos. Doble-click para entrar, Esc para salir." Primera vez que la barra de fatiga llega a amarillo → tooltip en el portrait.
- **10.2 Settings panel:** umbral de alerta de fatiga (default 80%), toggle "skip animations" (desactiva pathfinding visual de agentes, llega directo al workbench).
- **10.3 Tests:**

| Archivo | Cobertura |
|---|---|
| `localMap.test.ts` | groupByFolder, roomDimensions, buildGrid sin solapamiento, rest_area única |
| `localPathfinding.test.ts` | A* en grid 2D, coste debris, pared = Infinity, sin path = [] |
| `priority.test.ts` | defaults, resolución de conflictos, persistencia ida/vuelta |
| `fatigue.test.ts` | acumulación de chars, proxy tokens, evento context_update, umbral 95% |

Target total: 65+ tests (desde 37).

- **10.4 README.md:** crear en raíz del repo. Secciones: qué es RepoCiv, cómo correr dev server, cómo agregar un agente nuevo, flujo macro→local.
- **10.5 Screenshot showcase:** F12 en local view captura el canvas local. GIF demo del flujo completo: Civ macro → doble-click → local view → agente caminando → workbench → fatiga.

---

## 5. Orden de ejecución

```
Phase 6
  └── Phase 7a
        ├── Phase 7b ──────────────────────┐
        └── Phase 9 (paralelo a 7b)        │
              └── Phase 10 ←───────────────┘

Phase 8: desacoplada, se desbloquea por condición externa (token tracking real)
```

**Puntos de checkpoint:**
- Después de 6: grid local visible, sin agentes. Valor: diseño visual validado.
- Después de 7a: agentes caminando. Valor: la metáfora RimWorld funciona.
- Después de 7b o 9 (lo que termine antes): primera capa de mecánica. Valor: hay decisiones que tomar en la UI.
- Después de 10: producto entregable con tutorial.

---

## 6. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Grid local vacío en repos pequeños (<10 archivos) | Visual pobre | Tamaño mínimo de room 3×3 + tile decorativo "archivo vacío" para completar |
| dblclick colisiona con single-click de ciudad en mobile/trackpad | UX rota | Usar evento nativo `dblclick`; en mobile, botón explícito "Entrar al repo" |
| Proxy de tokens diverge de realidad >50% | Fatiga bar engaña al usuario | Etiquetar explícitamente como "estimado"; opción de silenciar la barra |
| Priority Matrix percibida como complejidad innecesaria | Usuarios la ignoran | Defaults buenos que funcionan sin tocar nada; la matriz es opt-in, no obligatoria |
| Phase 9 (fatiga) introduce ansiedad en el usuario | UX contraproducente | Rest area automática neutraliza la ansiedad; colores solo suben de intensidad en ≥80% |
| Renderer local sin assets dedicados se ve genérico | Impresión visual débil | Tile de workbench con extensión como texto es suficiente para MVP; assets pixel-art en Phase 10 polish |

---

## 7. Lo que explícitamente no está en este roadmap

- **Factorio / flujo de datos:** baja accionabilidad en repos estáticos; retomar si RepoCiv expande a monitoreo de sistemas en producción.
- **Zachtronics / vista AST:** compite con el IDE real sin aportar diferencia.
- **Mercados de APIs:** precios reales no fluctúan lo suficiente para que la mecánica tenga decisión real.
- **Slay-the-Spire deckbuilding:** compite con la Priority Matrix.
- **Frostpunk (Phase 8):** diferido, condiciones definidas arriba.
- **3rd party agents (Claude/Gemini/Codex):** primero los 5 agentes propios del roster. Decisión en `project_repociv_roster.md`.

---

## 8. Definición de "done" del roadmap completo

Este documento se cierra cuando:

1. ✅ Phase 6 + 7a: demo funcional Civ → RimWorld con agentes caminando
2. ✅ Phase 7b: Priority Matrix editable + escombros visibles
3. ✅ Phase 9: fatiga de contexto con barra, auto-reset y rest area
4. ✅ Phase 10: tutorial contextual + 65+ tests + README

El próximo roadmap aborda: Phase 8 (si tokens disponibles), multi-workspace, y 3rd party agents.
