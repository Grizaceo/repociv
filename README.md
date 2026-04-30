# RepoCiv — Imperial Agent Dashboard

> Dashboard hexagonal estilo Civ V que visualiza `~/.hermes/workspace/repos/` como ciudades, agentes como unidades, y procesos como edificios.

**Stack:** TypeScript + Vite (frontend, Canvas 2D) · Python HTTP bridge (backend) · 60 FPS target en RTX 4060.

---

## Quick Start

```bash
# Terminal 1 — Backend
cd ~/.hermes/workspace/repos/repociv
python3 server/bridge.py

# Terminal 2 — Frontend
cd ~/.hermes/workspace/repos/repociv
npm run dev
```

Abre `http://localhost:5273`. Verás el **Imperial Map** con tus ciudades (repos) y agentes caminando.

---

## Arquitectura en 3 capas

```
┌─────────────────────────────────────────────┐
│  Canvas 2D Renderer  (src/renderer.ts)       │  ← Dibuja hexes, unidades,
│  Renderer3D (Three.js) (src/renderer3d.ts)  │     ciudades, minimap
├─────────────────────────────────────────────┤
│  GameState  (src/game.ts)                   │  ← Loop de simulación,
│  Priority Matrix (src/priorityMatrix.ts)     │     fatiga, colas misión,
│  Fatigue System (src/fatigue.ts)             │     Pathfinding A*
├─────────────────────────────────────────────┤
│  Bridge  (src/bridge.ts + server/bridge.py) │  ← HTTP → Hermes/DAVI,
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
  - Las **unidades** (DAVI, LexO, Workers) caminan hacia workbenches.
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
| `Q` `W` `E` `L` `O` | Spawn DAVI / WORKER / SCOUT / LEXO / OPENCLAW |
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
| `3` | Alternar vista Macro ↔ Local |
| `F9` | Quest Board |
| `F11` | Settings Panel |
| `F12` | Screenshot |
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
├── renderer3d.ts        Three.js 3D renderer
├── minimapRenderer.ts   Minimapa
├── unitRenderer.ts      Sprites de unidades
├── bridge.ts            HTTP client → Hermes/DAVI
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

## Tests

```bash
npm test -- --run
```

| Suite | Tests | Cobertura |
|-------|-------|-----------|
| `fatigue.test.ts` | 18 | Modelo lineal, RestArea, edge cases |
| `hex.test.ts` | 23 | Coordenadas axiales, hex math |
| `pathfinding.test.ts` | 14 | A* pathfinding, cache |
| `localMap.test.ts` | 6 | FileNode building, tree stats |

**245 tests pasando** (174 TS + 71 Py). Target: 200 ✅

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

## Debug

```bash
# Ver rooms发现问题 (si bridge.py falla)
node debug_rooms.ts

# Test local map build
npx ts-node src/local.demo.ts

# Bridge health check
curl http://localhost:5274/health
```
