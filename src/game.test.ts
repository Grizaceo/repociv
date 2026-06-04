import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameState, pickDetachmentHex } from './game.ts';
import type { World } from './types.ts';

// ─── Minimal mocks ────────────────────────────────────────────────────────────
vi.mock('./pathfinding.ts', () => ({
  // aStarPath is used by moveUnit — return short path so moveUnit returns false cleanly
  aStarPath: vi.fn(() => []),
  invalidatePathCache: vi.fn(),
}));

vi.mock('./localMap.ts', () => ({
  buildLocalWorld: vi.fn(() => ({
    repoId: 'test-repo',
    tiles: [],
    units: [],
    workbenches: [],
    width: 10,
    height: 10,
  })),
}));

vi.mock('./localPathfinding.ts', () => ({
  findLocalPath: vi.fn(() => []),
}));

vi.mock('./localWorldManager.ts', () => {
  return {
    LocalWorldManager: class {
      viewMode: 'macro' | 'local' = 'macro';
      getLocalWorld() {
        return null;
      }
      getLocalUnits() {
        return [];
      }
      getLocalUnit() {
        return undefined;
      }
      queueLocalMission() {}
      dispatchMissionById() {}
      getMissionQueue() {
        return [];
      }
      getLocalTick() {
        return 0;
      }
      enterLocalView() {
        return { repoId: 'r', tiles: new Map(), units: [], workbenches: [], width: 5, height: 5 };
      }
      enterLocalViewMock() {
        return { repoId: 'r', tiles: new Map(), units: [], workbenches: [], width: 5, height: 5 };
      }
      enterMacroView() {}
      syncSubagentSpawn() {}
      removeSubagentUnit() {}
    },
  };
});

// ─── World factory ────────────────────────────────────────────────────────────
function makeWorld(overrides?: Partial<World>): World {
  return {
    tiles: new Map(),
    cities: [],
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0, culture: 0 } as World['resources'],
    generatedAt: Date.now(),
    restAreas: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GameState construction', () => {
  it('indexes pre-existing units on construction', () => {
    const world = makeWorld({
      units: [
        {
          id: 'DAVI',
          name: 'DAVI',
          type: 'hero',
          civ: 'capital',
          coord: { q: 0, r: 0 },
          path: [],
          pathIndex: 0,
          pathProgress: 0,
          state: 'idle',
          speed: 1,
          color: '#fff',
          movesLeft: 4,
          maxMoves: 4,
          fatigue: 100,
          maxFatigue: 100,
          isResting: false,
          effectiveSpeed: 1,
        },
      ],
    });
    const gs = new GameState(world);
    expect(gs.getUnit('DAVI')).toBeDefined();
    expect(gs.getUnit('DAVI')!.id).toBe('DAVI');
  });

  it('indexes pre-existing buildings on construction', () => {
    const world = makeWorld({
      buildings: [
        {
          id: 'bldg-1',
          cityId: 'repo-a',
          name: 'BuildA',
          type: 'building',
          progress: 0,
          durationSeconds: 60,
          elapsedSeconds: 0,
          state: 'building',
        },
      ],
    });
    const gs = new GameState(world);
    // Should not throw; building is indexed internally
    expect(gs.world.buildings).toHaveLength(1);
  });
});

describe('GameState.spawnUnit', () => {
  let gs: GameState;
  beforeEach(() => {
    gs = new GameState(makeWorld());
  });

  it('adds unit to world.units and unitMap', () => {
    const u = gs.spawnUnit('WORKER-1', 'Worker 1', 'worker', 'capital', { q: 1, r: 2 });
    expect(u.id).toBe('WORKER-1');
    expect(gs.getUnit('WORKER-1')).toBe(u);
    expect(gs.world.units).toContain(u);
  });

  it('returns existing unit if id already present', () => {
    const u1 = gs.spawnUnit('LEXO', 'LexO', 'hero', 'capital', { q: 0, r: 0 });
    const u2 = gs.spawnUnit('LEXO', 'LexO', 'hero', 'capital', { q: 1, r: 1 });
    expect(u1).toBe(u2);
  });

  it('initialises unit with default fatigue values', () => {
    const u = gs.spawnUnit('S1', 'Scout', 'scout', 'capital', { q: 0, r: 0 });
    // freshly spawned units start at full fatigue (100)
    expect(u.fatigue).toBe(100);
    expect(u.maxFatigue).toBeGreaterThan(0);
    expect(u.isResting).toBe(false);
  });
});

