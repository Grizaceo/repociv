# RepoCiv — Imperial Agent Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status](https://img.shields.io/badge/status-public%20preview-blue.svg)](docs/ROADMAP.md)

> Dashboard hexagonal estilo Civ V que visualiza `~/.hermes/workspace/repos/` como ciudades, agentes como unidades, y procesos como edificios.

**Stack:** TypeScript + Vite (frontend, Canvas 2D) · Python HTTP bridge (backend) · DuckDB/JSONL para ledger local.

---

## Quick Start

### 1. Instalar dependencias

```bash
git clone <repo-url> repociv
cd repociv

# Frontend
npm install

# Backend (Python)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Levantar el sistema

```bash
# Opción A: dos terminales manuales
# Terminal 1 — Backend
python3 -m server.bridge

# Terminal 2 — Frontend
npm run dev

# Opción B: script de startup con tmux
./scripts/dev-start.sh --tmux
```

Abre `http://localhost:5273`. Verás el **Imperial Map** con tus ciudades (repos) y agentes caminando.

---

## Arquitectura en 3 capas

```
┌─────────────────────────────────────────────┐
│  Canvas 2D Renderer  (src/renderer.ts)       │  ← Dibuja hexes, unidades,
│  Minimap Renderer    (src/minimapRenderer.ts)│     ciudades, minimapa
├─────────────────────────────────────────────┤
│  GameState  (src/game.ts)                   │  ← Loop de simulación,
│  Priority Matrix (src/priorityMatrix.ts)     │     fatiga, colas misión,
│  Fatigue System (src/fatigue.ts)             │     Pathfinding A*
├─────────────────────────────────────────────┤
│  Bridge  (src/bridge.ts + server/bridge.py) │  ← HTTP → agent runtime,
│  localMap.ts + localPathfinding.ts            │     LexO, agentes Worker
└─────────────────────────────────────────────┘
```

---

## Vista Macro → Vista Local (Phase 6)

```
[VISTA MACRO]                           [VISTA LOCAL — RimWorld style]
~/.hermes/workspace/repos/          →   Grid hexagonal interior
  └─ repo-1 (city)                     Workbenches = archivos/carpetas
       ├─ src/                          Unidades = agentes caminando
       ├─ tests/                        Misión = ir de A a B
       └─ ...
```

- **Macro:** hex map donde cada tile es un repo.
- **Local:** al hacer doble-click en una ciudad, entras a la vista interior.
  - Los **workbenches** son archivos/carpetas prioritizados.
  - Las **unidades** (orchestrator, LexO, Workers) caminan hacia workbenches.
  - El **pathfinding** usa A* con cache por `unitType` (≤300 hexes explorados).
- `Space` o `3` alterna entre vista macro y local de la ciudad seleccionada.

---

## Priority Matrix (Phase 7b)

**Qué es:** Sistema que decide qué archivo/carpeta es más urgente procesar.

**Fórmula por agente** (archivo con peso más alto gana):

```
score = (ageWeight × ageScore)
      + (testWeight × hasTests ? 1 : 0)
      + (debtWeight × churnRisk)
      + (extWeight × extensionScore)
      + (sizeWeight × sizeScore)
```

**Pesos por defecto:**

| Parámetro | Default | Rango |
|-----------|---------|-------|
| `ageWeight` | 0.3 | 0–1 |
| `testWeight` | 0.25 | 0–1 |
| `debtWeight` | 0.25 | 0–1 |
| `extWeight` | 0.1 | 0–1 |
| `sizeWeight` | 0.1 | 0–1 |

**Labels de urgencia:**

| Label | Condición |
|-------|-----------|
| `CRIT` | score ≥ 70 |
| `HIGH` | score ≥ 50 |
| `NORM` | score ≥ 30 |
| `LOW` | score < 30 |

**Cómo se usa en el juego:**
- `src/priorityMatrix.ts` exports `computePriorityScore(fileNode, weights)` → `number`
- `src/ui/priorityPanel.ts` renderiza la UI del panel lateral
- Presiona `P` para abrir/cerrar el Priority Panel

