import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHexTerrain,
  findPlacedCityEntry,
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
import {
  applyMapEdits,
  eraseHexOp,
  foundCityOp,
  moveCityOp,
  paintHexOp,
  recalculateAllTerritories,
  relocateCity,
  removeCityOp,
  undoEraseHex,
  undoFoundCity,
  undoMoveCity,
  undoPaintHex,
  undoRemoveCity,
  type ScannedRepo,
} from './map.ts';
import { createNation, getNationStore, resetNationStoreCache } from './nations.ts';
import { logger } from './logger.ts';
import { loadManualLayout, upsertManualRepoEntry } from './manualLayout.ts';
import type { City, District, Terrain, Tile, Unit, World } from './types.ts';
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

function diskRepo(name: string, path: string, repoPath: string): ScannedRepo {
  return {
    name,
    path,
    repoPath,
    population: 12,
    extensions: {},
    gold: 1,
    lastCommitDays: 1,
    isLegacy: false,
    hasGit: true,
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

  it('keeps the city hex and frees its district tiles when it removes a city', () => {
    removeCityFromMap('/workspace/repociv');
    const target = city('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const district = {
      id: 'repociv-src',
      name: 'src',
      type: 'campus' as const,
      coord: { q: 1, r: 0 },
    };
    target.districts = [district];
    const world = worldWith(
      [target],
      [tile({ q: 0, r: 0 }), { ...tile({ q: 1, r: 0 }), district }],
    );

    applyMapEdits(world);

    expect(world.cities).toHaveLength(0);
    expect(world.tiles.has('0,0')).toBe(true);
    expect(world.tiles.get('0,0')?.city).toBeUndefined();
    expect(world.tiles.get('1,0')?.district).toBeUndefined();
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
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
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
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('extra'))).toBe(true);
    warn.mockRestore();
  });

  it('never re-places a city whose placement entry is in removedCities', () => {
    // Defensive: placeCity clears removedCities, but a stale store (or a
    // removal that only knew the absolute path) can leave both entries.
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 3, r: 0 } });
    removeCityFromMap('/workspace/extra');
    const world = worldWith([], [tile({ q: 3, r: 0 })]);
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
    expect(world.cities).toHaveLength(0);
  });

  it('places a city on the hex another city vacated (move entry first)', () => {
    // A is generated at (1,0) but was moved to (2,0); B was placed on the hex
    // A left. The placement must not see that hex as taken.
    placeCity({ repoPath: '/workspace/a', repoName: 'a', coord: { q: 2, r: 0 } });
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 1, r: 0 } });
    const a = city('/workspace/a', { q: 1, r: 0 }, '/workspace/a');
    const world = worldWith(
      [a],
      [tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 }), tile({ q: 3, r: 0 })],
    );

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

    expect(world.cities.find((c) => c.id === '/workspace/a')?.coord).toEqual({ q: 2, r: 0 });
    expect(world.cities.map((c) => c.id)).toContain('/workspace/extra');
    expect(world.cities.find((c) => c.id === '/workspace/extra')?.coord).toEqual({ q: 1, r: 0 });
  });

  it('places the city no matter the entry order (placed entry before the move)', () => {
    // placeCity updates an existing entry in place, so B's entry stays first
    // in the list even after it was moved.
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 3, r: 0 } });
    placeCity({ repoPath: '/workspace/a', repoName: 'a', coord: { q: 2, r: 0 } });
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 1, r: 0 } });
    expect(getMapEdits().placedCities.map((e) => e.repoPath)).toEqual([
      '/workspace/extra',
      '/workspace/a',
    ]);
    const a = city('/workspace/a', { q: 1, r: 0 }, '/workspace/a');
    const world = worldWith(
      [a],
      [tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 }), tile({ q: 3, r: 0 })],
    );

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

    expect(world.cities.find((c) => c.id === '/workspace/a')?.coord).toEqual({ q: 2, r: 0 });
    expect(world.cities.map((c) => c.id)).toContain('/workspace/extra');
    expect(world.cities.find((c) => c.id === '/workspace/extra')?.coord).toEqual({ q: 1, r: 0 });
  });

  it('founds a hand-placed city on an ocean hex painted to land', () => {
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 3, r: 0 } });
    setHexTerrain({ q: 3, r: 0 }, 'plains');
    const world = worldWith([], [tile({ q: 3, r: 0 }, 'ocean')]);

    applyMapEdits(world, [diskRepo('extra', '/workspace/extra', '/workspace/extra')]);

    expect(world.cities).toHaveLength(1);
    expect(world.tiles.get('3,0')?.terrain).toBe('plains');
  });

  it('refuses to found a hand-placed city on bare ocean and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 3, r: 0 } });
    const world = worldWith([], [tile({ q: 3, r: 0 }, 'ocean')]);

    applyMapEdits(world, [diskRepo('extra', '/workspace/extra', '/workspace/extra')]);

    expect(world.cities).toHaveLength(0);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('extra'))).toBe(true);
    warn.mockRestore();
  });

  it('does not duplicate another repo with the same name', () => {
    placeCity({ repoPath: '/a/api', repoName: 'api', coord: { q: 3, r: 0 } });
    // /b/api is already on the map; the entry belongs to /a/api.
    const b = city('api', { q: 1, r: 0 }, '/b/api');
    const world = worldWith([b], [tile({ q: 1, r: 0 }), tile({ q: 3, r: 0 })]);

    applyMapEdits(world, [diskRepo('api', 'b-id', '/b/api'), diskRepo('api', 'a-id', '/a/api')]);

    expect(world.cities.filter((c) => c.repoPath === '/b/api')).toHaveLength(1);
    expect(world.cities.find((c) => c.repoPath === '/a/api')?.coord).toEqual({ q: 3, r: 0 });
  });

  it('does not resurrect a city erased after its folder moved', () => {
    placeCity({ repoPath: '/old/api', repoName: 'api', coord: { q: 3, r: 0 } });
    removeCityFromMap('/new/api');
    const world = worldWith([], [tile({ q: 3, r: 0 })]);

    applyMapEdits(world, [diskRepo('api', 'api-id', '/new/api')]);

    expect(world.cities).toHaveLength(0);
  });

  it('still places a moved-folder city when its name is unique', () => {
    placeCity({ repoPath: '/old/api', repoName: 'api', coord: { q: 3, r: 0 } });
    const world = worldWith([], [tile({ q: 3, r: 0 })]);

    applyMapEdits(world, [diskRepo('api', 'api-id', '/new/api')]);

    expect(world.cities).toHaveLength(1);
    expect(world.cities[0]?.coord).toEqual({ q: 3, r: 0 });
    expect(world.cities[0]?.repoPath).toBe('/new/api');
  });

  it('does not guess when two repos share the name and no key matches', () => {
    placeCity({ repoPath: '/old/api', repoName: 'api', coord: { q: 3, r: 0 } });
    const world = worldWith([], [tile({ q: 3, r: 0 })]);

    applyMapEdits(world, [diskRepo('api', 'a-id', '/a/api'), diskRepo('api', 'b-id', '/b/api')]);

    expect(world.cities).toHaveLength(0);
  });

  it('moves in a chain regardless of the entry order', () => {
    // a goes to the hex b is standing on; b's own entry (the hex it leaves for)
    // comes after a's in the list.
    placeCity({ repoPath: '/w/a', repoName: 'a', coord: { q: 2, r: 0 } });
    placeCity({ repoPath: '/w/b', repoName: 'b', coord: { q: 3, r: 0 } });
    const a = city('a', { q: 1, r: 0 }, '/w/a');
    const b = city('b', { q: 2, r: 0 }, '/w/b');
    const world = worldWith([a, b], [tile({ q: 1, r: 0 }), tile({ q: 3, r: 0 })]);

    applyMapEdits(world);

    expect(b.coord).toEqual({ q: 3, r: 0 });
    expect(a.coord).toEqual({ q: 2, r: 0 });
  });

  it('warns when two cities cannot swap hexes', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // A pure swap has no free hex to route through: both stay where they are.
    placeCity({ repoPath: '/w/alfa', repoName: 'alfa', coord: { q: 2, r: 0 } });
    placeCity({ repoPath: '/w/beta', repoName: 'beta', coord: { q: 1, r: 0 } });
    const alfa = city('alfa', { q: 1, r: 0 }, '/w/alfa');
    const beta = city('beta', { q: 2, r: 0 }, '/w/beta');
    const world = worldWith([alfa, beta], [tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 })]);

    applyMapEdits(world);

    expect(alfa.coord).toEqual({ q: 1, r: 0 });
    expect(beta.coord).toEqual({ q: 2, r: 0 });
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('alfa'))).toBe(true);
    expect(messages.some((m) => m.includes('beta'))).toBe(true);
    warn.mockRestore();
  });
});

