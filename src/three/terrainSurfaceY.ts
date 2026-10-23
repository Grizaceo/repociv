// ─── CPU mirror of terrain shader top-surface Y ─────────────────────────────
//
// 3D props (cities, wonders, units) are CPU-positioned while the terrain top
// face is GPU-displaced in terrainShader.ts. If props use only axialToWorld3D()
// they can sink into hills/desert dunes or float above depressions. This file
// mirrors the shader's centre/top-cap relief for object placement.
import { type Tile, type Terrain, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { HEX_SIZE } from '../constants.ts';
import { AXIAL_DIRECTIONS } from '../hex.ts';
import { axialToWorld3D, TILE_HEIGHT, world3DToAxialFraction } from './axialToWorld3D.ts';

/** Pre-scaled unit XZ directions toward each axial neighbor (matches uCoastDir
 *  in terrainShader.ts so dot(localXZ, dir) === 1.0 at the shared hex edge). */
const COAST_EDGE_DIRS: Array<{ x: number; z: number }> = AXIAL_DIRECTIONS.map((d) => {
  const origin = axialToWorld3D(0, 0, 0);
  const neighbor = axialToWorld3D(d.q, d.r, 0);
  const dx = neighbor.x - origin.x;
  const dz = neighbor.z - origin.z;
  const dist = Math.hypot(dx, dz);
  const half = dist / 2;
  return { x: dx / dist / half, z: dz / dist / half };
});

function fract(x: number): number {
  return x - Math.floor(x);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// GLSL hash21() mirror from terrainShader.ts.
function hash21(x: number, y: number): number {
  let px = fract(x * 123.34);
  let py = fract(y * 456.21);
  const d = px * (px + 45.32) + py * (py + 45.32);
  px += d;
  py += d;
  return fract(px * py);
}

function valueNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fract(x);
  const fy = fract(y);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function fbm3(x: number, y: number): number {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < 3; i++) {
    s += a * valueNoise2D(x, y);
    x *= 2;
    y *= 2;
    a *= 0.5;
  }
  return s;
}

function ridge3(x: number, y: number): number {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < 3; i++) {
    const n = 1 - Math.abs(valueNoise2D(x, y) * 2 - 1);
    s += a * n * n;
    x *= 2;
    y *= 2;
    a *= 0.5;
  }
  return s;
}

/** Shader-equivalent micro-relief at a world-space XZ point on one terrain tile,
 *  before the edge fade (terrainEdgeBlend) that terrainSurfaceY applies. */
export function terrainReliefAt(terrain: Terrain, worldX: number, worldZ: number): number {
  switch (terrain) {
    case 'plains': {
      const r = (fbm3(worldX * 0.04, worldZ * 0.04) - 0.5) * 2;
      return r * (HEX_SIZE * 0.03);
    }
    case 'forest': {
      const r = (fbm3(worldX * 0.05, worldZ * 0.05) - 0.5) * 2;
      return r * (HEX_SIZE * 0.04);
    }
    case 'mountain': {
      const r = ridge3(worldX * 0.06, worldZ * 0.06);
      return r * (HEX_SIZE * 0.12);
    }
    case 'desert': {
      const x = worldX * 0.03 + worldZ * 0.08;
      const y = worldZ * 0.02;
      const r = (fbm3(x, y) - 0.5) * 2;
      return r * (HEX_SIZE * 0.05);
    }
    case 'hills': {
      const r = ridge3(worldX * 0.055, worldZ * 0.055);
      return r * (HEX_SIZE * 0.08);
    }
    case 'sacred': {
      const r = (fbm3(worldX * 0.045, worldZ * 0.045) - 0.5) * 2;
      return r * (HEX_SIZE * 0.03);
    }
    // terrainShader.ts skips micro-relief for ocean and ice; ocean waves are
    // animated and not a stable placement surface for land props.
    case 'ocean':
    case 'ice':
    default:
      return 0;
  }
}

/** CPU mirror of terrainShader.ts's per-edge neighbor blend: the elevation
 *  ramp (world units) and the 0..1 fade that zeroes micro-relief toward edges
 *  shared with a different land biome. */
