// ─── Axial hex coords → Three.js world space (XZ plane, Y = elevation) ─────
import { Vector3 } from 'three';
import { axialToPixel, pixelToAxialFraction } from '../hex.ts';
import { HEX_SIZE } from '../constants.ts';

/** Vertical units per terrain elevation step (matches isoHex ISO_EXTRUDE_H). */
export const TILE_HEIGHT = 12;

/** Hex corner angle for the 3D renderer (flat-top hexes, corners at 0°, 60°, …).
 *  The legacy isoHex.hexCornerAngle() puts corners at 60i−30° (pointy-top) —
 *  rotated 30° against the flat-top axial layout used by axialToPixel. With
 *  that mismatch the prisms leave ~7% of the plane uncovered (triangular gaps
 *  at every hex corner, showing the ground plane through) and overlap another
 *  ~8%. Flat-top corners tile the plane exactly. 2D/iso keeps the old angle. */
export function hexCornerAngle3D(index: number): number {
  return (Math.PI / 180) * (60 * index);
}

/** Map axial (q,r) to world position; 2D pixel Y becomes 3D Z. */
export function axialToWorld3D(q: number, r: number, elev: number): Vector3 {
  const flat = axialToPixel({ q, r }, HEX_SIZE);
  return new Vector3(flat.x, elev * TILE_HEIGHT, flat.y);
}

/** Inverse: world XZ → fractional axial (no rounding). Shares the 2D layout
 *  formula via hex.pixelToAxialFraction — XZ world coords use the same flat-top
 *  spacing as 2D pixels, so the inverse is identical at HEX_SIZE. */
export function world3DToAxialFraction(x: number, z: number): { q: number; r: number } {
  return pixelToAxialFraction(x, z, HEX_SIZE);
}
