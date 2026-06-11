# Plan: Ríos estilo Civ V (edge ribbons)

## Estado
No existe campo de ríos en `Tile` ni generación de ríos en `map.ts`.

## Diseño propuesto (reusa infraestructura coast mask)

### 1. Modelo de datos
Añadir a `Tile`:
```ts
riverEdges: number; // 6-bit mask, mismo formato que coast mask
```

### 2. Generación determinista (en `generateWorld` o post-proceso)
- Usar `Math.seedrandom(seed)` o LCG con seed del mundo (ej. hash de selectedRepoPaths).
- Algoritmo simple: partir de tiles de montaña/hills, caminar hacia el océano más cercano por BFS aleatorizado, marcar las aristas recorridas.
- Limitar a N ríos (ej. 3-5) para no saturar.

### 3. Renderer
- En `HexWorldScene.rebuildTerrainMesh`: calcular `instanceRiverMask` igual que `instanceCoastMask`.
- Pasar `instanceRiverMask` como atributo instanciado al terrain mesh.
- En `terrainShader.ts` vertex prelude: declarar `attribute float instanceRiverMask;`, pasar a `vRiverMask`.
- En fragment: donde `vTopFace > 0.5` y `vRiverMask > 0.5`, renderizar cinta azul (#4a90d9) por la arista usando `uCoastDir` (mismo patrón que foam ring). Ancho ~0.08 del hex.
- Excluir ríos en tiles oceánicos (no tiene sentido).

### 4. Shader cache key
Bump `repociv-terrain-v18 → v20` (o v19 si otro gap lo usa).

### 5. Tests / audit
- Vitest + screenshots 3D audit con `--update`.
- Verificar que ríos no rompan coast foam ni neighbor blending.

## Complejidad estimada
Mediana-alta (tocar 5+ archivos). Recomendado para iter6 dedicada.
