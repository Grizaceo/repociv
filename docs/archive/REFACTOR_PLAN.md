# RepoCiv — Refactor Plan (delegable)

> **Audiencia:** otro agente IA (Sonnet/Haiku) que ejecutará estos refactors **estéticos / estructurales** sin tocar features ni runtime crítico. Cristóbal reserva la cuota de Opus para core.

> **Reglas globales:**
> 1. Cada item es **una PR/commit independiente**. No mezclar.
> 2. Después de cada cambio: `npx tsc --noEmit` + `npm test` deben pasar (37 tests).
> 3. **No** introducir nuevas features, no cambiar comportamiento observable, no cambiar contratos de eventos `BridgeEvent`.
> 4. Conservar paridad visual exacta — si cambia un pixel, vuelve atrás.
> 5. Asume `.env`, Valibot validation, roster de agentes y chat input ya están en `main`. No los toques.

---

## Item R1 — Split `renderer.ts` (798 LOC → 3 archivos)

**Problema.** `src/renderer.ts` es God Class: maneja input, cámara, hex drawing, unit drawing, city labels, minimap, ticks de animación. 798 LOC.

**Objetivo.** Tres responsabilidades, tres archivos:
- `renderer.ts` (~250 LOC) → orquestador: ciclo `render()`, input handlers, owns `Camera`.
- `hexRenderer.ts` (~250 LOC) → `drawTile`, `fillHex`, `drawHexOutline`, `drawCityTerritory`, `drawCityLabel`.
- `unitRenderer.ts` (~150 LOC) → `drawUnit`, sprites, paths animados.
- `minimapRenderer.ts` (~150 LOC) → `drawMinimap`, `minimapClick`, viewport box.

**Pasos.**
1. Crear `hexRenderer.ts`. Mover métodos `drawTile`, `fillHex`, `drawHexOutline`, `drawCityTerritory`, `drawCityLabel` (líneas 292–~520 aprox). Recibe `ctx`, `cam`, `world` por constructor o por arg. Mantener firmas idénticas.
2. Crear `unitRenderer.ts`. Mover `drawUnit` (~250 LOC bloque, buscar `private drawUnit`). Misma estrategia.
3. Crear `minimapRenderer.ts`. Mover `drawMinimap` y `minimapClick`. Atención: `minimapClick` muta `this.cam` → recibir setter `(cam: Camera) => void`.
4. En `renderer.ts`: instanciar las 3 clases en `start()`, llamarlas desde `render()`.
5. Borrar `worldToViewport` muerto (línea 791) — único TS warning actual.

**Criterio de aceptación.**
- `npx tsc --noEmit` sin warnings.
- `npm test` pasa.
- Screenshot F12 antes/después idéntico (Cristóbal puede comparar).
- Hover, click, drag, zoom, minimap funcionan igual.

**Riesgo.** Medio. La cámara se muta desde minimap → cuidado con referencias.

---

## Item R2 — Extraer `camera.ts`

**Problema.** Tipo `Camera` vive en `hex.ts` pero la lógica de mutación (drag, zoom, minimap-jump) está esparcida en `renderer.ts`. Sin módulo dueño.

**Objetivo.** `src/camera.ts` con clase `Camera` que encapsula `{x, y, cx, cy, zoom}` + métodos `pan(dx,dy)`, `zoomAt(factor, sx, sy)`, `centerOn(axial)`, `worldToScreen`, `screenToWorld`.

**Pasos.**
1. Crear `src/camera.ts`. Copiar interfaz desde `hex.ts`, expandir a clase.
2. Mover funciones `worldToScreen`/`screenToWorld` desde `hex.ts` (verificar nombres reales).
3. `renderer.ts` ahora hace `this.camera = new Camera()` en vez de `this.cam = {...}`.
4. Tras R1 + R2, eliminar definición de `Camera` en `hex.ts`.

**Criterio.** Lo mismo de R1. **Hacer R1 antes de R2** o se pelean los diffs.

**Riesgo.** Bajo si R1 ya está hecho.

---

## Item R3 — Split `ui.ts` (432 LOC → 4 archivos)

