import { describe, expect, it } from 'vitest';
import { _testRecipes, rebuildTerrainScatter, clearTerrainScatter } from './TerrainScatter3D.ts';

const { RECIPES_BY_TERRAIN, PROP_IDS } = _testRecipes;

describe('TerrainScatter3D recipes', () => {
  it('references only known prop ids', () => {
    const known = new Set<string>(PROP_IDS);
    for (const recipes of Object.values(RECIPES_BY_TERRAIN)) {
      for (const recipe of recipes) {
        for (const entry of recipe ?? []) {
          expect(known.has(entry.prop)).toBe(true);
        }
      }
    }
  });

  it('keeps cluster offsets clear of tile edges (≤0.45 circumradius)', () => {
    for (const recipes of Object.values(RECIPES_BY_TERRAIN)) {
      for (const recipe of recipes) {
        for (const entry of recipe ?? []) {
          for (const { offset, scale } of entry.placements) {
            expect(Math.hypot(offset[0], offset[1])).toBeLessThanOrEqual(0.45);
            expect(scale).toBeGreaterThan(0);
            expect(scale).toBeLessThanOrEqual(1.2);
          }
        }
      }
    }
  });

  it('stays sparse — every biome keeps bare tiles', () => {
    for (const [terrain, recipes] of Object.entries(RECIPES_BY_TERRAIN)) {
      const bare = recipes.filter((r) => r === null).length;
      expect(bare, `${terrain} must keep some bare tiles`).toBeGreaterThan(0);
      expect(bare / recipes.length).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('rebuildTerrainScatter before load', () => {
  it('is a safe no-op when GLBs are not loaded', () => {
    expect(() => {
      rebuildTerrainScatter([]);
      clearTerrainScatter();
    }).not.toThrow();
  });
});
