import { describe, it, expect } from 'vitest';
import {
  computeRiverPaths,
  edgeRoutePath,
  rebuildRivers,
  clearRivers,
  getRiverGroup,
} from './Rivers3D.ts';
import { worldTerrainSurfaceY } from './terrainSurfaceY.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
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

  it('rebuildRivers builds ribbon meshes and bridge crossings above terrain surface, and clears cleanly', () => {
    clearRivers();
    const island = makeIsland();
    rebuildRivers(island);
    // River ribbon + mouth foam + bridge crossing InstancedMesh
    expect(getRiverGroup().children.length).toBeGreaterThanOrEqual(2);

    // Every inland river ribbon vertex must sit above the rendered terrain cap
    const ribbonMesh = getRiverGroup().children[0] as import('three').Mesh;
    const pos = ribbonMesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y > -5) {
        const surfY = worldTerrainSurfaceY(x, z, island);
        expect(y).toBeGreaterThanOrEqual(surfY);
      }
    }

    clearRivers();
    expect(getRiverGroup().children.length).toBe(0);
  });

  it('keeps river control points on the terrain surface, not floating over highland edges', () => {
    const island = makeIsland();
    const paths = computeRiverPaths(island);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      // Body points only: the mouth deliberately dips to the sea surface.
      const body = p.mouth ? p.points.slice(0, -1) : p.points;
      for (const pt of body) {
        const lift = pt.y - worldTerrainSurfaceY(pt.x, pt.z, island);
        expect(lift).toBeGreaterThanOrEqual(1.29);
        expect(lift).toBeLessThanOrEqual(1.41);
      }
    }
  });

  it('routes straight runs and 120° turns around the tile perimeter, never near its centre', () => {
    const island = makeIsland();
    const tile = (q: number, r: number) => island.get(tileKey({ q, r }))!;
    const center = axialToWorld3D(0, 0, 0);
    // Distance from b's centre to segment p→q in XZ.
    const segDist = (p: { x: number; z: number }, q: { x: number; z: number }) => {
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const t = Math.max(
        0,
        Math.min(1, ((center.x - p.x) * dx + (center.z - p.z) * dz) / (dx * dx + dz * dz)),
      );
      return Math.hypot(p.x + dx * t - center.x, p.z + dz * t - center.z);
    };
    for (const path of [
      [tile(-1, 0), tile(0, 0), tile(1, 0)], // straight
      [tile(0, -1), tile(0, 0), tile(0, 1)], // straight, other axis
      [tile(-1, 0), tile(0, 0), tile(1, -1)], // 120° turn
    ]) {
      const { points } = edgeRoutePath(path, null, island);
      // Skip the spring (inside the source tile); every later chord is on or
      // around b's perimeter: consecutive edge midpoints sit 0.75·R out.
      for (let i = 1; i < points.length - 1; i++) {
        expect(segDist(points[i]!, points[i + 1]!)).toBeGreaterThan(HEX_SIZE * 0.7);
      }
    }
  });
});
