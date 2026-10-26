# RepoCiv — Imperial Agent Dashboard

> 🌐 **Idiomas / Languages:** [Español](README.md) · [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Grizaceo/repociv/actions/workflows/ci.yml/badge.svg)](https://github.com/Grizaceo/repociv/actions)
[![Status](https://img.shields.io/badge/status-public%20alpha-blue.svg)](docs/SCOPE.md)

> Un dashboard hexagonal estilo Civilization V que visualiza tu workspace de repos como ciudades en un mapa, agentes de IA como unidades, y procesos en segundo plano como edificios.

**Stack:** TypeScript + Vite (Canvas 2D + WebGL/Three.js) · Python HTTP bridge · DuckDB/JSONL ledger local
**Compatible con:** [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) — drop-in en cualquier setup existente

**Nueva demo (41 s):** [ver MP4](docs/design/screenshots/repociv-demo-2026-10-25.mp4) · [GIF](docs/design/screenshots/repociv-demo-2026-10-25.gif). Mapa 3D con familia visual 2K PBR, órbita `Q/E`, unidad acoplada, deliberación multi-agente en RoundTablet y vista local 2.5D. [Detalles de la captura](docs/design/screenshots/repociv-demo-2026-10-25.md).

![Vista macro 2D](docs/design/screenshots/macro-2d-view.jpg) | ![Vista 3D WebGL pulida](docs/design/screenshots/3d-polished-overview.png)
--- | ---
*Mapa hexagonal 2D plano — el clásico, rápido y completo.* | *Render 3D WebGL (Three.js r175) — pase low-poly facetado estilo Civ V: biomas, bosques densos, ciudades amuralladas y hora dorada. Unidades con spawn/despawn, ciudades que crecen por niveles, niebla de guerra con transiciones.*

![Demo: agente responde desde el mapa](docs/design/screenshots/demo-chat-untracked-files.jpg)
*Haz clic en una ciudad del mapa, pregúntale a tu agente qué hay ahí — el agente inspecciona el repo real y responde.*

---

## Vista Local — estilo RimWorld / isométrica 2.5D

Al hacer doble-click en una ciudad del mapa se entra a la **vista local**: una oficina isométrica estilo RimWorld generada proceduralmente a partir de la estructura real del repo.

![Vista isométrica — oficina completa](docs/design/screenshots/local-isometric-view.jpg)

Cada sala corresponde a una carpeta del repo. Las unidades (agentes IA) caminan entre workbenches, los NPCs manager están de pie frente a pizarras, y las puertas se deslizan al pasar.

![Detalle de salas](docs/design/screenshots/local-isometric-detail.jpg)

### Elementos de la vista local

| Elemento | Qué representa |
|----------|---------------|
| **Sala (room)** | Carpeta del repo — zona coloreada según tipo (`team_cluster`, `focus`, `break`, `infra`, `meeting`) |
| **Workbench** (`×`) | Archivo priorizado por la Priority Matrix — hover muestra nombre y score |
| **Whiteboard** | Pared norte de cada sala — click abre panel con subcarpetas navegables |
| **NPC Manager** | Figura estacionaria frente a la pizarra — representa la sala, clickeable para info |
| **Unidad (agente)** | Prismo 2.5D animado — camina de workbench en workbench mientras trabaja |
| **Puerta** | Divide salas — se desliza al entrar/salir (animación paralela-ográmica) |
| **Lámpara de piso** | Zona `focus` — luz ambiental en esquina NW interior |
| **Cafetera** | Zona `break` — esquina NE interior |
| **Placa de puerta** | Label flotante sobre cada sala |

**Hotkeys en vista local:** `F` overlay de debug · flechas / `W/A/S/D` desplazan la cámara · `Esc` vuelve al mapa macro. `1` y `4–9` seleccionan slots de sesión, no salas; `2`/`3` alternan el renderer 2D/3D.

---

## ¿Qué es esto?

RepoCiv convierte tu carpeta de repos en un mapa interactivo:

- Cada **repo** es una **ciudad** en el mapa hexagonal
- Cada **agente de IA** (Claude, Codex, tu propio LLM) es una **unidad** que camina hacia workbenches en una oficina isométrica 2.5D
- Los **procesos en segundo plano** son edificios dentro de la ciudad
- El **bridge HTTP + WebSocket** conecta el mapa en tiempo real con tu runtime de agentes

Es single-user por diseño: un tablero para coordinar tu propio ecosistema de agentes, localmente, sin cloud.

---

## Quick Start

### Opción A — Docker (recomendado para probarlo)

```bash
git clone https://github.com/Grizaceo/repociv.git
cd repociv
export MAP_ROOT="$HOME/projects"   # carpeta cuyas hijas se vuelven ciudades
docker compose up --build
# Abre http://localhost:5273
```

Ver [docs/DOCKER.md](docs/DOCKER.md) para referencia completa (mapeo de puertos, env vars, troubleshooting). La imagen corre bridge + Vite en un solo container — no necesitas Python ni Node en el host.

### Opción B — Instalación local

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

# Assets (obligatorio antes del primer arranque — no están en git)
npm run assets
npm run assets:3d
```

> **Assets obligatorios.** Los atlases PNG/WebP y texturas 3D no se versionan en git.
> Tras clonar, ejecuta `npm run assets` y `npm run assets:3d` antes de `npm run dev`
> o el mapa puede aparecer sin terreno, props u oficina isométrica.

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

RepoCiv busca repos en este orden de prioridad. Los valores por defecto son **ejemplos típicos** (asumen un layout estilo Hermes) — puedes apuntar a cualquier ruta de tu sistema. El **onboarding** te guía en la primera ejecución y te deja elegir tus propias carpetas.

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
│  ThreeMapRenderer   (src/three/)*           │  ← Renderizador WebGL 3D (Three.js r175)
│  Canvas 2D Renderer (src/renderer.ts)        │  ← Dibujo 2D hex normal (fallback)
│  Minimap Renderer   (src/minimapRenderer.ts) │     minimapa, unidades, ciudades
├─────────────────────────────────────────────┤
│  GameState  (src/game.ts)                   │  ← Loop de simulación,
│  Priority Matrix (src/priorityMatrix.ts)     │     fatiga, colas misión,
│  Fatigue (GameState, src/game.ts)            │     Pathfinding A*
├─────────────────────────────────────────────┤
│  Bridge  (src/bridge.ts + server/bridge.py) │  ← HTTP/WebSocket → agent runtime
│  localMap.ts + localPathfinding.ts           │     Process scanner, task queue
└─────────────────────────────────────────────┘

*  \* 25+ módulos: TerrainAtlas, HexWorldScene, CityProps3D, FogOfWar,
     UnitMesh3D, Rivers3D, SkyDome3D, ForestProps, MountainProps, etc.
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

- **Macro:** hex map en 2D (por defecto) o 3D WebGL — tecla `3` o botón en barra superior alterna `flat` ↔ `webgl`
- **Local:** doble-click en una ciudad → oficina isométrica 2.5D generada desde la estructura del repo
  - **Salas** = carpetas, coloreadas por zona (`team_cluster` azul, `focus` violeta, `break` verde, `infra` concreto)
  - **Workbenches** (`×`) = archivos priorizados por la Priority Matrix — A* cacheado (≤300 hexes)
  - **Whiteboards** = pared norte de cada sala; click → panel de subcarpetas navegables
  - **Puertas isométricas** = paneles deslizantes con perspectiva correcta
  - **NPCs manager** = figuras estacionarias frente a pizarras; click → info de sala
  - **Unidades** = prismos 2.5D animados que caminan entre workbenches
- `Esc` sale de la vista local y vuelve al mapa macro

---

## Integración con agentes

RepoCiv expone un **bridge HTTP + WebSocket** al que cualquier agente se puede conectar:

```bash
# El bridge escucha en localhost:5274 por default
# Endpoints principales:
POST /commands                    # enviar comando al bus
GET  /agents                      # listar agentes activos
GET  /pending                     # cola de tareas pendientes
GET  /approvals                   # comandos esperando aprobación
POST /approvals/<id>/approve      # aprobar comando pendiente
POST /approvals/<id>/reject       # rechazar comando pendiente
```

Ver [docs/API.md](docs/API.md) para la referencia completa.

**Hooks de posición:** para que tu CLI (Claude Code, Codex, Hermes, Devin, mcode, OpenCode) aparezca como unidad en el mapa, RepoCiv puede instalar hooks que reportan solo ubicación y sesión — ver [docs/HARNESS_HOOKS.md](docs/HARNESS_HOOKS.md).

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

42 tools cubriendo 15 dominios con tools MCP: agents, commands, approvals, pending, context, GPU, wonders, graph-relations, foreign-relations y más. Ver [docs/MCP.md](docs/MCP.md).

> **Indicador en el HUD.** Cuando un cliente MCP está operando el dashboard, el HUD
> muestra `MCP ●` (verde) junto al estado del bridge; `MCP ○` (atenuado) cuando no
> hubo actividad MCP en los últimos 60 s. La señal es real: el bridge marca cada
> request que llega etiquetada por el servidor MCP (`X-RepoCiv-Client: mcp`).

**Recetas** (desde otra ventana de Claude Code / Cursor con el MCP registrado):

- **Mandar trabajo sin tocar el mapa:** "Lista los agentes (`agents_list`), elegí
  el de cola más corta y mandale un comando (`command_submit`) para correr los tests
  del repo X." El resultado aparece en vivo en el dashboard.
- **Triage de aprobaciones:** "Mostrame las aprobaciones pendientes (`approvals_list`)
  y aprobá (`approval_approve`) las de riesgo bajo." Los comandos `risk=high` quedan
  en cola hasta que los liberás.
- **Salud del imperio:** "Dame `agents_health` + `gpu_status` + `metrics_snapshot`
  y resumí qué agente está saturado." Mutating tools requieren `REPOCIV_TOKEN`.

---

## Priority Matrix

Puntúa las misiones locales en cola con `priorityScore(mission, now)` en
`src/priorityMatrix.ts`. Los pesos vienen de `shared/priority-weights.json`:

- Espera en minutos: `ageWeight × log1p(age)`.
- Bonus de tests por nombre test/spec o rutas `/test/` y `/tests/`.
- Bonus de deuda por rutas `/debt/`, `/legacy/` y `/stale/` (no mide churn ni inspecciona comentarios).
- Bonus de extensión y penalización por longitud de ruta (no tamaño real del archivo):
  `min(sizeWeight × max(0, filePath.length − 40), 30)`. Con el peso actual
  `size = -3`, el término es no positivo y no tiene límite inferior de −30.
- Resultado redondeado a dos decimales.

| Label | Rango de score (`scoreToPriority`) |
|-------|----------------------------------|
| `CRIT` | score ≥ 60 |
| `HIGH` | 35 ≤ score < 60 |
| `NORM` | 15 ≤ score < 35 |
| `LOW` | score < 15 |

Presiona `P` para abrir el Priority Panel. `sortByPriority(missions, now)` ordena
por score descendente; `peekNextMission(missions, now)` devuelve la siguiente
misión o `null`.

---

## Fatigue System

El estado de fatiga y las áreas de descanso viven en `GameState`
(`src/game.ts`): `updateUnitFatigue`, `getUnitFatigue`, `decayUnitFatigue`,
`addRestArea` y `removeRestArea`. El bridge puede actualizar la fatiga mediante
eventos de contexto.

```
effectiveSpeed = maxFatigue > 0 ? fatigue / maxFatigue : 1
```

Thresholds configurables en `Settings Panel` (`F11`) o en `src/gameConfig.ts`.

---

## Gaceta de noticias

La **Gaceta** (`src/ui/gacetaWidget.ts`) muestra artículos del bridge de
noticias: filtros por categoría/fuente, estado de lectura, gestión de fuentes
y escaneo. No es el log de eventos de misiones.

El **log de actividad** (`F10`, `src/ui/logPanel.ts`) muestra el historial
operativo. `N` abre el wizard de nuevo perfil en `hotkeys.ts`, mientras que
`Shift+N` alterna el widget de noticias montado.

---

## Hotkeys

| Tecla | Acción |
|-------|--------|
| `Ctrl+Q` | Wizard de sesión con perfil seleccionado; Hermes si no hay perfil |
| `Ctrl+G` | Wizard de nueva sesión Hermes |
| `Ctrl+Shift+W` / `Ctrl+O` | Wizard de nueva sesión OpenClaw |
| `Ctrl+E` / `Ctrl+C` | Wizard de nueva sesión Claude |
| `Ctrl+X` | Wizard de nueva sesión Codex |
| `Ctrl+R` / `R` | Wizard de nueva sesión Cursor |
| Flechas / `W/A/S/D` | Desplazar cámara |
| `Q` / `E` | Rotar yaw de la cámara (mapa WebGL; mantener pulsada) |
| Rueda mantenida (MMB) + arrastre | Orbitar cámara (mapa WebGL) |
| `1`, `4`–`9` | Seleccionar sesión por slot (`2`/`3` están reservados para la vista) |
| `Space` | Ciclar al siguiente héroe idle |
| `Tab` | Ciclar todas las sesiones activas (propias y externas) |
| `Enter` | Abrir/cerrar side panel |
| `P` | Priority Matrix panel |
| `M` | Modo Move |
| `Ctrl+S` | Dormir unidad seleccionada |
| `B` | Modo Build |
| `G` | Toggle grid |
| `V` | Toggle fog of war |
| `Ctrl+A` | Aprobaciones pendientes |
| `T` | Terminal panel |
| `N` | Wizard de nuevo perfil |
| `Shift+N` | Alternar widget de noticias (Gaceta) |
| `F10` | Log de actividad |
| `2` / `3` | Alternar render 2D (`flat`) ↔ WebGL (`webgl`) |
| `F11` | Settings Panel |
| `?` | Keyboard help |

**Vista local:** doble-click en una ciudad para entrar; `Esc` para volver al mapa macro.

---

## Agregar un tipo de agente nuevo

1. **Tipo** en `src/types.ts` → `UnitType`
2. **Color** en `UNIT_COLORS` (`src/types.ts`), usado por `GameState.spawnAgent`
3. **Spawn** en el método `spawnAgent(type, ...)` de `src/game.ts`
4. **Hotkey** en `src/ui/hudWiring/hotkeys.ts` (wizard de sesiones)
5. (Opcional) **Comportamiento** en `updateUnits(dt)` o módulo dedicado

---

## Estructura de archivos

```
src/
├── game.ts              GameState, misión, spawn, fatiga/descanso
├── gameConfig.ts        Config singleton (localStorage + thresholds)
├── priorityMatrix.ts    priorityScore, scoreToPriority, sortByPriority
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
├── bridge.py            HTTP bridge (entry point: python -m server.bridge)
├── http_routes.py       Fachada compatible; handlers en routes/
├── websocket_handler.py WebSocket bidireccional
├── mcp_server.py        MCP stdio server (42 tools)
├── agent_runner.py      Ejecuta agentes (Hermes, Claude, Codex, OpenRouter…)
├── process_scanner.py   Detecta procesos → spawns automáticos
├── task_orchestrator.py Cola de tareas con prioridad
└── security_harness.py  Validación de comandos (3 capas)
```

---

## Tests

```bash
# Suite completa (types, lint, tests, build, budgets)
./scripts/check.sh

# O por separado:
npm test -- --run
python3 -m pytest server/ -q
```

> La suite de backend es hermética: `conftest.py` redirige `HOME`,
> `REPOCIV_CONFIG_DIR` y `XDG_*` a un directorio temporal e ignora `.env`, así
> que puede correr con el bridge vivo sin tocar `~/.repociv` ni lockear su ledger.

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
| [docs/README.md](docs/README.md) | Índice de documentación: guías, referencia e histórico |
| [docs/SCOPE.md](docs/SCOPE.md) | Qué es y qué no es el proyecto |
| [docs/API.md](docs/API.md) | Referencia completa de endpoints |
| [docs/MCP.md](docs/MCP.md) | MCP server — 42 tools, ejemplos |
| [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | Tutorial paso a paso |
| [docs/HARNESS_HOOKS.md](docs/HARNESS_HOOKS.md) | Hooks de posición: tu CLI como unidad en el mapa |
| [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) | Acceso remoto via Tailscale |
| [docs/EVOLUTION.md](docs/EVOLUTION.md) | Historia del proyecto |
| [docs/archive/ROADMAP.md](docs/archive/ROADMAP.md) | Roadmap histórico (alpha, May 2026) |
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
