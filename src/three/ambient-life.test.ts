import { afterEach, describe, expect, it } from 'vitest';
import {
  getAmbientLifeGroup,
  rebuildAmbientLife,
  tickAmbientLife,
  clearAmbientLife,
  disposeAmbientLife,
  pickBirdAnchors,
  birdTransform,
  puffTransform,
  flagOffset,
  _ambientLifeSignature,
} from './AmbientLife3D.ts';
import type { City, Terrain, Tile } from '../types.ts';
import { tileKey } from '../types.ts';

function tile(q: number, r: number, terrain: Terrain, revealed = true): Tile {
  return {
    coord: { q, r },
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed,
  };
}

function city(id: string, q: number, r: number, isCapital = false): City {
  return {
    id,
    name: id,
    coord: { q, r },
    population: 10,
    territory: [],
    districts: [],
    buildings: [],
    isCapital,
    color: [0.8, 0.3, 0.3],
  };
}

function makeWorld(tiles: Tile[]) {
  const map = new Map(tiles.map((t) => [tileKey(t.coord), t]));
  return (key: string) => map.get(key);
}

afterEach(() => {
  disposeAmbientLife();
});

describe('pickBirdAnchors', () => {
  it('picks only revealed ocean tiles, deterministically', () => {
    const tiles = [
      tile(0, 0, 'plains'),
      tile(1, 0, 'ocean'),
      tile(2, 0, 'ocean', false),
      tile(3, 0, 'ocean'),
      tile(4, 0, 'ocean'),
    ];
    const a = pickBirdAnchors(tiles, 3);
    const b = pickBirdAnchors([...tiles].reverse(), 3);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((t) => t.terrain === 'ocean' && t.revealed)).toBe(true);
    // Order-independent: same picks regardless of input order.
    expect(a.map((t) => tileKey(t.coord))).toEqual(b.map((t) => tileKey(t.coord)));
  });

  it('returns empty when there is no ocean', () => {
    expect(pickBirdAnchors([tile(0, 0, 'plains')], 3)).toEqual([]);
  });
});

describe('freeze determinism', () => {
  it('bird and puff transforms are pure in animTime', () => {
    const bird = { anchor: { x: 10, z: -5 }, radius: 60, speed: 0.25, phase: 1.3 };
    expect(birdTransform(bird, 2.0)).toEqual(birdTransform(bird, 2.0));
    const puff = { phase: 0.4, drift: 0.4 };
    expect(puffTransform(puff, 2.0)).toEqual(puffTransform(puff, 2.0));
    // ...and actually move when time moves.
    expect(birdTransform(bird, 3.0).x).not.toBe(birdTransform(bird, 2.0).x);
  });

  it('puff scale shrinks to ~0 at the top of its loop so it never pops mid-air', () => {
    const puff = { phase: 0, drift: 0 };
    // t≈0.999 of the cycle (SMOKE_CYCLE=6.5): fadeOut ≈ 0
    const nearEnd = puffTransform(puff, 6.4935);
    expect(nearEnd.scale).toBeLessThan(0.15);
  });

  it('flagOffset is deterministic and clears the tile centre', () => {
    const [ox, oz] = flagOffset(2, -1);
    expect(flagOffset(2, -1)).toEqual([ox, oz]);
    expect(Math.hypot(ox, oz)).toBeGreaterThan(1);
  });
});

describe('rebuild/tick lifecycle', () => {
  const tiles = [tile(0, 0, 'plains'), tile(1, 0, 'ocean'), tile(2, 0, 'ocean')];

  it('builds flags for revealed cities, birds over ocean, smoke over capitals', () => {
    rebuildAmbientLife(tiles, [city('cap', 0, 0, true)], makeWorld(tiles));
    const g = getAmbientLifeGroup();
    // flag group + bird InstancedMesh + smoke InstancedMesh
    expect(g.children.length).toBe(3);
    expect(_ambientLifeSignature()).toContain('cap');
  });

  it('skips unrevealed cities and rebuilds only on signature change', () => {
    const hidden = [tile(0, 0, 'plains', false), tile(1, 0, 'ocean')];
    rebuildAmbientLife(hidden, [city('cap', 0, 0, true)], makeWorld(hidden));
    const g = getAmbientLifeGroup();
    // birds only — no flag, no smoke for the unrevealed capital
    expect(g.children.length).toBe(1);
    const sig = _ambientLifeSignature();
    rebuildAmbientLife(hidden, [city('cap', 0, 0, true)], makeWorld(hidden));
    expect(_ambientLifeSignature()).toBe(sig);
    expect(g.children.length).toBe(1);
  });

  it('hides everything below high LOD and lays out instances at high', () => {
    rebuildAmbientLife(tiles, [city('cap', 0, 0, true)], makeWorld(tiles));
    const g = getAmbientLifeGroup();
    tickAmbientLife(2.0, 'low');
    expect(g.visible).toBe(false);
    tickAmbientLife(2.0, 'high');
    expect(g.visible).toBe(true);
  });

  it('clearAmbientLife empties the group', () => {
    rebuildAmbientLife(tiles, [city('cap', 0, 0, true)], makeWorld(tiles));
    clearAmbientLife();
    expect(getAmbientLifeGroup().children.length).toBe(0);
  });
});
