# RepoCiv — Task Board (Vivo en cada sesión)

Instrucciones para DAVI: Al retomar este proyecto, leer este archivo primero para saber en qué sprint se quedó.

---

## Estadísticas Rápidas

| Sprint | Tareas | ✅ Hechas | ⬜ Pendientes | Estado |
|--------|--------|----------|-------------|--------|
| 0. Foundation | 11 | 3 | 8 | 🟡 En progreso |
| 1. Hex Math + Camera | 11 | 0 | 11 | ⚪ No iniciado |
| 2. Map Generator | 10 | 0 | 10 | ⚪ No iniciado |
| 3. Terrain Rendering | 10 | 0 | 10 | ⚪ No iniciado |
| 4. Cities & Districts | 8 | 0 | 8 | ⚪ No iniciado |
| 5. Units / Agents | 15 | 0 | 15 | ⚪ No iniciado |
| 6. Buildings & Wonders | 13 | 0 | 13 | ⚪ No iniciado |
| 7. HUD Civ V Style | 12 | 0 | 12 | ⚪ No iniciado |
| 8. API Bridge Server | 13 | 0 | 13 | ⚪ No iniciado |
| 9. Polish & FX | 10 | 0 | 10 | ⚪ No iniciado |
| 10. Multi-agent | 5 | 0 | 5 | ⚪ No iniciado |
| **TOTAL** | **118** | **3** | **115** | 🟡 |

Última actualización: 2026-04-27 05:55 AM Santiago

---

## Sprint 0: Foundation (Infra + Scaffolding)

- [x] 0.1 Crear directorio y estructura base
- [x] 0.2 Escribir DESIGN.md
- [x] 0.3 Escribir SPRINTS.md y TASKBOARD.md
- [ ] 0.4 Inicializar package.json con Vite + TypeScript
- [ ] 0.5 Crear vite.config.ts con plugin de API bridge
- [ ] 0.6 Crear tsconfig.json estricto
- [ ] 0.7 Crear index.html base
- [ ] 0.8 Crear styles.css con paleta Civ V
- [ ] 0.9 Entry point src/main.ts con bootstrap
- [ ] 0.10 Probar `npm install` y `npm run dev`

---

## Sprint 1: Hex Math + Camera

- [ ] 1.1 Implementar coordenadas axiales (q, r) → pixel (x, y)
- [ ] 1.2 Implementar coordenadas cube (x, y, z) con validación x+y+z=0
- [ ] 1.3 Implementar distancia hexagonal
- [ ] 1.4 Implementar vecinos (6 direcciones)
- [ ] 1.5 Implementar línea/rayo entre hexes
- [ ] 1.6 Implementar range/hex circle
- [ ] 1.7 Implementar cámara ortográfica (offset + zoom)
- [ ] 1.8 Pan con drag de mouse
- [ ] 1.9 Zoom con scroll (clamped)
- [ ] 1.10 Render loop base: placeholder hex grid
- [ ] 1.11 Debug overlay: coordenadas q,r en cada hex

---

## Sprint 2: Map Generator

- [ ] 2.1 Scanear `~/.hermes/workspace/repos/` (nivel 1)
- [ ] 2.2 Determinar terreno por extensión de archivo mayoritaria
- [ ] 2.3 Clasificar repos en ciudades vs tiles sueltos
- [ ] 2.4 Algoritmo de colocación: espiral outward desde (0,0)
- [ ] 2.5 Rellenar espacios vacíos con Mar
- [ ] 2.6 Generar distritos alrededor de ciudades (subdirectorios)
- [ ] 2.7 Asignar recursos (oro, ciencia, producción) por stats del repo
- [ ] 2.8 Clase Tile: posición, tipo, ciudad, recursos, fog state
- [ ] 2.9 Clase World: grid de tiles, lookup por coordenadas
- [ ] 2.10 Renderizar primer mapa real desde filesystem

---

## Sprint 3: Terrain Rendering

- [ ] 3.1 Dibujar hex flat-topped con bordes redondeados
- [ ] 3.2 Paleta de terreno: 6 colores base
- [ ] 3.3 Dibujar hex con gradiente sutil para profundidad
- [ ] 3.4 Sombras de borde entre hexes adyacentes
- [ ] 3.5 Efecto de costa (shallows más claras)
- [ ] 3.6 Montañas: sprite triangular o dibujo a mano
- [ ] 3.7 Bosques: sprite de pino
- [ ] 3.8 Ríos (v1: línea entre hexes con curva bezier)
- [ ] 3.9 Fog of war overlay negro 60%
- [ ] 3.10 Hover highlight (brillo) sobre hex debajo del cursor

---

## Sprint 4: Cities & Districts

- [ ] 4.1 Clase City: nombre, hex, población (archivos), territorio controlado
- [ ] 4.2 Renderizar sprite de ciudad (pentágono/bandera) con nombre
- [ ] 4.3 Territorio: hexes en range 2 pintados con borde del color del equipo
- [ ] 4.4 Districts: subdirectorios expanden la ciudad visualmente
- [ ] 4.5 Barra de producción flotando sobre ciudad
- [ ] 4.6 Popup de ciudad al click: info panel
- [ ] 4.7 Click en ciudad abre detalle de recursos y distrito
- [ ] 4.8 Capital del imperio marca especial (corona/estrella)

---

## Sprint 5: Units — Agents on the Map

