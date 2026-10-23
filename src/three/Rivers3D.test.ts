import { describe, it, expect } from 'vitest';
import type { Vector3 } from 'three';
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

  it('routes along hex edges: corners only, ±60° turns, never near a path tile centre', () => {
    const island = makeIsland();
    const tile = (q: number, r: number) => island.get(tileKey({ q, r }))!;
    const centers = Array.from(island.values()).map((t) => axialToWorld3D(t.coord.q, t.coord.r, 0));
    const nearestCenter = (p: { x: number; z: number }) =>
      Math.min(...centers.map((c) => Math.hypot(p.x - c.x, p.z - c.z)));
    const turnDeg = (a: Vector3, b: Vector3, c: Vector3) => {
      const ux = b.x - a.x;
      const uz = b.z - a.z;
      const vx = c.x - b.x;
      const vz = c.z - b.z;
      return (Math.abs(Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz)) * 180) / Math.PI;
    };
    const synthetic = [
      [tile(-1, 0), tile(0, 0), tile(1, 0), tile(2, 0)], // straight
      [tile(-1, 0), tile(0, 0), tile(1, -1), tile(1, -2)], // two 60° bends, same way
      [tile(-1, 0), tile(0, 0), tile(1, -1), tile(2, -1)], // S-bend
      [tile(-1, 0), tile(0, 0), tile(0, 1), tile(0, 2)], // sharp turn, then straight
    ].map((path) => edgeRoutePath(path, null, island).points);
    const grown = computeRiverPaths(island).map((p) => p.points);
    expect(grown.length).toBeGreaterThan(0);
    for (const points of [...synthetic, ...grown]) {
      // Body = everything between the spring and the end point (mouth / join).
      const body = points.slice(1, -1);
      expect(body.length).toBeGreaterThan(0);
      for (const p of body) expect(nearestCenter(p)).toBeCloseTo(HEX_SIZE, 3);
      for (let i = 1; i < body.length - 1; i++) {
        expect(turnDeg(body[i - 1]!, body[i]!, body[i + 1]!)).toBeLessThanOrEqual(60.001);
      }
    }
  });
});
