import { describe, it, expect } from 'vitest';
import { forestTreeKind } from './ForestProps3D.ts';

const TREES_PER_TILE = 11;

describe('forestTreeKind', () => {
  it('is deterministic — same (hash, slot) always yields the same tree', () => {
    for (let h = 0; h < 997; h += 13) {
      for (let t = 0; t < TREES_PER_TILE; t++) {
        const a = forestTreeKind(h, t);
        const b = forestTreeKind(h, t);
        expect(a.kind).toBe(b.kind);
        expect(a.variant).toBe(b.variant);
      }
    }
  });

  it('mixes both kinds into every forest tile silhouette', () => {
    // Per tile: exactly 4 of the 11 slots go deciduous, for EVERY hash.
    // (t*29 mod 11 cycles all residues since gcd(29,11)=1, so the <4 gate
    // always admits 4 slots.) Forests keep their pine-led Civ V silhouette —
    // broadleafs are the variety, never the base note, and no tile is ever a
    // monoculture of either kind.
    for (let h = 0; h < 997; h++) {
      let deciduous = 0;
      for (let t = 0; t < TREES_PER_TILE; t++) {
        if (forestTreeKind(h, t).kind === 'deciduous') deciduous++;
      }
      expect(deciduous).toBe(4);
    }
  });

  it('returns valid variant indices for each kind', () => {
    for (let h = 0; h < 200; h++) {
      for (let t = 0; t < TREES_PER_TILE; t++) {
        const { kind, variant } = forestTreeKind(h, t);
        if (kind === 'pine') {
          expect(variant).toBeGreaterThanOrEqual(0);
          expect(variant).toBeLessThan(3);
        } else {
          expect(variant).toBeGreaterThanOrEqual(0);
          expect(variant).toBeLessThan(2);
        }
      }
    }
  });

  it('keeps the tile-level pine variant stable across slots', () => {
    // All pine slots of one tile share the hash-picked variant so a tile
    // reads as one stand, not confetti.
    for (let h = 0; h < 100; h++) {
      const pineVariants = new Set<number>();
      for (let t = 0; t < TREES_PER_TILE; t++) {
        const { kind, variant } = forestTreeKind(h, t);
        if (kind === 'pine') pineVariants.add(variant);
      }
      expect(pineVariants.size).toBeLessThanOrEqual(1);
    }
  });
});
