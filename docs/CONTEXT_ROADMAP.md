# RepoCiv — Contexto y Roadmap Persistente

> Fecha: 2026-04-28
> Estado: post-auditoría end-to-end por DAVI. Beta funcional, deudas técnicas de mantenibilidad.
> Sesión anterior: revisión de punta a punta (src/, bridge.py, vite.config.ts, renderer, game state).

---

## 1. Qué es RepoCiv (una línea)

Dashboard hexagonal Civ-V-like que visualiza `~/.hermes/workspace/repos/` como ciudades, agentes (DAVI, LexO, Workers) como unidades, y procesos en ejecución como edificios en construcción. Corre local en RTX 4060. Stack: TypeScript + Vite (frontend), Python HTTP bridge (backend), Canvas 2D renderer.

---

## 2. Estado Post-Auditoría (DAVI, 2026-04-28)

**Veredicto:** Beta funcional. El loop principal (mapa → unidades → bridge → UI) funciona. Los problemas son de **mantenibilidad y robustez**, no de funcionalidad.

**Funciona:**
- Generación de mundo desde repos reales (terrain por extensión de archivo).
- A* con cache por unitType (eficiente, <=300 hexes).
- Bridge.py: backoff exponencial, demo mode fallback, GPU monitoring, LexO detection.
- Hotkeys, selección de unidades, minimap clickeable, barra de recursos.
- Screenshot (F12), Quest Board (F9), side panel con git/files.

**No funciona / riesgo:**
- `bridge.py` fallback "offline mode" retorna `success=True` cuando NO hizo nada. Miente al Quest Board.
- `updateUnits(_dt)` ignora el delta time. Si el tab pierde foco, la animación se desfasa.
- Sin validación de eventos: `bridge.ts` hace `data as BridgeEvent`. Un campo nuevo rompe todo en silencio.
- CORS `*` en bridge.py sin auth. Si expone el puerto fuera de localhost es inseguro.
- Parser de `PENDING_TRACKER.md` es naive: solo detecta `- [ ]`, no `- [x]` ni otros formatos.
- Memory leak potencial en renderer loop (no perfilado, pero canvas state por frame no es free).
- Tests = 0. Vitest declarado, cero archivos `.test.ts`.

---

## 3. Auditoría en 3 Buckets (SOBRA / MERGE / FALTA)

### SOBRA — limpiar
1. `UNIT_TYPE_COLOR` en `game.ts` duplica `UNIT_COLORS` en `types.ts`. → Consolidar en `types.ts`.
2. `tileKey()` vive en `types.ts` y `renderer.ts`. → El de renderer debe importarse.
3. `HEX_SIZE_LOCAL` en `renderer.ts:749` — variable declarada pero no usada. Código muerto.
4. `spawnCounters` (TS) y `_lexo_counter` (Python) son contadores paralelos que pueden divergir. → Backend genera ID único.

### MERGE — consolidar
1. `ui.ts` es monolito (maneja DOM, chat, quest board, side panel, keyboard). Si supera 800 líneas, partir en `ui/{panel,chat,quest,keyboard}.ts`.
2. `styles.css` tiene 1122 líneas / 30KB sin CSS modules. Al menos documentar secciones, considerar CSS-in-TS o split por componente.
3. `Camera` vive en `hex.ts` pero `renderer.ts` muta `this.cam` directamente. Centralizar en módulo `camera.ts`.
4. `SKIP_DIRS` repetido en `vite.config.ts` y `bridge.py`. → Unificar o al menos sincronizar.

### FALTA — instalar / arreglar
| Prioridad | Ítem | Archivos afectados |
|---|---|---|
| CRÍTICO | Validar eventos bridge con zod/valibot antes de `handleBridgeEvent` | `bridge.ts`, `types.ts` |
| CRÍTICO | Sacar config hardcodeada (ports 5273/5274, modelo "mimo-v2.5-pro", paths `~/.hermes`) a `.env` o `config.json` | `bridge.py`, `vite.config.ts`, `bridge.ts` |
| ALTO | Escribir 3 tests puros (hex math, pathfinding A*, game state spawn/move) | nuevo: `src/*.test.ts` |
| ALTO | Restringir bridge.py a localhost o añadir token de auth | `bridge.py` |
| MEDIO | Usar `_dt` real en `updateUnits` en vez de 0.04 hardcode | `game.ts` |
| MEDIO | Event sourcing: guardar todos los `BridgeEvent` en `events/YYYY-MM-DD.jsonl` para replay y debug | nuevo: `src/eventStore.ts` |
| MEDIO | Parser robusto de `PENDING_TRACKER.md` (soportar `[x]`, `*`, etc.) | `bridge.py` |
| BAJO | README raíz con `npm run dev` + `python3 bridge.py` + screenshot | nuevo: `README.md` |

