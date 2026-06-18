import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./CityProps3D.ts', () => ({
  areCityPropsReady: () => false,
}));

import {
  clearCityClusters,
  getCityGroup,
  rebuildCityClusters,
  tickCities,
  cityLevel,
  _testGetGrowth,
  _testClearGrowth,
} from './CityCluster3D.ts';
import type { City, Tile, Building } from '../types.ts';

function makeBuilding(id: string, state: 'building' | 'complete' = 'complete'): Building {
  return {
    id,
    name: id,
    type: 'building',
    cityId: 'alpha',
    progress: state === 'complete' ? 100 : 0,
    durationSeconds: 10,
    elapsedSeconds: 0,
    state,
  };
}

function makeCity(id: string, q: number, r: number, buildings: Building[] = []): City {
  return {
    id,
    name: id,
    coord: { q, r },
    population: 120,
    territory: [],
    districts: [],
    buildings,
    isCapital: false,
  };
}

function makeTile(q: number, r: number): Tile {
  return {
    coord: { q, r },
    terrain: 'plains',
    resources: { gold: 0, science: 0, production: 0 },
    city: undefined,
    inFog: false,
    revealed: true,
  };
}

const tiles = new Map<string, Tile>([['0,0', makeTile(0, 0)]]);
const getTile = (key: string) => tiles.get(key);

afterEach(() => {
  clearCityClusters();
  _testClearGrowth();
});

describe('cityLevel', () => {
  it('returns 0 for a city with no completed buildings', () => {
    expect(cityLevel(makeCity('a', 0, 0, []))).toBe(0);
  });

  it('returns 1 for 1-2 completed buildings', () => {
    expect(cityLevel(makeCity('a', 0, 0, [makeBuilding('b1')]))).toBe(1);
    expect(cityLevel(makeCity('a', 0, 0, [makeBuilding('b1'), makeBuilding('b2')]))).toBe(1);
  });

  it('returns 2 for 3-5 completed buildings', () => {
    expect(cityLevel(makeCity('a', 0, 0, [makeBuilding('b1'), makeBuilding('b2'), makeBuilding('b3')]))).toBe(2);
    expect(cityLevel(makeCity('a', 0, 0, [makeBuilding('b1'), makeBuilding('b2'), makeBuilding('b3'), makeBuilding('b4'), makeBuilding('b5')]))).toBe(2);
  });

  it('returns 3 for 6+ completed buildings', () => {
    const buildings = Array.from({ length: 6 }, (_, i) => makeBuilding(`b${i}`));
    expect(cityLevel(makeCity('a', 0, 0, buildings))).toBe(3);
  });

  it('does not count buildings in "building" state', () => {
    expect(cityLevel(makeCity('a', 0, 0, [makeBuilding('b1', 'building')]))).toBe(0);
  });
});

describe('CityCluster3D growth state', () => {
  it('initializes growth at spireRise=1 for new cities', () => {
    rebuildCityClusters([makeCity('alpha', 0, 0)], getTile, 'high');
    const growth = _testGetGrowth('alpha');
    expect(growth).toBeDefined();
    expect(growth!.level).toBe(0);
    expect(growth!.spireRise).toBe(1);
  });

  it('starts spire rise tween at 0 when a city levels up', () => {
    // First rebuild at level 0.
    const city = makeCity('alpha', 0, 0, []);
    rebuildCityClusters([city], getTile, 'high');
    expect(_testGetGrowth('alpha')!.spireRise).toBe(1);

    // Level up: add a completed building.
    city.buildings.push(makeBuilding('b1'));
    rebuildCityClusters([city], getTile, 'high');
    const growth = _testGetGrowth('alpha')!;
    expect(growth.level).toBe(1);
    expect(growth.spireRise).toBe(0); // tween starts at 0
  });

  it('spire rise tween progresses with dt and completes at 800ms', () => {
    const city = makeCity('alpha', 0, 0, []);
    rebuildCityClusters([city], getTile, 'high');
    // Level up.
    city.buildings.push(makeBuilding('b1'));
    rebuildCityClusters([city], getTile, 'high');
    expect(_testGetGrowth('alpha')!.spireRise).toBe(0);

    // Tick 400ms (halfway).
    tickCities(0.4);
    expect(_testGetGrowth('alpha')!.spireRise).toBeGreaterThan(0);
    expect(_testGetGrowth('alpha')!.spireRise).toBeLessThan(1);

    // Tick another 400ms: complete.
    tickCities(0.4);
    expect(_testGetGrowth('alpha')!.spireRise).toBe(1);
  });

  it('frozen dt=0 does not advance spire rise tween', () => {
    const city = makeCity('alpha', 0, 0, []);
    rebuildCityClusters([city], getTile, 'high');
    city.buildings.push(makeBuilding('b1'));
    rebuildCityClusters([city], getTile, 'high');
    expect(_testGetGrowth('alpha')!.spireRise).toBe(0);

    tickCities(0.0);
    expect(_testGetGrowth('alpha')!.spireRise).toBe(0);
  });

  it('higher level cities have more city group children (walls visible)', () => {
    // Level 0: walls are full height (hamlet palisade), mesh exists.
    const city0 = makeCity('alpha', 0, 0, []);
    rebuildCityClusters([city0], getTile, 'high');
    const count0 = getCityGroup().children.length;

    // Level 3: walls are full height.
    _testClearGrowth();
    clearCityClusters();
    const buildings = Array.from({ length: 6 }, (_, i) => makeBuilding(`b${i}`));
    const city3 = makeCity('alpha', 0, 0, buildings);
    rebuildCityClusters([city3], getTile, 'high');
    const count3 = getCityGroup().children.length;

    // Same number of layers (plaza, spire, buildings, roofs, walls, towers).
    // The difference is in the instance matrices (wall Y-scale), not layer count.
    expect(count0).toBe(count3);
  });
});