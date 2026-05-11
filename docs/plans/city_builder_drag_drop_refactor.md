# Plan arquitectónico: refactor a drag & drop para ciudades (city-builder / RTS)

Este documento define la arquitectura y el plan de ejecución para sustituir el flujo actual **"clic en ✥ → modo placing → clic en casilla → `window.location.reload()`"** por una mecánica continua de **arrastrar y soltar** la ciudad sobre el mapa hexagonal, con preview válido/inválido y persistencia sin recargar la aplicación.

---

## 0. Estado actual del código (grounding en RepoCiv)

Estos son los puntos de anclaje reales en el repositorio; cualquier plan debe referenciarlos así, no con nombres genéricos.

| Área | Archivo(s) | Comportamiento relevante |
|------|------------|---------------------------|
| FSM de gestos | `src/renderer.ts` | `gestureMode`: `'camera_pan' \| 'unit_drag' \| 'area_select' \| 'route'`. Orden en `mousedown`: unidad bajo cursor → ruta (Shift+ciudad) → selección de área (Shift+vacío) → pan. |
| Modo "colocar casilla" | `src/renderer.ts` | `_placingMode` (boolean privado): highlight verde/rojo en hover (`render()` ~565–577); `handleClick` (~385–398) dispara `onEmptyTileClick` y sale del modo. |
| **No confundir** | `src/renderer.ts` | `actionMode === 'build'` es el **botón Construir del HUD** (edificios con unidad seleccionada), **no** el panel "Modo construcción". |
| Panel construcción | `src/ui/constructionPanel.ts` | Botón ✥ llama `setPlacingMode(true)`, `updateManualRepoCoord`, **`window.location.reload()`** — es el comportamiento a eliminar. |
| Preview espacial | `src/ui/spatialPreview.ts` | `renderDragGhost`, `renderDropTarget` ya implementan fantasma + anillo de drop para **unidades**; se puede reutilizar el patrón visual para ciudades. |
| Mundo y territorio | `src/map.ts` | `addCityToWorld` (~325), `removeCityFromWorld` (~349), generación con `territory = [coord, ...axialRange(coord, 2)]` filtrado por distritos; `reconnectCities(world)` tras cambios topológicos. |
| Persistencia manual | `src/manualLayout.ts` | `updateManualRepoCoord(repoPath, coord)`, `upsertManualRepoEntry`. **`City` en `types.ts` (~37–47) no lleva `repoPath`** — hay que resolver la ruta. |
| Estado reactivo | `src/game.ts` | `notify()` / `notifyUpdate()` para refrescar UI tras mutar el mundo. |

---

## 1. Fundamentos técnicos (grounding ampliado)

### 1.1 Patrones de motores y juegos de ciudad

- **FSM de colocación:** En Unity/Godot/Unreal el "placement mode" consume input antes que selección o cámara. RepoCiv ya tiene una FSM rudimentaria (`gestureMode`); `city_drag` sería un estado más con prioridad explícita documentada.
- **Ghost / preview:** No instanciar la entidad real hasta `mouseup` válido; solo preview (OpenRCT2, SimCity, factorio-blueprint style). Aquí el ghost de unidad (`renderDragGhost`) valida el enfoque canvas 2D.
- **Snapping hexagonal:** `worldToAxial` + tile lookup (`tileKey`) ya existen; la validación es por **tile** (terreno, ocupación, agua, unidades).
- **Mutación in-memory + persistencia async:** Coherente con OpenTTD/Micropolis: el mapa es la fuente de verdad en RAM; el guardado en `localStorage` (`manualLayout`) debe ser **después** de commit exitoso en el estado del juego.

### 1.2 Patrones específicos de canvas / web