**Problema.** `ui.ts` tiene HUD + chat + git/files + quest board + tooltip + keyboard help mezclados. Cristóbal dijo **no tocar hasta 800 LOC**, pero ya estamos a ~432 con el chat input nuevo. Hacerlo ahora es preventivo.

**Objetivo.** `src/ui/` carpeta con:
- `ui/hud.ts` — `showLoadingProgress`, `hideLoadingScreen`, `updateResource`, `setBridgeStatus`, `updateGpuBar`, `setOperationTicker`, `logEvent`.
- `ui/panel.ts` — `showUnitPanel`, `hideUnitPanel`, `renderHeroBar`, `unitModelLabel`, `unitStateColor`.
- `ui/chat.ts` — `openSidePanel`, `closeSidePanel`, `isSidePanelOpen`, `appendChatChunk`, `appendUserMessage`, `clearChat`, `wireSideTabs`, `loadGitInfo`, `loadFilesInfo`. Mover el state local (`activeChatUnit`, `chatBuffers`).
- `ui/quest.ts` — `openQuestBoard`, `closeQuestBoard`, `isQuestBoardOpen`, `fetchPendingTracker`, `fetchPersistedMissions`, `renderQuestBoard`, `wireQuestBoardTabs`.
- `ui/keyboard.ts` — `toggleKeyboardHelp`, `showTooltip`, `hideTooltip`, `escapeHtml`.
- `ui/index.ts` — barrel re-export para no romper imports en `main.ts` y `bridge.ts`.

**Pasos.**
1. Crear `src/ui/index.ts` que reexporte todo lo actual de `ui.ts`. Confirmar build.
2. Crear `ui/hud.ts`, mover funciones, importar lo necesario, reexportar desde index.
3. Repetir por archivo. Borrar `src/ui.ts` al final.
4. **No** cambiar firmas. **No** convertir a clases.

**Criterio.** `npx tsc --noEmit` y `npm test` pasan. Cero cambios en `main.ts` (sigue importando desde `'./ui.ts'` → ahora `'./ui/index.ts'`, o crear alias `./ui`).

**Riesgo.** Bajo. Es mover código sin transformarlo.

---

## Item R4 — Modularizar `styles.css` (1156 LOC → carpeta)

**Problema.** Un solo archivo CSS de 1156 LOC.

**Objetivo.** `src/styles/` con:
- `tokens.css` — `:root` custom properties, `@import` de fuentes.
- `reset.css` — reset y base.
- `hud.css` — top bar, hero bar, bridge status, gpu bar, event log.
- `panels.css` — unit panel, side panel, quest board, keyboard help.
- `inputs.css` — `mission-input`, `chat-input`, botones.
- `minimap.css` — minimapa, tooltip.
- `loading.css` — loading screen.
- `index.css` — `@import` de todo en orden.

**Pasos.**
1. Crear `src/styles/index.css` que `@import` el `styles.css` actual. Ajustar `import './styles.css'` en `main.ts` → `import './styles/index.css'`. Verificar nada cambió.
2. Cortar por secciones (ya existen comentarios `/* ─── X ─── */` que delimitan bloques). Una sección a la vez, build, comparar visualmente.
3. Borrar `styles.css` al final.

**Criterio.** Cero diff visual.

**Riesgo.** Bajo, es split mecánico.

---

## Item R5 — Unificar `SKIP_DIRS`

**Problema.** Lista repetida en `vite.config.ts` y (probablemente) `bridge.py`. Divergen con el tiempo.

**Objetivo.** Una sola fuente.

**Pasos.**
1. Crear `shared/skip-dirs.json` en raíz del repo:
   ```json
   ["node_modules", ".git", "dist", "build", "target", ".next",
    "__pycache__", ".venv", "venv", ".pytest_cache", ".cache",
    "checkpoints", ".turbo", ".parcel-cache"]
   ```
2. `vite.config.ts`: `import skipDirs from './shared/skip-dirs.json' assert { type: 'json' };` → `const SKIP_DIRS = new Set(skipDirs);`
3. `bridge.py`: `SKIP_DIRS = set(json.loads(Path("shared/skip-dirs.json").read_text()))` (si bridge.py escanea — verificar; si no escanea dirs aún, **omitir paso 3**).

