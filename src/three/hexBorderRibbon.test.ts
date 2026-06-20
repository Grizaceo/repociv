import { describe, it, expect } from 'vitest';
import { buildRibbonGeometry } from './HexWorldScene.ts';
import { HEX_SIZE } from '../constants.ts';

// Production band params (mirror addBorderRibbon): thinner, inside-hugging.
const BORDER_BAND_W = HEX_SIZE * 0.1;
const W = BORDER_BAND_W * 0.7;
const INSET = W * 0.5 + HEX_SIZE * 0.012;

describe('culture border ribbon', () => {
  it('stays fully inside the owner frontier — no overhang into the neighbour tile', () => {
    // One vertical edge at x=10 of a tile centred at the origin: the inward
    // normal points in -x, so a vertex's signed offset past the frontier is
    // its projection onto that inward normal relative to the edge midpoint.
    const edge = { x1: 10, z1: -5, x2: 10, z2: 5, cx: 0, cz: 0, y: 0 };
    const geom = buildRibbonGeometry([edge], W, INSET);
    const pos = geom.getAttribute('position').array as Float32Array;

    const midx = 10;
    const midz = 0;
    const nx = -1; // inward (toward origin)
    const nz = 0;
    let minOff = Infinity;
    let maxOff = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const off = (pos[i]! - midx) * nx + (pos[i + 2]! - midz) * nz;
      minOff = Math.min(minOff, off);
      maxOff = Math.max(maxOff, off);
    }
    // No part of the band crosses the frontier (offset < 0) into the neighbour.
    expect(minOff).toBeGreaterThanOrEqual(-1e-4);
    // …and it never reaches deep enough to swallow the tile interior.
    expect(maxOff).toBeLessThanOrEqual(HEX_SIZE * 0.5);
  });
});
