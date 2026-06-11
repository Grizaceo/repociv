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

/** Bevel inset: top face radius as fraction of circumradius. */
const BEVEL_INSET = 0.96;

/**
 * Extruded flat-top hex prism with beveled top edges.
 * Top face is inset slightly; a slanted ring connects the outer rim to the inner top face.
 * This eliminates the sharp "floating island" silhouette.
 */
export function createHexPrismGeometry(
  circumradius = HEX_SIZE,
  height = TILE_PRISM_HEIGHT,
): BufferGeometry {
  const rOuter = circumradius;
  const rInner = circumradius * BEVEL_INSET;
  const rBevel = circumradius * (1.0 + BEVEL_INSET) * 0.5;

  // Vertices: outer top ring, bevel mid ring, inner top ring, bottom ring
  const outerTop: Array<[number, number, number]> = [];
  const bevelRing: Array<[number, number, number]> = [];
  const innerTop: Array<[number, number, number]> = [];
  const bottom: Array<[number, number, number]> = [];

  for (let i = 0; i < 6; i++) {
    const angle = hexCornerAngle3D(i);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    outerTop.push([rOuter * cos, 0, rOuter * sin]);
    bevelRing.push([rBevel * cos, -BEVEL_DEPTH, rBevel * sin]);
    innerTop.push([rInner * cos, -BEVEL_DEPTH, rInner * sin]);
    bottom.push([rOuter * cos, -height, rOuter * sin]);
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const toUv = (p: [number, number, number]): [number, number] => [
    0.5 + p[0] / (circumradius * 2),
    0.5 + p[2] / (circumradius * 2),
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

  // 1. Inner top face (CCW from +Y)
  for (let i = 1; i < 5; i++) {
    pushTri(innerTop[0]!, innerTop[i + 1]!, innerTop[i]!);
  }

  // 2. Bottom face
  for (let i = 1; i < 5; i++) {
    pushTri(bottom[0]!, bottom[i + 1]!, bottom[i]!);
  }

  // 3. Bevel ring: outerTop → bevelRing → innerTop (two tris per side)
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    // Slanted bevel face (outer edge)
    pushTri(outerTop[i]!, bevelRing[i]!, bevelRing[j]!);
    pushTri(outerTop[i]!, bevelRing[j]!, outerTop[j]!);
    // Top bevel face connecting to inner top
    pushTri(bevelRing[i]!, innerTop[i]!, innerTop[j]!);
    pushTri(bevelRing[i]!, innerTop[j]!, bevelRing[j]!);
  }

  // 4. Side faces (outerTop → bottom)
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
