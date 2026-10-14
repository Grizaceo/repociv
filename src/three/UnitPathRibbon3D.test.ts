import { afterEach, describe, expect, it } from 'vitest';
import {
  clearUnitPaths,
  getUnitPathGroup,
  rebuildUnitPaths,
  setUnitPathsVisible,
} from './UnitPathRibbon3D.ts';
import type { Tile, Unit } from '../types.ts';

function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 'U1',
    name: 'Scout',
    type: 'scout',
    civ: 'gris',
    cityId: 'capital',
    coord: { q: 0, r: 0 },
    path: [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ],
    pathIndex: 0,
    pathProgress: 0,
    state: 'moving',
    speed: 2,
    color: '#58a6ff',
    movesLeft: 3,
    maxMoves: 3,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 2,
    ...overrides,
  };
}

describe('UnitPathRibbon3D', () => {
  afterEach(() => {
    clearUnitPaths();
    setUnitPathsVisible(true);
  });

  it('builds ribbon tube, waypoint pips, and destination arrowhead for moving units', () => {
    const u = makeUnit();
    const getTile = (_k: string): Tile | undefined => undefined;

    rebuildUnitPaths([u], getTile, null);
    const group = getUnitPathGroup();

    // 1 tube + 1 intermediate pip (for 3-node path) + 1 arrowhead cone = 3 meshes
    expect(group.children.length).toBe(3);
  });

  it('includes idle unit path when that unit is currently selected', () => {
    const u = makeUnit({ state: 'idle' });
    const getTile = (_k: string): Tile | undefined => undefined;

    rebuildUnitPaths([u], getTile, null);
    expect(getUnitPathGroup().children.length).toBe(0);

    rebuildUnitPaths([u], getTile, 'U1');
    expect(getUnitPathGroup().children.length).toBe(3);
  });

  it('skips rebuild when signature is unchanged and clears cleanly', () => {
    const u = makeUnit();
    const getTile = (_k: string): Tile | undefined => undefined;

    rebuildUnitPaths([u], getTile, null);
    const firstTube = getUnitPathGroup().children[0];
    rebuildUnitPaths([u], getTile, null);
    expect(getUnitPathGroup().children[0]).toBe(firstTube);

    clearUnitPaths();
    expect(getUnitPathGroup().children.length).toBe(0);
  });
});
