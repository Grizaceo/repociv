# RepoCiv — Design Document v1.0

## Visión

Un mapa hexagonal al estilo Civilization V que visualiza el ecosistema de repos, agentes y procesos del workspace de Cristóbal (~/.hermes/workspace/repos/). El usuario (Cristóbal) mueve la cámara, selecciona unidades (agentes), y ve en tiempo real (o semipausado) cómo los procesos de background avanzan como construcciones de edificios o maravillas.

## 1. Metáfora Civilization ↔ Sistema

| Civ V Concepto | RepoCiv Concepto | Origen de Datos |
|----------------|------------------|-----------------|
| Mapa hexagonal | Directorios de repos scaneados | `~/.hermes/workspace/repos/*` |
| Ciudad | Proyecto principal con subdirectorios | `repo/apps/`, `repo/packages/` se expanden como distrito |
| Terreno (llanura, bosque, desierto, mar, montaña) | Tipo de proyecto inferido por stack | File extensions, presence of package.json, pyproject.toml, etc. |
| Unidad / Héroe | Agente de IA (DAVI, LexO, TurboQuant, entrenamientos, scrapers) | Procesos detectados via `ps aux`, bridge.py events, cronjobs |
| Movimiento de unidad | El agente se mueve al tile del repo donde está trabajando | Bridge events `unit_move` |
| Edificio en construcción | Proceso background de corta/mediana duración (< 30 min) | Bridge events `building_start`, `building_progress`, `building_complete` |
| Maravilla en construcción | Proceso background pesado de larga duración (> 30 min) | Bridge events `wonder_start`, `wonder_progress`, `wonder_complete` |
| Recurso Oro | Commits / líneas añadidas | `git log --shortstat` |
| Recurso Ciencia | Tests / coverage / validación | `pytest`, `coverage`, `mypy` |
| Recurso Producción | Features / pull requests abiertos | GitHub API / `gh pr list` |
| Ciudadano trabajando | Subproceso / subagente dentro de un proyecto | `ps aux` threads, subagentes delegate_task |
| Fog of War | Repo sin commits en >30 días o no visitado | `git log -1 --since="30 days ago"` |
| Era / Turno | Timestamp — el mundo envejece con el tiempo real | `Date.now()` |
| Diplomacia con otra civilización | Integración con AgentCraft / otro usuario | Websocket multiplayer |
| Horda bárbara | Errores / bugs sin resolver | GitHub issues abiertos con label "bug" |
| Ruinas antiguas | Repos archivados / legacy | `repo/archived/` o sin commits en >180 días |
| Caravana / Ruta comercial | Dependencia entre repos (npm link, workspace) | `package.json` workspaces, `requirements.txt` imports |
| Gran Persona | Milestone / release tag | Git tags `v*` |

## 2. Estado del Mundo (Semipausado)

```
 Estado del renderer:
   NO_INPUT  →  corre a 0.5x (movimientos lentos, construcciones avanzan)
   HOVER     →  pausa momentánea (tooltip se muestra)
   CLICK     →  pausa mientras se procesa acción
   DRAG      →  pausa durante pan de cámara
   ANIMATION →  tiempo real (para tweenings)
```

La simulación avanza en un `requestAnimationFrame` loop. Cuando no hay input de usuario, el `deltaTime` acumulado se aplica a construcciones y movimientos. Cuando hay input, `deltaTime` se congela para el mundo pero no para la UI.

## 3. Sistema de Renderizado (Canvas 2D)

- **Vista principal**: Canvas full-viewport, Hex Grid con cámara ortográfica (pan/zoom)
- **Minimapa**: Canvas 200x150 px, bottom-right overlay, renderiza mundo completo a escala 1/N
- **HUD superior**: DOM overlay, barra de recursos globales (oro, ciencia, producción) + fecha/turno
- **Panel inferior izquierdo**: DOM overlay, info de unidad seleccionada + botones de acción
- **Panel inferior centro**: DOM overlay, log de eventos recientes (últimos 5 mensajes)
- **Panel inferior derecho**: DOM overlay, lista de ciudades / hotkeys
- **Tooltip**: DOM posicionado absoluto cerca del cursor

Paleta: Extraída de Civ V base game.
- Plano/Pradera: #7ba05b (verde tierra)
- Desierto: #d4a574 (arena)
- Bosque: #2d5a27 (verde oscuro)
- Montaña: #6b6b6b (gris rocoso) + sombra #444
- Mar: #2b6da5 (azul profundo) + #3a8bc8 shallows
- Nieve/Hielo: #e0e0e0 (para repos legacy/archived)
- Borde hex: #1a1a1a a 0.3 opacity
- Fog of war overlay: #000 a 0.6 opacity

## 4. Sistema de Hexágonos

Coordenadas: **Axial (q, r)** — más simple que offset para rendering.
Math: `x = size * (3/2 * q)`, `y = size * (sqrt(3)/2 * q + sqrt(3) * r)`
Pathfinding: A* sobre grid de hexágonos con pesos según terreno.
Distancia: `distance(a, b) = (abs(q1-q2) + abs(q1+r1 - q2 - r2) + abs(r1-r2)) / 2`

## 5. Generación de Mapa

