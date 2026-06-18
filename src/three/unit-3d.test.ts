import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock UnitProps3D so we get the procedural fallback figurine (no async GLB).
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
import type { Unit, Tile } from '../types.ts';

function makeUnit(id: string, q: number, r: number, state: 'idle' | 'moving' = 'idle'): Unit {
  return {
    id,
    name: id,
    type: 'worker',
    civ: 'gris',
    coord: { q, r },
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state,
    speed: 1,
    color: '#4488ff',
    movesLeft: 2,
    maxMoves: 2,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
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
]);
const getTile = (key: string) => tiles.get(key);

afterEach(() => {
  clearUnits();
});

describe('UnitMesh3D lifecycle — spawn', () => {
  it('new units start at scale 0 (spawning state)', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    const entry = _testGetEntry('u1');
    expect(entry).toBeDefined();
    expect(entry!.lifeState).toBe('spawning');
    expect(entry!.group.scale.x).toBe(0);
  });

  it('spawn tween grows scale 0→1 over 300ms with ease-out', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    const entry = _testGetEntry('u1')!;

    // 150ms (halfway): scale should be > 0 and < 1.
    tickUnits(0.15, 0.15);
    expect(entry.group.scale.x).toBeGreaterThan(0);
    expect(entry.group.scale.x).toBeLessThan(1);

    // 300ms total: spawn complete.
    tickUnits(0.30, 0.15);
    expect(entry.lifeState).toBe('alive');
    // Easing makes it ~1.0 but the idle pulse immediately takes over.
    expect(entry.group.scale.x).toBeGreaterThan(0.95);
  });

  it('frozen animTime (dt=0) does not advance spawn tween', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    const entry = _testGetEntry('u1')!;
    expect(entry.group.scale.x).toBe(0);

    tickUnits(2.0, 0.0);
    expect(entry.lifeState).toBe('spawning');
    expect(entry.group.scale.x).toBe(0);
  });
});

describe('UnitMesh3D lifecycle — despawn', () => {
  it('removed units enter despawning state and shrink to 0 over 200ms', () => {
    // Spawn first.
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    tickUnits(0.30, 0.30); // complete spawn
    expect(_testGetEntry('u1')!.lifeState).toBe('alive');

    // Remove unit.
    rebuildUnits([], getTile);
    const entry = _testGetEntry('u1')!;
    expect(entry.lifeState).toBe('despawning');

    // 100ms (halfway): scale between 0 and 1.
    tickUnits(0.40, 0.10);
    expect(entry.group.scale.x).toBeGreaterThan(0);
    expect(entry.group.scale.x).toBeLessThan(1);

    // 200ms total: entry removed.
    tickUnits(0.50, 0.10);
    expect(_testGetEntry('u1')).toBeUndefined();
    expect(_testEntryCount()).toBe(0);
  });
});

describe('UnitMesh3D lifecycle — idle pulse', () => {
  it('alive units oscillate scale around 1 with a subtle pulse', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    tickUnits(0.30, 0.30); // complete spawn

    const entry = _testGetEntry('u1')!;
    expect(entry.lifeState).toBe('alive');

    // Sample the scale at several time points — it should oscillate.
    const scales: number[] = [];
    for (let i = 0; i < 40; i++) {
      tickUnits(i * 0.1, 0.1);
      scales.push(entry.group.scale.x);
    }

    // The pulse range is 1.0 to 1.05. All values should be in [0.99, 1.06].
    for (const s of scales) {
      expect(s).toBeGreaterThanOrEqual(0.99);
      expect(s).toBeLessThanOrEqual(1.06);
    }
    // And there should be some variation (not all the same value).
    const min = Math.min(...scales);
    const max = Math.max(...scales);
    expect(max - min).toBeGreaterThan(0.001);
  });
});

describe('UnitMesh3D lifecycle — walking hop', () => {
  it('moving units get a vertical Y offset that oscillates', () => {
    rebuildUnits([makeUnit('u1', 0, 0, 'moving')], getTile);
    tickUnits(0.30, 0.30); // complete spawn

    const entry = _testGetEntry('u1')!;
    const baseY = entry.group.position.y;

    // Sample Y over several frames — the hop should lift the unit.
    let maxLift = 0;
    for (let i = 0; i < 30; i++) {
      tickUnits(i * 0.02, 0.02);
      const lift = entry.group.position.y - baseY;
      if (lift > maxLift) maxLift = lift;
    }
    // The hop height is 12 units, so we should see a lift > 1 at some point.
    expect(maxLift).toBeGreaterThan(1);
  });

  it('idle units do not hop (Y stays at base)', () => {
    rebuildUnits([makeUnit('u1', 0, 0, 'idle')], getTile);
    tickUnits(0.30, 0.30); // complete spawn

    const entry = _testGetEntry('u1')!;
    const baseY = entry.group.position.y;

    for (let i = 0; i < 20; i++) {
      tickUnits(i * 0.02, 0.02);
      // Y should not lift significantly for idle units.
      expect(entry.group.position.y).toBeLessThanOrEqual(baseY + 0.1);
    }
  });
});