---

## Fatigue System — XCOM Style (Phase 9)

**Modelo:** fatiga lineal simple. Sin umbrales mágicos, sin umbrales ocultos.

```
fatiguePercent = currentFatigue / maxFatigue   (0.0 → 1.0)
effectiveSpeed = fatiguePercent                 (velocidad = % de energía)
```

**Thresholds configurables** (Settings Panel o `src/gameConfig.ts`):

| Parámetro | Default | Efecto |
|-----------|---------|--------|
| `warnThreshold` | 0.6 | Barra de fatiga cambia a amarillo |
| `criticalThreshold` | 0.3 | Barra de fatiga cambia a rojo |
| `criticalFatigue` | 20 | Mensaje de aviso aparece cuando `fatigue ≤ 20` |

**Rest Areas** (`RestArea` en `src/types.ts`):
```typescript
interface RestArea {
  id: string;
  roomId: string;
  coord: Axial;          // posición en grid local
  recoveryRate: number;  // fatiga recuperada por tick
  capacity: number;      // máximo de unidades simultáneas
  unitsInside: string[]; // IDs de unidades descansando
}
```

- `getUnitFatigue(unit)` → `number` (fatiga actual)
- `removeRestArea(id)` → elimina área de descanso
- Test suite: `src/fatigue.test.ts` (18 tests cubriendo modelo lineal, edge cases)

---

## Cómo agregar un agente nuevo

**1. Definir el tipo** en `src/types.ts`:
```typescript
export type UnitType = 'davi' | 'lexo' | 'worker' | 'scout' | 'openclaw' | 'tuagente';
```

**2. Agregar color** en `src/types.ts` (`UNIT_COLORS`) y en `src/game.ts` (`UNIT_TYPE_COLOR`):
```typescript
export const UNIT_COLORS: Record<UnitType, string> = {
  davi: '#7ec8e3',
  lexo: '#c8a2c8',
  worker: '#90ee90',
  scout: '#ffa500',
  openclaw: '#ff6b6b',
  tuagente: '#yourcolor',
};
```

**3. Agregar lógica de spawn** en `src/game.ts` — método `spawnAgent(type, ...)`:
```typescript
if (type === 'tuagente') {
  const unit: Unit = {
    id: `tuagente-${Date.now()}`,
    type: 'tuagente',
    name: 'Tu Agente',
    // ... resto de campos de Unit
  };
  this.unitMap.set(unit.id, unit);
  this.world.units.push(unit);
}
```

**4. Hotkey** en `src/main.ts` (`wireHUD` → hotkeys):
```typescript
if (e.key.toLowerCase() === 'x') return spawnAgent('tuagente', state, renderer, bridge);
```

**5. (Opcional) Comportamiento especial** — modifica `updateUnits(dt)` en `game.ts` o crea un comportamiento dedicado.

---

## Hotkeys

| Tecla | Acción |
|-------|--------|
| `Q` `W` `E` `L` `O` | Spawn orchestrator / WORKER / SCOUT / LEXO / OPENCLAW |
| `1`–`9` | Seleccionar héroe por slot |
| `Space` | Ciclar al siguiente héroe idle |
| `Tab` | Ciclar todos los héroes |
| `Enter` | Abrir/cerrar side panel |
| `P` | Priority Matrix panel |
| `M` | Modo Move |
| `S` | Dormir unidad seleccionada |
| `B` | Modo Build |
| `G` | Toggle grid |
| `F` | Toggle debug overlay |
| `V` | Toggle fog of war |
| `A` | Abrir/cerrar aprobaciones |
| `T` | Terminal panel |
| `F6` | Ledger / city ledger |
| `F7` | Replay Panel |
| `F8` | Observability Panel |
| `F9` | Quest Board |
| `F10` | Timeline Panel |
| `F11` | Settings Panel |
| `F12` | Screenshot |
| `3` | Alternar vista Macro ↔ Local |
| `Escape` | Cerrar overlays |
| `?` | Keyboard help |

