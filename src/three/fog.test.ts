import { afterEach, describe, expect, it } from 'vitest';

import {
  clearFogTransition,
  updateFogTransition,
  tickFogTransition,
  _testFadeCount,
  _testParticleCount,
  _testResetPrevUnrevealed,
} from './FogTransition3D.ts';
import type { Tile, City } from '../types.ts';

function makeTile(q: number, r: number, revealed: boolean, city?: City): Tile {
  return {
    coord: { q, r },
    terrain: 'plains',
    resources: { gold: 0, science: 0, production: 0 },
    city,
    inFog: !revealed,
    revealed,
  };
}

function makeCity(id: string, q: number, r: number): City {
  return {
    id,
    name: id,
    coord: { q, r },
    population: 100,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
  };
}

afterEach(() => {
  clearFogTransition();
  _testResetPrevUnrevealed();
});

describe('FogTransition3D — fade-out', () => {
  it('does not trigger fade when no tiles are revealed', () => {
    const tiles = [makeTile(0, 0, false), makeTile(1, 0, false)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);
    expect(_testFadeCount()).toBe(0);
  });

  it('triggers fade-out when a tile transitions from unrevealed to revealed', () => {
    const city = makeCity('alpha', 0, 0);
    let tiles = [makeTile(0, 0, false, city), makeTile(1, 0, false)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);

    // First call: establishes the baseline (both unrevealed).
    updateFogTransition(tiles, getTile);
    expect(_testFadeCount()).toBe(0);

    // Reveal tile (0,0).
    tiles = [makeTile(0, 0, true, city), makeTile(1, 0, false)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);
    expect(_testFadeCount()).toBe(1);
  });

  it('fade-out completes after 500ms', () => {
    const city = makeCity('alpha', 0, 0);
    let tiles = [makeTile(0, 0, false, city)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);

    // Reveal.
    tiles = [makeTile(0, 0, true, city)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);
    expect(_testFadeCount()).toBe(1);

    // Tick 250ms (halfway): still fading.
    tickFogTransition(0.25);
    expect(_testFadeCount()).toBe(1);

    // Tick another 250ms: complete.
    tickFogTransition(0.25);
    expect(_testFadeCount()).toBe(0);
  });

  it('frozen dt=0 does not advance fade-out', () => {
    const city = makeCity('alpha', 0, 0);
    let tiles = [makeTile(0, 0, false, city)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);

    tiles = [makeTile(0, 0, true, city)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);
    expect(_testFadeCount()).toBe(1);

    tickFogTransition(0.0);
    tickFogTransition(0.0);
    expect(_testFadeCount()).toBe(1);
  });
});

describe('FogTransition3D — particle burst', () => {
  it('triggers particle burst on city tile reveal', () => {
    const city = makeCity('alpha', 0, 0);
    let tiles = [makeTile(0, 0, false, city)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);

    // Reveal the city tile.
    tiles = [makeTile(0, 0, true, city)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);

    expect(_testParticleCount()).toBe(1);
  });

  it('does not trigger particle burst on non-city tile reveal', () => {
    let tiles = [makeTile(0, 0, false)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);

    tiles = [makeTile(0, 0, true)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);

    expect(_testParticleCount()).toBe(0);
    // But fade-out should still be active.
    expect(_testFadeCount()).toBe(1);
  });

  it('particle burst completes after 800ms', () => {
    const city = makeCity('alpha', 0, 0);
    let tiles = [makeTile(0, 0, false, city)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);

    tiles = [makeTile(0, 0, true, city)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);
    expect(_testParticleCount()).toBe(1);

    // Tick 400ms (halfway): still active.
    tickFogTransition(0.4);
    expect(_testParticleCount()).toBe(1);

    // Tick another 400ms: complete.
    tickFogTransition(0.4);
    expect(_testParticleCount()).toBe(0);
  });

  it('frozen dt=0 does not advance particle burst', () => {
    const city = makeCity('alpha', 0, 0);
    let tiles = [makeTile(0, 0, false, city)];
    const getTile = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile);

    tiles = [makeTile(0, 0, true, city)];
    const getTile2 = (key: string) => tiles.find((t) => `${t.coord.q},${t.coord.r}` === key);
    updateFogTransition(tiles, getTile2);
    expect(_testParticleCount()).toBe(1);

    tickFogTransition(0.0);
    tickFogTransition(0.0);
    expect(_testParticleCount()).toBe(1);
  });
});