**Criterio.** Tests pasan, scan de repos devuelve los mismos 24.

**Riesgo.** Bajo.

---

## Item R6 — Mover `bridge.py` → `server/bridge.py`

**Problema.** `bridge.py` en raíz mezclado con frontend.

**Objetivo.** Carpeta `server/` con `bridge.py` y futuro código Python.

**Pasos.**
1. `mkdir server && git mv bridge.py server/bridge.py`.
2. Ajustar `_load_dotenv()` para buscar `.env` en `Path(__file__).parent.parent / ".env"` (el `.env` queda en raíz).
3. README/docs si existe que mencionen `python3 bridge.py` → `python3 server/bridge.py`.
4. Buscar referencias en `package.json` scripts, en `vite.config.ts` (no debería haber), en `docs/`.

**Criterio.** `python3 server/bridge.py` arranca, responde `/health`, recibe `unit_command`.

**Riesgo.** Bajo.

---

## Item R7 — Limpiar dead code (SOBRA)

**Problema.** Pequeñas piezas muertas.

**Pasos.**
1. `renderer.ts:791` → eliminar `worldToViewport` (TS6133 unused).
2. `renderer.ts:749` → eliminar constante `HEX_SIZE_LOCAL` muerta (verificar referencias antes).
3. `main.ts:282` `spawnCounters` vs `bridge.py:_lexo_counter`: ambos generan IDs de unidades en paralelo y divergen. **Decisión de diseño (no es solo cleanup):** backend debe ser único generador de IDs. Pero esto requiere que `unit_spawn` desde frontend pase por bridge primero — cambio de flujo. **MARCAR COMO ITEM CORE, NO REFACTOR.** No tocar en este sprint estético.

**Criterio.** Solo (1) y (2). `npx tsc --noEmit` clean.

**Riesgo.** Trivial.

---

## Item R8 — Offline mode honesto

**Problema.** `bridge.py` en `_run_hermes_streaming` cuando falla retorna `success=True` con un mensaje "[Bridge offline mode]". Mentira: parece misión completada.

**Objetivo.** Cambiar el return final del except a `return False, msg` y agregar campo `simulated: true` en el `mission_record` que se persiste.

**Pasos.**
1. `bridge.py` → en el `except Exception as e:` del `_run_hermes_streaming`, cambiar `return True, msg` → `return False, msg`.
2. En `mission_record`, antes de `save_mission` final, si `simulated`: `mission_record["simulated"] = True`.
3. Frontend `Mission` type (`game.ts`) → opcional `simulated?: boolean`. Quest board renderer puede mostrar badge "🎭 sim" si está marcado.

**Criterio.** Si Hermes API + openclaw están off, la misión aparece como "fallida" o "simulada", no como "completada".

**Riesgo.** Bajo. **Este item está al borde del refactor estético** — confirmar con Cristóbal antes de mergear porque cambia comportamiento observable.

---

## Items NO incluidos (son CORE, requieren Opus)

Estos los hace Cristóbal con agente Opus, **no aquí**:
- Pathfinding A* sin colisiones (cruza unidades) → diseño de juego.
- `updateUnits(_dt)` frame-dependent → cambio de loop, podría romper animaciones.
- Memory leak `chatBuffers` sin perfilar → necesita medición primero.
- WebSocket bridge.
- CLICK TILE → ficha ciudad estilo Civ V (feature).
- Border expansion / territorio.
- Wonders Laboratory + Great Library.
- Event sourcing jsonl + replay.
- Backend genera unit IDs (cambia contrato).

---

## Orden sugerido para el agente

```
R7 (trivial, calienta motor)
R5 (unificar SKIP_DIRS)
R4 (CSS split, sin riesgo)
R6 (mover bridge.py)
R3 (ui.ts split)
R2 (camera.ts) — requiere R1
R1 (renderer.ts split) ← el más grande, dejarlo para cuando esté en ritmo
R8 (offline honesto) — confirmar con Cristóbal antes
```

Total: ~5–8 commits. Sin tocar features. Sin tocar contratos de eventos. Sin tocar tests existentes.
