# RepoCiv — Sprint Plan + Task Board

## Proyecto
**Repositorio**: `~/.hermes/workspace/repos/repociv/`
**Branch**: `main`
**Design Doc**: `./docs/DESIGN.md`

---

## Sprint 0: Foundation (Infra + Scaffolding)

| # | Tarea | Estado | Archivos creados/modificados |
|---|-------|--------|-----------------------------|
| 0.1 | Crear directorio y estructura base | ✅ | `mkdir docs/ src/ public/ assets/` |
| 0.2 | Escribir DESIGN.md | ✅ | `docs/DESIGN.md` |
| 0.3 | Escribir SPRINTS.md (este archivo) | ✅ | `docs/SPRINTS.md` |
| 0.4 | Inicializar package.json con Vite + TypeScript | ⬜ | `package.json` |
| 0.5 | Crear vite.config.ts con plugin de API bridge | ⬜ | `vite.config.ts` |
| 0.6 | Crear tsconfig.json estricto | ⬜ | `tsconfig.json` |
| 0.7 | Crear index.html base | ⬜ | `index.html` |
| 0.8 | Crear styles.css con paleta Civ V | ⬜ | `src/styles.css` |
| 0.9 | Entry point src/main.ts con bootstrap | ⬜ | `src/main.ts` |
| 0.10 | Probar `npm install` y `npm run dev` | ⬜ | — |

---

## Sprint 1: Hex Math + Camera (El Motor)

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 1.1 | Implementar coordenadas axiales (q, r) → pixel (x, y) | ⬜ | `src/hex/axial.ts` |
| 1.2 | Implementar coordenadas cube (x, y, z) con validación x+y+z=0 | ⬜ | `src/hex/cube.ts` |
| 1.3 | Implementar distancia hexagonal | ⬜ | `src/hex/axial.ts` |
| 1.4 | Implementar vecinos (6 direcciones) | ⬜ | `src/hex/axial.ts` |
| 1.5 | Implementar línea/rayo entre hexes | ⬜ | `src/hex/axial.ts` |
| 1.6 | Implementar range/hex circle | ⬜ | `src/hex/axial.ts` |
| 1.7 | Implementar cámara ortográfica (offset + zoom) | ⬜ | `src/render/camera.ts` |
| 1.8 | Pan con drag de mouse (mousedown + mousemove + mouseup) | ⬜ | `src/render/camera.ts` |
| 1.9 | Zoom con scroll (clamped a límites razonables) | ⬜ | `src/render/camera.ts` |
| 1.10 | Render loop base: clear + transform + placeholder hex grid | ⬜ | `src/render/renderer.ts` |
| 1.11 | Debug overlay: mostrar coordenadas q,r en cada hex (toggle) | ⬜ | `src/render/renderer.ts` |

---

## Sprint 2: Map Generator (Del Filesystem al Mundo)

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 2.1 | Scanear `~/.hermes/workspace/repos/` (nivel 1) | ⬜ | `src/map/scanner.ts` |
| 2.2 | Determinar terreno por extensión de archivo mayoritaria | ⬜ | `src/map/scanner.ts` |
| 2.3 | Clasificar repos en ciudades vs tiles sueltos | ⬜ | `src/map/scanner.ts` |
| 2.4 | Algoritmo de colocación: espiral outward desde (0,0) | ⬜ | `src/map/placer.ts` |
| 2.5 | Rellenar espacios vacíos con Mar | ⬜ | `src/map/placer.ts` |
| 2.6 | Generar distritos alrededor de ciudades (subdirectorios) | ⬜ | `src/map/placer.ts` |
| 2.7 | Asignar recursos (oro, ciencia, producción) por stats del repo | ⬜ | `src/map/resources.ts` |
| 2.8 | Clase Tile: posición, tipo, ciudad, recursos, fog state | ⬜ | `src/map/types.ts` |
| 2.9 | Clase World: grid de tiles, lookup por coordenadas | ⬜ | `src/map/world.ts` |
| 2.10 | Renderizar primer mapa real desde filesystem | ⬜ | Integración 1.10 + 2.x |

