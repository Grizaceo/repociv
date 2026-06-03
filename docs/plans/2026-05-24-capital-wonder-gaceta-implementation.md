# PROMPT DE IMPLEMENTACION — RepoCiv Capital + Maravillas + Gaceta Improvements

## Contexto Base (no modificar fuera del alcance)

- Repo: `<repo-root>`
- Commit base: `371f737`
- Stack: TypeScript vanilla, Vite, Canvas 2D, Python bridge (FastAPI-style)
- CSS tokens ya implementados en `src/styles/variables.css`
- Verificacion obligatoria: `npx tsc --noEmit` limpio despues de cada paso
- Regla KISS: no agregar frameworks, no deps nuevas, no cambiar arquitectura de bridge

---

## Alcance: 6 Pasos Secuenciales

---

### PASO 0: APLICAR PLAN GACETA EXISTENTE

Implementar las 3 mejoras del archivo `docs/plans/2026-05-24-gaceta-improvements.md`.

**0.1 Redimensionamiento libre en `src/styles/gaceta.css`**

Modificar `#gaceta-widget` para que use flexbox vertical. En estado `.gaceta-expanded`:
- `resize: both`
- `overflow: hidden`
- `min-width: 280px; min-height: 180px`
- `max-width: 600px; max-height: 800px`
- `height: 420px` (default inicial)
- `.gaceta-body`: `flex: 1`, `overflow-y: auto`

Cuando `.gaceta-collapsed`: quitar `resize` y volver a `max-height: 48px`.

**0.2 Endpoint POST `/api/news/scan` en `server/http_routes.py`**

Crear funcion `post_news_scan` que ejecute via `subprocess.run`:
```python
["blogwatcher-cli", "scan"]
```
con `capture_output=True, text=True, timeout=120`. Manejar `FileNotFoundError`, `TimeoutExpired`, y error generico. Retornar siempre JSON con `{ok, stdout?, stderr?, returncode?, error?}`.

**0.3 Registrar ruta en `server/bridge.py`**

En `_POST_EXACT` agregar: `"/api/news/scan": _routes.post_news_scan`

**0.4 Funcion `scanNews()` en `src/bridge.ts`**

Exportar funcion async que haga POST `/api/news/scan`, envie `X-RepoCiv-Token`, y devuelva `{ok: boolean; error?: string}`.

**0.5 Boton de Scan en `src/ui/gacetaWidget.ts`**

- Agregar boton `🔄` (o span con clase `.gaceta-scan-btn`) en el header del widget, al lado del chevron.
- Al hacer click: (a) agregar clase CSS `spinning` al icono, (b) llamar `scanNews()`, (c) al completar quitar `spinning` y llamar `_refresh()`.
- Estilo del boton: solo icono, sin borde, color `--ui-text-dim`, hover gold. Animacion CSS `spin` cuando tiene clase `spinning`.

**0.6 Categorias + chips en `src/ui/gacetaWidget.ts` y `gaceta.css`**

- En `http_routes.py`: cargar `../cdaily/config.yaml` para extraer mapeo `category -> emoji`. Si falla, fallback a diccionario inline. Ampliar limite de articulos de 5 a 15. Incluir `category` y `emoji` en cada articulo JSON.
- En `types.ts`: ampliar `CDailyArticle` con `category?: string; emoji?: string;`
- En `gacetaWidget.ts`: despues de `_renderList()`, extraer categorias unicas de `_articles`. Crear barra horizontal con chips: `[Todo]` + uno por categoria detectada (ej: `[🔐 Seguridad]`). Estado `_selectedCategory: string = 'all'`. Click en chip filtra localmente el render de lista (sin re-fetch).
- CSS chips: `.gaceta-categories` con `display: flex; gap: 6px; overflow-x: auto; padding: 8px 0;`. Chip activo: fondo dorado, texto negro. Inactivo: borde `--border-dim`.

---

### PASO 1: EXTENDER TIPOS PARA MARAVILLAS

**Archivo: `src/types.ts`**

A la interfaz `Building`, agregar campo opcional:
```typescript
wonderType?: 'bibliotheca' | 'institutum';
```

