# RepoCiv — Map Editor y Naciones

> Capa editorial sobre el mapa real. El workspace no se toca: el editor cambia
> **cómo se lee** el mapa (qué bandera pertenece a qué repo, qué terreno tiene
> cada hex, dónde está cada ciudad), nunca qué hay en el disco.

Estado: implementado en `feat/map-edit-nations` (2026-10-26).

---

## 1. El problema

El mapa de RepoCiv se genera desde el workspace: cada repo es una ciudad,
cada agente es una unidad, cada hex tiene un terreno inferido. Hasta ahora el
mapa era de **solo lectura** en todo lo que no sea repositorio:

- Cada ciudad tenía un color propio, determinista por id. No había forma de
  decir "este repo y aquel otro son la misma potencia".
- El terreno era inferido del contenido del repo (`inferTerrain`). Un usuario
  que quiere un mapa con otra geografía no tenía cómo expresarlo.
- La única edición posible era el botón `✥` del panel de construcción: arrastrar
  **una** ciudad a otra casilla. Un modo de un solo uso, con su propio estado
  en el renderer (`_cityRelocateMode`), su propio escape y su propia
  notificación.

El objetivo de esta feature es un **editor de mapa de verdad**: un modo con
herramientas, y una capa de **naciones** que agrupe ciudades bajo una bandera.

## 2. Modelo de datos

### 2.1 Nación

```ts
// src/types.ts
export interface Nation {
  id: string;
  name: string;
  color: string; // '#rrggbb'
  createdAt: number;
}
```

Una ciudad lleva `nationId?: string`. El color efectivo de una ciudad es:

```
territoryColorFor(city) = color de su nación ?? city.color (por id)
```

Es decir: la nación **pisa** el color propio de la ciudad. Sin nación, el mapa
se ve exactamente como antes.

### 2.2 Dónde vive el estado

El mundo se regenera en cada arranque (`generateWorld()`), así que las
ediciones no pueden vivir dentro de él. Viven en `localStorage`, igual que el
layout manual de ciudades (`src/manualLayout.ts`):

| Store | Clave | Contenido |
|-------|-------|-----------|
| `src/nations.ts` | `repociv:nations:v1` | naciones + asignaciones `ciudad → nación` |
| `src/mapEdits.ts` | `repociv:map-edits:v1` | terreno pintado, hexes borrados, ciudades quitadas o colocadas a mano |

Las ciudades se identifican por `cityKey(city) = city.repoPath ?? city.id`: el
path absoluto del repo sobrevive a recargas y renombrados, mientras que el
`id` generado no siempre lo hace.

Ambas piezas son **editoriales**: no escriben en el repositorio, no tocan el
bridge, no alteran el runtime de los agentes.

## 3. Superficie de UI

### 3.1 Pestaña `Naciones` (panel lateral)

`src/ui/nationsPanel.ts`, montado en `index.html` como quinta pestaña del
side panel.

- Crear nación (botón `+ Nueva`): toma el siguiente color libre de la paleta
  heráldica y deja el foco en el nombre para renombrarla.
- Renombrar y recolorear: el `<input type="color">` actualiza la bandera en
  vivo; el nombre se confirma al salir del campo.
- Borrar una nación: sus ciudades quedan **sin asignar**, no desaparecen.
- Asignar ciudades: un `<select>` por ciudad, con `Sin nación` como opción.

Tras cada cambio se llama a `applyNationsToWorld(world)`, que reescribe
`city.nationId` desde el store, y el mapa se repinta.

### 3.2 Editor de mapa (`K`)

`src/ui/mapEditor.ts` monta una barra flotante sobre el mapa con cinco
herramientas. Reemplaza al botón `✥` (que ya no existe) y se abre también
desde el panel de construcción y desde la paleta de comandos.

| Herramienta | Interacción | Efecto |
|-------------|-------------|--------|
| **Mover** | arrastrar una ciudad | reubica ciudad, distritos y territorio (reutiliza `relocateCity`, con su validación) |
| **Terreno** | clic y arrastre | pinta el terreno elegido; la capital nunca se pinta |
| **Nación** | clic en una ciudad | alinea la ciudad a la nación activa |
| **Crear** | clic en un hex libre | funda una ciudad con el repo elegido |
| **Borrar** | clic en una ciudad o hex | quita la ciudad del mapa (el repo sigue en disco) o borra el hex |

`Esc` cierra el editor. El modo vive en el renderer
(`setMapEditorMode` / `setMapEditorTool` / `setMapEditorTerrain` /
`setMapEditorNation` / `setMapEditorRepo`); la herramienta **Mover** reusa el
arrastre de ciudades ya existente, así que hereda sus reglas (no se puede
soltar una ciudad sobre otra ni sobre océano con unidades encima).

## 4. Render por nación

El color de nación se aplica en los dos renderers:

- **2D** (`src/hexRenderer.ts`): las fronteras del territorio se tiñen con el
  color de la nación; sin nación se mantiene el trazo dorado de la capital y
  el marrón de las ciudades.
- **3D** (`src/three/HexWorldScene.ts`): las cintas de frontera y el tinte de
  relleno del territorio usan el color de la nación. La firma de reconstrucción
  incluye el color efectivo, así que cambiar una bandera repinta sin recargar.
- **Unidades**: un anillo con el color de la bandera bajo cada agente, en 2D
  (`src/unitRenderer.ts`) y en 3D (`src/three/UnitMesh3D.ts`). El color propio
  del agente (tipo de harness) se conserva: la nación no pisa la identidad del
  agente.

`computeWorldSignature()` incluye el color efectivo de cada ciudad, de modo
que un cambio de bandera marca la escena 3D como sucia.

## 5. Ciclo de vida de las ediciones

`applyMapEdits(world, diskRepos)` se ejecuta dentro de `generateWorld()`, antes
del recálculo de territorios, para que el mapa editado sea el que se Voronoiiza:

1. **Ciudades fuera**: se quitan del mundo y sus agentes con ellas.
2. **Ciudades colocadas a mano**: se agregan desde `diskRepos` si el hex está
   libre (nunca sobre otra ciudad).
3. **Terreno pintado**: se aplica a los tiles, salvo la capital.
4. **Hexes borrados**: se eliminan los tiles libres; los hexes con ciudad o
   distrito están protegidos.

Después, `applyNationsToWorld(world)` reescribe las asignaciones de nación.

## 6. Verificación

- `src/nations.test.ts` — store de naciones: crear, renombrar, asignar,
  borrar, color de territorio, payload corrupto.
- `src/mapEdits.test.ts` — store de ediciones y `applyMapEdits`: quitar
  ciudades, pintar terreno, borrar hexes, proteger capital y ciudades.
- `src/renderer.mapEditor.test.ts` — el modo editor sobre el renderer real
  (brocha de terreno, herramienta de nación, borrado).
- `e2e/map-editor-nations.spec.ts` — panel de naciones y barra del editor en
  navegador, más un caso contra la app real (pestaña y hotkey `K`).

Gates: `npx tsc --noEmit`, `npx eslint src --max-warnings=0`, `npx vitest run`.

## 7. Lo que NO hace

- No toca el filesystem: quitar una ciudad del mapa no borra el repo.
- No cambia el runtime de los agentes: una nación es color y pertenencia, no
  permisos ni enrutado.
- No hay deshacer/rehacer todavía: las ediciones se acumulan en el store.
- La asignación de unidades es implícita (heredan la ciudad); no hay una
  pestaña por agente.