---

## Sprint 3: Terrain Rendering (Civ V Visual)

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 3.1 | Dibujar hex flat-topped con bordes redondeados | ⬜ | `src/render/hex.ts` |
| 3.2 | Paleta de terreno: 6 colores (mar, llanura, bosque, desierto, montaña, hielo) | ⬜ | `src/styles.css` y `src/render/terrain.ts` |
| 3.3 | Dibujar hex con gradiente sutil para profundidad | ⬜ | `src/render/terrain.ts` |
| 3.4 | Sombras de borde entre hexes adyacentes | ⬜ | `src/render/terrain.ts` |
| 3.5 | Efecto de costa (shallows más claras) para mar adyacente a tierra | ⬜ | `src/render/terrain.ts` |
| 3.6 | Montañas: sprite triangular o dibujo a mano | ⬜ | `src/render/sprites.ts` |
| 3.7 | Bosques: sprite de pino | ⬜ | `src/render/sprites.ts` |
| 3.8 | Ríos (v1: línea entre hexes con curva bezier) | ⬜ | `src/render/rivers.ts` |
| 3.9 | Fog of war overlay negro 60% | ⬜ | `src/render/fog.ts` |
| 3.10 | Hover highlight (brillo) sobre hex debajo del cursor | ⬜ | `src/render/renderer.ts` |

---

## Sprint 4: Cities & Districts

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 4.1 | Clase City: nombre, hex, población (archivos), territorio controlado | ⬜ | `src/city/types.ts` |
| 4.2 | Renderizar sprite de ciudad (pentágono/bandera) con nombre | ⬜ | `src/render/city.ts` |
| 4.3 | Territorio: hexes en range 2 de la ciudad pintados con borde del color del equipo | ⬜ | `src/render/city.ts` |
| 4.4 | Districts: subdirectorios expanden la ciudad visualmente (hexes adyacentes con icono pequeño) | ⬜ | `src/render/city.ts` |
| 4.5 | Barra de producción flotando sobre ciudad (si hay edificio en construcción) | ⬜ | `src/render/building.ts` |
| 4.6 | Popup de ciudad al click: info panel con lista de edificios existentes | ⬜ | `src/ui/city-panel.ts` |
| 4.7 | Click en ciudad abre detalle de recursos y distrito | ⬜ | `src/ui/city-panel.ts` |
| 4.8 | Capital del imperio marca especial (corona/estrella) | ⬜ | `src/render/city.ts` |

---

## Sprint 5: Units — Agents on the Map

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 5.1 | Clase Unit: tipo, nombre, sprite/color, hex, path, state | ⬜ | `src/unit/types.ts` |
| 5.2 | Renderizar unidad como círculo con iniciales + borde de color de equipo | ⬜ | `src/render/unit.ts` |
| 5.3 | Renderizar sombra bajo la unidad (ellipse oscura) | ⬜ | `src/render/unit.ts` |
| 5.4 | Movimiento: calcular path A* | ⬜ | `src/unit/pathfinding.ts` |
| 5.5 | Movimiento: animar tween entre hexes (requestAnimationFrame) | ⬜ | `src/unit/movement.ts` |
| 5.6 | Movimiento: costo variable según terreno (bosque = 2x, montaña = 3x) | ⬜ | `src/unit/movement.ts` |
| 5.7 | Selección: click en unidad la marca con halo dorado | ⬜ | `src/render/selection.ts` |
| 5.8 | Selección: mostrar rangos de movimiento posibles (colorear hexes alcanzables) | ⬜ | `src/render/selection.ts` |
| 5.9 | Acciones: botón "Mover" (modo cursor cruz) | ⬜ | `src/ui/actions.ts` |
| 5.10 | Acciones: botón "Dormir" (idle, no se mueve) | ⬜ | `src/ui/actions.ts` |
| 5.11 | Acciones: botón "Construir" (shortcut para building en esa ciudad) | ⬜ | `src/ui/actions.ts` |
| 5.12 | Panel inferior izquierdo de unidad seleccionada (estilo Civ V) | ⬜ | `src/ui/unit-panel.ts` |
| 5.13 | Tooltip al hover unidad: nombre, misión actual, estado | ⬜ | `src/ui/tooltip.ts` |
| 5.14 | Animación idle: unidad flota ligeramente (seno del tiempo) | ⬜ | `src/render/unit.ts` |
| 5.15 | Unit stacking: si hay varias en un tile, mostrar pilones | ⬜ | `src/render/unit.ts` |

