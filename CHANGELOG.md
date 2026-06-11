# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Vista local: oficina legible (rediseño de composición)** — las salas ya no escalan con el número de archivos: cap de 12 escritorios por sala (`MAX_DESKS_PER_ROOM`) con sizing por capacidad real del grid (`teamClusterCapacity`, misma geometría que el layout). Anillo perimetral de paso, pasillo central ≥2, filas desk/chair/walkway centradas. Todas las zonas con archivos (meeting/infra/break/biophilic incluidas) usan el grid ordenado en vez del fallback checkerboard. Mobiliario de anclaje: watercooler en pared norte, planters en esquinas (sin scatter). Overflow de archivos via cluster pill; misiones caen a `findBestWorkbench`. Escritorio rediseñado como caja extruida con monitor encima y silla de oficina en el atlas SVG. Golden 04 regenerado. Commit `f398568`.
- **Standalone capital Gris + wonder district hex rendering** — capital Gris se renderiza como entidad separada del grid de repos. Distritos de maravillas (Bibliotheca, Institutum) con renderizado hexagonal propio y fallback de conectividad UI. Commit `871bce7`.
- **Dual-source task system** — sistema de tareas dual: tareas de Hermes (`PENDING_TRACKER.md`) + tareas locales RepoCiv (IDs con prefijo `L-`). Merger en `GET /pending`, CRUD separado por prefijo de ID. Commits `d8f7efa`.
- **Approval panel UX** — confirm-before-approve para comandos de riesgo alto, badges de riesgo por `data-risk`, badges de fuente (`rc`/`hm`) en items pending, estado de confirmación con botón "¿Confirmar?" en dos pasos. Commits `d8f7efa`.
- **Layer telemetry** — `_trackLayerToggle()` en `layers.ts` registra opens/closes/lastAt por capa en `localStorage('repociv_layer_analytics')`. Permite adoption gate antes de Fase 2. Commit `4bf6fc4`.
- **Per-layer status API** — `setLayerStatus(id, status)` permite al renderer señalar empty/loading/error por capa. CSS cues: empty=dim icon, loading=pulse animation, error=red dot superscript. Commit `370f285`.
- **MCP server expansion (+11 tools)** — 11 tools nuevas: `wonders_list`, `wonders_get`, `wonder_health`, `graph_relations_list`, `graph_relations_evidence`, `graph_relations_stats`, `foreign_repo_profile`, `foreign_reports_list`, `foreign_report_get`, `ws_info`. Total: 41 tools, 15 dominios. Commits `cc82088`, `5f6393d`.
- **MCP server foundation** — bridge expuesto como MCP server por stdio con 32 tools iniciales (11 dominios). Commits `5f6393d`.
- **Agent type expansion** — CLAUDE y CODEX como tipos de agente dedicados con perfiles propios. LEXO con perfil Worker/Scout genéricos. Commits `cd8e503`, `0022467`.
- **WebSocket transport** — capa de transporte bidireccional WebSocket + refactor de bridge. Commit `e7a6469`.
- **Chat markdown rendering + chip selector** — rendering de markdown en chat, selector de chips estilo Civ V para harness/provider/model. Commits `c61e205`, `8abcc67`.
- **Per-chip harness/provider/model config** — cada chip de agente guarda su propia configuración de harness, provider y model. Commits `7db1d09`, `8df9b1f`.
- **Message dispatch fixes** — alineación de dispatch con chip guardado, envío de misiones a agents recién spawneados. Commits `5790b3f`, `33ee12f`, `168ab78`, `7c3ce26`.
- **CDaily integration** — Gaceta Exterior widget, city panel kiosk tile, bridge routes, recovery bonus. Commits `a7e628b`, `39d58a0`.
- **Capital + Wonders + Gaceta improvements** — 6 mejoras integradas a capital, maravillas y gaceta. Commit `45e59d7`.
- **Gran Biblioteca iframe embed** — La Gran Biblioteca embebida via URLs configurables de iframe. Commit `166d1a9`.
- **Wonder vignette guard** — guard en gaceta para prender/apagar wonder vignette de forma segura. Commit `e7ddc50`.
- **Flidez quick wins** — chunking de chunks, contrato en Gaceta, base de capas. Commit `c4ed1b8`.
- **Terrain asset atlases** — reemplazo de sprites individuales de terreno por atlases pre-generados. Commits `5c68fed`, `c63e919`, `193d1c0`.
- **Local view Phases 1-9** — sistema completo de vista local RimWorld-style: HSL tokens, glassmorphism, body class toggling, analog noise, caching, offscreen pre-render, particle pool, squash & stretch, workbench glows, security gates, floor/wall tiles, visual polish, task assignment HUD. Commits `bfd87f2` → `51806e3`.
- **Agency 8-persona frontend pass** — refactor visual completo con 8 personas de diseño. Commit `371f737`.
- **Map civilizationficación** — repos más juntos y terreno revelado. Commit `febcd82`.
- **Orchestrator stall detection** — warnings and empty output detection in the agent runner.
- **Workspace safety invariants** — Symphony §9.5 extraction for secure agent boundaries.
- **Agent auto-discovery implementation plan** — docs/plans for agent self-discovery roadmap.
- **City drag-and-drop relocation** — move cities on the map with visual feedback and lifecycle completion.
- **Log panel collapsibility** — log panel no longer blocks the chat panel.
- **Public documentation suite** — README público, CONTRIBUTING.md, issue templates, MIT License, CI badges. Commits `e2d7cdc`, `6990ff1`, `7b70eb6`, `9a8aa44`, `7171f87`.
- **Remote access docs** — documentación de acceso remoto via Tailscale. Commit `e2d7cdc`.
- **Namespace migration `/wonders` → `/api/wonders/`** — canonical namespace bajo `/api/`. Legacy `/wonders` se mantiene como alias. Commit `4bf6fc4`.
- **"Mapa Limpio" localization** — label de Clean Map localizado a español. Commit `4bf6fc4`.
- **Layer effects: knowledge, labs, security** — cada capa tiene efecto visual real (conexiones Bibliotheca, anillos Institutum, contorno security). Commits `c4ed1b8`.
- **LOD 3-step system** — tres escalones perceptibles de Level of Detail: bajo, medio, alto. Commit `c4ed1b8`.
- **Lucide icons migration** — emojis de botones top bar reemplazados por Lucide icons. Commit `587cd17`.