---

## Estructura de archivos

```
src/
├── game.ts              GameState, misión, loop, spawn
├── gameConfig.ts       Config singleton (localStorage, thresholds)
├── fatigue.ts          getUnitFatigue, removeRestArea
├── priorityMatrix.ts   computePriorityScore
├── map.ts              generateWorld
├── hex.ts              Axial coords, hex math
├── pathfinding.ts      A* con cache
├── localMap.ts         buildLocalWorld (archivos → grid)
├── localPathfinding.ts A* para grid local
├── renderer.ts          Canvas 2D main renderer
├── minimapRenderer.ts   Minimap
├── unitRenderer.ts      Sprites de unidades
├── bridge.ts            HTTP client → agent runtime
├── main.ts             Entry point, hotkeys, HUD wiring
├── ui/
│   ├── index.ts         Barrel re-export
│   ├── panel.ts         Unit panel, hero bar
│   ├── hud.ts           Loading, resources, bridge status
│   ├── settingsPanel.ts  Config panel (Phase 10.2)
│   ├── priorityPanel.ts  Priority Matrix UI
│   └── ...
└── styles/
    ├── tokens.css       CSS custom properties (--ui-*)
    ├── hud.css           Top bar, hero bar, botones
    ├── components.css    Panels, side panel
    └── ...
```

---

## Documentación

- **Activa:**
  - `README.md` (este archivo) — visión, arranque, hotkeys
  - [`docs/SCOPE.md`](docs/SCOPE.md) — qué es y qué no es el proyecto (alpha de un solo usuario)
  - [`docs/EVOLUTION.md`](docs/EVOLUTION.md) — narrativa cronológica de cómo se construyó
  - [`docs/implementation_plan.md`](docs/implementation_plan.md) — plan vivo del Agent OS (Fases 0-5 cerradas)
  - [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) — invariantes de persistencia (JSONL ↔ DuckDB)
  - [`docs/AUDIT_DELTA_ADDENDUM.md`](docs/AUDIT_DELTA_ADDENDUM.md) — patrones avanzados (bloqueados por SCOPE)
  - [`deploy/systemd/README.md`](deploy/systemd/README.md) — operación / servicios permanentes
  - [`execplan/repociv-harness-control-plane.md`](execplan/repociv-harness-control-plane.md) — plan ejecutable día a día
- **Referencia (germen):** [`docs/archive/`](docs/archive/) — 5 documentos de diseño con valor independiente
- **Histórico:** `git log --all -- docs/archive/<archivo>.md` para recuperar documentos condensados en `EVOLUTION.md`

---

## Tests

```bash
# Frontend (Vitest)
npm test -- --run               # 279 tests, ~1s

# Backend (pytest)
python3 -m pytest server/ -q    # 488 tests, ~25s
```

> ⚠️ **Limitación conocida:** si el bridge está corriendo (systemd unit
> activo o `python3 -m server.bridge` en otra terminal), DuckDB lockea
> `~/.repociv/ledger.duckdb` exclusivamente. Tests del backend que toquen
> el ledger fallarán en silencio. Workarounds:
>
> ```bash
> # Opción 1: parar el bridge antes de testear
> systemctl --user stop repociv-bridge && python3 -m pytest server/
>
> # Opción 2: usar un data dir aislado
> REPOCIV_DATA_DIR=/tmp/repociv-test python3 -m pytest server/
> ```
>
> El `checkpoint.py` ya respeta `REPOCIV_DATA_DIR` desde el sprint de
> consolidación; el resto de los stores se irán adaptando según se
> detecten en el dogfooding.

Suites principales del frontend:

| Suite | Tests | Qué cubre |
|-------|-------|-----------|
| `fatigue.test.ts` | 18 | Modelo lineal, RestArea, edge cases |
| `hex.test.ts` | 23 | Coordenadas axiales, hex math |
| `pathfinding.test.ts` | 14 | A* pathfinding, cache |
| `game.test.ts` | 29 | GameState, misiones, spawn |
| `priorityMatrix.test.ts` | 18 | Scoring por archivo |
| `bridge.test.ts` + `bridgeSchema.test.ts` | 39 | HTTP client + valibot validation |

