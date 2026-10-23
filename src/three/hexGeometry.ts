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
 *
 * `subdivide` adds the concentric top rings and 4-segment sides that the
 * terrain shader's per-vertex ramp + relief need (148 triangles). Meshes that
 * never displace vertices (fog cover) pass false and get the 20-triangle prism.
 */
export function createHexPrismGeometry(
  circumradius = HEX_SIZE,
  height = TILE_PRISM_HEIGHT,
  subdivide = true,
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

  // 1. Top face (CCW from +Y): subdivided into 4 concentric hex rings so the
  // inner plateau (r <= 0.55 * circumradius, where terrainShader's neighbor
  // elevation ramp weight smoothstep(0.55, 0.98, edgeT) is 0) stays flat at
  // the tile's own elevation while only the outer rim ramps to neighbors.
  // Without interior rings, the 6 corner vertices tented straight across the
  // hex centre — burying cities next to hills and dropping mountain tops
  // 18 units below their mountain props.
  const RING_FRACTIONS = [0.28, 0.55, 0.78, 1.0] as const;
  const EDGE_SEGMENTS = subdivide ? RING_FRACTIONS.length : 1; // segments per hex edge
  if (fullTop && subdivide) {
    const ringPoint = (wedge: number, ringIdx: number, step: number): [number, number, number] => {
      if (ringIdx === 0) return [0, 0, 0];
      const frac = RING_FRACTIONS[ringIdx - 1]!;
      const c0 = topRing[wedge]!;
      const c1 = topRing[(wedge + 1) % 6]!;
      const t = step / ringIdx;
      return [(c0[0] * (1 - t) + c1[0] * t) * frac, 0, (c0[2] * (1 - t) + c1[2] * t) * frac];
    };

    for (let w = 0; w < 6; w++) {
      for (let k = 1; k <= EDGE_SEGMENTS; k++) {
        for (let j = 0; j < k; j++) {
          const pInner0 = ringPoint(w, k - 1, j);
          const pOuter0 = ringPoint(w, k, j);
          const pOuter1 = ringPoint(w, k, j + 1);
          pushTri(pInner0, pOuter1, pOuter0);
          if (j < k - 1) {
            const pInner1 = ringPoint(w, k - 1, j + 1);
            pushTri(pInner0, pInner1, pOuter1);
          }
        }
      }
    }
  } else {
    for (let i = 1; i < 5; i++) {
      pushTri(topRing[0]!, topRing[i + 1]!, topRing[i]!);
    }
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

  // 4. Side faces (subdivided along each edge to match the 4-segment top rim)
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const t0 = outerTop[i]!;
    const t1 = outerTop[j]!;
    const b0 = bottom[i]!;
    const b1 = bottom[j]!;
    for (let s = 0; s < EDGE_SEGMENTS; s++) {
      const u0 = s / EDGE_SEGMENTS;
      const u1 = (s + 1) / EDGE_SEGMENTS;
      const ta: [number, number, number] = [
        t0[0] * (1 - u0) + t1[0] * u0,
        t0[1],
        t0[2] * (1 - u0) + t1[2] * u0,
      ];
      const tb: [number, number, number] = [
        t0[0] * (1 - u1) + t1[0] * u1,
        t0[1],
        t0[2] * (1 - u1) + t1[2] * u1,
      ];
      const ba: [number, number, number] = [
        b0[0] * (1 - u0) + b1[0] * u0,
        b0[1],
        b0[2] * (1 - u0) + b1[2] * u0,
      ];
      const bb: [number, number, number] = [
        b0[0] * (1 - u1) + b1[0] * u1,
        b0[1],
        b0[2] * (1 - u1) + b1[2] * u1,
      ];
      pushTri(ta, ba, bb);
      pushTri(ta, bb, tb);
    }
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geom;
}

/** Reusable unit hex for InstancedMesh (terrain: subdivided for the shader). */
export const sharedHexGeometry = createHexPrismGeometry(HEX_SIZE, TILE_PRISM_HEIGHT);

/** Same prism without subdivision, for undisplaced meshes (fog cover). */
export const sharedFlatHexGeometry = createHexPrismGeometry(HEX_SIZE, TILE_PRISM_HEIGHT, false);
