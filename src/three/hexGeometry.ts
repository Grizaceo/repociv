// ─── Flat-top hex prism geometry with beveled top edges ──────────────────────
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { HEX_SIZE } from '../constants.ts';
import { hexCornerAngle3D } from './axialToWorld3D.ts';

/** Side depth of terrain prism below the top face (world units).
 *  Must be ≥ TILE_HEIGHT (12) × max_elevation_steps (3) = 36 to close all inter-tier gaps.
 *  At 24 (= 2 elevation steps), hills/mountain prisms extend below plains level, eliminating float. */
export const TILE_PRISM_HEIGHT = 24;

/** Bevel depth: how far down the outer rim extends before the top face begins. */
const BEVEL_DEPTH = 0.24;

/** Top face radius as fraction of circumradius. Must be 1.0 for flat-top
 *  tiling — values below 1 leave triangular corner gaps where the ground
 *  plane shows through as a brown honeycomb. The bevel is vertical-only
 *  (same radius, lower Y); terrainShader flattens y > -1 to a continuous cap. */
const BEVEL_INSET = 1.0;

/** Slight overlap on the top ring so coplanar caps never leave sub-pixel
 *  gaps that show the clear colour / void between instanced prisms. */
const TOP_OVERLAP = 1.028;

/**
 * Extruded flat-top hex prism. Full circumradius top face tiles the plane
 * exactly with flat-top corner angles; terrainShader flattens any residual
 * bevel groove so adjacent caps share one continuous surface.
 */
export function createHexPrismGeometry(
  circumradius = HEX_SIZE,
  height = TILE_PRISM_HEIGHT,
): BufferGeometry {
  const r = circumradius;
  const fullTop = BEVEL_INSET >= 1.0;

  const top: Array<[number, number, number]> = [];
  const bottom: Array<[number, number, number]> = [];

  for (let i = 0; i < 6; i++) {
    const angle = hexCornerAngle3D(i);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    top.push([r * TOP_OVERLAP * cos, 0, r * TOP_OVERLAP * sin]);
    bottom.push([r * cos, -height, r * sin]);
  }

  // Legacy bevel rings — only when top face is radially inset (< 1.0).
  const outerTop: Array<[number, number, number]> = fullTop
    ? top.map(([x, y, z]) => [x / TOP_OVERLAP, y, z / TOP_OVERLAP] as [number, number, number])
    : top;
  const bevelRing: Array<[number, number, number]> = [];
  const innerTop: Array<[number, number, number]> = [];
  if (!fullTop) {
    const rInner = circumradius * BEVEL_INSET;
    const rBevel = circumradius * (1.0 + BEVEL_INSET) * 0.5;
    for (let i = 0; i < 6; i++) {
      const angle = hexCornerAngle3D(i);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      outerTop[i] = [r * cos, 0, r * sin];
      bevelRing.push([rBevel * cos, -BEVEL_DEPTH, rBevel * sin]);
      innerTop.push([rInner * cos, -BEVEL_DEPTH, rInner * sin]);
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  // Normalize by the overlapped extent so the visible top cap maps to exactly
  // [0,1] of its atlas cell. Without the TOP_OVERLAP factor the slightly-enlarged
  // top ring would push UVs past 1.0 and sample the neighbouring atlas column.
  const uvSpan = circumradius * 2 * TOP_OVERLAP;
  const toUv = (p: [number, number, number]): [number, number] => [
    0.5 + p[0] / uvSpan,
    0.5 + p[2] / uvSpan,
  ];

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ) => {
    positions.push(...a, ...b, ...c);
    const [au, av] = toUv(a);
    const [bu, bv] = toUv(b);
    const [cu, cv] = toUv(c);
    uvs.push(au, av, bu, bv, cu, cv);

    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const sn = [nx / len, ny / len, nz / len] as const;
    normals.push(...sn, ...sn, ...sn);
  };

  const topRing = fullTop ? top : innerTop;

  // 1. Top face (CCW from +Y)
  for (let i = 1; i < 5; i++) {
    pushTri(topRing[0]!, topRing[i + 1]!, topRing[i]!);
  }

  // 2. Bottom face
  for (let i = 1; i < 5; i++) {
    pushTri(bottom[0]!, bottom[i + 1]!, bottom[i]!);
  }

  // 3. Bevel ring (inset tops only)
  if (!fullTop) {
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      pushTri(outerTop[i]!, bevelRing[i]!, bevelRing[j]!);
      pushTri(outerTop[i]!, bevelRing[j]!, outerTop[j]!);
      pushTri(bevelRing[i]!, innerTop[i]!, innerTop[j]!);
      pushTri(bevelRing[i]!, innerTop[j]!, bevelRing[j]!);
    }
  }

  // 4. Side faces
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    pushTri(outerTop[i]!, bottom[i]!, bottom[j]!);
    pushTri(outerTop[i]!, bottom[j]!, outerTop[j]!);
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geom;
}

/** Reusable unit hex for InstancedMesh. */
export const sharedHexGeometry = createHexPrismGeometry(HEX_SIZE, TILE_PRISM_HEIGHT);
