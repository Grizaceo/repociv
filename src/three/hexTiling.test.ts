import { describe, it, expect } from 'vitest';
import { AXIAL_DIRECTIONS, axialToPixel } from '../hex.ts';
import { HEX_SIZE } from '../constants.ts';
import { hexCornerAngle3D } from './axialToWorld3D.ts';

/** Edge index for each axial direction — mirrors HexWorldScene DIR_TO_EDGE. */
const DIR_TO_EDGE = [0, 5, 4, 3, 2, 1] as const;

function cornerWorld(q: number, r: number, corner: number, scale = 1): { x: number; z: number } {
  const c = axialToPixel({ q, r }, HEX_SIZE);
  const a = hexCornerAngle3D(corner);
  return {
    x: c.x + HEX_SIZE * scale * Math.cos(a),
    z: c.y + HEX_SIZE * scale * Math.sin(a),
  };
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('hex tiling', () => {
  it('shared edges between neighbors meet at both endpoints', () => {
    for (let d = 0; d < 6; d++) {
      const dir = AXIAL_DIRECTIONS[d]!;
      const nq = dir.q;
      const nr = dir.r;
      const e = DIR_TO_EDGE[d]!;
      const opp = (e + 3) % 6;

      const a1 = cornerWorld(0, 0, e);
      const a2 = cornerWorld(0, 0, (e + 1) % 6);
      const b1 = cornerWorld(nq, nr, opp);
      const b2 = cornerWorld(nq, nr, (opp + 1) % 6);

      const direct = dist(a1, b1) + dist(a2, b2);
      const crossed = dist(a1, b2) + dist(a2, b1);
      expect(Math.min(direct, crossed)).toBeLessThan(0.05);
    }
  });
});