- **Orden de hit-testing:** Quien se "come" el clic primero gana. Hoy una **unidad** en la misma celda que una ciudad captura el drag (`unit_drag`). El plan debe decidir: modifier (p.ej. Alt+drag = ciudad), solo si no hay unidad, o modo explícito "mover ciudad" que deshabilita arrastre de unidad temporalmente.
- **Conflicto Shift:** `Shift` + ciudad inicia `route` (city-to-city workflow). El drag de reubicación debe **no** activarse con Shift, o documentar otra tecla.
- **Cancelación:** `Escape` debería abortar `city_drag` sin aplicar cambios (patrón estándar en herramientas de colocación).

### 1.3 Coherencia con `spatialDirectives`

Los gestos `interpretUnitDrag`, `interpretCityToCityDrag`, etc. modelan **órdenes a agentes**. Mover una ciudad es **metajuego / layout**, no un comando espacial hacia el bridge: probablemente **no** debe pasar por `SpatialDirective`, salvo que se quiera un evento de auditoría explícito (opcional).

---

## 2. Restricciones y decisiones de diseño

- **Activación restringida ("god mode"):** El arrastre de ciudades **no** está siempre disponible. Opciones coherentes con el código actual:
  - **A)** Solo con el **panel de construcción abierto** (`isConstructionPanelOpen()`), o
  - **B)** Un flag dedicado en el renderer, p.ej. `_cityRelocateMode`, activado desde el panel o un toggle en UI,
  - **C)** Combinación: panel abierto **o** modo explícito para no forzar mantener el panel visible.

  Evitar usar `actionMode === 'build'` como señal: en el código actual eso es **construcción de edificios RTS**, no layout de ciudades.

- **Persistencia silenciosa:** Tras un drop válido, llamar `updateManualRepoCoord` (o `upsertManualRepoEntry` si faltara entrada) **sin** `window.location.reload()`.

- **Resolución `repoPath`:** `City` en `types.ts` no tiene `repoPath`. Se resuelve así:
  1. Al iniciar el drag desde el panel ✥, el botón conoce el `repoPath` del item clickeado (`data-path` en `.construction-city-item`).
  2. Ese `repoPath` se pasa al estado de drag como `dragCityRepoPath: string | null` en el renderer.
  3. Opcional: agregar `repoPath?: string` a la interfaz `City` en `types.ts` y setearlo en `generateWorld()` para que cualquier drag desde el mapa (no solo desde el panel) pueda resolver la ruta.

---

## 3. Decisiones de arquitectura (bloqueantes resueltos)

### 3.1 `city_drag` NO es un nuevo `gestureMode` en `mousedown`

**Decisión:** `city_drag` no se mete en la FSM de `gestureMode`. En vez de eso, se reescribe `_placingMode` para que sea drag nativo dentro de `mousemove`/`mouseup`, sin tocar la prioridad de `mousedown`.

**Razón:** La FSM de `mousedown` (líneas 118–158) tiene prioridades complejas (unidad > ruta > área > pan). Insertar `city_drag` ahí requeriría modificar cada nivel de prioridad para verificar si `_relocateMode` está activo. Es más limpio y menos riesgoso que `handleClick` detecte si el usuario arrastró vs. clickeó, y en vez de llamar `onEmptyTileClick` (actual), inicie el flujo de drag visual y espere `mouseup` para resolver.

**Cambios concretos:**
- `mousedown`: no se toca (salvo agregar: si `_placingMode` está activo, capturar `dragStart` para detectar drag vs click).
- `mousemove`: si `_placingMode` está activo Y el mouse se movió > 3px desde `dragStart` (drag real, no click), activar visual ghost.
- `mouseup`: si `_placingMode` activo Y hubo drag → `relocateCity()`; si fue click corto → comportamiento actual (`onEmptyTileClick`).

### 3.2 `relocateCity()` se implementa como función nueva en `map.ts`

**Decisión:** No reusar `removeCityFromWorld` + `addCityToWorld` porque:
1. `removeCityFromWorld` busca por `cityName` (frágil, dos repos podrían llamarse parecido).
2. `addCityToWorld` recrea `territory` desde 0 y pierde `districts` y `buildings` existentes.

