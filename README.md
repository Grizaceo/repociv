# RepoCiv — Imperial Agent Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Grizaceo/repociv/actions/workflows/ci.yml/badge.svg)](https://github.com/Grizaceo/repociv/actions)
[![Status](https://img.shields.io/badge/status-public%20alpha-blue.svg)](docs/ROADMAP.md)

> Un dashboard hexagonal estilo Civilization V que visualiza tu workspace de repos como ciudades en un mapa, agentes de IA como unidades, y procesos en segundo plano como edificios.

**Stack:** TypeScript + Vite (Canvas 2D) · Python HTTP bridge · DuckDB/JSONL ledger local

![RepoCiv hex map](docs/design/screenshot-placeholder.png)

---

## ¿Qué es esto?

RepoCiv convierte tu carpeta de repos en un mapa interactivo:

- Cada **repo** es una **ciudad** en el mapa hexagonal
- Cada **agente de IA** (Claude, Codex, tu propio LLM) es una **unidad** que camina hacia workbenches
- Los **procesos en segundo plano** son edificios dentro de la ciudad
- El **bridge HTTP + WebSocket** conecta el mapa en tiempo real con tu runtime de agentes

Es single-user por diseño: un tablero para coordinar tu propio ecosistema de agentes, localmente, sin cloud.

---

## Quick Start

### 1. Clonar e instalar

```bash
git clone https://github.com/Grizaceo/repociv.git
cd repociv

# Frontend
npm install

# Backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configurar

```bash
cp .env.example .env
# Edita .env si tu carpeta de repos no está en ~/.hermes/workspace/repos
# La variable clave: REPOCIV_MAP_ROOT=~/tu/carpeta/de/repos
```

### 3. Levantar

```bash
# Opción A: dos terminales

# Terminal 1 — Backend
python3 -m server.bridge

# Terminal 2 — Frontend
npm run dev
```

```bash
# Opción B: tmux (una sola sesión)
./scripts/dev-start.sh --tmux
```

Abre `http://localhost:5273`. Verás el **Imperial Map** con tus repos como ciudades.

---

## Configuración del workspace

RepoCiv busca repos en este orden de prioridad:

| Variable | Default | Función |
|---|---|---|
| `REPOCIV_MAP_ROOT` | — | Carpeta raíz del mapa (hijas directas = ciudades) |
| `WORKSPACE_ROOT` | `~/.hermes/workspace/repos` | Alias alternativo |
| `REPOCIV_REPOS_ROOT` | `~/.hermes/workspace/repos` | Fallback |

Ejemplo para una estructura estándar:

```bash
# .env
REPOCIV_MAP_ROOT=~/projects
```

---

## Arquitectura

```
┌─────────────────────────────────────────────┐
│  Canvas 2D Renderer  (src/renderer.ts)       │  ← Dibuja hexes, unidades,
│  Minimap Renderer    (src/minimapRenderer.ts)│     ciudades, minimapa
├─────────────────────────────────────────────┤
│  GameState  (src/game.ts)                   │  ← Loop de simulación,
│  Priority Matrix (src/priorityMatrix.ts)     │     fatiga, colas misión,
│  Fatigue System  (src/fatigue.ts)            │     Pathfinding A*
├─────────────────────────────────────────────┤
│  Bridge  (src/bridge.ts + server/bridge.py) │  ← HTTP/WebSocket → agent runtime
│  localMap.ts + localPathfinding.ts           │     Process scanner, task queue
└─────────────────────────────────────────────┘
```

### Vista Macro → Vista Local

```
[VISTA MACRO]                        [VISTA LOCAL — RimWorld style]
~/projects/                    →     Grid hexagonal interior
  └─ mi-repo (city)                  Workbenches = archivos/carpetas
       ├─ src/                        Unidades = agentes caminando
       ├─ tests/                      Misión = ir de A → B → completar
       └─ ...
```

- **Macro:** hex map donde cada tile es un repo
- **Local:** doble-click en una ciudad → vista interior de archivos
  - Los **workbenches** son archivos/carpetas priorizados por la Priority Matrix
  - Las **unidades** caminan hacia workbenches con A* cacheado (≤300 hexes)
- `Space` o tecla `3` alterna entre las dos vistas

---

## Integración con agentes

RepoCiv expone un **bridge HTTP + WebSocket** al que cualquier agente se puede conectar:

```bash
# El bridge escucha en localhost:5274 por default
# Eventos que entiende:
POST /api/command          # enviar misión a un agente
GET  /api/agents           # listar agentes activos
GET  /api/pending          # cola de aprobaciones pendientes
POST /api/approve/:id      # aprobar/rechazar una acción
```

Ver [docs/API.md](docs/API.md) para la referencia completa.

### MCP Server

RepoCiv también se expone como **MCP server por stdio** (`server/mcp_server.py`), lo que permite que Claude Code, Cursor u otros clientes operen el dashboard como agentes externos:

```json
{
  "mcpServers": {
    "repociv": {
      "command": "python",
      "args": ["/ruta-absoluta/repociv/server/mcp_server.py"]
    }
  }
}
```

41 tools cubriendo 15 dominios: agents, commands, approvals, pending, context, GPU, wonders, graph-relations, foreign-relations y más. Ver [docs/MCP.md](docs/MCP.md).

---

## Priority Matrix

Sistema que decide qué archivo/carpeta es más urgente para cada agente:

```
score = (ageWeight × ageScore)
      + (testWeight × hasTests ? 1 : 0)
      + (debtWeight × churnRisk)
      + (extWeight  × extensionScore)
      + (sizeWeight × sizeScore)
```

| Label | Condición |
|-------|-----------|
| `CRIT` | score ≥ 70 |
| `HIGH` | score ≥ 50 |
| `NORM` | score ≥ 30 |
| `LOW`  | score < 30 |

Presiona `P` para abrir el Priority Panel. API: `computePriorityScore(fileNode, weights)` en `src/priorityMatrix.ts`.

---

## Fatigue System

Las unidades tienen fatiga al estilo XCOM: trabajar la agota, descansar en un RestArea la recupera.

```
effectiveSpeed = currentFatigue / maxFatigue   (0.0 → 1.0)
```

Thresholds configurables en `Settings Panel` (`F11`) o en `src/gameConfig.ts`.

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
| `V` | Toggle fog of war |
| `A` | Aprobaciones pendientes |
| `T` | Terminal panel |
| `N` | Gaceta de noticias |
| `3` | Alternar vista Macro ↔ Local |
| `F11` | Settings Panel |
| `?` | Keyboard help |

---

## Agregar un tipo de agente nuevo

1. **Tipo** en `src/types.ts` → `UnitType`
2. **Color** en `UNIT_COLORS` (`src/types.ts`) y `UNIT_TYPE_COLOR` (`src/game.ts`)
3. **Spawn** en el método `spawnAgent(type, ...)` de `src/game.ts`
4. **Hotkey** en `src/main.ts` (sección `wireHUD`)
5. (Opcional) **Comportamiento** en `updateUnits(dt)` o módulo dedicado

---

## Estructura de archivos

```
src/
├── game.ts              GameState, misión, loop, spawn
├── gameConfig.ts        Config singleton (localStorage + thresholds)
├── fatigue.ts           getUnitFatigue, removeRestArea
├── priorityMatrix.ts    computePriorityScore
├── map.ts               generateWorld (repos → hex tiles)
├── hex.ts               Axial coords, hex math
├── pathfinding.ts       A* con cache
├── localMap.ts          buildLocalWorld (archivos → grid local)
├── localPathfinding.ts  A* para grid local
├── renderer.ts          Canvas 2D main renderer
├── minimapRenderer.ts   Minimap
├── bridge.ts            HTTP client → bridge
├── main.ts              Entry point, hotkeys, HUD wiring
├── ui/                  Panels, HUD, settings, wonders
└── styles/              CSS tokens, hud, components

server/
├── bridge.py            FastAPI bridge (entry point: python -m server.bridge)
├── http_routes.py       Todos los endpoints HTTP
├── websocket_handler.py WebSocket bidireccional
├── mcp_server.py        MCP stdio server (41 tools)
├── agent_runner.py      Ejecuta agentes (Hermes, Claude, Codex, OpenRouter…)
├── process_scanner.py   Detecta procesos → spawns automáticos
├── task_orchestrator.py Cola de tareas con prioridad
└── security_harness.py  Validación de comandos (3 capas)
```

---

## Tests

```bash
# Frontend (Vitest) — 409 tests
npm test -- --run

# Backend (pytest) — 644 tests
python3 -m pytest server/ -q
```

> ⚠️ Si el bridge está corriendo (systemd o terminal), DuckDB lockea el ledger.
> Para testear el backend con el bridge activo:
> ```bash
> REPOCIV_DATA_DIR=/tmp/repociv-test pytest server/
> ```

---

## Security

- **Dev mode:** `REPOCIV_TOKEN` vacío → auth bypass en localhost (nunca en producción)
- **Remote mode:** `REPOCIV_REMOTE=true` exige `REPOCIV_TOKEN` de 32+ chars; el bridge se niega a arrancar sin él
- Rate limit: 60 req/min por IP (en memoria)
- Ver [`SECURITY.md`](SECURITY.md) y `.env.example` para la configuración completa

---

## Documentación

| Doc | Contenido |
|-----|-----------|
| [docs/SCOPE.md](docs/SCOPE.md) | Qué es y qué no es el proyecto |
| [docs/API.md](docs/API.md) | Referencia completa de endpoints |
| [docs/MCP.md](docs/MCP.md) | MCP server — 41 tools, ejemplos |
| [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | Tutorial paso a paso |
| [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) | Acceso remoto via Tailscale |
| [docs/EVOLUTION.md](docs/EVOLUTION.md) | Historia del proyecto |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Estado actual y próximos pasos |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Cómo contribuir |
| [SECURITY.md](SECURITY.md) | Política de seguridad |

---

## Contributing

Ver [CONTRIBUTING.md](CONTRIBUTING.md) — setup, workflow, conventional commits, guía de estilo.

RepoCiv es un alpha de un solo usuario. Las contribuciones más útiles ahora mismo son: bug fixes con tests de regresión, mejoras de documentación, y optimizaciones de performance del renderer Canvas 2D (target: 60 FPS).

---

## License

MIT — ver [LICENSE](LICENSE).

---

_RepoCiv v0.1.0-alpha — [@Grizaceo](https://github.com/Grizaceo)_
