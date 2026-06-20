import { describe, it, expect } from 'vitest';
import { forestCanopyTint } from './ForestProps3D.ts';

const lum = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b;

describe('forestCanopyTint', () => {
  it('is always green-dominant — forests recede, never read as warm golden dots', () => {
    for (let h = 0; h < 256; h++) {
      for (let t = 0; t < 11; t++) {
        const [r, g, b] = forestCanopyTint(h, t);
        // Green channel strictly dominates → never the warm (R>=G) rosette the
        // old formula produced (R up to 1.14 > G).
        expect(g).toBeGreaterThan(r);
        expect(g).toBeGreaterThan(b);
      }
    }
  });

  it('stays below grass-biome luminance so canopies sink into the land', () => {
    let max = 0;
    for (let h = 0; h < 256; h++) {
      for (let t = 0; t < 11; t++) {
        max = Math.max(max, lum(forestCanopyTint(h, t)));
      }
    }
    // Grass top-cap albedo reads well above this; forests must stay under it.
    // (Old formula peaked at luminance > 1.0 — brighter than grass.)
    expect(max).toBeLessThan(0.8);
    // …but still visible, not black.
    expect(max).toBeGreaterThan(0.5);
  });
});