---

## 4. Decisiones de Cristóbal (actualizadas 2026-04-28)

1. **b)** Prioridad VISUAL: levantar RepoCiv y ver cómo se ve en su monitor. → **HECHO** (auditoría completada, siguiente paso es aplicar fixes).
2. **Prioridad absoluta:** bridge.py conectado a DAVI real. → **PENDIENTE**. Necesita que el agente que lee esto revise si `openclaw` está en PATH o configurar `HERMES_URL` + `HERMES_KEY`.
3. Gran Biblioteca: LexO (IndexO) vs Obsidian, diferenciadas, sin choque. → **FASE 4** (Junio+), no ahora.
4. Trade Routes, City-States, Notifications Queue, Turn-based overlay → **FASE 3** (post-Mayo), no ahora.
5. **NUEVO:** Quiere aplicar fixes "fix-and-rerun", no análisis largo. Espera opciones puntuales (a/b/c/d) y elige sin discusión.

---

## 5. Roadmap Ajustado

### FASE 1: "Lo veo correr y no se cae" (esta semana)
- [ ] Fix SOBRA #1 y #2 (limpieza de duplicados) → 10 min.
- [ ] Fix FALTA CRÍTICO #2 (config hardcode → `.env`) → 20 min.
- [ ] Fix FALTA CRÍTICO #1 (validación eventos con zod/valibot) → 30 min.
- [ ] Fix FALTA ALTO #3 (3 tests puros: hex, pathfinding, game state) → 40 min.
- [ ] Smoke test: `npm run dev` + `python3 bridge.py` /health OK + screenshot.

### FASE 2: "Bridge conectado a DAVI real" (próxima semana)
- [ ] Verificar `openclaw` en PATH o configurar variables `HERMES_URL`, `HERMES_KEY`, `HERMES_MODEL`.
- [ ] Integrar Pending Tracker como Quest Board real (no parser naive).
- [ ] Screenshot diario exportable.

### FASE 3: "Multi-agent + mecánicas" (post-SAIR Stage 2, post-Mayo)
- [ ] LexO como unidad separada.
- [ ] Worker como unidad batch (protein-lab).
- [ ] Trade Routes entre repos.
- [ ] Laboratory wonder (protein-lab integration).

### FASE 4: "Memoria institucional" (Junio+)
- [ ] Event sourcing + replay diario.
- [ ] Great Library (Obsidian + LexO diferenciadas, con búsqueda semántica Hindsight).
- [ ] Demographics / victory conditions panel.
- [ ] Civ V SDK inspection para mecánicas de AI/turnos.

---

## 6. Checksum / Context Anchor

Para evitar que una nueva sesión repita la auditoría completa:

- **Revisar SOBRA/MERGE/FALTA antes de preguntar "qué falta".**
- **Próximo paso concreto:** aplicar los 4 items de FASE 1 en orden.
- **Si bridge.py no conecta:** revisar `openclaw` en PATH primero. Si no existe, usar fallback Hermes API con variables de entorno.
- **No preguntar por decisiones ya tomadas** (ver Sección 4). Cristóbal ya eligió.

---

## 7. Estructura de Archivos Clave (para navegación rápida)

```
repociv/
├── src/
│   ├── main.ts           # Bootstrap, HUD wiring, hotkeys
│   ├── types.ts          # Tipos, UNIT_COLORS, tileKey
│   ├── hex.ts            # Axial math, Camera, spiralCoords
│   ├── map.ts            # generateWorld(), inferTerrain(), fetchSubdirs
│   ├── renderer.ts       # Canvas 2D draw loop, minimap
│   ├── game.ts           # GameState, updateUnits, updateBuildings
│   ├── pathfinding.ts    # A* + cache
│   ├── bridge.ts         # BridgeEvents, health check, demo mode
│   └── ui.ts             # DOM helpers (probable monolito)
├── bridge.py             # HTTP bridge, agent execution, GPU, process scan
├── vite.config.ts        # Plugin custom con /api/repos, /api/git, etc.
├── docs/
│   └── CONTEXT_ROADMAP.md  # Este archivo
└── package.json          # Dependencias: typescript, vite, vitest (0 tests)
```

---

*Última actualización: 2026-04-28 por DAVI. Si lees esto en una nueva sesión, empezar desde FASE 1.*