Agregar tipo:
```typescript
export type WonderType = 'bibliotheca' | 'institutum';
```

A `City`, agregar campo:
```typescript
wonders?: Building[];  // Edificios tipo wonder construidos en esta ciudad
```

Asegurar que `Building.type` pueda seguir siendo `'building' | 'wonder'` (ya existe).

---

### PASO 2: SPAWN AUTOMATICO DE CAPITAL + MARAVILLAS

**Archivo: `src/map.ts` — funcion `generateWorld`**

Despues de generar las ciudades desde repos, buscar si existe alguna ciudad con `isCapital: true`. Si no existe:

1. Crear una ciudad capital en la coordenada mas central del mapa (o `(0,0)` si el mapa es vacio):
```typescript
const capitalCity: City = {
  id: 'capital-imperialis',
  name: 'Capitalis',
  coord: { q: 0, r: 0 },
  population: 1,
  territory: [],
  districts: [],
  buildings: [],
  isCapital: true,
};
```

2. Asignar 6 hexes adyacentes como `territory` de la capital (usar `axialNeighbours` o `spiralCoords` a radio 1).

3. Spawn automático de 2 maravillas en la capital (no en hexes separados; son metafóricamente "dentro" de la capital):
```typescript
const bibliotheca: Building = {
  id: 'wonder-bibliotheca',
  name: 'Bibliotheca Alexandrina',
  type: 'wonder',
  wonderType: 'bibliotheca',
  cityId: capitalCity.id,
  progress: 100,
  durationSeconds: 0,
  elapsedSeconds: 0,
  state: 'complete',
};

const institutum: Building = {
  id: 'wonder-institutum',
  name: 'Institutum Scientiarum',
  type: 'wonder',
  wonderType: 'institutum',
  cityId: capitalCity.id,
  progress: 100,
  durationSeconds: 0,
  elapsedSeconds: 0,
  state: 'complete',
};

capitalCity.buildings = [bibliotheca, institutum];
capitalCity.wonders = [bibliotheca, institutum];
```

4. Insertar la capital en `world.cities`.

5. Para los hexes de territorio de la capital, setear `tile.city = capitalCity`.

---

### PASO 3: RENDERIZAR SPRITES EN CANVAS

**Archivo: `src/renderer.ts` — funcion `render` o `_drawTile`**

Para la ciudad con `isCapital: true`:

1. **Hex Capital**: dibujar un hexágono base con gradiente dorado (usar `ctx.createLinearGradient`). En el centro del hex, dibujar una corona pequeña (👑 o simplemente un círculo dorado con borde más grueso).
2. **Indicadores de Maravillas**: alrededor del centro del hex capital (arriba-izquierda y arriba-derecha), dibujar 2 pequeños iconos/círculos de color distintivo:
   - Bibliotheca: círculo azul oscuro `#1a3a5c` con letra "B" blanca (o un pequeño arco de templo).
   - Institutum: círculo verde ciencia `#2d5a27` con letra "I" blanca (o un pequeño matraz).
3. Escala de los iconos: radio ~8px, posicionados a ~45° arriba-izquierda y arriba-derecha del centro del hex.

**Archivo: `src/game.ts`**

Asegurar que al iniciar `GameState`, si `world.cities` tiene capital, setear `game.selectedCapital` o exponerla via getter para que el renderer la encuentre sin O(n^2).

---

### PASO 4: DETECTAR DOBLE-CLICK EN CAPITAL

**Archivo: `src/main.ts` — evento `dblclick` en canvas**

En el handler de `dblclick` del canvas (o en el sistema de input existente):

1. Convertir coordenadas de pantalla a coordenadas axiales (usar `pixelToAxial` que ya existe o crear una basada en `renderer.hexSize` y `panOffset`).
2. Buscar si existe una ciudad en esa coordenada o en sus adyacentes (2 hexes de tolerancia).
3. Si la ciudad tiene `isCapital: true` → abrir Capital Panel.
4. Si la ciudad tiene `wonders` y el click está cerca de un icono de maravilla (proyección simple) → abrir Wonder Vignette para esa `wonderType`.

