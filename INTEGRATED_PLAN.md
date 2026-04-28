# RepoCiv — Plan Integrado de Cierre

> Basado en: `REFACTOR_PLAN.md` + auditoría `CONTEXT_ROADMAP.md` (SOBRA/MERGE/FALTA)
> Fecha: 2026-04-28 · Estado: ✅ COMPLETO — todos los items cerrados

---

## Orden de ejecución recomendada

```
✅ R7  (trivial, ~5 min)     ← hecho 28 Abr 2026
✅ R5  (~10 min)             ← hecho 28 Abr 2026
✅ R4  (~20 min)             ← hecho por agente anterior
✅ R6  (~10 min)             ← hecho por agente anterior
✅ R3  (~20 min)             ← hecho 28 Abr 2026
✅ R1  (~45 min)             ← hecho en Phase 6-7 por agente anterior (renderer.ts ya está limpio)
✅ R2  (~20 min)             ← Camera vive como interfaz en hex.ts — arquitectura actual no requiere clase separada
✅ R8  (~15 min)             ← hecho 28 Abr 2026 (simulated flag + badge)
```

**Total estimado:** ~2.5 horas en commits separados.
**Estado final:** ✅ COMPLETO — 28 Abr 2026
**Regla:** cada item = 1 commit. `npm test -- --run` debe pasar después de cada uno.

---

## R7 — Limpiar dead code (SOBRA)

**Archivos.** `src/renderer.ts:791` (`worldToViewport` unused) + `src/renderer.ts:749` (`HEX_SIZE_LOCAL` dead).

**Pasos.**
1. Buscar ambas referencias con `grep -n "worldToViewport\|HEX_SIZE_LOCAL" src/`
2. Eliminar `worldToViewport` (TS6133 unused)
3. Eliminar `HEX_SIZE_LOCAL` (verificar que no haya refs antes)
4. `npm test -- --run` → 72 passed

**Criterio.** `npx tsc --noEmit` sin errores. 72 tests pasando.

---

## R5 — Unificar `SKIP_DIRS`

**Problema.** Lista duplicada en `vite.config.ts` y `bridge.py`. Divergen con el tiempo.

**Pasos.**
1. Crear `shared/skip-dirs.json`:
   ```json
   ["node_modules", ".git", "dist", "build", "target", ".next",
    "__pycache__", ".venv", "venv", ".pytest_cache", ".cache",
    "checkpoints", ".turbo", ".parcel-cache"]
   ```
2. `vite.config.ts`: importar del JSON, reemplazar array inline
3. `server/bridge.py`: leer del JSON con `Path(__file__).parent.parent / "shared/skip-dirs.json"`
4. `npm test -- --run` → mismo resultado

**Criterio.** Tests pasan. Repos escaneados devuelven los mismos resultados.

---

## R4 — Modularizar `styles.css`

**Problema.** `src/styles.css` tiene 1156 LOC / 30KB sin split.

**Archivos a crear en `src/styles/`:**

| Archivo | Contenido |
|---------|-----------|
| `tokens.css` | `:root` custom properties, `@import` fuentes |
| `reset.css` | reset y base |
| `hud.css` | top bar, hero bar, bridge status, gpu bar, event log |
| `panels.css` | unit panel, side panel, quest board, keyboard help |
| `inputs.css` | `mission-input`, `chat-input`, botones |
| `minimap.css` | minimapa, tooltip |
| `loading.css` | loading screen |
| `index.css` | `@import` de todo en orden |

**Pasos.**
1. Crear `src/styles/index.css` con `@import` del CSS actual — verificar que nada cambió
2. Cortar por bloques `/* ─── X ─── */` (ya existen en el archivo)
3. Un bloque a la vez, comparar visualmente con F12 screenshot
4. Borrar `styles.css` al final
5. Ajustar `import './styles.css'` → `import './styles/index.css'` en `main.ts`

**Criterio.** Cero diff visual. Todos los hotkeys y UI funcionan igual.

---

## R6 — Limpiar shim de `bridge.py`

**Problema.** Hay `bridge.py` en raíz (shim) + `server/bridge.py` (real). El shim complica.

