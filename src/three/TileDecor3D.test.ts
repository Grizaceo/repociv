import { afterEach, describe, expect, it } from 'vitest';
import type { City, Tile } from '../types.ts';
import { clearTileDecor, getTileDecorGroup, rebuildTileDecor } from './TileDecor3D.ts';

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

describe('TileDecor3D plains', () => {
  // The old plains decor was a hash-gated scatter of green boxes ("grass
  // patches") and golden slabs ("farms") on ~45% of plains tiles. It carried
  // no game meaning and read as floating crates/planks at every zoom, so
  // plains now rely on the terrain surface alone.
  it('adds no placeholder boxes to plains tiles', () => {
    const plains: Tile[] = [];
    for (let q = -6; q <= 6; q++) {
      for (let r = -6; r <= 6; r++) {
        plains.push({ ...mountainTile(false), coord: { q, r }, terrain: 'plains' });
      }
    }
    rebuildTileDecor(plains, 'high');

    expect(getTileDecorGroup().children).toHaveLength(0);
  });
});

describe('TileDecor3D sacred stone circle', () => {
  // The capital always sits on a sacred tile; its 6-stone ring (r=0.3·HEX)
  // landed inside the KayKit castle footprint as bare tan pillars.
  it('skips the stone circle on a city tile (the capital)', () => {
    rebuildTileDecor([{ ...mountainTile(true), terrain: 'sacred' }], 'high');

    expect(getTileDecorGroup().children).toHaveLength(0);
  });

  it('keeps the stone circle on a free sacred tile', () => {
    rebuildTileDecor([{ ...mountainTile(false), terrain: 'sacred' }], 'high');

    expect(getTileDecorGroup().children.length).toBeGreaterThan(0);
  });
});
