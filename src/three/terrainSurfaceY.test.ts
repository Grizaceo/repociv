import { describe, expect, it } from 'vitest';
import { terrainReliefAt, terrainSurfaceY, PROP_SURFACE_CLEARANCE } from './terrainSurfaceY.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { terrainElevation } from '../isoHex.ts';
import type { Tile } from '../types.ts';

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
});