- [ ] 5.1 Clase Unit: tipo, nombre, sprite/color, hex, path, state
- [ ] 5.2 Renderizar unidad como círculo con iniciales + borde de color de equipo
- [ ] 5.3 Renderizar sombra bajo la unidad (ellipse oscura)
- [ ] 5.4 Movimiento: calcular path A*
- [ ] 5.5 Movimiento: animar tween entre hexes
- [ ] 5.6 Movimiento: costo variable según terreno
- [ ] 5.7 Selección: click en unidad la marca con halo dorado
- [ ] 5.8 Selección: mostrar rangos de movimiento posibles
- [ ] 5.9 Acción botón "Mover"
- [ ] 5.10 Acción botón "Dormir" (idle)
- [ ] 5.11 Acción botón "Construir"
- [ ] 5.12 Panel inferior izquierdo de unidad seleccionada
- [ ] 5.13 Tooltip al hover unidad
- [ ] 5.14 Animación idle: unidad flota ligeramente
- [ ] 5.15 Unit stacking: si hay varias en un tile, mostrar pilones

---

## Sprint 6: Buildings & Wonders

- [ ] 6.1 Clase Building: nombre, tipo, progreso, duración, estado
- [ ] 6.2 Clase Wonder: idem pero tipo wonder
- [ ] 6.3 Renderizar building en construcción: barra verde sobre ciudad
- [ ] 6.4 Renderizar wonder en construcción: barra dorada + resplandor
- [ ] 6.5 Avance de progreso: simulación local en renderer loop
- [ ] 6.6 Evento `building_start`
- [ ] 6.7 Evento `building_progress`
- [ ] 6.8 Evento `building_complete`
- [ ] 6.9 Evento `wonder_start`
- [ ] 6.10 Evento `wonder_complete`
- [ ] 6.11 Log de eventos inferior al completar building/wonder
- [ ] 6.12 Conexión del building a un proceso real via pid/cmd
- [ ] 6.13 Si el proceso real muere, mark building como failed (rojo)

---

## Sprint 7: HUD Completo (Civ V Style DO M Overlay)

- [ ] 7.1 Barra superior de recursos: Oro, Ciencia, Producción
- [ ] 7.2 Sistema de eras / turnos: fecha actual como "Era"
- [ ] 7.3 Panel unidad seleccionada (bottom-left)
- [ ] 7.4 Log de eventos (bottom-center): scrollable, últimos 5 eventos
- [ ] 7.5 Minimapa (bottom-right): canvas 200x150
- [ ] 7.6 Click en minimapa → teleporta cámara
- [ ] 7.7 Selector de ciudad (bottom-right arriba de minimapa)
- [ ] 7.8 Tooltip global: sistema posicionado absoluto
- [ ] 7.9 Hotkeys visuales en HUD: [M]over, [S]leep, [B]uild
- [ ] 7.10 Animación de nuevo evento en log (slide up)
- [ ] 7.11 Toggle grid lines (g)
- [ ] 7.12 Toggle debug info (F12)

---

## Sprint 8: API Bridge Server + Python Adapter

- [ ] 8.1 Endpoint `/event` POST en vite dev server
- [ ] 8.2 Validación de schema para cada tipo de evento
- [ ] 8.3 Forward de events al frontend via Vite HMR / custom event
- [ ] 8.4 Bridge.py adaptado para soportar `--mode civ`
- [ ] 8.5 bridge_civ.py eventos unit_spawn, unit_move, unit_work
- [ ] 8.6 bridge_civ.py eventos building_start, building_progress, building_complete
- [ ] 8.7 bridge_civ.py eventos wonder_start, wonder_complete
- [ ] 8.8 bridge_civ.py eventos city_founder, resource_update, fog_reveal
- [ ] 8.9 Auto-detectar procesos background: ps aux para training, scraping
- [ ] 8.10 Asociar pid de proceso a building en construcción
- [ ] 8.11 Demo script: simular training con edificio
- [ ] 8.12 README de integración con DAVI / bridge
- [ ] 8.13 Proceso de bridge auto-restart

---

## Sprint 9: Polish & Visual FX

- [ ] 9.1 Antialiasing en líneas de borde de hex
- [ ] 9.2 Partículas al completar wonder (chispas doradas)
- [ ] 9.3 Tráiler de cámara suave al seleccionar unidad/city
- [ ] 9.4 Sonido placeholder al completar edificio
- [ ] 9.5 Loading screen con "Cargando imperio..."
- [ ] 9.6 Responsive: HUD se adapta a viewport pequeño
- [ ] 9.7 Iconos para cada tipo de terreno (emoji o SVG)
- [ ] 9.8 Animación de amanecer/atardecer sutil
- [ ] 9.9 Performance: no renderizar hexes fuera de viewport + buffer
- [ ] 9.10 Guardar posición de cámara en localStorage

---

## Sprint 10: Multi-Agent & Multiplayer (Futuro)

- [ ] 10.1 Distinción de civilizaciones: colores de equipo
- [ ] 10.2 Websync: otro usuario en la misma red ve el mismo mundo
- [ ] 10.3 Diplomacia: tratos entre imperios
- [ ] 10.4 Combate: conflicto visual cuando unidades colisionan
- [ ] 10.5 Barbarians (bugs abiertos) merodean tiles con issues

---

## Notas de sesión

### 27 Abr 2026 05:48 - Diseño completo
- Diseño documentado en DESIGN.md y SPRINTS.md
- Task board creado
- 3 tareas de Sprint 0 completadas
- Próximo paso: tarea 0.4 (package.json)
