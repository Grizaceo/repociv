import { describe, expect, it } from 'vitest';
import {
  terrainReliefAt,
  terrainSurfaceY,
  terrainEdgeRampY,
  terrainFootprintMaxY,
  worldTerrainSurfaceY,
  PROP_SURFACE_CLEARANCE,
} from './terrainSurfaceY.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { terrainElevation } from '../isoHex.ts';
import { HEX_SIZE } from '../constants.ts';
import { tileKey, type Tile } from '../types.ts';

function makeTile(terrain: Tile['terrain'], q = 0, r = 0): Tile {
  return {
    coord: { q, r },
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    city: undefined,
    inFog: false,
    revealed: true,
  };
}

describe('terrainSurfaceY', () => {
  it('matches base elevation for ice/ocean (no stable micro-relief)', () => {
    for (const terrain of ['ice', 'ocean'] as const) {
      const tile = makeTile(terrain);
      const base = axialToWorld3D(0, 0, terrainElevation(terrain));
      expect(terrainSurfaceY(tile)).toBeCloseTo(base.y, 6);
    }
  });

  it('returns finite shader relief for land biomes', () => {
    for (const terrain of ['plains', 'forest', 'desert', 'hills', 'mountain', 'sacred'] as const) {
      const tile = makeTile(terrain, 2, -1);
      const y = terrainSurfaceY(tile);
      expect(Number.isFinite(y)).toBe(true);
      expect(Math.abs(terrainReliefAt(terrain, 12.3, -4.5))).toBeLessThan(8);
    }
  });

  it('exports a small positive prop clearance', () => {
    expect(PROP_SURFACE_CLEARANCE).toBeGreaterThan(0);
    expect(PROP_SURFACE_CLEARANCE).toBeLessThan(2);
  });

  it('keeps inner plateau (r <= 0.50 HEX) unaffected by neighbor elevation ramps and ramps outer rim', () => {
    const center = makeTile('plains', 0, 0);
    const neighbor = makeTile('mountain', 1, 0);
    const map = new Map<string, Tile>([
      [tileKey(center.coord), center],
      [tileKey(neighbor.coord), neighbor],
    ]);
    const getTile = (k: string) => map.get(k);

    expect(terrainEdgeRampY(center, 0, 0, getTile)).toBe(0);
    expect(terrainEdgeRampY(center, HEX_SIZE * 0.3, 0, getTile)).toBe(0);

    const nPos = axialToWorld3D(1, 0, 0);
    const edgeMidX = nPos.x * 0.5;
    const edgeMidZ = nPos.z * 0.5;
    expect(terrainEdgeRampY(center, edgeMidX, edgeMidZ, getTile)).toBeGreaterThan(10);
  });

  it('meets every neighbor cap exactly along shared edges and 3-biome corners', () => {
    // Plains disc with a mountain east of the origin and a desert south-east,
    // so (0,0)–(1,0)–(0,1) is a plains/mountain/desert corner. Full disc: no
    // missing neighbors, which the shader encodes as "same biome".
    const map = new Map<string, Tile>();
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        if (Math.abs(q + r) > 3) continue;
        map.set(tileKey({ q, r }), makeTile('plains', q, r));
      }
    }
    map.set(tileKey({ q: 1, r: 0 }), makeTile('mountain', 1, 0));
    map.set(tileKey({ q: 0, r: 1 }), makeTile('desert', 0, 1));
    const getTile = (k: string) => map.get(k);
    const surfaceAt = (q: number, r: number, x: number, z: number): number => {
      const tile = map.get(tileKey({ q, r }))!;
      const c = axialToWorld3D(q, r, 0);
      return terrainSurfaceY(tile, x - c.x, z - c.z, getTile);
    };
    const corner = (...coords: Array<[number, number]>) => {
      const ps = coords.map(([q, r]) => axialToWorld3D(q, r, 0));
      return { x: ps.reduce((s, p) => s + p.x, 0) / 3, z: ps.reduce((s, p) => s + p.z, 0) / 3 };
    };

    // Edge (0,0)|(1,0): plains vs mountain, from a same-biome corner to the
    // 3-biome corner. Before the relief fade the plains rim kept its noise
    // while the mountain rim lost it, so the caps missed by up to ±1.5.
    const c1 = corner([0, 0], [1, 0], [1, -1]);
    const c2 = corner([0, 0], [1, 0], [0, 1]);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const x = c1.x + (c2.x - c1.x) * t;
      const z = c1.z + (c2.z - c1.z) * t;
      expect(surfaceAt(0, 0, x, z)).toBeCloseTo(surfaceAt(1, 0, x, z), 6);
    }
    // The 3-biome corner sits at the mean elevation of the three tiles.
    const meanY = (axialToWorld3D(0, 0, 0).y + axialToWorld3D(0, 0, 3).y) / 3;
    for (const [q, r] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      expect(surfaceAt(q, r, c2.x, c2.z)).toBeCloseTo(meanY, 6);
    }
    // Edge (0,0)|(0,1): same elevation (plains vs desert), different noise.
    const c3 = corner([0, 0], [0, 1], [-1, 1]);
    for (const t of [0, 0.5, 1]) {
      const x = c2.x + (c3.x - c2.x) * t;
      const z = c2.z + (c3.z - c2.z) * t;
      expect(surfaceAt(0, 0, x, z)).toBeCloseTo(surfaceAt(0, 1, x, z), 6);
    }
  });

  it('samples footprint maximum and world surface Y across tiles', () => {
    const hill = makeTile('hills', 0, 0);
    const map = new Map<string, Tile>([[tileKey(hill.coord), hill]]);
    const getTile = (k: string) => map.get(k);
    const centerY = terrainSurfaceY(hill, 0, 0, getTile);
    const maxFootY = terrainFootprintMaxY(hill, 0, 0, HEX_SIZE * 0.25, getTile);
    expect(maxFootY).toBeGreaterThanOrEqual(centerY);
    expect(worldTerrainSurfaceY(0, 0, map)).toBeCloseTo(centerY, 5);
  });
});
