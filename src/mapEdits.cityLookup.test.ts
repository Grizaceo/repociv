// ─── RepoCiv — shared unit→city lookup (C3) ──────────────────────────────────
// spawn.ts matched a unit to its city only by exact centre coord while
// inputs.ts used territory containment, so a worker standing on a district
// hex resolved no city in one path and the right one in the other. One
// helper, one semantic: territory contains OR exact coordinate.

import { describe, expect, it } from 'vitest';
import type { City } from './types.ts';
import { findCityForCoord } from './mapEdits.ts';

function city(coord: { q: number; r: number }, territory: Array<{ q: number; r: number }>): City {
  return { id: `c-${coord.q}-${coord.r}`, coord, territory } as unknown as City;
}

const CENTRE = city({ q: 0, r: 0 }, [
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
]);
const OTHER = city({ q: 5, r: 5 }, [{ q: 5, r: 5 }]);

describe('findCityForCoord', () => {
  it('matches the city centre hex exactly', () => {
    expect(findCityForCoord([CENTRE, OTHER], { q: 0, r: 0 })).toBe(CENTRE);
  });

  it('matches a non-centre territory tile', () => {
    expect(findCityForCoord([CENTRE, OTHER], { q: 1, r: 0 })).toBe(CENTRE);
    expect(findCityForCoord([CENTRE, OTHER], { q: 0, r: 1 })).toBe(CENTRE);
  });

  it('returns undefined outside every footprint', () => {
    expect(findCityForCoord([CENTRE, OTHER], { q: 3, r: 3 })).toBeUndefined();
    expect(findCityForCoord([], { q: 0, r: 0 })).toBeUndefined();
  });
});