```
Input:  ~/.hermes/workspace/repos/
Output: JSON de tiles

Algoritmo:
1. Listar todos los directorios de nivel 1 (repos principales) → son ciudades candidatas
2. Para cada ciudad, listar subdirectorios de nivel 2 (apps/, packages/, src/) → hex tiles adyacentes
3. Para cada subdirectorio, listar archivos → determina terreno por extensión
   .ts/.tsx/.js/.jsx → Llanura
   .py/.ipynb → Bosque (ML/data)
   .cpp/.rs/.go → Montaña (low-level)
   .md/.txt/.json → Desierto (config/docs)
   .db/.pt/.onnx/.h5 → Montaña (binary heavy)
   mixed → Pradera
4. Tiles sin ciudad cercana (< 3 hex dist) se rellenan como Mar
5. Ciudad en tile central, tiles adyacentes = distrito/expansión
```

## 6. Sistema de Unidades (Agentes)

```typescript
interface Unit {
  name: string;           // "DAVI", "LexO-Alpha", "training-m6"
  type: "hero" | "worker" | "scout" | "army" | "caravan";
  civ: string;            // "gris" (el imperio del usuario)
  sprite: string;           // URL a sprite o generado proceduralmente
  hex: Axial;             // posición actual
  targetHex?: Axial;      // moviéndose hacia aquí
  path: Axial[];          // ruta calculada
  state: "idle" | "moving" | "working" | "building";
  mission?: string;       // descripción visible en tooltip
  progress?: number;       // 0-100 si está trabajando en tile
  speed: number;          // hex/segundo en movimiento
  actions: Action[];      // botones disponibles al seleccionar
}
```

Sprites: Por ahora, círculo con iniciales + color de equipo. Más tarde: iconos de agente.

## 7. Sistema de Construccion (Edificios y Maravillas)

```typescript
interface Building {
  name: string;           // "M6-Retraining", "Scraping-CVEs"
  type: "building" | "wonder";
  city: string;           // ciudad anfitriona
  hex: Axial;             // posición en mapa (sobre la ciudad)
  progress: number;       // 0-100
  durationSeconds: number;
  elapsedSeconds: number;
  status: "planned" | "building" | "complete";
  sourceProcess?: {       // info del proceso real
    pid?: number;
    cmd?: string;
    startTime: number;
  };
}
```

Edificio: barra de progreso verde pequeña debajo del sprite de ciudad.
Maravilla: barra de progreso dorada grande, animación de partículas, anuncio global en log.

## 8. Sistema de Eventos / Bridge

RepoCiv expone un servidor HTTP simple (Node/Express o Vite plugin).

```
POST /event
Content-Type: application/json

{ "type": "unit_spawn", "unit": "DAVI", "civ": "gris", "hex": [0,0], "mission": "Bridge visual spawn" }
{ "type": "unit_move", "unit": "DAVI", "from": [0,0], "to": [3,2], "mission": "Evaluar CfCNavigator" }
{ "type": "unit_work", "unit": "DAVI", "hex": [3,2], "progress": 45 }
{ "type": "building_start", "city": "L-KN", "building": "M6-Retraining", "durationSeconds": 120 }
{ "type": "building_progress", "city": "L-KN", "building": "M6-Retraining", "progress": 67 }
{ "type": "building_complete", "city": "L-KN", "building": "M6-Retraining" }
{ "type": "wonder_start", "city": "Tamagotchi", "wonder": "Stage-3-Prod", "durationSeconds": 600 }
{ "type": "wonder_complete", "city": "Tamagotchi", "wonder": "Stage-3-Prod" }
{ "type": "city_founder", "name": "agentcraft-bridge", "hex": [12,8] }
{ "type": "resource_update", "resource": "gold", "delta": +150 }
{ "type": "fog_reveal", "hexes": [[1,1], [1,2], [2,1]] }
```

El bridge.py actual se puede extender o reescribir para enviar a `http://localhost:5173/event`.

## 9. UI / HUD Layout (Civ V style)

```
+-------------------------------------------------------------+
|  [Oro: 1,204]  [Ciencia: 340]  [Producción: 89]   Era 3: IA |
+-------------------------------------------------------------+
|                                                             |
|                                                             |
|                    Mundo Hexagonal                          |
|              (pan con drag, zoom con scroll)               |
|                                                             |
|                                                             |
+-----------------------------------------------+ +---------+ |
| [DAVI icon]        |                            |  Minimap| |
| Scout · 4/4 moves |                            |         | |
| Mision: Evaluar   |  Event Log:                 | ▓▓░▓░▓  | |
| [Mover] [Construir]|  > M6-Retraining 67%       | ▓░▓▓░▓  | |
| [Dormir] [Skip]   |  > DAVI reached L-KN        | ▓▓▓░░▓  | |
|                   |                            |         | |
+-----------------------------------------------+ +---------+ |
```

## 10. Tech Stack

| Capa | Tecnología |
|------|-----------|
| Bundler | Vite 6 |
| Lenguaje | TypeScript |
| Renderer | HTML5 Canvas 2D (manos, sin librerías externas de grid) |
| UI Overlay | Vanilla JS + CSS (DOM encima del canvas) |
| Servidor bridge | Vite dev server + API endpoint personalizado |
| Persistencia | `localStorage` para preferencias de cámara |
| Estado | Clases vanilla (no React/State Manager por ahora) |

## 11. Extensibilidad Futura

- **Multiplayer**: Websockets para ver agentes de otros usuarios (Diplomacia)
- **Combate**: Cuando 2 agentes llegan al mismo tile, mostrar "conflict" visual
- **Tecnologias de época**: Desbloquear visualización avanzada al cumplir milestones
- **Mods**: Cargar mapeos custom de directorios
- **Sonido**: FX de Civ V para movimiento, completación de edificios, etc.

---

*Documento base para el Sprint Plan y decisiones arquitectónicas.*