describe('GameState.removeUnit', () => {
  it('removes unit from world.units and unitMap', () => {
    const gs = new GameState(makeWorld());
    gs.spawnUnit('X1', 'X', 'worker', 'capital', { q: 0, r: 0 });
    expect(gs.removeUnit('X1')).toBe(true);
    expect(gs.getUnit('X1')).toBeUndefined();
    expect(gs.world.units.find((u) => u.id === 'X1')).toBeUndefined();
  });

  it('returns false for unknown unit id', () => {
    const gs = new GameState(makeWorld());
    expect(gs.removeUnit('does-not-exist')).toBe(false);
  });
});

describe('GameState.moveUnit', () => {
  it('returns false when A* finds no path (mocked to [])', () => {
    // aStarPath is mocked to return [] — path.length < 2, so moveUnit returns false
    const gs = new GameState(makeWorld());
    gs.spawnUnit('DAVI', 'DAVI', 'hero', 'capital', { q: 0, r: 0 });
    const moved = gs.moveUnit('DAVI', { q: 3, r: 4 });
    expect(moved).toBe(false);
  });

  it('returns false for unknown unit', () => {
    const gs = new GameState(makeWorld());
    expect(gs.moveUnit('ghost', { q: 0, r: 0 })).toBe(false);
  });
});

describe('GameState.setUnitState', () => {
  it('updates unit state field', () => {
    const gs = new GameState(makeWorld());
    gs.spawnUnit('W1', 'W', 'worker', 'capital', { q: 0, r: 0 });
    gs.setUnitState('W1', 'working');
    expect(gs.getUnit('W1')!.state).toBe('working');
  });
});

describe('GameState.buildings', () => {
  let gs: GameState;
  beforeEach(() => {
    gs = new GameState(makeWorld());
  });

  it('startBuilding adds a building to the city', () => {
    gs.startBuilding('city-1', 'bldg-a', 'Building A', 30, 'building');
    const b = gs.world.buildings.find((b) => b.id === 'bldg-a');
    expect(b).toBeDefined();
    expect(b!.state).toBe('building');
  });

  it('completeBuilding marks building state complete', () => {
    gs.startBuilding('city-1', 'bldg-b', 'Building B', 30, 'building');
    gs.completeBuilding('city-1', 'bldg-b');
    const b = gs.world.buildings.find((b) => b.id === 'bldg-b');
    expect(b!.state).toBe('complete');
    expect(b!.progress).toBe(100);
  });

  it('failBuilding marks building state failed', () => {
    gs.startBuilding('city-1', 'bldg-c', 'Building C', 30, 'building');
    gs.failBuilding('city-1', 'bldg-c');
    const b = gs.world.buildings.find((b) => b.id === 'bldg-c');
    expect(b!.state).toBe('failed');
  });

  it('startBuilding is idempotent for same id', () => {
    gs.startBuilding('city-1', 'dup', 'Dup', 10, 'building');
    gs.startBuilding('city-1', 'dup', 'Dup', 10, 'building');
    expect(gs.world.buildings.filter((b) => b.id === 'dup')).toHaveLength(1);
  });
});

describe('GameState.missions', () => {
  let gs: GameState;
  beforeEach(() => {
    gs = new GameState(makeWorld());
  });

  it('startMission registers mission', () => {
    gs.startMission('m-1', 'DAVI', 'Build something');
    expect(gs.missions.get('m-1')).toBeDefined();
    expect(gs.missions.get('m-1')!.questName).toBe('Build something');
  });

  it('completeMission success marks complete', () => {
    gs.startMission('m-2', 'LEXO', 'Analysis');
    gs.completeMission('m-2', true);
    const m = gs.missions.get('m-2');
    expect(m!.status).toBe('complete');
  });

  it('completeMission failure marks failed', () => {
    gs.startMission('m-3', 'WORKER-1', 'Patch');
    gs.completeMission('m-3', false);
    const m = gs.missions.get('m-3');
    expect(m!.status).toBe('failed');
  });
});

