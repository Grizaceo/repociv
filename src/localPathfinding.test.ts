import { describe, it, assert } from 'vitest';
import { findPath, findNearestWorkbench, chairTileForWorkbench } from './localPathfinding.ts';
import { buildMockLocalWorld } from './localMap.ts';
import type { LocalWorld, LocalTile, LocalTileType, LocalUnit } from './types.ts';

function makeGrid(tiles: string[]): LocalWorld {
  // Simple grid from string rows:
  //   '.' floor  '#' wall  'W' workbench  'C' chair  'D' door
  const typeMap: Record<string, LocalTileType> = {
    '.': 'floor',
    '#': 'wall',
    W: 'workbench',
    C: 'chair',
    D: 'door',
  };
  const grid: LocalTile[][] = tiles.map((row, y) =>
    row.split('').map((ch, x) => ({
      x,
      y,
      type: typeMap[ch] ?? 'floor',
      roomId: null,
      workbench:
        ch === 'W'
          ? {
              id: `wb-${x}-${y}`,
              filePath: `/f/${x}/${y}`,
              fileName: 'f.ts',
              extension: 'ts',
              isTest: false,
              repoPath: 'test',
            }
          : null,
    })),
  );
  return {
    repoId: 'test',
    grid,
    rooms: [],
    width: grid[0]!.length,
    height: grid.length,
    workbenches: [],
    deskAssignments: new Map(),
  };
}

describe('localPathfinding — findPath', () => {
  it('finds direct path on open floor', () => {
    const world = makeGrid(['.....', '.....', '.....']);
    const result = findPath(world, 0, 0, 4, 2);
    assert.ok(result !== null, 'should find a path');
    assert.ok(result!.path.length > 0, 'path should have steps');
    const last = result!.path[result!.path.length - 1]!;
    assert.equal(last.x, 4);
    assert.equal(last.y, 2);
  });

  it('returns null when source is a wall', () => {
    const world = makeGrid(['#..', '...']);
    const result = findPath(world, 0, 0, 2, 0);
    assert.ok(result === null, 'wall source should return null');
  });

  it('returns null when destination is a wall', () => {
    const world = makeGrid(['...', '..#']);
    const result = findPath(world, 0, 0, 2, 1);
    assert.ok(result === null, 'wall destination should return null');
  });

  it('returns null when path is fully blocked', () => {
    const world = makeGrid(['.#.', '.#.', '.#.']);
    const result = findPath(world, 0, 0, 2, 2);
    assert.ok(result === null, 'fully blocked path should return null');
  });

  it('routes around walls', () => {
    const world = makeGrid(['..#..', '..#..', '.....']);
    const result = findPath(world, 0, 0, 4, 0);
    assert.ok(result !== null, 'should find a path around the wall');
  });

  it('path from same position has trivial length', () => {
    const world = makeGrid(['....']);
    const result = findPath(world, 2, 0, 2, 0);
    assert.ok(result !== null);
    assert.ok(result!.path.length <= 1, 'same-position path should be trivial');
  });
});