### Fixed

- **Sprites de oficina dibujados a 2× del tile** — las celdas del atlas (128×64) se renderizaban a tamaño nativo ancladas arriba: cada mueble medía 2 tiles de ancho y quedaba corrido 2 filas al sureste de su propio tile (escritorios como "piezas regadas"). Ahora se escalan a 1.5× `ISO_TILE_W` con el fondo de celda anclado a la esquina sur del tile. Commit `f398568`.
- **Ventanas y vents como huecos en muros** — `window` colocado sobre tiles de piso (reception/meeting/biophilic/corredores) renderizaba bloques de vidrio flotantes en medio de la sala; ahora `placeWallWindows()` las pone sobre tiles de MURO. `window` y `vent` son intransitables en pathfinding y `vent` dibuja su prisma de muro (cerraba huecos visibles en paredes compartidas). Commit `f398568`.
- **City panel: ancho y overflow** — neutralizado el `top:50%` legacy, body flexible hasta `max-height`, filas de git/files/misiones a una línea con ellipsis + tooltip (los paths largos invadían la columna vecina). Ancho 560px. Commit `d8af38b`.
- **go.mod tuple arity bug** — manifest parser de Go tenía 4-tuple pero unpack esperaba 3. Causaba ValueError silencioso en todo repo Go. Fix: fold `re.MULTILINE` en `re.compile()`. Commit `344e0fb`.
- **Path validation in graph_relations** — `is_dir()` guard antes de `iterdir`/`subprocess` calls previene filesystem traversal con paths inválidos. Commit `344e0fb`.
- **display:flex overridden by display:none** — fix de bug CSS donde flex era inmediatamente sobrescrito. Commit `d18b128`.
- **transition:all replaced** — reemplazo de `transition:all` con propiedades explícitas para mejor performance. Commit `6284e53`.
- **Separator DOM bug** — separator insertado dentro de `<label>` (semánticamente inválido) corregido. Commit `370f285`.
- **no-useless-assignment** — fix de lint warning para `cityHere`. Commit `8f5d8ae`.
- **Cap `max_tokens` at 4096** — en payload Hermes para evitar requests oversized.
- **Wire harness param** — a través de `run_agent` wrapper con cascade model pass-through.
- **Complete city relocate lifecycle** — panel state, cursor reset, success toast.
- **14 new signal tests** — coverage para path validation, base shape, imports, go.mod parse, package.json deps, README links, mtime cache. Commit `344e0fb`.
- **Lint 16 warnings resolved** — `console.*` removidos, `any` types tipados correctamente. Commit `d24ecc9`.
- **WebSocket handler fixes** — normalización de command data, consumo silencioso de `auth_ok`. Commits `6b44f45`, `d7458c2`, `8abcc67`.
- **Schema fix** — `hex` opcional en evento `unit_work` (server lo envía sin hex). Commit `dab425a`.
- **Provider list filter** — lista de providers filtrada por harness configurado. Commit `872af8b`.

### Tests

- Cover `canRelocateCityTo` and `relocateCity` with unit tests.
- `test_graph_relations_signals.py` — 22 tests (path validation, shapes, parsers, cache). Commit `344e0fb`.
- Total test count: ~784 passing (318 frontend Vitest + 466 backend pytest).

### Design

- `--state-approval token` agregado, approval orange wired. Commit `d266b2e`.
- LOD tooltip added for discoveribility, font size increased. Commit `370f285`.

## [0.1.0] — 2025-04-30

### Added

- Initial release: Imperial Agent Dashboard.
- Hexagonal map rendering (Canvas 2D, 60 FPS).
- Python HTTP bridge for agent orchestration.
- Priority Matrix for file/carpeta scoring.
- Fatigue system and A* pathfinding.
- 314 frontend unit tests (Vitest) + 544 backend tests (pytest).
