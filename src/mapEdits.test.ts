import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHexTerrain,
  getMapEdits,
  isCityRemoved,
  isHexRemoved,
  placeCity,
  removeCityFromMap,
  removeHex,
  removePlacedCity,
  resetMapEditsCache,
  restoreCityToMap,
  restoreHex,
  setHexTerrain,
  terrainOverrideFor,
} from './mapEdits.ts';
import { applyMapEdits } from './map.ts';
import type { City, Tile, World } from './types.ts';
import { tileKey } from './types.ts';

function stubStorage(): void {
  const storage: Record<string, string> = {};
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  };
  vi.stubGlobal('window', { localStorage: localStorageMock });
  vi.stubGlobal('localStorage', localStorageMock);
}

function tile(
  coord: { q: number; r: number },
  terrain: Tile['terrain'] = 'plains',
  city?: City,
): Tile {
  return {
    coord,
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
    city,
  };
}

function city(id: string, coord: { q: number; r: number }, repoPath: string): City {
  return {
    id,
    name: id,
    coord,
    repoPath,
    population: 5,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
    color: [0.3, 0.3, 0.3],
  };
}

function worldWith(cities: City[], tiles: Tile[]): World {
  const map = new Map<string, Tile>();
  for (const t of tiles) map.set(tileKey(t.coord), t);
  // A city owns the hex it stands on — the world generator links them.
  for (const c of cities) {
    const key = tileKey(c.coord);
    const existing = map.get(key);
    map.set(key, existing ? { ...existing, city: c } : tile(c.coord, 'plains', c));
  }
  return {
    tiles: map,
    cities,
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: Date.now(),
    restAreas: [],
  };
}

describe('map edits store', () => {
  beforeEach(() => {
    stubStorage();
    resetMapEditsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMapEditsCache();
  });

  it('stores and clears a terrain override', () => {
    setHexTerrain({ q: 1, r: 2 }, 'mountain');
    expect(terrainOverrideFor({ q: 1, r: 2 })).toBe('mountain');
    clearHexTerrain({ q: 1, r: 2 });
    expect(terrainOverrideFor({ q: 1, r: 2 })).toBeNull();
  });

  it('refuses to paint a terrain that is not paintable', () => {
    setHexTerrain({ q: 1, r: 2 }, 'sacred');
    expect(terrainOverrideFor({ q: 1, r: 2 })).toBeNull();
  });

  it('removes and restores hexes', () => {
    removeHex({ q: 3, r: 3 });
    expect(isHexRemoved({ q: 3, r: 3 })).toBe(true);
    restoreHex({ q: 3, r: 3 });
    expect(isHexRemoved({ q: 3, r: 3 })).toBe(false);
  });

  it('takes a city off the map without touching the repo', () => {
    removeCityFromMap('/workspace/repociv');
    expect(isCityRemoved('/workspace/repociv')).toBe(true);
    restoreCityToMap('/workspace/repociv');
    expect(isCityRemoved('/workspace/repociv')).toBe(false);
  });

  it('remembers a hand-placed city and updates its position', () => {
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 2, r: 0 } });
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 4, r: 0 } });
    const placed = getMapEdits().placedCities;
    expect(placed).toHaveLength(1);
    expect(placed[0]?.coord).toEqual({ q: 4, r: 0 });
    removePlacedCity('/workspace/extra');
    expect(getMapEdits().placedCities).toHaveLength(0);
  });
});

describe('applyMapEdits', () => {
  beforeEach(() => {
    stubStorage();
    resetMapEditsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMapEditsCache();
  });

  it('removes a city from the world and its units', () => {
    removeCityFromMap('/workspace/repociv');
    const target = city('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const world = worldWith([target], [tile({ q: 0, r: 0 })]);
    world.units = [
      {
        id: 'MAIN',
        name: 'MAIN',
        type: 'hero',
        civ: 'gris',
        coord: { q: 0, r: 0 },
        path: [],
        pathIndex: 0,
        pathProgress: 0,
        state: 'idle',
        cityId: 'repociv',
        speed: 1,
        color: '#fff',
        movesLeft: 1,
        maxMoves: 1,
        fatigue: 0,
        maxFatigue: 100,
        isResting: false,
        effectiveSpeed: 1,
      },
    ];
    applyMapEdits(world);
    expect(world.cities).toHaveLength(0);
    expect(world.units).toHaveLength(0);
  });

  it('paints terrain and erases free hexes', () => {
    setHexTerrain({ q: 1, r: 0 }, 'forest');
    removeHex({ q: 2, r: 0 });
    const world = worldWith([], [tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 })]);
    applyMapEdits(world);
    expect(world.tiles.get('1,0')?.terrain).toBe('forest');
    expect(world.tiles.has('2,0')).toBe(false);
  });

  it('never erases the hex a city stands on', () => {
    removeHex({ q: 0, r: 0 });
    const target = city('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const world = worldWith([target], [tile({ q: 0, r: 0 })]);
    applyMapEdits(world);
    expect(world.tiles.has('0,0')).toBe(true);
  });

  it('places a hand-positioned city on a free hex', () => {
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 3, r: 0 } });
    const world = worldWith([], [tile({ q: 3, r: 0 })]);
    applyMapEdits(world, [
      {
        name: 'extra',
        path: '/workspace/extra',
        repoPath: '/workspace/extra',
        population: 12,
        extensions: { '.ts': 4 },
        gold: 40,
        lastCommitDays: 1,
        isLegacy: false,
        hasGit: true,
      },
    ]);
    expect(world.cities).toHaveLength(1);
    expect(world.cities[0]?.coord).toEqual({ q: 3, r: 0 });
  });

  it('skips a hand-placed city whose hex is already taken', () => {
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 0, r: 0 } });
    const target = city('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const world = worldWith([target], [tile({ q: 0, r: 0 })]);
    applyMapEdits(world, [
      {
        name: 'extra',
        path: '/workspace/extra',
        repoPath: '/workspace/extra',
        population: 12,
        extensions: {},
        gold: 40,
        lastCommitDays: 1,
        isLegacy: false,
        hasGit: true,
      },
    ]);
    expect(world.cities).toHaveLength(1);
  });
});
