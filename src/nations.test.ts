import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyNationsToWorld,
  assignCityToNation,
  createNation,
  deleteNation,
  getNationStore,
  hexToRgb01,
  nationForCity,
  resetNationStoreCache,
  rgb01ToHex,
  territoryColorFor,
  updateNation,
} from './nations.ts';
import type { City, World } from './types.ts';

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

function city(overrides: Partial<City> = {}): City {
  return {
    id: 'repociv',
    name: 'repociv',
    coord: { q: 0, r: 0 },
    repoPath: '/workspace/repociv',
    population: 10,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
    color: [0.2, 0.4, 0.6],
    ...overrides,
  };
}

describe('nations store', () => {
  beforeEach(() => {
    stubStorage();
    resetNationStoreCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNationStoreCache();
  });

  it('creates a nation with a palette color and no duplicates', () => {
    const first = createNation('Imperio');
    const second = createNation('Liga del Norte');
    expect(first.color).not.toBe(second.color);
    expect(getNationStore().nations).toHaveLength(2);
  });

  it('normalizes the name and rejects malformed colors on update', () => {
    const nation = createNation('  barbarie  ');
    expect(nation.name).toBe('barbarie');
    const updated = updateNation(nation.id, { color: 'not-a-color' });
    expect(updated?.color).toBe(nation.color);
  });

  it('assigns a city to a nation and resolves its territory color', () => {
    const nation = createNation('Imperio', '#4a70b8');
    const target = city();
    assignCityToNation('/workspace/repociv', nation.id);
    expect(nationForCity(target)?.id).toBe(nation.id);
    expect(territoryColorFor(target)).toEqual(hexToRgb01('#4a70b8'));
  });

  it('keeps the city color when the city has no nation', () => {
    const target = city();
    expect(territoryColorFor(target)).toEqual([0.2, 0.4, 0.6]);
  });

  it('unassigns every city when a nation is deleted', () => {
    const nation = createNation('Imperio');
    assignCityToNation('/workspace/repociv', nation.id);
    expect(deleteNation(nation.id)).toBe(true);
    expect(getNationStore().assignments['/workspace/repociv']).toBeUndefined();
    expect(nationForCity(city())).toBeNull();
  });

  it('re-applies the nation layer onto a regenerated world', () => {
    const nation = createNation('Imperio');
    assignCityToNation('/workspace/repociv', nation.id);
    const world: World = {
      tiles: new Map(),
      cities: [city()],
      units: [],
      buildings: [],
      resources: { gold: 0, science: 0, production: 0 },
      generatedAt: Date.now(),
      restAreas: [],
    };
    applyNationsToWorld(world);
    expect(world.cities[0]?.nationId).toBe(nation.id);
  });

  it('falls back to an empty store when the payload is corrupt', () => {
    window.localStorage.setItem('repociv:nations:v1', '{not json');
    resetNationStoreCache();
    expect(getNationStore().nations).toEqual([]);
  });
});

describe('nation colors', () => {
  it('round-trips hex and rgb', () => {
    expect(rgb01ToHex(hexToRgb01('#3d948c'))).toBe('#3d948c');
  });

  it('parses a hex color into 0-1 channels', () => {
    const [r, g, b] = hexToRgb01('#ffffff');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(1);
  });
});