export function terrainEdgeBlend(
  tile: Tile,
  localX: number,
  localZ: number,
  getTile?: (key: string) => Tile | undefined,
): { rampY: number; reliefFade: number } {
  if (!getTile || tile.terrain === 'ocean' || tile.terrain === 'ice') {
    return { rampY: 0, reliefFade: 0 };
  }
  const thisElev = terrainElevation(tile.terrain);
  let rampSum = 0;
  let rampW = 0;
  let reliefFade = 0;
  for (let k = 0; k < 6; k++) {
    const d = AXIAL_DIRECTIONS[k]!;
    const n = getTile(tileKey({ q: tile.coord.q + d.q, r: tile.coord.r + d.r }));
    const nTerrain: Terrain = n ? n.terrain : tile.terrain;
    if (nTerrain === 'ocean' || nTerrain === 'ice') continue;
    const elevDiff = terrainElevation(nTerrain) - thisElev;
    const dir = COAST_EDGE_DIRS[k]!;
    const edgeT = Math.max(0, Math.min(1, localX * dir.x + localZ * dir.z));
    const w = smoothstep(0.55, 0.98, edgeT);
    rampSum += w * elevDiff;
    rampW += w;
    if (nTerrain !== tile.terrain) reliefFade = Math.max(reliefFade, w);
  }
  const rampY = rampW > 0.001 ? (rampSum / (1 + rampW)) * TILE_HEIGHT : 0;
  return { rampY, reliefFade };
}

/** CPU mirror of the per-edge neighbor elevation transition ramp in terrainShader.ts. */
export function terrainEdgeRampY(
  tile: Tile,
  localX: number,
  localZ: number,
  getTile?: (key: string) => Tile | undefined,
): number {
  return terrainEdgeBlend(tile, localX, localZ, getTile).rampY;
}

export function terrainSurfaceY(
  tile: Tile,
  localX = 0,
  localZ = 0,
  getTile?: (key: string) => Tile | undefined,
): number {
  const base = axialToWorld3D(tile.coord.q, tile.coord.r, terrainElevation(tile.terrain));
  const worldX = base.x + localX;
  const worldZ = base.z + localZ;
  const { rampY, reliefFade } = terrainEdgeBlend(tile, localX, localZ, getTile);
  return base.y + rampY + terrainReliefAt(tile.terrain, worldX, worldZ) * (1 - reliefFade);
}

/** Sample the highest terrain surface Y across a circular building/wall footprint
 *  so structures on sloped hills/mountains never get one side buried under a ridge. */
export function terrainFootprintMaxY(
  tile: Tile,
  localX: number,
  localZ: number,
  footprintRadius: number,
  getTile?: (key: string) => Tile | undefined,
): number {
  let maxY = terrainSurfaceY(tile, localX, localZ, getTile);
  if (footprintRadius <= 0.01) return maxY;
  const r = footprintRadius * 0.65;
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const y = terrainSurfaceY(tile, localX + Math.cos(a) * r, localZ + Math.sin(a) * r, getTile);
    if (y > maxY) maxY = y;
  }
  return maxY;
}

/** Exact terrain surface Y at an arbitrary world-space (worldX, worldZ) point.
 *  Checks the enclosing hex and any overlapping neighbor hex cap so river ribbons
 *  and bridges along hex boundaries always sit above the highest rendered cap. */
export function worldTerrainSurfaceY(
  worldX: number,
  worldZ: number,
  tiles: Map<string, Tile>,
): number {
  const frac = world3DToAxialFraction(worldX, worldZ);
  let rq = Math.round(frac.q);
  let rr = Math.round(frac.r);
  const rs = Math.round(-frac.q - frac.r);
  const dq = Math.abs(rq - frac.q);
  const dr = Math.abs(rr - frac.r);
  const ds = Math.abs(rs - (-frac.q - frac.r));
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;

  const getTile = (k: string) => tiles.get(k);
  const candidates = [
    { q: rq, r: rr },
    ...AXIAL_DIRECTIONS.map((d) => ({ q: rq + d.q, r: rr + d.r })),
  ];

  let bestY = -Infinity;
  for (const c of candidates) {
    const t = tiles.get(tileKey(c));
    if (!t) continue;
    const base = axialToWorld3D(t.coord.q, t.coord.r, terrainElevation(t.terrain));
    const lx = worldX - base.x;
    const lz = worldZ - base.z;
    // Check if (lx, lz) lies within the overlapped hex top cap (apothem ratio <= 1.04)
    let maxEdge = 0;
    for (let k = 0; k < 6; k++) {
      const dir = COAST_EDGE_DIRS[k]!;
      const edgeT = lx * dir.x + lz * dir.z;
      if (edgeT > maxEdge) maxEdge = edgeT;
    }
    if (maxEdge <= 1.06) {
      const y = terrainSurfaceY(t, lx, lz, getTile);
      if (y > bestY) bestY = y;
    }
  }
  if (bestY === -Infinity) {
    const centerTile = tiles.get(tileKey({ q: rq, r: rr }));
    if (centerTile) return terrainSurfaceY(centerTile, 0, 0, getTile);
    return 0;
  }
  return bestY;
}

/** Tiny lift above the exact GPU surface to avoid z-fighting/clipping. */
export const PROP_SURFACE_CLEARANCE = HEX_SIZE * 0.015;

// Keep this exported for tests and future visual placement math.
export const _testTerrainSurface = { hash21, valueNoise2D, fbm3, ridge3, smoothstep };
