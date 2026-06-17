# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Onboarding harness pick step** — paso 2 de 4 del panel inicial. El usuario elige el harness que corre su primera unidad (MAIN) entre Hermes (recomendado), Claude Code, Codex, Cursor y OpenClaw. La elección persiste en `~/.repociv/config.json` y se usa al rutear comandos sobre MAIN. Visitantes recurrentes ven su selección previa. Endpoint `GET/POST /api/config/default-harness` (auth por token).
- **MAIN slot como primera unidad** — `state.spawnUnit('MAIN', ...)` reemplaza al antiguo `'DAVI'` hardcoded. La tecla Q spawnea MAIN; la L (LEXO) se eliminó del hotkey map. MAIN es agnóstico al harness hasta que el usuario elige uno; el bridge resuelve el routing desde config en cada comando.
- **One-shot events.jsonl migration** — al primer boot, las entradas históricas que referencian al agente personal `'DAVI'` se reescriben a `'MAIN'` (actor, unit, unitId, agentId, y campos en `data.*`). Marker file `.migrated-davi-to-main` hace la migración idempotente. Commits `55b9dc0`, `f84ff20`.

### Changed

- **Sanitize agent surface** — los nombres personales DAVI y LEXO salen del shipped product surface. AgentBase (TS), AGENT_CAPABILITIES, _BASE_TIERS, _BASE_ENFORCED, AGENT_CONCURRENCY, los defaults de los endpoints del bridge, y la Q-spawn heredada ahora apuntan a MAIN o a los shipped built-ins (WORKER, SCOUT) y aliases de harness (OPENCLAW, CLAUDE, CODEX, CURSOR). 9 docs públicos saneados (SCOPE, ROADMAP, COMPARISON, PUBLIC_ARCHITECTURE, API, MCP, GETTING_STARTED, DATA_SOURCES, design/BRAND). Los archivos históricos (`docs/archive/`, `docs/plans/`, `AUDIT_*`, `FASE1_*`, `EVOLUTION`) se preservan como registro. 677/677 → 684/684 pytest, 493/493 vitest. Commits `55b9dc0`, `f84ff20`.

### Added

- **Picker interactivo de harness/provider/model en el chat** — `/model`, `/harness` y `/provider` (sin args) abren un picker in-chat estilo Civ V, teclado-first: lista filtrable con dots de disponibilidad (✓ verde / parcial ámbar / ✗ atenuado y no elegible), selección actual marcada "● activo", navegación ↑↓ + Enter, salto por número 1-9 (cuando el filtro está vacío) y type-ahead fuzzy (`/model gpt` filtra modelos entre todos los providers; al teclear, los dígitos pasan a ser parte del filtro). Esc cancela sin cerrar el panel. Toda selección pasa por la misma API `applyHarness/Provider/ModelSelection` que usan los dropdowns DOM, así que dropdowns, `getSelectedConfig()` y la persistencia per-chip (`repociv:chatConfig:<unitId>`) quedan siempre en sync. Se mantiene `/model <provider> <modelo>` como atajo de power-user (aplica local + best-effort `/model/override`). Lógica pura en `pickerLogic.ts` (39 tests: parser de slash, clasificación de args, builders de opciones, filtro fuzzy, navegación); overlay/teclado en `slashPicker.ts`.
- **Filtro de providers por harness (R2)** — al elegir un harness, la lista de providers se acota a los compatibles (cada modelo trae su lista `harnesses`); 'auto' muestra todos y, si un harness no declara compatibilidad en el registry (p.ej. cursor/codex), se cae de vuelta a la lista completa para no dejar el picker vacío. Aplica al picker y a los dropdowns DOM (vía `_filteredProviders`).
- **Modelo activo visible en el chip (R3)** — cada chip de agente muestra una segunda línea con su modelo (id, provider o `auto`), en oro cuando está activo, con `harness · provider/model` en el tooltip. Se sincroniza con cualquier cambio (dropdown, slash o picker) vía un hook `setConfigPersistedHandler` en `persistSelection` — sin acoplar `modelSelector` ↔ `agentChip`.

### Added

