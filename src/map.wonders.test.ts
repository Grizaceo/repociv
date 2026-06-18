// ─── RepoCiv — syncWorldWonders (live map reconcile) tests ───────────────────
//
// Verifies that connecting/disconnecting a wonder reconciles the live world's
// capital (tiles + districts + buildings) so the Maravilla shows up on the map
// without a full reload.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { syncWorldWonders, assignWonderCoords } from './map.ts';
import { loadWonders, invalidateWondersCache } from './wonders/manifest.ts';
import { tileKey, type World, type City, type Tile } from './types.ts';
import type { WonderManifest } from './wonders/types.ts';

function iframeManifest(id: string): WonderManifest {
  return {
    id,
    title: id === 'bibliotheca' ? 'Bibliotheca Alexandrina' : id,
    kind: 'iframe',
    category: 'knowledge',
    version: '0.1.0',
    defaultEnabled: true,
    automationLevel: 'passive',
    passiveMode: true,
    agenticMode: false,
    canSuggest: false,
    canAct: false,
    requiresConfirmation: true,
    ui: { url: 'http://127.0.0.1:9998' },
    permissions: {
      readRepos: false,
      writeRepos: false,
      network: 'loopback-only',
      requiresApprovalForMutations: true,
    },
    optionalFeatures: [],
    actions: [{ id: 'open', label: 'Abrir', risk: 'safe', requiresUserOptIn: false }],
    events: { emits: ['wonder.ready'], accepts: [] },
    mcp: { enabled: false, server: null },
  };
}

async function hydrate(ids: string[]) {
  invalidateWondersCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ids.map(iframeManifest) })),
  );
  await loadWonders(true);
}

function capitalWorld(): World {
  const capital: City = {
    id: 'capital',
    name: 'Capital',
    coord: { q: 0, r: 0 },
    population: 1,
    territory: [
      { q: -1, r: 0 },
      { q: 1, r: 0 },
    ],
    districts: [],
    buildings: [],
    wonders: [],
    isCapital: true,
  };
  const tiles = new Map<string, Tile>();
  tiles.set(tileKey({ q: 0, r: 0 }), {
    coord: { q: 0, r: 0 },
    terrain: 'sacred',
    city: capital,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
  });
  for (const c of capital.territory) {
    tiles.set(tileKey(c), {
      coord: c,
      terrain: 'plains',
      resources: { gold: 0, science: 0, production: 0 },
      inFog: false,
      revealed: true,
    });
  }
  return {
    tiles,
    cities: [capital],
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: 0,
    restAreas: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateWondersCache();
});

describe('syncWorldWonders', () => {
  it('adds a connected wonder as a sacred district tile on the capital', async () => {
    await hydrate(['bibliotheca']);
    const world = capitalWorld();
    const changed = syncWorldWonders(world);
    expect(changed).toBe(true);

    const coord = assignWonderCoords([iframeManifest('bibliotheca')])[0]!.coord;
    const tile = world.tiles.get(tileKey(coord))!;
    expect(tile.terrain).toBe('sacred');
    expect(tile.district?.type).toBe('wonder');
    expect(tile.district?.wonderType).toBe('bibliotheca');

    const capital = world.cities.find((c) => c.isCapital)!;
    expect(capital.districts.some((d) => d.wonderType === 'bibliotheca')).toBe(true);
    expect(capital.wonders?.some((b) => b.wonderType === 'bibliotheca')).toBe(true);
  });

  it('is idempotent — re-syncing the same set changes nothing', async () => {
    await hydrate(['bibliotheca']);
    const world = capitalWorld();
    expect(syncWorldWonders(world)).toBe(true);
    expect(syncWorldWonders(world)).toBe(false);
  });

  it('reverts the tile to plains when a wonder is disconnected', async () => {
    await hydrate(['bibliotheca']);
    const world = capitalWorld();
    syncWorldWonders(world);
    const coord = assignWonderCoords([iframeManifest('bibliotheca')])[0]!.coord;

    await hydrate([]); // disconnect everything
    const changed = syncWorldWonders(world);
    expect(changed).toBe(true);
    const tile = world.tiles.get(tileKey(coord))!;
    expect(tile.terrain).toBe('plains');
    expect(tile.district).toBeUndefined();
    const capital = world.cities.find((c) => c.isCapital)!;
    expect(capital.districts.some((d) => d.type === 'wonder')).toBe(false);
  });
});
