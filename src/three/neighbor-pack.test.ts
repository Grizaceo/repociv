import { describe, it, expect } from 'vitest';
import { packNeighborTerrains } from './HexWorldScene.ts';
import { TERRAIN_ATLAS_INDEX } from './terrainShader.ts';
import { AXIAL_DIRECTIONS } from '../hex.ts';
import { tileKey, type Terrain } from '../types.ts';

// Decode digit k the same way the GLSL neighborIdxAt() does.
function digitAt(packed: number, k: number): number {
  let p = Math.floor(packed + 0.5);
  for (let i = 0; i < k; i++) p = Math.floor(p / 8);
  return p % 8;
}

function makeWorld(center: Terrain, neighbors: Array<Terrain | undefined>) {
  const tiles = new Map<string, { terrain: Terrain }>();
  AXIAL_DIRECTIONS.forEach((d, k) => {
    const t = neighbors[k];
    if (t) tiles.set(tileKey({ q: d.q, r: d.r }), { terrain: t });
  });
  const tile = { coord: { q: 0, r: 0 }, terrain: center };
  return { tile, getTile: (key: string) => tiles.get(key) };
}

describe('packNeighborTerrains', () => {
  it('packs each direction into its own base-8 digit (AXIAL_DIRECTIONS order)', () => {
    const neighbors: Terrain[] = ['desert', 'forest', 'ocean', 'mountain', 'ice', 'hills'];
    const { tile, getTile } = makeWorld('plains', neighbors);
    const packed = packNeighborTerrains(tile, getTile);
    neighbors.forEach((t, k) => {
      expect(digitAt(packed, k)).toBe(TERRAIN_ATLAS_INDEX[t]);
    });
  });

  it('encodes missing and same-terrain neighbors as the tile itself (= no blend)', () => {
    const { tile, getTile } = makeWorld('desert', [
      'desert', // same → self
      undefined, // missing → self
      'plains',
      undefined,
      'desert',
      'forest',
    ]);
    const packed = packNeighborTerrains(tile, getTile);
    const self = TERRAIN_ATLAS_INDEX.desert;
    expect(digitAt(packed, 0)).toBe(self);
    expect(digitAt(packed, 1)).toBe(self);
    expect(digitAt(packed, 2)).toBe(TERRAIN_ATLAS_INDEX.plains);
    expect(digitAt(packed, 3)).toBe(self);
    expect(digitAt(packed, 4)).toBe(self);
    expect(digitAt(packed, 5)).toBe(TERRAIN_ATLAS_INDEX.forest);
  });

  it('stays float32-exact even at the maximum packing (all sacred)', () => {
    const { tile, getTile } = makeWorld('plains', [
      'sacred',
      'sacred',
      'sacred',
      'sacred',
      'sacred',
      'sacred',
    ]);
    const packed = packNeighborTerrains(tile, getTile);
    expect(packed).toBe(8 ** 6 - 1 - 0); // 7 in every digit = 262143
    // Round-trips through Float32 (the InstancedBufferAttribute storage).
    expect(Math.fround(packed)).toBe(packed);
    for (let k = 0; k < 6; k++) expect(digitAt(packed, k)).toBe(7);
  });
});