**Alternativa mas simple**: en `renderer.ts`, durante `_drawTile`, mantener un mapa de posiciones de sprites a wonderType. En `dblclick`, buscar la posición más cercana.

---

### PASO 5: CAPITAL COMMAND CENTER (4 TABS)

**Nuevo archivo: `src/ui/capitalPanel.ts`**

Exportar:
```typescript
export function openCapitalPanel();
export function closeCapitalPanel();
```

Comportamiento:
- Crear/modificar elemento DOM `#capital-panel` (overlay fixed centrado, 80vw x 80vh, z-index 950).
- Fondo: `#1a1a2e` con borde dorado de 2px `var(--clr-gold)`.
- Header: "🏛 Palacio Imperial — Centrum Operarum" con boton cierre X.
- Tabs horizontales en la parte superior (4 tabs):

| Tab ID | Label | Contenido |
|--------|-------|-----------|
| `tab-gaceta` | 📰 Gaceta | Importar y montar el widget de Gaceta existente (`mountGacetaWidget`), pero en modo "full panel" (sin teaser, lista completa de 15 articulos en vez de 5). |
| `tab-biblio` | 📚 Bibliotheca | Boton grande "Entrar a la Bibliotheca" que llama `openWonderVignette('bibliotheca')`. Ademas mostrar un resumen de stats: "Grafo de conocimiento", "Nodos indexados", etc. (datos hardcodeados o del localStorage). |
| `tab-labhub` | 🧪 Institutum | Boton "Entrar al Institutum" que llama `openWonderVignette('institutum')`. Resumen: "Labs activos: 5", "Ultima mision: ..." (usar `localStorage` si LabHub ya guarda algo). |
| `tab-stats` | 🔭 Observatorium | Dashboard interno: (a) Analytics del `analytics.ts` existente (mensajes enviados, paneles abiertos), (b) Era actual y progreso (`eraSystem.ts`), (c) Stats de sistema (GPU, memoria, bridge status — reusar `observabilityPanel.ts` si existe). |

- Persistencia: recordar tab activo en `localStorage.getItem('repociv-capital-tab')`.
- Cierre: Escape o click en X. Emitir evento `repociv:panel-close`.

**CSS: `src/styles/panels.css`**

Agregar clases:
```css
.capital-panel { /* overlay fixed, centrado, 80vw 80vh, z-index 950, fondo oscuro, borde dorado */ }
.capital-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-dim); }
.capital-tab { padding: 10px 20px; cursor: pointer; ... }
.capital-tab.active { border-bottom: 2px solid var(--clr-gold); color: var(--clr-gold); }
.capital-tab-body { flex: 1; overflow-y: auto; padding: 16px; }
```

---

### PASO 6: WONDER VIGNETTE (IFRAME WRAPPER)

**Nuevo archivo: `src/ui/wonderVignette.ts`**

Exportar:
```typescript
export function openWonderVignette(type: 'bibliotheca' | 'institutum');
export function closeWonderVignette();
```

Configuracion (hardcodear por ahora, leer de `.env` si Vite lo expone):
```typescript
const WONDER_URLS = {
  bibliotheca: 'http://localhost:3001',
  institutum: 'http://localhost:5280',
};
```

Comportamiento:
- Crear `#wonder-vignette` (overlay fixed, centrado pero mas pequeno que capital, 70vw x 75vh, z-index 960, arriba de todo).
- Header draggeable: titulo segun tipo + boton X + boton fullscreen toggle.
- Body: unico `<iframe>` cargando `WONDER_URLS[type]`.
- Iframe atributos: `sandbox="allow-scripts allow-same-origin allow-forms"`, `loading="eager"`.
- `resize: both` en el contenedor `#wonder-vignette` (overflow hidden para activar el handle nativo del navegador).
- Persistir posicion y tamaño en `localStorage` (keys: `repociv-vignette-pos-bibliotheca`, `repociv-vignette-pos-institutum`).
- Lazy-load: el iframe solo se crea al abrir, se destruye al cerrar (no mantener en DOM oculto).
- Health check: antes de montar, hacer `fetch(WONDER_URLS[type], {method:'HEAD', mode:'no-cors'})` con timeout 3s. Si falla, mostrar empty state tematico: "La maravilla esta en construccion. Los obreros duermen... [Reintentar]". Usar `emptyStates.ts` existente si aplica.

