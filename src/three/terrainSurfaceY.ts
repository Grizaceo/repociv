// ─── CPU mirror of terrain shader top-surface Y ─────────────────────────────
//
// 3D props (cities, wonders, units) are CPU-positioned while the terrain top
// face is GPU-displaced in terrainShader.ts. If props use only axialToWorld3D()
// they can sink into hills/desert dunes or float above depressions. This file
// mirrors the shader's centre/top-cap relief for object placement.
import { type Tile, type Terrain } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { HEX_SIZE } from '../constants.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';

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

/** Shader-equivalent micro-relief at a world-space XZ point on one terrain tile.
 *  Edge transition ramps are intentionally not mirrored: city buildings and
 *  units are placed near tile centres, where the shader ramp has zero weight. */
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

export function terrainSurfaceY(tile: Tile, localX = 0, localZ = 0): number {
  const base = axialToWorld3D(tile.coord.q, tile.coord.r, terrainElevation(tile.terrain));
  const worldX = base.x + localX;
  const worldZ = base.z + localZ;
  return base.y + terrainReliefAt(tile.terrain, worldX, worldZ);
}

/** Tiny lift above the exact GPU surface to avoid z-fighting/clipping. */
export const PROP_SURFACE_CLEARANCE = HEX_SIZE * 0.015;

// Keep this exported for tests and future visual placement math.
export const _testTerrainSurface = { hash21, valueNoise2D, fbm3, ridge3, smoothstep };
