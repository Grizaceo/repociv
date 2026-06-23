import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./CityProps3D.ts', () => ({
  areCityPropsReady: () => false,
}));

import { clearCityClusters, getCityGroup, rebuildCityClusters } from './CityCluster3D.ts';
import type { City, Tile } from '../types.ts';

function makeCity(id: string, q: number, r: number): City {
  return {
    id,
    name: id,
    coord: { q, r },
    population: 120,
    territory: [],
    districts: [],
    buildings: [],
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

afterEach(() => {
  clearCityClusters();
});

describe('CityCluster3D civic framing', () => {
  it('high-detail normal cities include the civic plaza and spire layers that keep walls visually ordered', () => {
    const city = makeCity('alpha', 0, 0);
    const tiles = new Map<string, Tile>([['0,0', makeTile(0, 0)]]);

    rebuildCityClusters([city], (key) => tiles.get(key), 'high');

    // Expected layers for one non-capital city in the restored Civ V stack:
    // plaza, spire, buildings, roofs, walls, towers.
    expect(getCityGroup().children.length).toBe(6);
  });
});
