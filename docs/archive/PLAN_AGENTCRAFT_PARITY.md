# Plan de Paridad: RepoCiv → AgentCraft Level

**Fecha:** 2026-04-30  
**Referencia:** https://www.getagentcraft.com/  
**Objetivo:** Llevar RepoCiv desde su estado actual (beta funcional, Canvas 2D, agentes locales) al nivel de AgentCraft: orquestador de agentes de producción con UI RTS, soporte multi-proveedor, acceso remoto, contenedores aislados y experiencia multiplayer.

---

## Diagnóstico Comparativo

| Dimensión | RepoCiv (hoy) | AgentCraft (target) | Brecha |
|---|---|---|---|
| **Renderer** | Canvas 2D, Civ-V hex grid 60 FPS | Three.js 3D map, fog of war, faction skins | Alta |
| **Agentes soportados** | DAVI / LEXO / WORKER / SCOUT / OPENCLAW (propios) | Claude Code, OpenCode, Cursor, OpenClaw (CLI hooks) | Alta |
| **Transporte real-time** | SSE (Server-Sent Events) | WebSocket bidireccional | Media |
| **Terminal integrada** | No existe | PTY full con multi-tab en HUD | Alta |
| **Plan review UX** | Modal básico de aprobación | Full-screen plan review con diff highlights | Media |
| **Git diff viewer** | No existe | Codex: diff multi-sesión filtrable | Alta |
| **Git worktrees** | No existe | Spawn hero en worktree desde UI | Media |
| **Scheduled tasks** | Scheduler con priority queue | Loops recurrentes con intervalos preset | Media |
| **Contenedores aislados** | No existe | Docker / Apple Containers por agente | Alta |
| **Acceso remoto** | No existe | Túnel seguro TTL + PWA instalable + push notifs | Alta |
| **Voz** | No existe | Web Speech API en composer | Baja |
| **Multiplayer** | No existe | Alliance Hall: room compartido multi-developer | Alta |
| **Skill Scrolls** | No existe | Coleccionables que instalan habilidades reales | Media |
| **Achievements** | No existe | Sistema de logros con trophies compartibles | Baja |
| **Race skins** | No existe | Orc / Human / Elf / Undead con arte propio | Media |
| **Música ambient** | No existe | Soundtrack togglable | Baja |
| **Context usage bar** | No existe | Verde/amarillo/rojo visual en panel | Baja |
| **Model selector** | No existe | Cambiar modelo mid-session | Media |
| **File @ mention** | No existe | Autocomplete @ para referenciar archivos | Baja |
| **Instalación** | npm run dev + python3 | `npx @idosal/agentcraft` (one-liner) | Alta |
| **Tests** | 0 implementados | Suite completa | Alta |
| **Documentación** | Solo docs/ internas | Site docs público con tutoriales | Alta |

---

## Plan de Ejecución por Sprints

### SPRINT 1 — Fundación crítica (sem 1–2)
> *Sin esto, el resto no tiene base sólida. Todo en paralelo con lo existente.*

#### 1.1 Test Suite baseline
- Implementar los 0 tests declarados en vitest (hex math, pathfinding A*, game state, bridge schema)
- Mínimo 80% coverage en `server/` con pytest
- Pipeline CI básico (GitHub Actions: lint + test en cada PR)
- **Archivos:** `src/*.test.ts` ya existen vacíos, `server/test_*.py` ya existen

#### 1.2 Configuración externalizada
- Mover todos los hardcodes a `.env` con schema validado
- Puertos: `REPOCIV_PORT`, `BRIDGE_PORT`, rutas `HERMES_ROOT`, model, token
- Usar `dotenv` en TS (ya tiene `_load_dotenv` en Python)
- **Archivos:** `server/bridge.py`, `vite.config.ts`, `.env.example`

