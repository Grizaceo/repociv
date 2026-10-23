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

  it('joins the two halves of a split edge end to end, without overlap', () => {
    // Halves of one vertical edge, split at z=0 as rebuildTerritoryLines does.
    const base = { x1: 10, x2: 10, cx: 0, cz: 0, y: 0 };
    const geom = buildRibbonGeometry(
      [
        { ...base, z1: -5, z2: 0, extendEnd: false },
        { ...base, z1: 0, z2: 5, extendStart: false },
      ],
      W,
      INSET,
    );
    const pos = geom.getAttribute('position').array as Float32Array;
    // 6 verts (18 floats) per half: first half's z range, then the second's.
    const zRange = (from: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < from + 18; i += 3) {
        lo = Math.min(lo, pos[i + 2]!);
        hi = Math.max(hi, pos[i + 2]!);
      }
      return [lo, hi] as const;
    };
    const [lo1, hi1] = zRange(0);
    const [lo2, hi2] = zRange(18);
    // Outer ends still mitre out by half a band; the shared midpoint does not.
    expect(lo1).toBeCloseTo(-5 - W / 2, 5);
    expect(hi1).toBeCloseTo(0, 5);
    expect(lo2).toBeCloseTo(0, 5);
    expect(hi2).toBeCloseTo(5 + W / 2, 5);
  });
});