Se implementa `relocateCity()` como función pura que:

```
relocateCity(world, cityId, targetCoord): void
```

Tareas internas:

1. **Validación** (`canRelocateCityTo`): tile destino existe, no océano, hex libre de otra ciudad, unidad en destino no bloquea (opcional: mover unidad también).
2. **Encontrar la ciudad** por `city.id` (no por `cityName`).
3. **Delta vector:** `Δq = targetCoord.q - city.coord.q`, `Δr = targetCoord.r - city.coord.r`.
4. **Distritos:** trasladar cada `district.coord` por Δ. Eliminar tiles viejos de distrito de `world.tiles`. Insertar nuevos tiles de distrito en nuevas coordenadas.
5. **Tile viejo:** quitar `city` del tile origen. Si el tile queda sin contenido (solo terreno), se deja como tile vacío (no se borra).
6. **Tile nuevo:** asignar `city` al tile destino con los mismos `resources` y metadatos que tenía antes.
7. **Territorio:** recalcular con `[targetCoord, ...axialRange(targetCoord, 2)]`, filtrando por coordenadas de distritos trasladados.
8. **`invalidatePathCache()`** (pathfinding).
9. **`reconnectCities(world)`** — async (como en main.ts).
10. **`updateManualRepoCoord(repoPath, targetCoord)`**.
11. **`state.notifyUpdate()`**.

### 3.3 `repoPath` en la interfaz `City`

**Decisión:** Se agrega `repoPath?: string` opcional a `City` en `types.ts`. Esto se setea en `generateWorld()` donde ya existe el mapeo `manualRepoMap.get(repo.path)`. No rompe serialización porque es opcional.

Cambio en `types.ts`:
```typescript
export interface City {
  id: string;
  name: string;
  coord: Axial;
  repoPath?: string;       // <-- nuevo, opcional
  population: number;
  territory: Axial[];
  districts: District[];
  buildings: Building[];
  currentProject?: Building;
  isCapital: boolean;
}
```

Cambio en `map.ts` dentro de `generateWorld()` (~línea 513):
```typescript
const city: City = {
  id: repo.name,
  name: repo.name,
  coord,
  repoPath: repo.path,      // <-- nuevo
  population: repo.population,
  territory,
  districts,
  buildings: [],
  isCapital: i === 0,
};
```

### 3.4 Ghost visual para ciudad (nuevo `renderCityDragGhost`)

`renderDragGhost` en `spatialPreview.ts` dibuja un círculo con inicial. Para ciudad se necesita algo más grande y reconocible. Se crea `renderCityDragGhost`:

```typescript
export function renderCityDragGhost(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  cityName: string,
) {
  ctx.save();
  ctx.globalAlpha = 0.65;
  // Hexágono semi-transparente más grande que el ghost de unidad
  const size = HEX_SIZE * 1.2;
  _hexPath(ctx, screenX, screenY, size);
  ctx.fillStyle = '#d4a574';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cityName.slice(0, 8), screenX, screenY);
  ctx.restore();
}
```

### 3.5 No hay listener global de Escape — se agrega

El renderer no tiene listener de `keydown` para Escape. Se agrega en el constructor:

```typescript
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && this._placingMode) {
    this._placingMode = false;
    this.draggedCity = null;
    this.dragCityRepoPath = null;
    // cleanup visual
  }
});
```

---

## 4. Plan de implementación detallado

### Fase 1: Preparación de tipos y helpers (`src/types.ts`, `src/map.ts`)

1. Agregar `repoPath?: string` a `City` en `types.ts`.
2. Setear `repoPath` en `generateWorld()` y `addCityToWorld()` en `map.ts`.
3. Implementar `canRelocateCityTo(world, city, targetCoord): boolean` — función pura, testeable. Verifica:
   - tile destino existe (`world.tiles.has(tileKey(targetCoord))`)
   - tile destino no es océano
   - tile destino no tiene otra ciudad
   - tile destino no tiene unidad (o decisión documentada)
   - targetCoord no es igual a la coord actual (no-op)