#### 1.3 Seguridad real
- Reemplazar `CORS *` por allowlist configurable (ya está en bridge.py pero revisar)
- Fijar el "demo mode lies" (retorna `success=True` sin hacer nada)
- Auth token obligatorio con fallback a localhost-only sin token
- Validar eventos con valibot antes de `handleBridgeEvent` en bridge.ts
- **Archivos:** `server/bridge.py`, `src/bridge.ts`, `src/types.ts`

#### 1.4 WebSocket upgrade
- Migrar de SSE (one-way) a WebSocket bidireccional
- Backend: añadir `ws://` endpoint en `server/bridge.py` con `websockets` lib
- Frontend: reemplazar `EventSource` en `src/bridge.ts` por `WebSocket`
- Mantener SSE como fallback graceful
- **Por qué:** los flujos de approval, streaming de chat y plan review necesitan bidireccionalidad

---

### SPRINT 2 — Integración real de agentes CLI (sem 3–4)
> *AgentCraft funciona instalando hooks en los CLIs. RepoCiv necesita lo mismo.*

#### 2.1 Hook system para CLIs externos
- Crear `server/hooks/` con instaladores para Claude Code, OpenCode, Cursor
- Mecanismo: script que parchea el entrypoint del CLI para reportar eventos a `/event`
- Definir protocolo de eventos estandarizado (hero_active, mission_start, file_access, bash_command, hero_idle)
- **Archivos:** `server/hooks/claude_code.py`, `server/hooks/opencode.py`, `server/hooks/cursor.py`

#### 2.2 Estandarizar event protocol con OpenClaw
- RepoCiv ya soporta OPENCLAW como passive integration
- Alinear el formato de eventos con el estándar AgentCraft (mismo schema para interoperabilidad)
- Emitir `SKILL.md` automáticamente en setup igual que AgentCraft
- **Archivos:** `server/event_store.py`, `shared/openclaw-skill.md`

#### 2.3 Session handoff & fork
- Implementar endpoint `POST /sessions/<id>/fork` que clona el contexto de un agente
- UI: botón "Fork Session" en panel cuando el agente es externo
- Heredar citación de sesión padre en el chat (como el "Handoff Citation" de AgentCraft)
- **Archivos:** `server/sessions.py`, `src/ui/panel.ts`, `src/ui/chat.ts`

#### 2.4 Scheduled loops
- Extender `server/scheduler.py` con soporte de tareas recurrentes (intervalos: 1min, 5min, 15min, 30min, 1h)
- UI: "Active Loops" widget en sidebar izquierdo
- Estado de loop persistido y sobrevive reinicios
- **Archivos:** `server/scheduler.py`, `src/ui/index.ts`, nuevo `src/ui/loops.ts`

---

### SPRINT 3 — Terminal integrada + Git (sem 5–6)
> *Dos de las features más usadas en AgentCraft según su docs.*

#### 3.1 PTY Terminal en HUD
- Integrar `xterm.js` en el frontend como tab en el HUD inferior
- Backend: endpoint `POST /terminal/create` que spawna un PTY con `pty` Python lib
- Multi-tab: varias sesiones de terminal simultáneas
- **Archivos:** nuevo `src/ui/terminal.ts`, `server/terminal.py`, `src/ui/hud.ts`

#### 3.2 Git Diff Viewer (Codex)
- Endpoint `GET /git/changes` que devuelve `git diff --name-status` por sesión de agente
- UI: panel lateral "Codex" con archivos agrupados por directorio, filtrable por hero
- Ver diff individual por archivo (hunks formateados)
- Status labels: altered, sealed, newly scribed, destroyed
- **Archivos:** nuevo `server/git_bridge.py`, nuevo `src/ui/codex.ts`

#### 3.3 Git Worktree spawning
- Endpoint `POST /worktrees` para crear `git worktree add`
- En Spawn Modal: opción de branch/worktree al crear nuevo hero
- Cada worktree es tratado como ciudad independiente en el mapa
- **Archivos:** `server/git_bridge.py`, `src/ui/spawnModal.ts` (nuevo)