---

## Security

El bridge (`server/bridge.py`) usa token authentication vía header `X-RepoCiv-Token`.

- **Dev mode:** deja `REPOCIV_TOKEN` vacío en `.env` — el bridge acepta todas las requests
  desde localhost sin autenticación.
- **Producción:** configura `REPOCIV_TOKEN` con un string aleatorio de 32+ caracteres y
  actualiza `VITE_BRIDGE_TOKEN` en el frontend para que coincida.
- Rate limit: 60 requests/minuto por IP (en memoria, se resetea al reiniciar).
- Todas las rutas POST requieren token cuando está configurado.
- Ver `.env.example` para la lista completa de variables de entorno.

---

## Config persistida

`src/gameConfig.ts` expone `config` — un singleton que:
- Lee defaults de `DEFAULT_CONFIG`
- Sobrecribe con lo guardado en `localStorage['repociv-config']`
- Expone `sliders[]` con metadata para el Settings Panel (labels, rangos, steps)

No hay archivo `.env` para el frontend — toda config runtime va por aquí.

---

## API Reference

Ver [docs/API.md](docs/API.md) para documentación completa de endpoints del bridge.

---

## Integración con CDaily — Gaceta Exterior

RepoCiv lee directamente el SQLite de [CDaily](../cdaily) (`~/.blogwatcher-cli/blogwatcher-cli.db`) para mostrar el feed exterior dentro del dashboard imperial. Tres puntos de exposición:

- **Widget `📰 Gaceta` (top-left)** — flotante bajo los recursos (gold/science/production). Colapsado muestra badge + último titular; expandido lista top 5 no leídos con botón ✓ Leído. Toggle con hotkey `N`. Estado persistido en localStorage.
- **City panel CDAILY** — al hacer doble click sobre la ciudad `CDAILY` el panel lateral muestra el feed completo en lugar del árbol de archivos.
- **Kiosko de Prensa (vista local)** — un tile especial `kiosk` en la primera sala del repo CDAILY que aplica multiplicador `1.25x` a la recuperación de fatiga (`server/bridge.py` `discover_rest_area`).

### Endpoints del bridge

| Método | Path | Función |
|---|---|---|
| GET | `/api/news/latest` | Top 5 no leídos (`server/http_routes.py:get_latest_news`) |
| POST | `/api/news/read` | Marca como leído (`server/http_routes.py:post_news_read`) |

Acceden al SQLite con `with closing(sqlite3.connect(...))` — el FastAPI de CDaily no necesita estar corriendo.

### Cliente TypeScript

```ts
import { getLatestNews, markNewsAsRead } from './bridge.ts';
const articles = await getLatestNews();      // CDailyArticle[]
await markNewsAsRead(articleId);              // boolean
```

### MCP de CDaily

Aparte de esta integración HTTP, CDaily también expone un MCP server stdio propio con 13 tools / 3 resources / 2 prompts. Ver [`cdaily/README.md`](../cdaily/README.md#mcp-server-agent-native). Útil cuando quieres que agentes externos (Claude Code, Cursor) operen el feed directamente, sin pasar por el bridge de RepoCiv.

---

## Debug

```bash
# Bridge health check
curl http://localhost:5274/health

# Test local map build
npx ts-node src/local.demo.ts

# Reconstruir el DuckDB Ledger desde events.jsonl (si se corrompe)
python3 -m server.rebuild_ledger              # con paths default
python3 -m server.rebuild_ledger --dry-run    # contar sin escribir

# Inspeccionar propuestas SICA dormidas (read-only)
curl http://localhost:5274/improve/reflect    # patterns observados
curl http://localhost:5274/improve/proposals  # propuestas scoped
```

---

## Contributing

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para setup de desarrollo, workflow, conventional commits, y guía de estilo.

---

_RepoCiv — v0.1.0 — RepoCiv Team_