4. Implementar `relocateCity(world, cityId, targetCoord, repoPath): boolean` siguiendo 3.2.

### Fase 2: `renderCityDragGhost` (`src/ui/spatialPreview.ts`)

1. Agregar `renderCityDragGhost` según 3.4.
2. (Opcional) Reusar `renderDropTarget` que ya funciona para validación verde/rojo.

### Fase 3: Modo drag en `renderer.ts` — reescritura de `_placingMode`

1. Agregar estado:
   ```typescript
   private _cityRelocateMode = false;       // activado desde panel
   private draggedCity: City | null = null;
   private dragCityRepoPath: string | null = null;
   private dragStartPos: { x: number; y: number } | null = null; // para detectar drag vs click
   ```
2. **`mousedown`** (no tocar el orden de prioridad): solo agregar al inicio:
   ```typescript
   if (this._cityRelocateMode) {
     this.dragStartPos = { x: e.clientX, y: e.clientY };
     const tile = this.state.world.tiles.get(tileKey(coord));
     if (tile?.city) {
       this.draggedCity = tile.city;
       this.dragCityRepoPath = tile.city.repoPath || null;
       // No cambiar gestureMode — dejamos que el flujo siga como camera_pan,
       // pero el render() y mouseup van a detectar el drag por la posición.
       // El gestureMode sigue siendo 'camera_pan' para no romper nada.
     }
     return; // no propagar a los otros casos
   }
   ```
   **Importante:** Si `_cityRelocateMode` está activo y el usuario clickea una ciudad, consumimos el evento aquí para que no se dispare `unit_drag`, `route`, ni `area_select`. Si clickea fuera de una ciudad, se deja pasar para no romper pan.

3. **`mousemove`:** si `_cityRelocateMode && draggedCity`, calcular si el mouse se movió > 3px desde `dragStartPos`:
   - Si es drag real: activar ghost visual, validar hoveredHex, dibujar preview.
   - No tocar `gestureMode` — el ghost se dibuja fuera de la FSM, en el bloque de `if (this.draggedCity)` dentro de `render()`.

4. **`mouseup`:** en el case `camera_pan`, después del `wasDrag` check, si `_cityRelocateMode && draggedCity`:
   - Si fue drag (> 3px): ejecutar `relocateCity()`
   - Si fue click corto: seleccionar ciudad (mostrar información)
   - Limpiar `draggedCity`, `dragCityRepoPath`, `dragStartPos`
   - No llamar `handleClick` (ya se consumió el evento)

5. **Render (~línea 565):** agregar bloque para ghost de ciudad:
   ```typescript
   if (this.draggedCity && this.hoveredHex && this.wasDragging()) {
     // dibujar ghost + validación de destino
   }
   ```

6. **`Escape`:** agregar listener según 3.5.

### Fase 4: UI (`src/ui/constructionPanel.ts`)

1. Al hacer clic en ✥ de una ciudad, en vez de `setPlacingMode(true)`, llamar:
   ```typescript
   rendererRef.setCityRelocateMode(true, repoPath);
   ```
   (nuevo método en el renderer que activa `_cityRelocateMode` y guarda el `repoPath` contextual).
2. El ✥ ya no hace `window.location.reload()`.
3. Tras relocate exitoso, llamar `refreshCityList()` para actualizar coordenadas en el panel.
4. Opcional: suscribirse a `notifyUpdate` para refrescar la lista automáticamente.

### Fase 5: Pruebas y verificación

**Automatizables (`*.test.ts`):**