#### 3.4 Plan Review UX
- Cuando un agente entra en plan mode, el Side Panel abre vista full-screen
- Markdown rendering con syntax highlighting
- File paths en oro (`src/App.tsx:123`) como links clickables
- Dropdown de secciones para navegar planes largos
- Feedback textarea para pedir modificaciones
- Tecla `Y` / `N` para aprobar/rechazar (ya existe en `src/ui/approvalPanel.ts`)
- **Archivos:** `src/ui/approvalPanel.ts`, `src/ui/chat.ts`

---

### SPRINT 4 — Renderer upgrade: Canvas 2D → Three.js (sem 7–9)
> *El cambio visual más grande. Hay que mantener backward compat con el renderer 2D.*

#### 4.1 Three.js base layer
- Migrar de Canvas 2D a Three.js con `renderer3d.ts` (ya existe como stub)
- Terreno como mesh hexagonal 3D con elevación procedural
- Personajes como sprites billboarded (2.5D style como AgentCraft)
- Mantener el renderer 2D como fallback con flag `REPOCIV_RENDERER=2d`
- **Archivos:** `src/renderer3d.ts` (expandir), `src/renderer.ts` (mantener), `src/main.ts`

#### 4.2 Fog of War
- Implementar fog of war toggle (`V` key) que oscurece tiles sin hero nearby
- Visibility radius por tipo de agente (DAVI=5, LEXO=3, WORKER=2, SCOUT=7)
- Shader de niebla con transición suave
- **Archivos:** `src/renderer3d.ts`, `src/game.ts`, `src/ui/keyboard.ts`

#### 4.3 Race skins / Faction system
- Definir 4 facciones: Orc (WORKER), Human (DAVI), Elf (LEXO), Undead (SCOUT)
- Assets: sprites diferenciados por facción (placeholder SVG primero, arte real después)
- Edificios con estética de facción
- Selector de facción en Settings
- **Archivos:** nuevo `src/factions.ts`, `src/gameConfig.ts`, `src/ui/settingsPanel.ts`

#### 4.4 Ambient music
- Incorporar `Howler.js` para soundtrack ambient
- Toggle en HUD (tecla `M`)
- Tracks diferenciados por facción
- **Archivos:** nuevo `src/audio.ts`, `src/ui/hud.ts`

---

### SPRINT 5 — Panel de agente completo (sem 10–11)
> *El Side Panel es el corazón de la UX de AgentCraft.*

#### 5.1 Context usage bar
- Endpoint `GET /agents/<id>/context` que devuelve tokens usados / max
- Barra visual verde (<70%) / amarillo (70–90%) / rojo (>90%) en panel header
- Actualización en tiempo real vía WebSocket
- **Archivos:** `src/ui/panel.ts`, `server/sessions.py`

#### 5.2 Model selector mid-session
- Dropdown en panel header para cambiar modelo del agente
- Backend: `PATCH /agents/<id>/model` para hot-swap
- Soportar múltiples providers (Anthropic, OpenAI, local Ollama)
- **Archivos:** `src/ui/panel.ts`, `server/agent_runner.py`

#### 5.3 File @ mention autocomplete
- En el composer, `@` dispara autocomplete con archivos del repo activo
- Keyboard navigation (arrows + Enter)
- Inyecta path relativo en el prompt
- **Archivos:** `src/ui/chat.ts`

#### 5.4 Streaming con tool use blocks
- Mostrar bloques "tool use" en tiempo real: Read, Write, Edit, Bash, Search
- Thinking blocks (razonamiento del agente) colapsables
- Operation ticker en footer del panel: "Reading App.tsx", "Running git status..."
- **Archivos:** `src/ui/chat.ts`, `server/agent_runner.py`

#### 5.5 Agent summaries (AI-generated)
- Al cerrar una misión, generar resumen automático con LLM
- Persistir en `~/.repociv/missions.json` (ya existe)
- Mostrar último resumen en panel header ("Last completed mission")
- **Archivos:** `server/task_orchestrator.py`, `server/sessions.py`

