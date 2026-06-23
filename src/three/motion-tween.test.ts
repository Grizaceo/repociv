import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./UnitProps3D.ts', () => ({
  areUnitPropsReady: () => false,
  getUnitPropParts: () => null,
  ensureUnitPropsLoad: () => {},
  areUnitPropsSettled: () => true,
}));

import {
  clearUnits,
  rebuildUnits,
  tickUnits,
  _testGetEntry,
  _testEntryCount,
} from './UnitMesh3D.ts';
import { clearTileFlash, flashTile, getTileFlashGroup, tickTileFlash } from './TileFlash3D.ts';
import type { Unit, Tile } from '../types.ts';

function makeUnit(
  id: string,
  q: number,
  r: number,
  path: { q: number; r: number }[] = [],
  state: 'idle' | 'moving' = 'idle',
): Unit {
  return {
    id,
    name: id,
    type: 'worker',
    civ: 'gris',
    coord: { q, r },
    path,
    pathIndex: 0,
    pathProgress: 0,
    state,
    speed: 2.5,
    color: '#4488ff',
    movesLeft: 2,
    maxMoves: 2,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 2.5,
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

const tiles = new Map<string, Tile>([
  ['0,0', makeTile(0, 0)],
  ['1,0', makeTile(1, 0)],
  ['2,0', makeTile(2, 0)],
  ['3,0', makeTile(3, 0)],
]);
const getTile = (key: string) => tiles.get(key);

afterEach(() => {
  clearUnits();
  clearTileFlash();
});

describe('Movement tween', () => {
  it('moving unit interpolates position between path tiles', () => {
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ];
    rebuildUnits([makeUnit('u1', 0, 0, path, 'moving')], getTile);
    tickUnits(0.3, 0.3); // complete spawn

    const entry = _testGetEntry('u1')!;
    expect(entry.moving).toBe(true);

    // Record the initial position.
    const startX = entry.currentPos.x;

    // Tick forward — the unit should move toward tile (1,0).
    tickUnits(0.4, 0.1);
    // After 0.1s at 2.5 hex/s, pathProgress = 0.25. The unit should be
    // 25% of the way from tile 0 to tile 1.
    expect(entry.pathProgress).toBeGreaterThan(0);
    expect(entry.pathProgress).toBeLessThan(1);

    // The X position should have changed (moving toward +X).
    expect(entry.currentPos.x).not.toBe(startX);

    // Continue ticking until we arrive at tile 1.
    tickUnits(0.5, 0.1);
    tickUnits(0.6, 0.1);
    tickUnits(0.7, 0.1);
    // By now pathProgress should have wrapped at least once (0.4s * 2.5 = 1.0).
    expect(entry.pathIndex).toBeGreaterThanOrEqual(1);
  });

  it('idle unit does not move (position stays at coord)', () => {
    rebuildUnits([makeUnit('u1', 0, 0, [], 'idle')], getTile);
    tickUnits(0.3, 0.3); // complete spawn

    const entry = _testGetEntry('u1')!;
    const startX = entry.currentPos.x;
    const startZ = entry.currentPos.z;

    for (let i = 0; i < 10; i++) {
      tickUnits(i * 0.1, 0.1);
    }
    expect(entry.currentPos.x).toBe(startX);
    expect(entry.currentPos.z).toBe(startZ);
  });

  it('frozen dt=0 does not advance movement tween', () => {
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ];
    rebuildUnits([makeUnit('u1', 0, 0, path, 'moving')], getTile);
    tickUnits(0.3, 0.3); // complete spawn

    const entry = _testGetEntry('u1')!;
    const startProgress = entry.pathProgress;
    const startX = entry.currentPos.x;

    tickUnits(10.0, 0.0);
    expect(entry.pathProgress).toBe(startProgress);
    expect(entry.currentPos.x).toBe(startX);
  });
});

describe('Tile flash', () => {
  it('flashTile adds a ring to the flash group', () => {
    expect(getTileFlashGroup().children.length).toBe(0);
    flashTile(0, 0, 0);
    expect(getTileFlashGroup().children.length).toBe(1);
  });

  it('duplicate flash on same tile is skipped', () => {
    flashTile(0, 0, 0);
    flashTile(0, 0, 0);
    expect(getTileFlashGroup().children.length).toBe(1);
  });

  it('flash fades and is removed after 200ms', () => {
    flashTile(1, 0, 0);
    expect(getTileFlashGroup().children.length).toBe(1);

    // Tick 100ms (halfway): still visible.
    tickTileFlash(0.1);
    expect(getTileFlashGroup().children.length).toBe(1);

    // Tick another 100ms: expired.
    tickTileFlash(0.1);
    expect(getTileFlashGroup().children.length).toBe(0);
  });

  it('frozen dt=0 does not expire flashes', () => {
    flashTile(2, 0, 0);
    tickTileFlash(0.0);
    tickTileFlash(0.0);
    expect(getTileFlashGroup().children.length).toBe(1);
  });

  it('tile flash is triggered when a unit steps onto a new tile', () => {
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ];
    rebuildUnits([makeUnit('u1', 0, 0, path, 'moving')], getTile);
    tickUnits(0.3, 0.3); // complete spawn

    // Clear any existing flashes.
    clearTileFlash();
    expect(getTileFlashGroup().children.length).toBe(0);

    // Tick enough for pathProgress to wrap past 1 (0.4s * 2.5 = 1.0 hex).
    // Use the flashTile callback.
    tickUnits(0.4, 0.4, (q, r, _elev) => flashTile(q, r, 0));
    tickUnits(0.5, 0.1, (q, r, _elev) => flashTile(q, r, 0));

    // At least one flash should have been triggered.
    expect(getTileFlashGroup().children.length).toBeGreaterThan(0);
  });
});