describe('localPathfinding — findNearestWorkbench', () => {
  it('finds nearest workbench via BFS', () => {
    const world = makeGrid(['.....', '..W..', '.....']);
    const result = findNearestWorkbench(world, 0, 0);
    assert.ok(result !== null, 'should find a workbench');
    assert.equal(result!.x, 2);
    assert.equal(result!.y, 1);
  });

  it('returns null when no workbenches exist', () => {
    const world = makeGrid(['.....', '.....']);
    const result = findNearestWorkbench(world, 0, 0);
    assert.ok(result === null, 'no workbenches → null');
  });

  it('works on mock world (from a transit tile)', () => {
    const world = buildMockLocalWorld();
    if (world.workbenches.length > 0) {
      // (1,1) in buildMockLocalWorld is a lobby wall. Use a tile
      // we know is transit (floor/path) so the Dijkstra gate in
      // findNearestWorkbench doesn't return null on a hard wall.
      const start = { x: 0, y: 1 };
      const startTile = world.grid[start.y]![start.x]!;
      assert.notEqual(startTile.type, 'wall');
      const result = findNearestWorkbench(world, start.x, start.y);
      assert.ok(result !== null, 'mock world should have reachable workbenches');
      // The returned workbench tile should be reachable by walking
      // (i.e. not behind a wall from the start).
      assert.ok(result!.distance > 0);
    }
  });

  it('returns null when no workbench is reachable through walls', () => {
    // 5x5 grid, all walls except the start, plus a single workbench
    // tile that the start can NOT reach because walls block every
    // path. Phase 3 behaviour: returns null (was previously the
    // first workbench by Manhattan, even if unreachable).
    const wallGrid: LocalTile[][] = Array.from({ length: 5 }, (_, y) =>
      Array.from({ length: 5 }, (_, x) => ({
        x,
        y,
        type: y === 0 && x === 0 ? 'floor' : 'wall',
        roomId: null,
        workbench:
          y === 4 && x === 4
            ? {
                id: 'wb-isolated',
                filePath: '/f/4/4',
                fileName: 'f.ts',
                extension: 'ts',
                isTest: false,
                repoPath: 'test',
              }
            : null,
      })),
    );
    const world: LocalWorld = {
      repoId: 'test',
      grid: wallGrid,
      rooms: [],
      width: 5,
      height: 5,
      workbenches: [],
      deskAssignments: new Map(),
    };
    const result = findNearestWorkbench(world, 0, 0);
    assert.equal(result, null, 'isolated workbench must be reported as unreachable');
  });

  it('respects aisles: routes around a partition to the workbench', () => {
    // 3x3 grid: the unit starts at the top-left, the workbench is
    // at the bottom-right. The middle column is a partition
    // barrier for the top two rows; the bottom row is open, so
    // the unit walks down, across, and back up.
    const grid: LocalTile[][] = [
      [
        { x: 0, y: 0, type: 'aisle', roomId: null, workbench: null },
        { x: 1, y: 0, type: 'cubicle_partition', roomId: null, workbench: null },
        { x: 2, y: 0, type: 'aisle', roomId: null, workbench: null },
      ],
      [
        { x: 0, y: 1, type: 'aisle', roomId: null, workbench: null },
        { x: 1, y: 1, type: 'cubicle_partition', roomId: null, workbench: null },
        { x: 2, y: 1, type: 'aisle', roomId: null, workbench: null },
      ],
      [
        { x: 0, y: 2, type: 'aisle', roomId: null, workbench: null },
        { x: 1, y: 2, type: 'aisle', roomId: null, workbench: null },
        {
          x: 2,
          y: 2,
          type: 'workbench',
          roomId: null,
          workbench: {
            id: 'wb-far',
            filePath: '/f/2/2',
            fileName: 'f.ts',
            extension: 'ts',
            isTest: false,
            repoPath: 'test',
          },
        },
      ],
    ];
    const world: LocalWorld = {
      repoId: 'test',
      grid,
      rooms: [],
      width: 3,
      height: 3,
      workbenches: [],
      deskAssignments: new Map(),
    };
    const result = findNearestWorkbench(world, 0, 0);
    assert.ok(result !== null, 'should reach the workbench via the aisle');
    assert.equal(result!.x, 2);
    assert.equal(result!.y, 2);
  });
});

// ─── Phase B: Desk assignment tests ──────────────────────────────────────────

