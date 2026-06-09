import { describe, it, assert } from 'vitest';
import { findPath, findNearestWorkbench } from './localPathfinding.ts';
import { buildMockLocalWorld } from './localMap.ts';
import type { LocalWorld, LocalTile, LocalTileType } from './types.ts';

function makeGrid(tiles: string[]): LocalWorld {
  // Simple grid from string rows: '.' floor, '#' wall, 'W' workbench, 'D' door
  const typeMap: Record<string, LocalTileType> = {
    '.': 'floor',
    '#': 'wall',
    W: 'workbench',
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
    };
    const result = findNearestWorkbench(world, 0, 0);
    assert.ok(result !== null, 'should reach the workbench via the aisle');
    assert.equal(result!.x, 2);
    assert.equal(result!.y, 2);
  });
});
