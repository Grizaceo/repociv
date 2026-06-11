import { describe, it, expect } from 'vitest';
import { TERRAIN_ATLAS_INDEX } from './terrainShader.ts';
import { type Terrain } from '../types.ts';

const NON_FOG_TERRAINS: Terrain[] = [
  'plains',
  'forest',
  'mountain',
  'desert',
  'ocean',
  'ice',
  'hills',
  'sacred',
];

describe('TERRAIN_ATLAS_INDEX', () => {
  it('covers every non-fog terrain exactly once', () => {
    const values = NON_FOG_TERRAINS.map((t) => TERRAIN_ATLAS_INDEX[t]);
    expect(new Set(values).size).toBe(NON_FOG_TERRAINS.length);
    for (const t of NON_FOG_TERRAINS) {
      expect(TERRAIN_ATLAS_INDEX[t]).toBeGreaterThanOrEqual(0);
    }
  });

  it('assigns indices 0..7 for the eight base terrains', () => {
    const indices = NON_FOG_TERRAINS.map((t) => TERRAIN_ATLAS_INDEX[t]);
    const sorted = [...indices].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