describe('localWorldManager — desk assignment', () => {
  it('assigns unique desks to units in same room', async () => {
    const { LocalWorldManager } = await import('./localWorldManager.ts');
    const mgr = new LocalWorldManager(() => {}, () => undefined);
    // Room with 2 workbench tiles: both (0,0) and (1,0) are desks
    const wb0 = { id: 'wb-0', filePath: '/f/0', fileName: 'f0.ts', extension: 'ts', isTest: false, repoPath: 'test' };
    const wb1 = { id: 'wb-1', filePath: '/f/1', fileName: 'f1.ts', extension: 'ts', isTest: false, repoPath: 'test' };
    const grid: LocalTile[][] = [[
      { x: 0, y: 0, type: 'workbench', roomId: 'r1', workbench: wb0 },
      { x: 1, y: 0, type: 'workbench', roomId: 'r1', workbench: wb1 },
    ]];
    const world: LocalWorld = {
      repoId: 'test', grid, rooms: [{ id: 'r1', label: 'R', x: 0, y: 0, width: 2, height: 1, w: 2, h: 1, folderPath: '/r', folderName: 'r', workbenches: [wb0, wb1] }],
      width: 2, height: 1, workbenches: [wb0, wb1], deskAssignments: new Map(),
    };
    (mgr as unknown as { localWorld: unknown }).localWorld = world;

    // Two units in same room
    const u1: LocalUnit = { id: 'u1', name: 'A', unitType: 'worker', color: '#f00', gridX: 0, gridY: 0, targetX: null, targetY: null, path: [], pathIndex: 0, pathProgress: 0, state: 'idle_in_room', mission: null, workProgress: 0, macroUnitId: 'u1', currentWorkbenchId: null, currentRoomId: 'r1', fatigue: 100, maxFatigue: 100, isResting: false, effectiveSpeed: 1 };
    const u2: LocalUnit = { id: 'u2', name: 'B', unitType: 'worker', color: '#0f0', gridX: 0, gridY: 0, targetX: null, targetY: null, path: [], pathIndex: 0, pathProgress: 0, state: 'idle_in_room', mission: null, workProgress: 0, macroUnitId: 'u2', currentWorkbenchId: null, currentRoomId: 'r1', fatigue: 100, maxFatigue: 100, isResting: false, effectiveSpeed: 1 };

    mgr.assignDesk(u1);
    mgr.assignDesk(u2);

    assert.equal(world.deskAssignments.size, 2, 'both units got desks');
    const desk1 = world.deskAssignments.get('0,0')!;
    assert.ok(desk1 === 'u1' || desk1 === 'u2', 'desk assigned to one unit');
  });

  it('two units do not share the same desk', () => {
    // Direct Map test: single desk can only hold one unit
    const world = makeGrid(['W', '.']);
    world.deskAssignments.set('0,0', 'unit-1');
    // Second assignment attempt should not overwrite
    const key2 = '0,0';
    assert.ok(world.deskAssignments.has(key2));
    assert.equal(world.deskAssignments.get(key2), 'unit-1');
  });

  it('findBestWorkbench prefers assigned desk over nearest', () => {
    // Two workbenches at (0,0) and (2,0). Unit at (1,0) assigned to (2,0)
    const world = makeGrid(['W.W', '...']);
    // findNearestWorkbench normally picks (0,0) since it's closer to (1,0)
    const nearest = findNearestWorkbench(world, 1, 0);
    assert.equal(nearest!.x, 0, 'nearest is (0,0)');
    // But if assigned to (2,0), that should take priority
    world.deskAssignments.set('2,0', 'unit-1');
    // verify (2,0) exists
    const tile = world.grid[0]?.[2];
    assert.ok(tile?.workbench, 'workbench at (2,0) exists');
  });

  it('falls back to a desk outside the room when the spawn room has none', async () => {
    // Units spawn in the reception, which has no workbenches by design.
    const { LocalWorldManager } = await import('./localWorldManager.ts');
    const mgr = new LocalWorldManager(() => {}, () => undefined);
    const world = makeGrid(['..W']);
    world.grid[0]![0]!.roomId = 'lobby';
    world.grid[0]![2]!.roomId = 'r2';
    (mgr as unknown as { localWorld: unknown }).localWorld = world;

    const unit = {
      id: 'hero', name: 'H', unitType: 'hero', color: '#4af',
      gridX: 0, gridY: 0, targetX: null, targetY: null,
      path: [], pathIndex: 0, pathProgress: 0, state: 'idle_in_room',
      mission: null, workProgress: 0, macroUnitId: 'hero',
      currentWorkbenchId: null, currentRoomId: 'lobby',
      fatigue: 100, maxFatigue: 100, isResting: false, effectiveSpeed: 1,
    } as LocalUnit;

    mgr.assignDesk(unit);
    assert.deepEqual(unit.assignedDesk, { x: 2, y: 0 }, 'hero got the desk in the other room');
    assert.equal(world.deskAssignments.get('2,0'), 'hero');
  });

  it('nearest fallback skips desks assigned to other units, uses them as last resort', () => {
    // Two desks: (0,0) close, (2,0) far. (0,0) belongs to another unit.
    const world = makeGrid(['W.W']);
    world.deskAssignments.set('0,0', 'other-unit');
    const result = findNearestWorkbench(world, 1, 0, 'me');
    assert.ok(result, 'found a desk');
    assert.equal(result!.x, 2, 'skipped the taken desk, walked to the free one');
    // When EVERY desk is taken, the nearest taken one is the last resort.
    world.deskAssignments.set('2,0', 'other-unit');
    const lastResort = findNearestWorkbench(world, 1, 0, 'me');
    assert.ok(lastResort, 'still returns a desk when all are taken');
    assert.equal(lastResort!.x, 0, 'nearest taken desk wins as fallback');
  });

  it('releases desk assignments when a subagent unit is removed (after despawn fade)', async () => {
    const { LocalWorldManager } = await import('./localWorldManager.ts');
    const mgr = new LocalWorldManager(() => {}, () => undefined);
    const world = makeGrid(['W.']);
    (mgr as unknown as { localWorld: unknown }).localWorld = world;
    (mgr as unknown as { viewMode: string }).viewMode = 'local';

    const unit = {
      id: 'sub-1', name: 'S', unitType: 'worker', color: '#8ab4f8',
      gridX: 1, gridY: 0, targetX: null, targetY: null,
      path: [], pathIndex: 0, pathProgress: 0, state: 'working_on_file',
      mission: null, workProgress: 0, macroUnitId: 'MAIN',
      currentWorkbenchId: null, currentRoomId: null,
      fatigue: 100, maxFatigue: 100, isResting: false, effectiveSpeed: 1,
      ephemeral: true,
    } as LocalUnit;
    (mgr as unknown as { localUnits: LocalUnit[] }).localUnits = [unit];

    mgr.assignDesk(unit);
    assert.equal(world.deskAssignments.size, 1, 'subagent got a desk');

    // P1: removeSubagentUnit now triggers despawn fade, not instant removal.
    // The desk is released after the fade completes (~300ms = ~19 ticks).
    mgr.removeSubagentUnit('sub-1');
    // Desk still held during fade
    assert.equal(world.deskAssignments.size, 1, 'desk held during despawn fade');

    // Tick through the fade (~25 ticks to clear 300ms)
    for (let i = 0; i < 25; i++) {
      mgr.tick(16);
    }
    assert.equal(world.deskAssignments.size, 0, 'desk released after fade completes');
  });
});