| Test | Archivo |
|------|---------|
| `canRelocateCityTo` — océano, hex ocupado por otra ciudad, mismo hex, destino válido | `src/map.test.ts` |
| `canRelocateCityTo` — hex con unidad (decisión documentada) | `src/map.test.ts` |
| `relocateCity` — territorio se actualiza correctamente (cardinalidad, sin hexes huérfanos) | `src/map.test.ts` |
| `relocateCity` — distritos se trasladan por Δ correcto | `src/map.test.ts` |
| `relocateCity` — tile origen pierde `city`, tile destino gana `city` | `src/map.test.ts` |
| `relocateCity` — `invalidatePathCache` se llama | `src/map.test.ts` (mock) |
| `relocateCity` — no-op si coord actual === targetCoord | `src/map.test.ts` |
| Panel — ✥ ya no llama `window.location.reload()` | `src/ui/constructionPanel.test.ts` |

**Manuales (checklist):**

1. Abrir panel de construcción → click ✥ en ciudad → cursor cambia a modo relocate.
2. Click corto en la misma ciudad (sin drag) → no la mueve, solo la selecciona.
3. Arrastrar ciudad a océano → preview rojo; soltar no mueve.
4. Arrastrar a llanura libre → preview verde; soltar actualiza mapa y territorio visualmente.
5. `Shift`+drag en ciudad → sigue funcionando `route` / city-to-city sin interferencia.
6. Unidad sobre ciudad → el relocate consume el evento antes que unit_drag (prioridad documentada).
7. `Escape` cancela sin mutar estado ni disco.
8. Recarga manual de pestaña → posición persistida vía `manualLayout`.
9. Tras reubicación, `reconnectCities` no deja incoherencias (tiles intermedios, carpetas).

---

## 5. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Doble fuente de verdad (tile.city vs cities[]) | `relocateCity` actualiza ambos en un solo paso atómico; tests de consistencia posts-move. |
| Distritos / tiles desalineados al mover | Trasladar con Δ (no regenerar) mantiene consistencia 1:1. |
| Rendimiento al arrastrar | Validación solo al cambiar de hex (`tileKey` anterior ≠ actual), no cada píxel. |
| Confusión con HUD "Construir" | Nombres en UI y código: "Construir edificio" vs "Reubicar ciudad / layout manual". |
| Drag accidental (click sin intención de mover) | Se mueve solo si el mouse recorrió > 3px. Click corto = seleccionar, no mover. |
| `_cityRelocateMode` consume eventos y rompe pan/zoom | Si clickea fuera de una ciudad, el evento se deja pasar al flujo normal. Solo se captura si clickea sobre una ciudad. |

---

## 6. Resumen de cambios por archivo

| Archivo | Cambio |
|---------|--------|
| `src/types.ts` | Agregar `repoPath?: string` a `City` |
| `src/map.ts` | Setear `repoPath` en `generateWorld`/`addCityToWorld`; implementar `canRelocateCityTo`, `relocateCity` |
| `src/renderer.ts` | Agregar `_cityRelocateMode`, `draggedCity`, `dragCityRepoPath`, `dragStartPos`; reescribir interacción en mousedown/mousemove/mouseup/render; agregar listener Escape |
| `src/ui/spatialPreview.ts` | Agregar `renderCityDragGhost` |
| `src/ui/constructionPanel.ts` | ✥ llama `setCityRelocateMode` en vez de `setPlacingMode`+reload; llamar `refreshCityList` post-move |
| `src/main.ts` | Wire `notifyUpdate` + `refreshCityList` si hace falta |
| `src/map.test.ts` | Tests para `canRelocateCityTo`, `relocateCity` |

---

## 7. Referencias cruzadas (para PRs)

- Eliminar: `window.location.reload()` en `constructionPanel.ts` (mover ciudad).
- Añadir: tests en `src/map.test.ts` según Fase 5.
- No tocar: `src/spatialDirectives.ts`, `src/commandSchema.ts`, `src/commandBus.ts` (relocate no pasa por ahí).
- Tocará probablemente: `src/renderer.ts`, `src/map.ts`, `src/types.ts`, `src/game.ts`, `src/ui/constructionPanel.ts`, `src/ui/spatialPreview.ts`, `src/main.ts`.