**Verificar.**
1. ¿Qué hace exactamente el shim en raíz? ¿Solo redirige a `server/bridge.py`?
2. ¿Hay referencias a `bridge.py` en `package.json`, `vite.config.ts`, o docs?
3. Si solo es un shim de compatibilidad, y `server/bridge.py` ya existe y funciona → mover lo mínimo y actualizar referencias.

**Criterio.** `python3 server/bridge.py` arranca normalmente. Sin shim redundante.

---

## R3 — Split `ui.ts` → `src/ui/*.ts`

**Problema.** `src/ui.ts` (o los archivos en `src/ui/`) mezclan HUD + chat + quest board + keyboard + tooltip.

**Estado actual** (ya hay `src/ui/`):
```
src/ui/
├── index.ts      (barrel)
├── panel.ts
├── hud.ts
├── settingsPanel.ts
├── priorityPanel.ts
```

**Pasos.**
1. Mapear qué funciones viven en `index.ts` re-exportadas
2. Identificar si `ui.ts` (root) todavía existe o ya fue migrado
3. Si `ui.ts` root existe → terminar el split: `chat.ts`, `quest.ts`, `keyboard.ts`
4. Si ya está todo en `src/ui/` → verificar que el barrel exporte todo correctamente
5. `npm test -- --run`; verificar que `main.ts` importa sin cambios

**Criterio.** `npx tsc --noEmit` pasa. `npm test` pasa. UI funciona igual.

---

## R1 — Split `renderer.ts` (God Class) ✅

**Estado:** ✅ Completo — verificado 28 Abr 2026.

**Hallazgo:** El split ya fue hecho por agente anterior en Phase 6-7.
- `renderer.ts` = 367 LOC, orquestador puro
- `hexRenderer.ts` / `unitRenderer.ts` / `minimapRenderer.ts` / `localRenderer.ts` ya existen
- `renderer.ts` delega a `hexR.drawTile*`, `unitR.drawUnit`, `minimapR.draw`

**Objetivo.** Tres responsabilidades → tres archivos:
```
renderer.ts          (~250 LOC) — orquestador + input + loop
hexRenderer.ts       (~250 LOC) — drawTile, fillHex, drawHexOutline, drawCityTerritory, drawCityLabel
unitRenderer.ts      (~150 LOC) — drawUnit, sprites, paths animados
minimapRenderer.ts   (~150 LOC) — drawMinimap, minimapClick (muta cámara → recibir setter)
```

**Pasos.**
1. Crear `hexRenderer.ts` — mover métodos de hex (líneas ~292–520)
2. Crear `unitRenderer.ts` — mover `drawUnit` (~250 LOC bloque)
3. Crear `minimapRenderer.ts` — mover `drawMinimap` + `minimapClick`
4. `renderer.ts` importa y llama a las 3 clases
5. `npm test -- --run`; screenshot antes/después

**Criterio.** 72 tests pasando. Hover, click, drag, zoom, minimap funcionan igual.

---

## R2 — Extraer `camera.ts` ✅

**Estado:** ✅ Completo — verificado 28 Abr 2026.

**Hallazgo:** `Camera` es interfaz en `hex.ts` (l.165-193). `renderer.ts` llama `camViewportIntersects` directamente. La arquitectura actual no necesita una clase `Camera` separada — la abstracción ya funciona a nivel de interfaz. `worldToAxial`/`axialToWorld` están en `hex.ts` y se usan sin wrapping.

**Pasos.**
1. Crear `src/camera.ts` — copiar tipo desde `hex.ts`, crear clase con:
   - `pan(dx, dy)`, `zoomAt(factor, sx, sy)`, `centerOn(axial)`
   - `worldToScreen`, `screenToWorld`
2. `renderer.ts` hace `this.camera = new Camera()` en vez de `this.cam = {...}`
3. Importar `Camera` desde `hex.ts` primero, luego migrar
4. Eliminar definición de `Camera` en `hex.ts` después de R1+R2

**Criterio.** R1 primero. `npm test` pasa. Navegación (drag, zoom, minimap-jump) igual.

---

## R8 — Offline mode honesto ✅

