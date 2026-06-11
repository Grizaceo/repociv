import { describe, it, expect } from 'vitest';
import { computeRiverPaths, rebuildRivers, clearRivers, getRiverGroup } from './Rivers3D.ts';
import { tileKey, type Tile, type Terrain } from '../types.ts';

/** Synthetic island: mountain core, plains ring, ocean rim. */
function makeIsland(radius = 6): Map<string, Tile> {
  const tiles = new Map<string, Tile>();
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) > radius) continue;
      const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(s));
      let terrain: Terrain = 'plains';
      if (ring >= radius - 1) terrain = 'ocean';
      else if (ring <= 1) terrain = 'mountain';
      else if (ring === 2) terrain = 'hills';
      tiles.set(tileKey({ q, r }), {
        coord: { q, r },
        terrain,
        resources: { gold: 0, science: 0, production: 0 },
        inFog: false,
        revealed: true,
      });
    }
  }
  return tiles;
}

describe('Rivers3D', () => {
  it('grows at least one river from the highlands to the sea', () => {
    const paths = computeRiverPaths(makeIsland());
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.points.length).toBeGreaterThanOrEqual(2);
    }
    // At least one river actually reaches the sea (has a mouth).
    expect(paths.some((p) => p.mouth !== null)).toBe(true);
  });

  it('is deterministic for the same tile layout', () => {
    const a = computeRiverPaths(makeIsland());
    const b = computeRiverPaths(makeIsland());
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.points.map((p) => [p.x, p.y, p.z])).toEqual(
        b[i]!.points.map((p) => [p.x, p.y, p.z]),
      );
    }
  });

  it('returns no rivers on an all-land world (no ocean to reach)', () => {
    const tiles = makeIsland();
    for (const t of tiles.values()) {
      if (t.terrain === 'ocean') t.terrain = 'plains';
    }
    expect(computeRiverPaths(tiles)).toEqual([]);
  });

  it('rebuildRivers builds ribbon meshes and clears cleanly', () => {
    clearRivers();
    rebuildRivers(makeIsland());
    expect(getRiverGroup().children.length).toBeGreaterThan(0);
    clearRivers();
    expect(getRiverGroup().children.length).toBe(0);
  });
});
