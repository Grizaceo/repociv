import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Axial } from './hex.ts';
import {
  canRelocateCityTo,
  relocateCity,
  showMapLoadError,
} from './map.ts';
import type { City, Terrain, Tile, World } from './types.ts';
import { tileKey } from './types.ts';

describe('showMapLoadError', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders a visible alert instead of failing silently', () => {
    const appended: Array<{ id?: string; textContent?: string; role?: string }> = [];
    const element = {
      id: '',
      textContent: '',
      style: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        if (name === 'role') this.role = value;
      },
      role: '',
    };
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => element),
      body: { appendChild: (el: typeof element) => appended.push(el) },
    });

    showMapLoadError('No pude cargar repos reales: boom');

    expect(appended).toHaveLength(1);
    expect(appended[0]!.id).toBe('map-load-error');
    expect(appended[0]!.textContent).toContain('boom');
    expect(appended[0]!.role).toBe('alert');
  });
});

function baseTile(coord: Axial, terrain: Terrain, extra?: Partial<Tile>): Tile {
  return {
    coord,
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
    ...extra,
  };
}

function minimalWorldWithCity(center: Axial, target: Axial): { world: World; city: City } {
  const city: City = {
    id: 'repo-a',
    name: 'repo-a',
    coord: center,
    repoPath: '/tmp/repo-a',
    population: 1,
    territory: [center],
    districts: [],
    buildings: [],
    isCapital: false,
  };
  const tiles = new Map<string, Tile>();
  tiles.set(tileKey(center), baseTile(center, 'plains', { city }));
  tiles.set(tileKey(target), baseTile(target, 'plains'));

  const world: World = {
    tiles,
    cities: [city],
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: 0,
    restAreas: [],
  };
  return { world, city };
}

describe('canRelocateCityTo', () => {
  it('returns false when target equals current coord', () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    expect(canRelocateCityTo(world, city, { q: 0, r: 0 })).toBe(false);
  });

  it('returns false when destination tile is ocean', () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    const dest = world.tiles.get(tileKey({ q: 2, r: 0 }))!;
    dest.terrain = 'ocean';
    expect(canRelocateCityTo(world, city, { q: 2, r: 0 })).toBe(false);
  });

  it('returns false when another city occupies the destination', () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    const other: City = {
      id: 'repo-b',
      name: 'repo-b',
      coord: { q: 2, r: 0 },
      population: 1,
      territory: [{ q: 2, r: 0 }],
      districts: [],
      buildings: [],
      isCapital: false,
    };
    world.cities.push(other);
    world.tiles.set(tileKey({ q: 2, r: 0 }), baseTile({ q: 2, r: 0 }, 'plains', { city: other }));
    expect(canRelocateCityTo(world, city, { q: 2, r: 0 })).toBe(false);
  });

  it('returns false when destination hex does not exist', () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    world.tiles.delete(tileKey({ q: 2, r: 0 }));
    expect(canRelocateCityTo(world, city, { q: 2, r: 0 })).toBe(false);
  });

  it('returns true for a simple plains → plains move', () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    expect(canRelocateCityTo(world, city, { q: 2, r: 0 })).toBe(true);
  });

  it('returns false when a foreign unit stands on the destination', () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    world.units.push({
      id: 'u1',
      name: 'u1',
      type: 'scout',
      civ: 'x',
      coord: { q: 2, r: 0 },
      path: [],
      pathIndex: 0,
      pathProgress: 0,
      state: 'idle',
      speed: 1,
      color: '#fff',
      movesLeft: 2,
      maxMoves: 2,
      fatigue: 100,
      maxFatigue: 100,
      isResting: false,
      effectiveSpeed: 1,
    });
    expect(canRelocateCityTo(world, city, { q: 2, r: 0 })).toBe(false);
  });
});

describe('relocateCity', () => {
  beforeEach(() => {
    const ls: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls[k] ?? null,
      setItem: (k: string, v: string) => {
        ls[k] = v;
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false without mutating when target is invalid', async () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    world.tiles.delete(tileKey({ q: 2, r: 0 }));
    const ok = await relocateCity(world, city.id, { q: 2, r: 0 }, city.repoPath ?? null);
    expect(ok).toBe(false);
    expect(city.coord).toEqual({ q: 0, r: 0 });
  });

  it('moves city center, swaps tiles, and updates territory', async () => {
    const center = { q: 0, r: 0 };
    const dest = { q: 2, r: 0 };
    const { world, city } = minimalWorldWithCity(center, dest);

    const ok = await relocateCity(world, city.id, dest, city.repoPath ?? null);
    expect(ok).toBe(true);
    expect(city.coord).toEqual(dest);

    expect(world.tiles.get(tileKey(center))?.city).toBeUndefined();
    expect(world.tiles.get(tileKey(dest))?.city?.id).toBe(city.id);
    expect(city.territory.some((t) => t.q === dest.q && t.r === dest.r)).toBe(true);
    // reconnectCities runs inside map.ts; namespace spy does not intercept internal calls.
  });

  it('returns false when source and target are the same', async () => {
    const { world, city } = minimalWorldWithCity({ q: 0, r: 0 }, { q: 2, r: 0 });
    const ok = await relocateCity(world, city.id, { q: 0, r: 0 }, city.repoPath ?? null);
    expect(ok).toBe(false);
  });
});
