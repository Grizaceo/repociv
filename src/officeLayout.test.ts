import { describe, it, expect } from 'vitest';
import { layoutOfficeRoom } from './officeLayout.ts';
import type { LocalRoom, LocalTile, Workbench } from './types.ts';

/**
 * Phase 3 regression: layoutFocusPod used to push workbenches into
 * cells that were also claimed as aisle (the south aisle strip).
 * The result was a deskPositions entry for a cell that the grid
 * rendered as aisle, and plan.deskCount that didn't match the
 * visible desks. The fix: skip cells already reserved as aisle or
 * cubicle_partition when placing extra workbenches.
 *
 * The test builds a 7x7 focus pod with 4 workbenches: the layout
 * has a 2-cell aisle on the south row, a 1-cell main desk just
 * north of it, and 2 extras that would have landed on aisle cells
 * without the fix.
 */
function mkWorkbench(id: string): Workbench {
  return {
    id,
    filePath: `/fake/${id}.ts`,
    fileName: `${id}.ts`,
    extension: 'ts',
    isTest: false,
    repoPath: '/fake',
  };
}

function mkGrid(w: number, h: number): LocalTile[][] {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => ({
      x,
      y,
      type: 'floor' as const,
      roomId: null,
      workbench: null,
    })),
  );
}

function mkFocusRoom(width: number, height: number, wbCount: number): LocalRoom {
  return {
    id: 'r1',
    label: 'focus',
    folderPath: 'src',
    folderName: 'src',
    x: 0,
    y: 0,
    width,
    height,
    w: width,
    h: height,
    zoneType: 'focus',
    workbenches: Array.from({ length: wbCount }, (_, i) => mkWorkbench(`w${i}`)),
  };
}

describe('layoutFocusPod / deskPositions consistency', () => {
  it('deskPositions only includes cells actually reserved for workbench', () => {
    const room = mkFocusRoom(7, 7, 4);
    const grid = mkGrid(7, 7);
    const result = layoutOfficeRoom(room, grid, 7, 7);

    // Sanity: this template should produce at least one desk.
    expect(result.deskPositions.length).toBeGreaterThan(0);

    // The cell at each deskPosition should NOT be on the aisle
    // (the bug was that some of them were).
    for (const desk of result.deskPositions) {
      const onAisle = result.placements.some(
        (p) => p.x === desk.x && p.y === desk.y && p.type === 'aisle',
      );
      expect(onAisle, `desk at (${desk.x},${desk.y}) overlaps aisle`).toBe(false);
      const onPartition = result.placements.some(
        (p) => p.x === desk.x && p.y === desk.y && p.type === 'cubicle_partition',
      );
      expect(onPartition, `desk at (${desk.x},${desk.y}) overlaps partition`).toBe(false);
    }

    // And the plan.deskCount matches what we actually placed.
    expect(result.plan.deskCount).toBe(result.deskPositions.length);
  });

  it('focus pod with a single workbench still returns a usable desk', () => {
    const room = mkFocusRoom(7, 7, 1);
    const grid = mkGrid(7, 7);
    const result = layoutOfficeRoom(room, grid, 7, 7);
    expect(result.deskPositions.length).toBe(1);
    expect(result.plan.deskCount).toBe(1);
  });

  it('focus pod with zero workbenches returns an empty deskPositions', () => {
    const room = mkFocusRoom(7, 7, 0);
    const grid = mkGrid(7, 7);
    const result = layoutOfficeRoom(room, grid, 7, 7);
    expect(result.deskPositions.length).toBe(0);
    expect(result.plan.deskCount).toBe(0);
  });
});