---

### SPRINT 6 — Contenedores + Acceso Remoto (sem 12–14)
> *Features de producción para uso en equipo. Las más complejas.*

#### 6.1 Isolated Agent Containers
- Integración con Docker SDK (`docker-py`)
- Al spawnar hero, opción de "Run in container"
- Montar project files como volumen, aislar network stack
- Badge de contenedor en hero roster y mapa
- `server/container_manager.py` nuevo
- **Archivos:** nuevo `server/container_manager.py`, `server/agent_runner.py`, `src/ui/spawnModal.ts`

#### 6.2 Remote Access con túneles seguros
- Integrar `ngrok` SDK o `cloudflared` para crear túneles auth con TTL
- Modal "Remote Access" en top bar con TTL presets (15min, 1h, 4h, 8h)
- Token de sesión único por túnel
- **Archivos:** nuevo `server/tunnel_manager.py`, `src/ui/hud.ts`

#### 6.3 Mobile PWA
- Añadir `manifest.json` + service worker para instalabilidad
- Vista mobile-optimizada (tabs: Agents, Chat, Quests)
- Touch controls para el mapa
- **Archivos:** `public/manifest.json`, nuevo `public/sw.js`, `src/ui/mobile.ts`

#### 6.4 Push notifications
- Web Push API con VAPID keys en backend
- Notificaciones para: plan approval needed, permission request, mission completed
- Quick-reply directo desde notificación (Approve/Deny)
- **Archivos:** nuevo `server/push_notifications.py`, `src/serviceWorker.ts`

---

### SPRINT 7 — Social + Gamification (sem 15–16)
> *Lo que hace que AgentCraft sea memorable, no solo funcional.*

#### 7.1 Alliance Hall (Multiplayer)
- Servidor de rooms con WebSocket multipeer (`server/alliance_hall.py`)
- Crear/unirse a sala compartida por código
- Ver agentes remotos de otros desarrolladores en el propio mapa
- Notice Board compartido para coordinar
- **Archivos:** nuevo `server/alliance_hall.py`, nuevo `src/ui/allianceHall.ts`

#### 7.2 Skill Scrolls
- Objetos coleccionables en el mapa (hexes especiales)
- Al recogerse, instalan habilidades reales del agente (skills.sh equivalente)
- Inventario de scrolls en side panel
- **Archivos:** nuevo `src/skillScrolls.ts`, `src/game.ts`, `server/skills.py`

#### 7.3 Sistema de Achievements
- Definir 20+ logros con tiers (bronce/plata/oro)
- Ejemplos: "First Mission", "100 Commands Dispatched", "Policy Blocked", "Full Context"
- Tarjetas de trophy compartibles (generadas como imagen via Canvas)
- **Archivos:** nuevo `src/achievements.ts`, nuevo `server/achievements.py`

#### 7.4 Telegram / Discord channels
- Bot de Telegram y webhook de Discord para recibir notificaciones
- Respuesta rápida: aprobar plan, dar permiso, enviar mensaje a agente
- **Archivos:** nuevo `server/channels/telegram.py`, nuevo `server/channels/discord.py`

---

### SPRINT 8 — Distribución y onboarding (sem 17–18)
> *AgentCraft se instala en segundos. RepoCiv debe lograr lo mismo.*

#### 8.1 npx / CLI installer
- Empaquetar como paquete npm publicable (`@repociv/cli`)
- `npx @repociv/cli` detecta agentes CLIs instalados, instala hooks, arranca servidor, abre browser
- Setup guiado interactivo
- **Archivos:** nuevo `cli/index.ts`, `package.json`

#### 8.2 Site de documentación
- Usar Docusaurus o VitePress para site docs público
- Secciones: Getting Started, Integrations, Features, CLI Reference
- Deploy automático a GitHub Pages / Cloudflare Pages
- **Archivos:** nuevo `docs-site/`