---

## Sprint 6: Buildings & Wonders (Background Processes)

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 6.1 | Clase Building: nombre, tipo, progreso, duración, estado | ⬜ | `src/building/types.ts` |
| 6.2 | Clase Wonder: idem pero tipo wonder | ⬜ | `src/building/types.ts` |
| 6.3 | Renderizar building en construcción: barra verde sobre ciudad | ⬜ | `src/render/building.ts` |
| 6.4 | Renderizar wonder en construcción: barra dorada grande + efecto resplandor | ⬜ | `src/render/wonder.ts` |
| 6.5 | Avance de progreso: simulación local en el renderer loop | ⬜ | `src/building/engine.ts` |
| 6.6 | Evento `building_start` → crea Building con timer | ⬜ | `src/api/events.ts` |
| 6.7 | Evento `building_progress` → actualiza porcentaje | ⬜ | `src/api/events.ts` |
| 6.8 | Evento `building_complete` → marca como done, log global | ⬜ | `src/api/events.ts` |
| 6.9 | Evento `wonder_start` → misma lógica pero con fanfarria inicial | ⬜ | `src/api/events.ts` |
| 6.10 | Evento `wonder_complete` → animación de terminación, popup grande | ⬜ | `src/api/events.ts` |
| 6.11 | Log de eventos inferior: mensaje cuando building/wonder completa | ⬜ | `src/ui/log.ts` |
| 6.12 | Conexión del building a un proceso real via pid/cmd que viene del bridge | ⬜ | `src/building/linker.ts` |
| 6.13 | Si el proceso real muere, mark building como failed (rojo) | ⬜ | `src/building/linker.ts` |

---

## Sprint 7: HUD Completo (Civ V Style DOM Overlay)

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 7.1 | Barra superior de recursos: Oro, Ciencia, Producción | ⬜ | `src/ui/top-bar.ts` |
| 7.2 | Sistema de eras / turnos: fecha actual como "Era" | ⬜ | `src/ui/top-bar.ts` |
| 7.3 | Panel unidad seleccionada (bottom-left): icono, nombre, movimiento, botones | ⬜ | `src/ui/unit-panel.ts` |
| 7.4 | Log de eventos (bottom-center): scrollable, últimos 5 eventos | ⬜ | `src/ui/event-log.ts` |
| 7.5 | Minimapa (bottom-right): canvas 200x150 con mundo completo a escala | ⬜ | `src/ui/minimap.ts` |
| 7.6 | Click en minimapa → teleporta cámara a esa posición | ⬜ | `src/ui/minimap.ts` |
| 7.7 | Selector de ciudad (bottom-right arriba de minimapa): dropdown/lista | ⬜ | `src/ui/city-list.ts` |
| 7.8 | Tooltip global: sistema de tooltip posicionado absoluto que sigue mouse | ⬜ | `src/ui/tooltip.ts` |
| 7.9 | Hotkeys visuales en HUD: [M]over, [S]leep, [B]uild | ⬜ | `src/ui/hotkeys.ts` |
| 7.10 | Animación de nuevo evento en log (slide up) | ⬜ | `src/ui/event-log.ts` |
| 7.11 | Toggle grid lines (g) | ⬜ | `src/ui/controls.ts` |
| 7.12 | Toggle debug info (F12) | ⬜ | `src/ui/controls.ts` |

---