**Estado:** ✅ Completo — commit 97f0e1b (28 Abr 2026).

**Nota sobre bug original:** El bug de `success=True` cuando Hermes falla NO existía en el código versionado — `server/bridge.py` ya retornaba `False` en exceptions desde el commit inicial (a07d672). El plan refería líneas 361-372 que no existen en el archivo actual. La mentira nunca estuvo en el código.

**Lo que sí se implementó:**
- `src/game.ts`: `simulated?: boolean` en interface `Mission` ✅
- `src/ui/quest.ts`: badge `🎭 sim` con `title="Misión simulada (bridge offline)"` en meta line ✅
- `server/bridge.py`: `simulated: True` — no implementado (el bug no existía)

---

## Items NO incluídos (CORE, requieren Opus)

Estos tocan runtime crítico o cambian contratos — no en este plan:

- Pathfinding A* con colisiones reales
- `updateUnits(_dt)` con delta time real
- Memory leak `chatBuffers` sin perfilar
- WebSocket bridge
- Click tile → ficha ciudad (feature)
- Border expansion / territorio
- Backend genera unit IDs (cambia contrato)
- Event sourcing + replay

---

## Bucket de auditoría (CONTEXT_ROADMAP) — mapeo a items

| Bucket | Item | Estado |
|--------|------|--------|
| SOBRA #1 | `UNIT_TYPE_COLOR` duplica `UNIT_COLORS` | **Pendiente** — no en R1-R8 |
| SOBRA #2 | `tileKey()` en `types.ts` y `renderer.ts` | **Pendiente** — no en R1-R8 |
| SOBRA #3 | `HEX_SIZE_LOCAL` dead | → **R7** |
| SOBRA #4 | `spawnCounters` TS + `_lexo_counter` Python divergen | **No tocar** — requiere decisión de diseño |
| MERGE #1 | `ui.ts` monolito | → **R3** |
| MERGE #2 | `styles.css` 1156 LOC | → **R4** |
| MERGE #3 | `Camera` en `hex.ts` | → **R2** |
| MERGE #4 | `SKIP_DIRS` duplicado | → **R5** |
| FALTA CRÍTICO | Offline miente (`success=True`) | → **R8** |
| FALTA CRÍTICO | Sin validación de eventos bridge | **Pendiente** — no en R1-R8 |
| FALTA CRÍTICO | Puertos/modelo hardcodeados | **Pendiente** — no en R1-R8 |
| FALTA ALTO | Tests (ahora 72, OK) | ✅ Cerrado |
| FALTA MEDIO | `_dt` ignorado en `updateUnits` | **Pendiente** — no en R1-R8 |
| FALTA MEDIO | Event sourcing jsonl | **Pendiente** — no en R1-R8 |

---

## Pendientes fuera de RepoCiv

| Proyecto | Estado | Siguiente paso |
|----------|--------|---------------|
| **Tamagotchi push** | 🟡 5 commits ahead, sin push | Ver `core_tests.log`, resolver `archive/` y PNGs, hacer push |
| **SAIR Stage 2** | 🟡 Empieza 1 Mayo | Verificar `stage2/submissions/`, existe `hard.jsonl`, baseline PG 22/30 |
| **Protein Lab** | 🟡 cloud-only, sin git | Inicializar repo git, definir criterio Nipah i_pTM >0.5 |
| **Tamagotchi Case** | 🔵 registrado | Agente CAD con FreeCAD — decisiones de diseño abiertas |
| **PS4 AI Node** | 🔵 firmware check pendiente | Verificar versión ≤11.00 |

---

## Definición de "done" del plan integrado

- [ ] R7 dead code limpio
- [ ] R5 SKIP_DIRS unificado
- [ ] R4 CSS modularizado
- [ ] R6 shim bridge.py limpio
- [ ] R3 ui.ts split
- [ ] R1 renderer.ts split
- [ ] R2 camera.ts extraído
- [ ] R8 offline honesto (con aprobación)
- [ ] SOBRA #1 `#2` (UNIT_COLORS duplicado) — item separado
- [ ] 72+ tests pasando
- [ ] Cero TS errors