#### 8.3 Voice Input
- Web Speech API en composer con auto-send en silencio
- Indicador visual de grabación
- Fallback graceful en browsers sin soporte
- **Archivos:** `src/ui/chat.ts`, nuevo `src/voiceInput.ts`

---

## Deuda Técnica Prioritaria (paralelo a todos los sprints)

Estos ítems del audit de 2026-04-28 deben resolverse cuanto antes:

| # | Issue | Impacto | Archivo |
|---|---|---|---|
| D1 | UNIT_TYPE_COLOR duplica UNIT_COLORS | Mantenibilidad | `src/game.ts`, `src/types.ts` |
| D2 | `tileKey()` duplicada en 2 archivos | Bug potencial | `src/types.ts`, `src/renderer.ts` |
| D3 | `HEX_SIZE_LOCAL` unused | Dead code | `src/renderer.ts:749` |
| D4 | `spawnCounters` (TS) vs `_lexo_counter` (Python) divergen | IDs inconsistentes | `server/bridge.py`, `src/game.ts` |
| D5 | Camera en `hex.ts` mutada desde `renderer.ts` | Acoplamiento | `src/hex.ts`, `src/renderer.ts` |
| D6 | `updateUnits` ignora `_dt` real | Animación desync | `src/game.ts` |
| D7 | CORS * sin auth (revisar) | Seguridad | `server/bridge.py` |
| D8 | PENDING_TRACKER parser solo detecta `- [ ]` | Parser frágil | `server/bridge.py` |

---

## Fortalezas de RepoCiv que NO tiene AgentCraft

> Estas son ventajas competitivas que hay que **mantener y profundizar**, no reemplazar.

1. **Policy engine sofisticado** — capability model granular (DAVI > LEXO > WORKER > SCOUT). AgentCraft no tiene esto.
2. **Directive learner** — aprendizaje de patrones gesture→outcome sin ML pesado. Único.
3. **Priority matrix scheduler** — urgency-driven vs FIFO. Más inteligente.
4. **Reconciliation layer** — detección de drift entre event_store, sessions, run_state. AgentCraft no publica esto.
5. **Tech debt scanner** — scan de repos integrado con priorización. Valioso para devs.
6. **GPU monitoring** — VRAM + temp vía nvidia-smi. Relevante para ML devs.
7. **XCOM fatigue system** — gestión de fatiga de agentes. Feature diferenciador.
8. **Local map (RimWorld mode)** — vista local por ciudad. Más granularidad.

---

## Métricas de Éxito

| Métrica | Hoy | Target |
|---|---|---|
| Test coverage (TS) | 0% | ≥ 80% |
| Test coverage (Python) | ~30% (archivos test existen) | ≥ 80% |
| Time to first hero (TTFH) | ~5min (manual) | < 60s (`npx`) |
| Agentes CLI soportados | 1 (OPENCLAW passive) | 4 (Claude Code, OpenCode, Cursor, OpenClaw) |
| Real-time transport | SSE | WebSocket |
| Mobile-ready | No | Sí (PWA) |
| Multiplayer | No | Sí (Alliance Hall) |
| Renderer | Canvas 2D | Three.js 3D |

---

## Resumen Ejecutivo

RepoCiv tiene una base técnica **más sofisticada que AgentCraft** en el backend (policy engine, reconciliation, directive learner, fatigue), pero carece de:

1. **Onboarding de cero fricción** (el `npx` de AgentCraft es imbatible)
2. **Integración real con CLIs de agentes externos** (Claude Code, OpenCode, Cursor)
3. **Renderer 3D** y experiencia visual más rica
4. **Producción-readiness**: contenedores, acceso remoto, mobile PWA
5. **Communidad y social**: Alliance Hall, achievements, skins

**Los sprints 1–3 son la base técnica que hace todo lo demás posible.**  
**Los sprints 4–5 son la paridad visual y UX con AgentCraft.**  
**Los sprints 6–8 son los features que llevan RepoCiv más allá de AgentCraft.**
