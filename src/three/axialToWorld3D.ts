// ─── Axial hex coords → Three.js world space (XZ plane, Y = elevation) ─────
import { Vector3 } from 'three';
import { axialToPixel } from '../hex.ts';
import { HEX_SIZE } from '../constants.ts';

/** Vertical units per terrain elevation step (matches isoHex ISO_EXTRUDE_H). */
export const TILE_HEIGHT = 12;

/** Map axial (q,r) to world position; 2D pixel Y becomes 3D Z. */
export function axialToWorld3D(q: number, r: number, elev: number): Vector3 {
  const flat = axialToPixel({ q, r }, HEX_SIZE);
  return new Vector3(flat.x, elev * TILE_HEIGHT, flat.y);
}

/** Inverse: world XZ → fractional axial (no rounding). */
export function world3DToAxialFraction(x: number, z: number): { q: number; r: number } {
  const size = HEX_SIZE;
  const q = ((2 / 3) * x) / size;
  const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * z) / size;
  return { q, r };
}