## Sprint 8: API Bridge Server + Python Adapter

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 8.1 | Endpoint `/event` POST en vite dev server | ⬜ | `server/bridge-api.ts` |
| 8.2 | Validación de schema para cada tipo de evento | ⬜ | `server/validate.ts` |
| 8.3 | Forward de events al frontend via Vite HMR / custom event | ⬜ | `server/forward.ts` |
| 8.4 | Bridge.py adaptado para soportar `--mode civ` | ⬜ | `bridge_civ.py` |
| 8.5 | bridge_civ.py eventos: `unit_spawn`, `unit_move`, `unit_work` | ⬜ | `bridge_civ.py` |
| 8.6 | bridge_civ.py eventos: `building_start`, `building_progress`, `building_complete` | ⬜ | `bridge_civ.py` |
| 8.7 | bridge_civ.py eventos: `wonder_start`, `wonder_complete` | ⬜ | `bridge_civ.py` |
| 8.8 | bridge_civ.py eventos: `city_founder`, `resource_update`, `fog_reveal` | ⬜ | `bridge_civ.py` |
| 8.9 | Auto-detectar procesos background: `ps aux` para training, scraping | ⬜ | `bridge_civ.py` |
| 8.10 | Asociar pid de proceso a building en construcción | ⬜ | `bridge_civ.py` |
| 8.11 | Demo script: simular un training que spawnea unidad y construye edificio | ⬜ | `scripts/demo_events.py` |
| 8.12 | README de integración con DAVI / bridge | ⬜ | `docs/BRIDGE.md` |
| 8.13 | Proceso de bridge auto-restart (systemd o cron) | ⬜ | `docs/RUNNING.md` |

---

## Sprint 9: Polish & Visual FX

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 9.1 | Antialiasing en líneas de borde de hex | ⬜ | `src/render/renderer.ts` |
| 9.2 | Partículas al completar wonder (chispas doradas) | ⬜ | `src/fx/particles.ts` |
| 9.3 | Tráiler de cámara suave al seleccionar unidad/city | ⬜ | `src/render/camera.ts` |
| 9.4 | Sonido placeholder al completar edificio (beep) | ⬜ | `src/fx/audio.ts` |
| 9.5 | Loading screen con "Cargando imperio..." | ⬜ | `src/ui/loading.ts` |
| 9.6 | Responsive: HUD se adapta a viewport pequeño | ⬜ | `src/styles.css` |
| 9.7 | Iconos para cada tipo de terreno (emoji o SVG) | ⬜ | `assets/emoji/` |
| 9.8 | Animación de amanecer/atardecer sutil (opacidad overlay) | ⬜ | `src/fx/atmosphere.ts` |
| 9.9 | Performance: no renderizar hexes fuera de viewport + buffer | ⬜ | `src/render/culling.ts` |
| 9.10 | Guardar posición de cámara y zoom en localStorage | ⬜ | `src/save/camera.ts` |

---

## Sprint 10: Multi-Agent & Multiplayer (Futuro)

| # | Tarea | Estado | Archivos |
|---|-------|--------|----------|
| 10.1 | Distinción de civilizaciones: colores de equipo | ⬜ | `src/civ/color.ts` |
| 10.2 | Websync: otro usuario en la misma red ve el mismo mundo | ⬜ | — |
| 10.3 | Diplomacia: tratos entre imperios | ⬜ | — |
| 10.4 | Combate: conflicto visual cuando unidades de distintos equipos colisionan | ⬜ | — |
| 10.5 | Barbarians (bugs abiertos) merodean tiles de repos con issues | ⬜ | — |

---

## Estado Global del Proyecto

- Último Sprint completado: **—**
- Sprint en progreso: **0 (Foundation)**
- Tareas totales: ~115
- Tareas completadas: 3/115
- Próximo milestone: Mapa hexagonal navegable con grid visible (Fin Sprint 1)

## Próxima Sesión Sugerida

Continuar con Sprint 0.3 → `package.json`, Vite config, y primer render loop.
