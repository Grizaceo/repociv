import { describe, it, expect } from 'vitest';
import {
  axialDistance,
  axialRing,
  axialRound,
  axialLine,
  spiralCoords,
  axialNeighbours,
  axialEquals,
} from './hex.ts';

describe('axialDistance', () => {
  it('returns 0 for same coord', () => {
    expect(axialDistance({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(0);
  });

  it('returns 1 for direct neighbour', () => {
    expect(axialDistance({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(1);
    expect(axialDistance({ q: 0, r: 0 }, { q: 0, r: 1 })).toBe(1);
  });

  it('handles negative coords', () => {
    expect(axialDistance({ q: -2, r: 1 }, { q: 2, r: -1 })).toBe(4);
  });

  it('is symmetric', () => {
    const a = { q: 3, r: -1 };
    const b = { q: -2, r: 4 };
    expect(axialDistance(a, b)).toBe(axialDistance(b, a));
  });

  it('diagonal is correct', () => {
    // In axial: (0,0) to (2,2) — cube distance
    expect(axialDistance({ q: 0, r: 0 }, { q: 2, r: 2 })).toBe(4);
  });
});

describe('axialRing', () => {
  it('returns [center] for radius 0', () => {
    const ring = axialRing({ q: 0, r: 0 }, 0);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toEqual({ q: 0, r: 0 });
  });

  it('returns 6 hexes for radius 1', () => {
    const ring = axialRing({ q: 0, r: 0 }, 1);
    expect(ring).toHaveLength(6);
    for (const h of ring) {
      expect(axialDistance({ q: 0, r: 0 }, h)).toBe(1);
    }
  });

  it('returns 18 hexes for radius 3', () => {
    const ring = axialRing({ q: 0, r: 0 }, 3);
    expect(ring).toHaveLength(18);
  });

  it('all hexes in ring are at correct distance', () => {
    for (const r of [1, 2, 3, 5]) {
      const ring = axialRing({ q: 1, r: -1 }, r);
      expect(ring).toHaveLength(r * 6);
      for (const h of ring) {
        expect(axialDistance({ q: 1, r: -1 }, h)).toBe(r);
      }
    }
  });
});

describe('axialRound', () => {
  it('rounds to nearest hex', () => {
    expect(axialRound({ q: 0.4, r: 0.4 })).toEqual({ q: 0, r: 1 });
    expect(axialRound({ q: 0.6, r: 0.3 })).toEqual({ q: 1, r: 0 });
  });

  it('handles exact hex coords', () => {
    expect(axialRound({ q: 2, r: -1 })).toEqual({ q: 2, r: -1 });
  });

  it('handles negative fractional coords', () => {
    const r = axialRound({ q: -0.6, r: -0.3 });
    expect(typeof r.q).toBe('number');
    expect(typeof r.r).toBe('number');
  });
});

describe('axialLine', () => {
  it('returns single hex for same start and end', () => {
    const line = axialLine({ q: 2, r: -1 }, { q: 2, r: -1 });
    expect(line).toHaveLength(1);
    expect(line[0]).toEqual({ q: 2, r: -1 });
  });

  it('includes start and end coords', () => {
    const start = { q: 0, r: 0 };
    const end = { q: 3, r: 0 };
    const line = axialLine(start, end);
    expect(axialEquals(line[0]!, start)).toBe(true);
    expect(axialEquals(line[line.length - 1]!, end)).toBe(true);
  });

  it('has correct length', () => {
    const line = axialLine({ q: 0, r: 0 }, { q: 4, r: 0 });
    expect(line).toHaveLength(5); // N+1 points
  });

  it('each step is a neighbour', () => {
    const line = axialLine({ q: 0, r: 0 }, { q: 3, r: -3 });
    for (let i = 1; i < line.length; i++) {
      expect(axialDistance(line[i - 1]!, line[i]!)).toBe(1);
    }
  });
});

describe('spiralCoords', () => {
  it('returns empty for count 0', () => {
    expect(spiralCoords({ q: 0, r: 0 }, 0)).toHaveLength(0);
  });

  it('returns [center] for count 1', () => {
    const s = spiralCoords({ q: 0, r: 0 }, 1);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({ q: 0, r: 0 });
  });

  it('returns 7 coords for count 7 (center + ring 1)', () => {
    expect(spiralCoords({ q: 0, r: 0 }, 7)).toHaveLength(7);
  });

  it('all coords are unique including across ring boundaries', () => {
    for (const n of [1, 7, 8, 9, 13, 19, 20, 37, 38, 61]) {
      const coords = spiralCoords({ q: 0, r: 0 }, n);
      const keys = new Set(coords.map(c => `${c.q},${c.r}`));
      expect(coords).toHaveLength(n);
      expect(keys.size).toBe(n);
    }
  });

  it('works from non-origin center', () => {
    const s = spiralCoords({ q: 5, r: -3 }, 7);
    expect(s[0]).toEqual({ q: 5, r: -3 });
    expect(s).toHaveLength(7);
  });
});

describe('axialNeighbours', () => {
  it('returns 6 neighbours', () => {
    const nb = axialNeighbours({ q: 0, r: 0 });
    expect(nb).toHaveLength(6);
  });

  it('all neighbours are at distance 1', () => {
    const nb = axialNeighbours({ q: 3, r: -2 });
    for (const n of nb) {
      expect(axialDistance({ q: 3, r: -2 }, n)).toBe(1);
    }
  });
});