/** What a reload does: generate from the workspace + manual layout, then apply the edits. */
function reloadWorld(diskCities: City[], tiles: Tile[], diskRepos: ScannedRepo[] = []): World {
  const manual = loadManualLayout().entries;
  const cities = diskCities.map((c) => {
    const entry = manual.find(
      (e) =>
        e.repoPath === c.id ||
        e.repoPath === c.repoPath ||
        e.repoFsPath === c.repoPath ||
        e.repoFsPath === c.id,
    );
    return entry ? { ...c, coord: { q: entry.coord.q, r: entry.coord.r } } : c;
  });
  const world = worldWith(cities, tiles);
  applyMapEdits(world, diskRepos);
  return world;
}

describe('relocateCity persistence', () => {
  beforeEach(() => {
    stubStorage();
    resetMapEditsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMapEditsCache();
  });

  it('saves the move of a city that has a manual layout entry', async () => {
    upsertManualRepoEntry({
      repoPath: 'repociv', // stable id, the one the construction panel lists
      repoFsPath: '/workspace/repociv',
      repoName: 'repociv',
      coord: { q: 0, r: 0 },
      addedAt: Date.now(),
      source: 'manual',
    });
    const target = city('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const world = worldWith([target], [tile({ q: 0, r: 0 }), tile({ q: 4, r: 1 })]);

    expect(await relocateCity(world, target.id, { q: 4, r: 1 }, null)).not.toBeNull();
    expect(target.coord).toEqual({ q: 4, r: 1 });
    // The absolute path is the city key: it must not be replaced by the stable id.
    expect(target.repoPath).toBe('/workspace/repociv');
    expect(loadManualLayout().entries[0]?.coord).toEqual({ q: 4, r: 1 });

    const reloaded = reloadWorld(
      [city('repociv', { q: 0, r: 0 }, '/workspace/repociv')],
      [tile({ q: 0, r: 0 }), tile({ q: 4, r: 1 })],
    );
    expect(reloaded.cities[0]?.coord).toEqual({ q: 4, r: 1 });
  });

  it('saves the move of a city that came from placedCities', async () => {
    const repo: ScannedRepo = {
      name: 'extra',
      path: 'extra',
      repoPath: '/workspace/extra',
      population: 12,
      extensions: {},
      gold: 40,
      lastCommitDays: 1,
      isLegacy: false,
      hasGit: true,
    };
    placeCity({ repoPath: '/workspace/extra', repoName: 'extra', coord: { q: 3, r: 0 } });
    const target = city('extra', { q: 3, r: 0 }, '/workspace/extra');
    const world = worldWith([target], [tile({ q: 3, r: 0 }), tile({ q: 5, r: -1 })]);

    expect(await relocateCity(world, target.id, { q: 5, r: -1 }, null)).not.toBeNull();
    const placed = getMapEdits().placedCities;
    expect(placed).toHaveLength(1);
    expect(placed[0]?.coord).toEqual({ q: 5, r: -1 });

    // On reload the generated world has the city where it was placed; the
    // placement entry has to move it, not skip it because it already exists.
    const reloaded = reloadWorld(
      [city('extra', { q: 3, r: 0 }, '/workspace/extra')],
      [tile({ q: 3, r: 0 }), tile({ q: 5, r: -1 })],
      [repo],
    );
    expect(reloaded.cities).toHaveLength(1);
    expect(reloaded.cities[0]?.coord).toEqual({ q: 5, r: -1 });
  });

  it('saves the move of an auto-generated city without touching the manual list', async () => {
    const target = city('auto', { q: 2, r: 2 }, '/workspace/auto');
    const world = worldWith([target], [tile({ q: 2, r: 2 }), tile({ q: 6, r: 0 })]);

    expect(await relocateCity(world, target.id, { q: 6, r: 0 }, null)).not.toBeNull();
    // The construction panel lists manual layout entries: adding one here would
    // invent a "manually placed" city the user never picked.
    expect(loadManualLayout().entries).toHaveLength(0);

    const reloaded = reloadWorld(
      [city('auto', { q: 2, r: 2 }, '/workspace/auto')],
      [tile({ q: 2, r: 2 }), tile({ q: 6, r: 0 })],
    );
    expect(reloaded.cities[0]?.coord).toEqual({ q: 6, r: 0 });
  });

  it('moves the painted terrain with the city instead of leaving it behind', async () => {
    const target = city('auto', { q: 2, r: 2 }, '/workspace/auto');
    const world = worldWith([target], [tile({ q: 2, r: 2 }), tile({ q: 6, r: 0 })]);
    // H is painted desert, but the city brings its own (plains) terrain there.
    setHexTerrain({ q: 6, r: 0 }, 'desert');
    world.tiles.get('6,0')!.terrain = 'desert';

    expect(await relocateCity(world, target.id, { q: 6, r: 0 }, null)).not.toBeNull();
    const live = world.tiles.get('6,0')?.terrain;

    const reloaded = reloadWorld(
      [city('auto', { q: 2, r: 2 }, '/workspace/auto')],
      [tile({ q: 2, r: 2 }), tile({ q: 6, r: 0 })],
    );
    expect(reloaded.tiles.get('6,0')?.terrain).toBe(live);
  });

  it('carries the painted terrain of the city hex to the destination', async () => {
    const target = city('auto', { q: 2, r: 2 }, '/workspace/auto');
    const world = worldWith([target], [tile({ q: 2, r: 2 }), tile({ q: 6, r: 0 })]);
    setHexTerrain({ q: 2, r: 2 }, 'forest');
    world.tiles.get('2,2')!.terrain = 'forest';

    expect(await relocateCity(world, target.id, { q: 6, r: 0 }, null)).not.toBeNull();
    expect(world.tiles.get('6,0')?.terrain).toBe('forest');

    const reloaded = reloadWorld(
      [city('auto', { q: 2, r: 2 }, '/workspace/auto')],
      [tile({ q: 2, r: 2 }), tile({ q: 6, r: 0 })],
    );
    expect(reloaded.tiles.get('6,0')?.terrain).toBe('forest');
  });

  it('never overwrites repoPath with a stable id that is not a filesystem path', async () => {
    upsertManualRepoEntry({
      repoPath: 'legacy-id',
      repoName: 'legacy',
      coord: { q: 0, r: 0 },
      addedAt: Date.now(),
      source: 'manual',
    });
    const target = { ...city('legacy-id', { q: 0, r: 0 }, 'legacy-id'), repoPath: undefined };
    const world = worldWith([target], [tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 })]);

    expect(await relocateCity(world, target.id, { q: 1, r: 0 }, null)).not.toBeNull();
    expect(target.repoPath).toBeUndefined();
    expect(loadManualLayout().entries[0]?.coord).toEqual({ q: 1, r: 0 });
  });

  it('does not hand a path-keyed entry to another repo with the same name', () => {
    placeCity({ repoPath: '/a/api', repoName: 'api', coord: { q: 3, r: 0 } });
    // A different `api` folder: same name, different path. The entry belongs
    // to /a/api and must not be matched by name.
    expect(findPlacedCityEntry({ id: 'api', name: 'api', repoPath: '/b/api' })).toBeNull();
  });

  it('does not change the saved coordinate of a same-named repo', async () => {
    placeCity({ repoPath: '/a/api', repoName: 'api', coord: { q: 3, r: 0 } });
    const target = city('api', { q: 0, r: 0 }, '/b/api');
    const world = worldWith([target], [tile({ q: 0, r: 0 }), tile({ q: 2, r: 0 })]);

    expect(await relocateCity(world, target.id, { q: 2, r: 0 }, null)).not.toBeNull();
    const placed = getMapEdits().placedCities;
    expect(placed.find((e) => e.repoPath === '/a/api')?.coord).toEqual({ q: 3, r: 0 });
    expect(placed.find((e) => e.repoPath === '/b/api')?.coord).toEqual({ q: 2, r: 0 });
  });

  it('still falls back to the name for a single id-keyed entry', () => {
    // Entries keyed by a stable id have no path to compare: the name is the
    // only handle, and there is exactly one candidate.
    placeCity({ repoPath: 'legacy-api', repoName: 'api', coord: { q: 3, r: 0 } });
    const entry = findPlacedCityEntry({ id: 'api', name: 'api', repoPath: '/b/api' });
    expect(entry?.repoPath).toBe('legacy-api');
  });
});