**CSS: `src/styles/panels.css`**

Agregar:
```css
.wonder-vignette { position: fixed; z-index: 960; resize: both; overflow: hidden; ... }
.wonder-vignette-header { cursor: grab; display: flex; justify-content: space-between; ... }
.wonder-vignette iframe { width: 100%; height: calc(100% - 40px); border: none; }
```

---

## Archivos a Modificar (orden de edicion)

| # | Archivo | Modificacion |
|---|---------|--------------|
| 0.1 | `src/styles/gaceta.css` | Flex + resize |
| 0.2 | `server/http_routes.py` | `post_news_scan()` + categorias |
| 0.3 | `server/bridge.py` | Registro ruta POST |
| 0.4 | `src/bridge.ts` | `scanNews()` |
| 0.5 | `src/ui/gacetaWidget.ts` | Boton scan + chips |
| 1 | `src/types.ts` | `wonderType?`, `City.wonders?` |
| 2 | `src/map.ts` | Spawn capital + 2 wonders |
| 3 | `src/renderer.ts` | Dibujar sprites capital + iconos |
| 4 | `src/game.ts` | Getter `getCapital()` |
| 5 | `src/main.ts` | Handler dblclick → capital/wonder |
| 6 | `src/ui/capitalPanel.ts` | Nuevo |
| 7 | `src/ui/wonderVignette.ts` | Nuevo |
| 8 | `src/styles/panels.css` | Clases .capital-panel, .wonder-vignette |

## Archivos Nuevos

- `src/ui/capitalPanel.ts`
- `src/ui/wonderVignette.ts`

## Archivos que NO se deben tocar

- `src/ui/chat/` (persistencia ya esta)
- `src/ui/analytics.ts` (solo importar para tab Stats)
- `src/ui/eraSystem.ts` (solo leer)
- `vite.config.ts`, `package.json`
- Cualquier archivo del backend Python fuera de `http_routes.py` y `bridge.py`

---

## Notas de Implementacion

- **Sprite dibujado en Canvas**: no usar imagenes externas. Puro Canvas 2D (arcos, rectangulos, texto). Esto mantice KISS y zero-asset.
- **Doble-click vs click**: asegurar que el click simple (seleccionar ciudad) siga funcionando. El doble-click debe ser un evento separado.
- **Z-index**: Capital Panel 950 < Wonder Vignette 960. Nada debe superponerse mal.
- **Health check**: el `fetch` HEAD con `mode: 'no-cors'` puede fallar silenciosamente; el empty state debe aparecer si el iframe no carga en 5s (usar `iframe.onload` y `iframe.onerror`).
- **localStorage**: no usar nombres genericos. Prefijo obligatorio: `repociv-*`.
- **Typescript**: cada nuevo modulo debe tener `export` explicitos. No usar `any`.

---

## Comandos de Verificacion Post-Implementacion

```bash
cd <repo-root>

# 1. Types limpio
npx tsc --noEmit

# 2. Build Vite pasa
npm run build

# 3. Tests existentes no se rompen
npm test -- --run

# 4. Lint
cd server && python -m pytest test_cdaily_bridge.py -v 2>/dev/null || echo "tests de bridge opcionales"
```

## Criterio de Terminacion
- [ ] Gaceta redimensionable con resize nativo
- [ ] Boton scan funciona (llama endpoint, el icono gira, recarga lista)
- [ ] Chips de categoria filtran localmente
- [ ] Capital spawnea automaticamente en (0,0) con isCapital=true
- [ ] 2 iconos de maravilla dibujados junto a la capital
- [ ] Doble-click en capital abre panel con 4 tabs
- [ ] Tab Gaceta muestra lista completa (15 items)
- [ ] Tab Bibliotheca/Institutum tienen boton que abre vignette
- [ ] Tab Stats muestra analytics + era + observabilidad
- [ ] Vignette carga iframe a puerto correcto, es resizable, tiene header draggeable
- [ ] Si puerto no responde, muestra empty state
- [ ] `npx tsc --noEmit` pasa limpio