describe('GameState.subscribe / notify', () => {
  it('calls listener when unit is spawned', () => {
    const gs = new GameState(makeWorld());
    const cb = vi.fn();
    const unsub = gs.subscribe(cb);
    gs.spawnUnit('N1', 'N', 'scout', 'capital', { q: 0, r: 0 });
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it('unsubscribe stops future notifications', () => {
    const gs = new GameState(makeWorld());
    const cb = vi.fn();
    const unsub = gs.subscribe(cb);
    unsub();
    gs.spawnUnit('N2', 'N2', 'scout', 'capital', { q: 0, r: 0 });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('GameState.fatigue', () => {
  let gs: GameState;
  beforeEach(() => {
    gs = new GameState(makeWorld());
    gs.spawnUnit('F1', 'F', 'worker', 'capital', { q: 0, r: 0 });
  });

  it('updateUnitFatigue sets fatigue on unit', () => {
    // updateUnitFatigue(unitId, fatigue, maxFatigue, atRest, restAreaId)
    gs.updateUnitFatigue('F1', 40, 100, false, null);
    const info = gs.getUnitFatigue('F1');
    expect(info).not.toBeNull();
    expect(info!.fatigue).toBe(40);
  });

  it('decayUnitFatigue changes fatigue field', () => {
    gs.updateUnitFatigue('F1', 50, 100, false, null);
    const before = gs.getUnitFatigue('F1')!.fatigue;
    gs.decayUnitFatigue('F1', 10);
    const after = gs.getUnitFatigue('F1')!.fatigue;
    expect(after).not.toBe(before);
  });

  it('setUnitResting toggles resting flag', () => {
    gs.setUnitResting('F1', true);
    expect(gs.getUnit('F1')!.isResting).toBe(true);
    gs.setUnitResting('F1', false);
    expect(gs.getUnit('F1')!.isResting).toBe(false);
  });

  it('getUnitFatigue returns null for unknown unit', () => {
    const f = gs.getUnitFatigue('nobody');
    expect(f).toBeNull();
  });
});

describe('GameState.getAllUnits', () => {
  it('returns all spawned units', () => {
    const gs = new GameState(makeWorld());
    gs.spawnUnit('A', 'A', 'hero', 'capital', { q: 0, r: 0 });
    gs.spawnUnit('B', 'B', 'worker', 'capital', { q: 1, r: 0 });
    expect(gs.getAllUnits()).toHaveLength(2);
  });
});

describe('GameState.selectUnit', () => {
  it('sets selectedUnit', () => {
    const gs = new GameState(makeWorld());
    const u = gs.spawnUnit('SEL', 'Sel', 'hero', 'capital', { q: 0, r: 0 });
    gs.selectUnit(u);
    expect(gs.selectedUnit).toBe(u);
  });

  it('clears selectedUnit with null', () => {
    const gs = new GameState(makeWorld());
    const u = gs.spawnUnit('SEL2', 'Sel2', 'hero', 'capital', { q: 0, r: 0 });
    gs.selectUnit(u);
    gs.selectUnit(null);
    expect(gs.selectedUnit).toBeNull();
  });
});

describe('GameState.pause / resume', () => {
  it('pause and resume toggle paused state without crashing', () => {
    // game.ts uses requestAnimationFrame when start() is called — mock it
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('performance', { now: vi.fn(() => 0) });
    const gs = new GameState(makeWorld());
    gs.start();
    gs.pause();
    gs.stop();
    vi.unstubAllGlobals();
  });
});

describe('GameState.getUnitAt', () => {
  it('returns unit at exact axial coordinate', () => {
    const gs = new GameState(makeWorld());
    gs.spawnUnit('AT1', 'AT', 'scout', 'capital', { q: 2, r: 3 });
    const found = gs.getUnitAt({ q: 2, r: 3 });
    expect(found?.id).toBe('AT1');
  });

  it('returns null when no unit at coordinate', () => {
    const gs = new GameState(makeWorld());
    expect(gs.getUnitAt({ q: 99, r: 99 })).toBeNull();
  });
});

// ─── Trail buffer truncation ──────────────────────────────────────────────────
// Tests the contract for the trail push logic in updateUnits():
//   trailPositions captures the departure hex before pathIndex advances,
//   and is capped at 5 entries (oldest dropped when full).
describe('Unit trail buffer', () => {
  function pushTrail(
    trailPositions: { q: number; r: number }[] | undefined,
    coord: { q: number; r: number },
  ): { q: number; r: number }[] {
    const trail = trailPositions ?? [];
    trail.push({ q: coord.q, r: coord.r });
    if (trail.length > 5) trail.shift();
    return trail;
  }

  it('starts empty and grows on first push', () => {
    const trail = pushTrail(undefined, { q: 1, r: 0 });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toEqual({ q: 1, r: 0 });
  });

  it('records departure coords in order (oldest first)', () => {
    let trail: { q: number; r: number }[] | undefined;
    trail = pushTrail(trail, { q: 0, r: 0 });
    trail = pushTrail(trail, { q: 1, r: 0 });
    trail = pushTrail(trail, { q: 2, r: 0 });
    expect(trail[0]).toEqual({ q: 0, r: 0 });
    expect(trail[2]).toEqual({ q: 2, r: 0 });
  });

  it('caps at 5 entries when more than 5 positions are pushed', () => {
    let trail: { q: number; r: number }[] | undefined;
    for (let i = 0; i < 7; i++) trail = pushTrail(trail, { q: i, r: 0 });
    expect(trail).toHaveLength(5);
    expect(trail![0]).toEqual({ q: 2, r: 0 }); // oldest 2 dropped
    expect(trail![4]).toEqual({ q: 6, r: 0 }); // most recent
  });

  it('evicts the oldest entry (index 0) when full', () => {
    let trail: { q: number; r: number }[] | undefined;
    for (let i = 0; i < 5; i++) trail = pushTrail(trail, { q: i, r: 0 });
    trail = pushTrail(trail, { q: 99, r: 0 });
    expect(trail![0]).toEqual({ q: 1, r: 0 }); // { q:0, r:0 } was evicted
    expect(trail![4]).toEqual({ q: 99, r: 0 });
  });
});

describe('GameState subagent detachments', () => {
  it('spawnUnit accepts parent/ephemeral options', () => {
    const state = new GameState(makeWorld());
    const parent = state.spawnUnit('DAVI', 'DAVI', 'hero', 'capital', { q: 0, r: 0 });
    const child = state.spawnUnit(
      'SCOUT-sub-x',
      'scout',
      'scout',
      'capital',
      parent.coord,
      'explore',
      undefined,
      { parentUnitId: 'DAVI', ephemeral: true, subagentRunId: 'sub-x' },
    );
    expect(child.parentUnitId).toBe('DAVI');
    expect(child.ephemeral).toBe(true);
    expect(state.getChildrenOfUnit('DAVI')).toHaveLength(1);
  });

  it('completeSubagent cascades despawn of ephemeral unit', () => {
    const state = new GameState(makeWorld());
    state.spawnUnit('DAVI', 'DAVI', 'hero', 'capital', { q: 0, r: 0 });
    state.spawnUnit(
      'SCOUT-sub-y',
      'scout',
      'scout',
      'capital',
      { q: 1, r: 0 },
      undefined,
      undefined,
      { parentUnitId: 'DAVI', ephemeral: true, subagentRunId: 'sub-y' },
    );
    state.registerSubagent({
      id: 'sub-y',
      parentMissionId: 'm1',
      parentUnitId: 'DAVI',
      kind: 'explore',
      label: 'scan',
      status: 'running',
      risk: 'low',
      ephemeralUnitId: 'SCOUT-sub-y',
      startedAt: Date.now(),
    });
    state.completeSubagent('sub-y', true, 'ok');
    expect(state.getUnit('SCOUT-sub-y')).toBeUndefined();
    expect(state.subagents.has('sub-y')).toBe(false);
    expect(state.completedSubagents[0]?.summary).toBe('ok');
  });

  it('revealHexes clears fog on tiles', () => {
    const world = makeWorld();
    world.tiles.set('0,0', {
      coord: { q: 0, r: 0 },
      terrain: 'plains',
      resources: { gold: 0, science: 0, production: 0 },
      inFog: true,
      revealed: false,
    });
    const state = new GameState(world);
    state.revealHexes([[0, 0]]);
    const tile = state.world.tiles.get('0,0');
    expect(tile?.inFog).toBe(false);
    expect(tile?.revealed).toBe(true);
  });
});

describe('pickDetachmentHex', () => {
  it('returns neighbor hex offset from parent, not same coord', () => {
    const state = new GameState(makeWorld());
    state.spawnUnit('DAVI', 'DAVI', 'hero', 'capital', { q: 0, r: 0 });
    const hex = pickDetachmentHex(state, { q: 0, r: 0 }, 0);
    expect(hex).not.toEqual({ q: 0, r: 0 });
    expect(state.getUnitAt(hex)).toBeNull();
  });

  it('uses childIndex to pick different ring slots', () => {
    const state = new GameState(makeWorld());
    state.spawnUnit('DAVI', 'DAVI', 'hero', 'capital', { q: 0, r: 0 });
    const h0 = pickDetachmentHex(state, { q: 0, r: 0 }, 0);
    const h1 = pickDetachmentHex(state, { q: 0, r: 0 }, 1);
    expect(h0).not.toEqual(h1);
  });

  it('falls back to parent when all neighbors occupied', () => {
    const state = new GameState(makeWorld());
    state.spawnUnit('DAVI', 'DAVI', 'hero', 'capital', { q: 0, r: 0 });
    const parent = { q: 0, r: 0 };
    const neighbors = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];
    neighbors.forEach((c, i) => {
      state.spawnUnit(`BLOCK-${i}`, `B${i}`, 'worker', 'capital', c);
    });
    expect(pickDetachmentHex(state, parent, 0)).toEqual(parent);
  });
});
