import { afterEach, describe, expect, it } from 'vitest';
import type { City, Tile } from '../types.ts';
import {
  clearTileDecor,
  getTileDecorGroup,
  rebuildTileDecor,
} from './TileDecor3D.ts';

function baseCity(): City {
  return {
    id: 'city-1',
    name: 'Mountain City',
    coord: { q: 0, r: 0 },
    population: 1,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
  };
}

function mountainTile(withCity = false): Tile {
  return {
    coord: { q: 0, r: 0 },
    terrain: 'mountain',
    city: withCity ? baseCity() : undefined,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
  };
}

afterEach(() => {
  clearTileDecor();
});

describe('TileDecor3D mountain decor', () => {
  it('builds mountain peak meshes for non-city mountain tiles', () => {
    rebuildTileDecor([mountainTile(false)], 'medium');

    const group = getTileDecorGroup();
    expect(group.children).toHaveLength(2);
    const counts = group.children.map((child) => (child as { count?: number }).count ?? 0);
    expect(counts).toEqual([2, 2]);
  });

  it('keeps visible mountain peak meshes for city mountain tiles', () => {
    rebuildTileDecor([mountainTile(true)], 'medium');

    const group = getTileDecorGroup();
    expect(group.children).toHaveLength(2);
    const counts = group.children.map((child) => (child as { count?: number }).count ?? 0);
    expect(counts).toEqual([2, 2]);
  });
});