// ─── Inverses ───────────────────────────────────────────────────────────────
// Every operation has an inverse that puts back exactly what it changed, in the
// world and in the saved store; redo is the operation again.

function settled(world: World): World {
  recalculateAllTerritories(world);
  return world;
}

function unitAt(id: string, coord: { q: number; r: number }): Unit {
  return {
    id,
    name: id,
    type: 'worker',
    civ: 'gris',
    coord,
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state: 'idle',
    speed: 1,
    color: '#fff',
    movesLeft: 1,
    maxMoves: 1,
    fatigue: 0,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
  };
}

function worldAndStores(world: World) {
  const tiles: Record<string, string> = {};
  for (const [key, tile] of world.tiles) {
    tiles[key] = `${tile.terrain}|${tile.city?.id ?? ''}|${tile.district?.id ?? ''}`;
  }
  const edits = getMapEdits();
  return {
    tiles,
    cities: world.cities
      .map((c) => ({
        id: c.id,
        coord: `${c.coord.q},${c.coord.r}`,
        districts: c.districts.map((d) => `${d.id}@${d.coord.q},${d.coord.r}`).sort().join(','),
        territory: c.territory.map((t) => `${t.q},${t.r}`).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    units: world.units.map((u) => `${u.id}@${u.coord.q},${u.coord.r}`).sort(),
    terrain: { ...edits.terrain },
    removedHexes: [...edits.removedHexes].sort(),
    removedCities: [...edits.removedCities].sort(),
    placed: edits.placedCities.map((p) => `${p.repoPath}@${p.coord.q},${p.coord.r}`).sort(),
    manual: loadManualLayout()
      .entries.map((e) => `${e.repoPath}@${e.coord.q},${e.coord.r}`)
      .sort(),
  };
}

describe('map edit inverses', () => {
  beforeEach(() => {
    stubStorage();
    resetMapEditsCache();
    resetNationStoreCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMapEditsCache();
    resetNationStoreCache();
  });

  const REC = { record: true };

  it('undoes and redoes painting a hex', () => {
    const world = settled(worldWith([], [tile({ q: 1, r: 0 })]));
    setHexTerrain({ q: 1, r: 0 }, 'forest');
    world.tiles.get('1,0')!.terrain = 'forest';
    const before = worldAndStores(world);

    const result = paintHexOp(world, { q: 1, r: 0 }, 'desert', REC)!;
    expect(world.tiles.get('1,0')?.terrain).toBe('desert');

    undoPaintHex(world, { q: 1, r: 0 }, result);
    expect(worldAndStores(world)).toEqual(before);

    expect(paintHexOp(world, { q: 1, r: 0 }, 'desert', REC)).not.toBeNull();
    expect(world.tiles.get('1,0')?.terrain).toBe('desert');
    expect(terrainOverrideFor({ q: 1, r: 0 })).toBe('desert');
  });

  it('undoes and redoes erasing a hex', () => {
    const world = settled(
      worldWith([city('a', { q: 0, r: 0 }, '/w/a')], [tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 })]),
    );
    const before = worldAndStores(world);

    const removed = eraseHexOp(world, { q: 1, r: 0 }, REC)!;
    expect(world.tiles.has('1,0')).toBe(false);

    undoEraseHex(world, removed);
    expect(worldAndStores(world)).toEqual(before);

    expect(eraseHexOp(world, { q: 1, r: 0 }, REC)).not.toBeNull();
    expect(world.tiles.has('1,0')).toBe(false);
  });

  it('undoes and redoes taking a hand-placed city off the map', () => {
    placeCity({ repoPath: '/w/extra', repoName: 'extra', coord: { q: 2, r: 0 } });
    const extra = city('extra', { q: 2, r: 0 }, '/w/extra');
    const world = settled(worldWith([extra], [tile({ q: 2, r: 0 })]));
    const before = worldAndStores(world);

    const removed = removeCityOp(world, extra, REC)!;
    expect(world.cities).toHaveLength(0);
    expect(getMapEdits().placedCities).toHaveLength(0);

    undoRemoveCity(world, removed);
    expect(worldAndStores(world)).toEqual(before);
    expect(isCityRemoved('/w/extra')).toBe(false);
    expect(getMapEdits().placedCities).toHaveLength(1);

    expect(removeCityOp(world, extra, REC)).not.toBeNull();
    expect(world.cities).toHaveLength(0);
    expect(getMapEdits().placedCities).toHaveLength(0);
  });

  it('undoes and redoes founding a city', () => {
    const world = settled(worldWith([], [tile({ q: 3, r: 0 }, 'forest')]));
    setHexTerrain({ q: 3, r: 0 }, 'forest');
    const repo = diskRepo('extra', 'extra-id', '/w/extra');
    const before = worldAndStores(world);

    const found = foundCityOp(world, repo, { q: 3, r: 0 }, REC)!;
    expect(world.cities).toHaveLength(1);
    expect(getMapEdits().placedCities).toHaveLength(1);

    undoFoundCity(world, found);
    expect(worldAndStores(world)).toEqual(before);
    expect(world.tiles.get('3,0')?.terrain).toBe('forest');

    expect(foundCityOp(world, repo, { q: 3, r: 0 }, REC)).not.toBeNull();
    expect(world.cities).toHaveLength(1);
    expect(getMapEdits().placedCities).toHaveLength(1);
  });

  it('undoes and redoes moving a city with districts and a unit', () => {
    const target = city('a', { q: 0, r: 0 }, '/w/a');
    const district = { id: 'a-d1', name: 'd1', type: 'campus' as const, coord: { q: 1, r: 0 } };
    target.districts = [district];
    const world = settled(
      worldWith(
        [target],
        [
          tile({ q: 0, r: 0 }),
          { ...tile({ q: 1, r: 0 }), district },
          tile({ q: 2, r: 0 }),
          tile({ q: 3, r: 0 }),
        ],
      ),
    );
    world.units.push(unitAt('MAIN', { q: 0, r: 0 }));
    const before = worldAndStores(world);

    const moved = moveCityOp(world, target, { q: 2, r: 0 }, REC)!;
    expect(target.coord).toEqual({ q: 2, r: 0 });
    expect(world.tiles.get('2,0')?.city).toBe(target);
    expect(world.units[0]?.coord).toEqual({ q: 2, r: 0 });

    undoMoveCity(world, moved);
    expect(worldAndStores(world)).toEqual(before);
    expect(world.tiles.get('1,0')?.district?.id).toBe('a-d1');
    expect(world.units[0]?.coord).toEqual({ q: 0, r: 0 });

    expect(moveCityOp(world, target, { q: 2, r: 0 }, REC)).not.toBeNull();
    expect(target.coord).toEqual({ q: 2, r: 0 });
    expect(world.units[0]?.coord).toEqual({ q: 2, r: 0 });
  });

  it('does not wipe a nation created between the edit and its undo', () => {
    const world = settled(worldWith([], [tile({ q: 1, r: 0 })]));
    const result = paintHexOp(world, { q: 1, r: 0 }, 'desert', REC)!;
    const nation = createNation('Imperio');

    undoPaintHex(world, { q: 1, r: 0 }, result);

    expect(getNationStore().nations.some((n) => n.id === nation.id)).toBe(true);
  });
});

// ─── Live edits and reload agree ────────────────────────────────────────────
// The property behind the shared operations: whatever the editor does with
// record: true must be exactly what applyMapEdits rebuilds on the next load.

const FIXTURE_REPOS: ScannedRepo[] = [
  {
    name: 'city-a',
    path: 'a-id',
    repoPath: '/w/a',
    population: 10,
    extensions: {},
    gold: 5,
    lastCommitDays: 1,
    isLegacy: false,
    hasGit: true,
  },
  {
    name: 'city-b',
    path: 'b-id',
    repoPath: '/w/b',
    population: 8,
    extensions: {},
    gold: 5,
    lastCommitDays: 1,
    isLegacy: false,
    hasGit: true,
  },
  {
    name: 'extra',
    path: 'extra-id',
    repoPath: '/w/extra',
    population: 6,
    extensions: {},
    gold: 5,
    lastCommitDays: 1,
    isLegacy: false,
    hasGit: true,
  },
];

const RECORD = { record: true };

function fixtureTile(
  coord: { q: number; r: number },
  terrain: Terrain,
  extra?: Partial<Tile>,
): Tile {
  return {
    coord,
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
    ...extra,
  };
}

/** Deterministic stand-in for generateWorld: fixed terrains, no Math.random. */
function fixtureWorld(): World {
  const districtsA: District[] = [
    { id: 'a-d1', name: 'd1', type: 'campus', coord: { q: -2, r: 1 } },
    { id: 'a-d2', name: 'd2', type: 'commercial', coord: { q: -2, r: 0 } },
  ];
  const districtsB: District[] = [
    { id: 'b-d1', name: 'd1', type: 'campus', coord: { q: 5, r: 0 } },
  ];
  const capital: City = {
    id: 'capital',
    name: 'Capital',
    coord: { q: 0, r: 0 },
    population: 1,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: true,
  };
  const a: City = {
    id: 'city-a',
    name: 'city-a',
    coord: { q: -3, r: 1 },
    repoPath: '/w/a',
    population: 10,
    territory: [],
    districts: districtsA,
    buildings: [],
    isCapital: false,
  };
  const b: City = {
    id: 'city-b',
    name: 'city-b',
    coord: { q: 4, r: 0 },
    repoPath: '/w/b',
    population: 8,
    territory: [],
    districts: districtsB,
    buildings: [],
    isCapital: false,
  };

  const tiles = new Map<string, Tile>();
  for (let q = -6; q <= 8; q++) {
    for (let r = -4; r <= 4; r++) {
      const terrain: Terrain = (q * 7 + r * 3) % 5 === 0 ? 'forest' : 'plains';
      tiles.set(tileKey({ q, r }), fixtureTile({ q, r }, terrain));
    }
  }
  // One ocean hex, for the "paint it to land, then found" sequence.
  tiles.set(tileKey({ q: -6, r: 3 }), fixtureTile({ q: -6, r: 3 }, 'ocean'));
  tiles.set('0,0', fixtureTile({ q: 0, r: 0 }, 'sacred', { city: capital }));
  tiles.set('-3,1', fixtureTile({ q: -3, r: 1 }, 'plains', { city: a }));
  tiles.set('4,0', fixtureTile({ q: 4, r: 0 }, 'plains', { city: b }));
  for (const d of districtsA)
    tiles.set(tileKey(d.coord), fixtureTile(d.coord, 'plains', { district: d }));
  for (const d of districtsB)
    tiles.set(tileKey(d.coord), fixtureTile(d.coord, 'plains', { district: d }));

  return {
    tiles,
    cities: [capital, a, b],
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: 0,
    restAreas: [],
  };
}

function cityIn(world: World, id: string): City {
  const city = world.cities.find((c) => c.id === id);
  if (!city) throw new Error(`no city ${id}`);
  return city;
}

/** What the player sees: terrain, who owns each hex, and each city's shape. */
function snapshotWorld(world: World) {
  const tiles: Record<string, string> = {};
  for (const [key, tile] of world.tiles) {
    tiles[key] = `${tile.terrain}|${tile.city?.id ?? ''}|${tile.district?.id ?? ''}`;
  }
  const cities = world.cities
    .map((c) => ({
      id: c.id,
      coord: `${c.coord.q},${c.coord.r}`,
      districts: c.districts
        .map((d) => `${d.id}@${d.coord.q},${d.coord.r}`)
        .sort()
        .join(','),
      territory: c.territory.map((t) => `${t.q},${t.r}`).sort(),
    }))
    .sort((x, y) => x.id.localeCompare(y.id));
  return { tiles, cities };
}

/** Apply the recorded edits to a fresh world, the way a reload does. */
function expectReloadMatches(live: World): void {
  // Guard against a vacuous pass: every sequence has to leave something saved.
  const edits = getMapEdits();
  const recorded =
    edits.removedCities.length +
    edits.removedHexes.length +
    edits.placedCities.length +
    Object.keys(edits.terrain).length;
  expect(recorded).toBeGreaterThan(0);

  const reloaded = fixtureWorld();
  applyMapEdits(reloaded, FIXTURE_REPOS);
  expect(snapshotWorld(reloaded)).toEqual(snapshotWorld(live));
}

describe('live edits and reload agree', () => {
  beforeEach(() => {
    stubStorage();
    resetMapEditsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMapEditsCache();
  });

  const H = { q: 6, r: -2 };

  it('paint H, then move a city onto H', () => {
    const live = fixtureWorld();
    paintHexOp(live, H, 'desert', RECORD);
    moveCityOp(live, cityIn(live, 'city-a'), H, RECORD);

    expectReloadMatches(live);
  });

  it('move a city onto H, then paint H', () => {
    const live = fixtureWorld();
    moveCityOp(live, cityIn(live, 'city-a'), H, RECORD);
    paintHexOp(live, H, 'desert', RECORD);

    expectReloadMatches(live);
  });

  it('paint a city hex, then move the city', () => {
    const live = fixtureWorld();
    paintHexOp(live, { q: -3, r: 1 }, 'forest', RECORD);
    moveCityOp(live, cityIn(live, 'city-a'), H, RECORD);

    expectReloadMatches(live);
  });

  it('move a city with districts far, and another one onto its own district', () => {
    const live = fixtureWorld();
    moveCityOp(live, cityIn(live, 'city-a'), H, RECORD);
    moveCityOp(live, cityIn(live, 'city-b'), { q: 5, r: 0 }, RECORD);

    expectReloadMatches(live);
  });

  it('move in a chain: A to a free hex, then B to the hex A left', () => {
    const live = fixtureWorld();
    moveCityOp(live, cityIn(live, 'city-a'), { q: -3, r: 0 }, RECORD);
    moveCityOp(live, cityIn(live, 'city-b'), { q: -3, r: 1 }, RECORD);

    expectReloadMatches(live);
  });

  it('paint an ocean hex to land, then found a city on it', () => {
    const live = fixtureWorld();
    const ocean = { q: -6, r: 3 };
    paintHexOp(live, ocean, 'plains', RECORD);
    foundCityOp(live, FIXTURE_REPOS[2]!, ocean, RECORD);

    expectReloadMatches(live);
  });

  it('remove a city with districts, then erase one of its freed district hexes', () => {
    const live = fixtureWorld();
    removeCityOp(live, cityIn(live, 'city-b'), RECORD);
    eraseHexOp(live, { q: 5, r: 0 }, RECORD);

    expectReloadMatches(live);
  });

  it('erase a hex next to a city, then found another city nearby', () => {
    const live = fixtureWorld();
    eraseHexOp(live, { q: -4, r: 1 }, RECORD);
    foundCityOp(live, FIXTURE_REPOS[2]!, { q: -5, r: 1 }, RECORD);

    expectReloadMatches(live);
  });
});