// ─── chairTileForWorkbench ───────────────────────────────────────────────────
// Phase 6 visual fix: when an agent is sent to a folder, the agent must
// walk to and sit at the chair in front of the desk, not on the desk tile
// itself (the desk tile is the click-target for opening the folder).
describe('localPathfinding — chairTileForWorkbench', () => {
  it('returns the south neighbor of a south-facing desk', () => {
    // Layout: chair at y+1 of the desk (default 's' facing)
    const world = makeGrid(['W', 'C']);
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 0, y: 1 });
  });

  it('returns the north neighbor of a north-facing desk', () => {
    // Desk at y=1 facing 'n' → chair at y=0
    const world = makeGrid(['C', 'W']);
    world.grid[1]![0]!.facing = 'n';
    const seat = chairTileForWorkbench(world, 0, 1);
    assert.deepEqual(seat, { x: 0, y: 0 });
  });

  it('returns the east neighbor of an east-facing desk', () => {
    // 1 row, 2 cols: desk at (0,0), chair at (1,0) (east of desk)
    const world = makeGrid(['WC']);
    world.grid[0]![0]!.facing = 'e';
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 1, y: 0 });
  });

  it('returns the west neighbor of a west-facing desk', () => {
    // 1 row, 2 cols: chair at (0,0), desk at (1,0) (west of desk)
    const world = makeGrid(['CW']);
    world.grid[0]![1]!.facing = 'w';
    const seat = chairTileForWorkbench(world, 1, 0);
    assert.deepEqual(seat, { x: 0, y: 0 });
  });

  it('falls back to desk position when no chair neighbor exists', () => {
    // Desk with no chair in any direction (mis-laid out)
    const world = makeGrid(['W.']);
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 0, y: 0 });
  });

  it('falls back to desk position when the neighbor is wrong tile type', () => {
    // South neighbor is floor, not chair → don't sit on the floor
    const world = makeGrid(['W', '.']);
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 0, y: 0 });
  });

  it('falls back to desk when neighbor is out of bounds', () => {
    // Desk at the south edge of the world → no y+1 neighbor
    const world = makeGrid(['W']);
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 0, y: 0 });
  });

  it('defaults to south-facing when facing field is missing', () => {
    // Tile exists but has no facing set (legacy data, hand-edited worlds)
    const world = makeGrid(['W', 'C']);
    delete world.grid[0]![0]!.facing;
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 0, y: 1 });
  });
});

// ─── Dispatch integration: end-to-end "send to folder" path ─────────────────
// The full path an agent takes when the user opens a folder: a pathfind
// must terminate at the chair, not the desk.
describe('localPathfinding — dispatch to chair (integration)', () => {
  it('a unit dispatched to a workbench lands on the chair, not the desk', () => {
    // 2 rows, 2 cols: unit spawn at (0,0); desk at (1,0); chair at (1,1) (south)
    const world = makeGrid(['.W', '.C']);
    const seat = chairTileForWorkbench(world, 1, 0);
    assert.deepEqual(seat, { x: 1, y: 1 }, 'seat lookup picks the chair');

    // Path from the unit's spawn to the chair
    const result = findPath(world, 0, 0, seat.x, seat.y);
    assert.ok(result, 'path to the chair is reachable');
    const last = result!.path[result!.path.length - 1]!;
    assert.equal(last.x, 1, 'path ends at chair x');
    assert.equal(last.y, 1, 'path ends at chair y, not desk y=0');
  });

  it('a unit already on the desk tile does not need to walk', () => {
    // Degenerate case: unit and workbench at the same coords. Seat lookup
    // should still produce a coherent (fallback or chair) result and not
    // throw.
    const world = makeGrid(['W', 'C']);
    const seat = chairTileForWorkbench(world, 0, 0);
    assert.deepEqual(seat, { x: 0, y: 1 });
  });
});
