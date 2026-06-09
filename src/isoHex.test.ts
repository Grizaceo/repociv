import { describe, it, expect } from 'vitest';
import {
  axialToIsoPixel,
  screenToAxial,
  terrainElevation,
  ISO_EXTRUDE_H,
  ISO_HEX_RADIUS,
} from './isoHex.ts';
import { axialToPixel, type Camera } from './hex.ts';

describe('terrainElevation', () => {
  it('assigns expected steps', () => {
    expect(terrainElevation('mountain')).toBe(3);
    expect(terrainElevation('hills')).toBe(2);
    expect(terrainElevation('forest')).toBe(1);
    expect(terrainElevation('plains')).toBe(0);
    expect(terrainElevation('ocean')).toBe(-1);
  });
});

describe('screenToAxial roundtrip', () => {
  const cam: Camera = { x: 120, y: 80, cx: 640, cy: 360, zoom: 1.25 };
  const size = 52;

  const cases: Array<{ q: number; r: number }> = [
    { q: 0, r: 0 },
    { q: 3, r: -2 },
    { q: -4, r: 5 },
    { q: 7, r: 1 },
    { q: -2, r: -3 },
  ];

  for (const coord of cases) {
    it(`roundtrips (${coord.q}, ${coord.r}) at zoom ${cam.zoom}`, () => {
      const center = axialToIsoPixel(coord.q, coord.r, size, 0);
      const screenX = cam.cx + (center.x - cam.x) * cam.zoom;
      const screenY = cam.cy + (center.y - cam.y) * cam.zoom;
      const picked = screenToAxial(screenX, screenY, size, cam);
      expect(picked.q).toBe(coord.q);
      expect(picked.r).toBe(coord.r);
    });
  }

  it('roundtrips at multiple zoom levels', () => {
    const coord = { q: 2, r: -1 };
    for (const zoom of [0.3, 0.75, 1, 1.5, 2.5]) {
      const c = { ...cam, zoom };
      const center = axialToIsoPixel(coord.q, coord.r, size, 0);
      const sx = c.cx + (center.x - c.x) * c.zoom;
      const sy = c.cy + (center.y - c.y) * c.zoom;
      const picked = screenToAxial(sx, sy, size, c);
      expect(picked).toEqual(coord);
    }
  });
});

describe('axialToIsoPixel', () => {
  it('applies elevation offset upward on screen', () => {
    const base = axialToIsoPixel(1, 0, 52, 0);
    const raised = axialToIsoPixel(1, 0, 52, 2);
    expect(raised.y).toBeLessThan(base.y);
    expect(raised.y - base.y).toBeCloseTo(-2 * ISO_EXTRUDE_H, 5);
  });

  it('preserves flat hex grid spacing (no Y compression overlap)', () => {
    const iso = axialToIsoPixel(0, 1, 52, 0);
    const flat = axialToPixel({ q: 0, r: 1 }, 52);
    expect(iso.x).toBeCloseTo(flat.x, 5);
    expect(iso.y).toBeCloseTo(flat.y, 5);
  });

  it('uses reduced radius to prevent overlap', () => {
    expect(ISO_HEX_RADIUS).toBeLessThan(0.92);
  });
});