- **Custom wonders (P3)** — los usuarios pueden agregar sus propias Maravillas al launcher de RepoCiv sin tocar el código. Crear `~/.repociv/wonders/<id>.json` con un `WonderManifest` + campo opcional `launch` que describe los comandos CLI a spawnear. Al reiniciar el bridge, la Maravilla aparece en `GET /api/wonders` y queda disponible vía `POST /api/wonders/<id>/launch`. Default sigue siendo CLI (`subprocess.Popen` con argv-list) — los custom specs heredan el mismo modelo de seguridad (allowlist server-side, ningún argv del cliente, rechazo en `REPOCIV_REMOTE=true`). Custom specs con el mismo id que un built-in (`bibliotheca`, `institutum`) ganan al default con un warning a stderr — útil para forkear Maravillas built-in. Limitación documentada: el frontend usa `WONDER_MANIFESTS` hardcodeado, así que Maravillas custom NO aparecen en el listado UI de la capital (sí funcionan vía API). Tests: 9 nuevos en `server/test_wonder_launcher.py` (dir missing, manifest sin `launch`, parse válido, malformed skipped con warning, fallback de id al filename, override de built-in, list_launchable con custom, end-to-end launch, repo_not_found). Docs: `docs/CUSTOM_WONDERS.md` (guía user-facing) + sección 5 de `docs/WONDER_CONTRACT.md` ampliada.

### Security

- **Fase 0 audit 0.1 — single-operator warning en docs** — `SECURITY.md` y `docs/GETTING_STARTED.md` ahora abren con un callout `⚠️` explícito: "Single-operator model — DO NOT share your instance". Refuerza que el bridge confía ciegamente en quien tenga `REPOCIV_TOKEN` (el agent runner lanza con `--dangerously-skip-permissions`), y que exponer RepoCiv en una red compartida es out of scope. `docs/CUSTOM_WONDERS.md` también apunta a `SECURITY.md` para que quien vaya a agregar Maravillas custom vea el modelo de seguridad primero. Sin cambios de código — la red de seguridad lógica es la siguiente entrada.
- **Fase 0 audit 0.4 — token + bind enforcement (single source of truth)** — `server/_security.py` con `enforce_token_policy()` centraliza los checks de Fase 0: (1) `REPOCIV_TOKEN` set pero < 32 chars → `SystemExit(1)` con error ruidoso; (2) bind non-loopback (`0.0.0.0`, `::`, o `BRIDGE_WS_HOST` no-loopback) + token vacío → `SystemExit(1)` refuse-to-start (cierra el agujero del `BRIDGE_WS_HOST` override que podía exponer WS sin token); (3) loopback + token vacío → `UserWarning` ruidoso (dev default documentado, no exit). `bridge.py` y `websocket_handler.py` ambos llaman al helper en import-time, así HTTP y WS nunca divergen en qué cuenta como "seguro". Tests: 32 nuevos en `server/test_security.py` (helper puro + integración con `subprocess` que verifica `SystemExit` codes en import real). El `UserWarning` de dev-mode se ve una vez en pytest, captado por el filter por defecto.
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

- **Picker: fuga de teclado con foco en una fila** — el keydown estaba sólo en el input de filtro; un Tab movía el foco a una fila `<button>` y desde ahí Esc cerraba el panel lateral completo y las teclas de spawn (q/w/e/...) disparaban agentes con el picker abierto. Ahora el keydown se enlaza al backdrop (intercepta venga de donde venga el foco), Tab queda fijo en el filtro, y `wireHotkeys` corta en seco mientras `isPickerOpen()`. Cubierto por un e2e que fuerza el foco a una fila.
- **Picker: dropdown en blanco con modelo custom** — `/model <provider> <id-no-listado>` fijaba el modelo en `getSelectedConfig()`/persistencia pero dejaba el `<select>` en blanco (no existía la `<option>`). `applyModelSelection` ahora inyecta una opción sintética `… (custom)` para que el dropdown muestre el modelo fijado.
- **Picker: provider switch fijaba modelos muertos** — `populateModels` clavaba `defaultModel`/modelo guardado sin chequear alcanzabilidad, pudiendo dejar en el estado un modelo que el propio picker marca no-elegible. Ahora prefiere el primer modelo alcanzable y sólo cae al default si nada responde (R5).
- **Picker: orden de modelos al filtrar por provider** — `scoreMatch` derivaba el puntaje del índice en el haystack, así que filtrar por nombre de provider reordenaba los modelos por largo de label (el flagship dejaba de ir primero). Los matches que no son por label ahora puntúan plano, preservando el orden declarado (R4); test de orden reforzado + caso de `moveCursor` desde el cursor inicial -1.
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
