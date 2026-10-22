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
