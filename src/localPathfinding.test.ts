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

  it('works on mock world', () => {
    const world = buildMockLocalWorld();
    if (world.workbenches.length > 0) {
      const result = findNearestWorkbench(world, 1, 1);
      assert.ok(result !== null, 'mock world should have reachable workbenches');
    }
  });
});
