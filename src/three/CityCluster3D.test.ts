import { afterEach, describe, expect, it, vi } from 'vitest';
import { IcosahedronGeometry, type InstancedMesh } from 'three';

// Mutable readiness flags so a test can flip the KayKit props/walls from
// "loading" to "ready" between two rebuilds, the way the async GLB load does.
const kit = vi.hoisted(() => ({ propsReady: false, wallsReady: false }));

vi.mock('./CityProps3D.ts', () => ({
  areCityPropsReady: () => kit.propsReady,
}));

vi.mock('./CityWalls3D.ts', () => ({
  areCityWallsReady: () => kit.wallsReady,
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
  kit.propsReady = false;
  kit.wallsReady = false;
});

/** Live instances across every mesh in the city group. */
function instanceTotal(): number {
  return getCityGroup().children.reduce((n, c) => n + (c as InstancedMesh).count, 0);
}

describe('CityCluster3D civic framing', () => {
  it('high-detail normal cities include the civic plaza and spire layers that keep walls visually ordered', () => {
    const city = makeCity('alpha', 0, 0);
    const tiles = new Map<string, Tile>([['0,0', makeTile(0, 0)]]);

    rebuildCityClusters([city], (key) => tiles.get(key), 'high');

    // Expected layers for one non-capital city in the restored Civ V stack:
    // plaza, spire, buildings, roofs, walls, towers, towerRoofs.
    expect(getCityGroup().children.length).toBe(7);
  });
});

describe('CityCluster3D procedural fallback retires when the KayKit kit lands', () => {
  // Regression: the cluster signature ignored kit readiness, so a world whose
  // first rebuild ran before the GLBs settled kept the procedural capital
  // (cream keep + icosahedron dome + star cone + 6 brown towers) and the
  // procedural corner towers forever, stacked under the KayKit models.
  it('drops the procedural capital compound once city props are ready', () => {
    const capital = { ...makeCity('cap', 0, 0), isCapital: true };
    const tiles = new Map<string, Tile>([['0,0', makeTile(0, 0)]]);

    rebuildCityClusters([capital], (key) => tiles.get(key), 'high');
    const hasDome = () =>
      getCityGroup().children.some(
        (c) => (c as InstancedMesh).geometry instanceof IcosahedronGeometry,
      );
    expect(hasDome()).toBe(true);

    kit.propsReady = true;
    kit.wallsReady = true;
    rebuildCityClusters([capital], (key) => tiles.get(key), 'high');

    expect(hasDome()).toBe(false);
  });

  it('drops procedural walls and corner towers once the wall kit is ready', () => {
    const city = makeCity('alpha', 0, 0);
    const tiles = new Map<string, Tile>([['0,0', makeTile(0, 0)]]);

    rebuildCityClusters([city], (key) => tiles.get(key), 'high');
    const before = instanceTotal();

    kit.propsReady = true;
    kit.wallsReady = true;
    rebuildCityClusters([city], (key) => tiles.get(key), 'high');

    // Only the (collapsed) plaza survives: no buildings, roofs, spire, wall
    // ring or towers. A wall-ring instance left at its identity matrix would
    // render at the world origin, so it must not be allocated at all.
    expect(instanceTotal()).toBeLessThan(before);
    expect(instanceTotal()).toBe(1);
  });
});
