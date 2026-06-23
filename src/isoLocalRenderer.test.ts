// ─── RepoCiv — Iso local renderer helpers ───────────────────────────────────
// Tests for the small pure helpers extracted from drawIsoUnit. The actual
// drawIsoUnit is canvas-bound (covered by golden e2e screenshots) — these
// tests pin down the dirAngle / isMoving math that the renderer relies on.

import { describe, it, expect } from 'vitest';
import { isUnitMoving, computeUnitDirAngle } from './isoLocalRenderer.ts';
import type { LocalUnit } from './types.ts';

function makeUnit(overrides: Partial<LocalUnit> = {}): LocalUnit {
  return {
    id: 'u',
    name: 'U',
    unitType: 'worker',
    color: '#fff',
    gridX: 0,
    gridY: 0,
    targetX: null,
    targetY: null,
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state: 'idle_in_room',
    mission: null,
    workProgress: 0,
    macroUnitId: 'u',
    currentWorkbenchId: null,
    currentRoomId: 'r1',
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
    ...overrides,
  } as LocalUnit;
}

describe('isUnitMoving', () => {
  it('returns true when the path has steps and pathIndex is in range', () => {
    const u = makeUnit({
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      pathIndex: 0,
    });
    expect(isUnitMoving(u)).toBe(true);
  });

  it('returns false when the path is empty', () => {
    const u = makeUnit({ path: [], pathIndex: 0 });
    expect(isUnitMoving(u)).toBe(false);
  });

  it('returns false when pathIndex has reached the end of the path', () => {
    const u = makeUnit({ path: [{ x: 0, y: 0 }], pathIndex: 1 });
    expect(isUnitMoving(u)).toBe(false);
  });
});

describe('computeUnitDirAngle', () => {
  it('returns 0 for a stationary idle unit', () => {
    const u = makeUnit({ state: 'idle_in_room' });
    expect(computeUnitDirAngle(u)).toBe(0);
  });

  it('returns 0 for a resting unit (regression: pre-fix this was 0 too)', () => {
    const u = makeUnit({ state: 'resting', isResting: true });
    expect(computeUnitDirAngle(u)).toBe(0);
  });

  it('returns 0 for a working unit (THE BUG: pre-fix this was -π/2, making the body lie down)', () => {
    // Pre-fix, the angle was atan2(desk.y - chair.y, desk.x - chair.x) = atan2(-1, 0) = -π/2
    // for a south-facing desk. ctx.rotate(-π/2) rotated the entire iso body
    // (legs/torso/head/helmet) 90° counter-clockwise, making the unit look
    // like it was lying on its side. Post-fix: working units always render
    // upright, with the facing direction implicit from their position
    // (chair is south of desk).
    const u = makeUnit({
      state: 'working_on_file',
      currentWorkbenchId: 'wb-1',
      gridX: 2,
      gridY: 3, // chair position (south of desk at (2,2))
    });
    expect(computeUnitDirAngle(u)).toBe(0);
  });

  it('returns 0 for a working unit with the desk anywhere on the grid', () => {
    // Even if the desk is at a different relative position, working units
    // must render upright. Position relative to the desk is the visual cue.
    const u = makeUnit({ state: 'working_on_file', currentWorkbenchId: 'wb-1' });
    expect(computeUnitDirAngle(u)).toBe(0);
  });

  it('returns the direction of motion for a unit walking east', () => {
    const u = makeUnit({
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      pathIndex: 0,
    });
    // atan2(0, 1) = 0 → facing east (no rotation)
    expect(computeUnitDirAngle(u)).toBeCloseTo(0, 5);
  });

  it('returns the direction of motion for a unit walking south', () => {
    const u = makeUnit({
      path: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 2 },
      ],
      pathIndex: 0,
    });
    // atan2(1, 0) = π/2 → facing south
    expect(computeUnitDirAngle(u)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('returns the direction of motion for a unit walking north', () => {
    const u = makeUnit({
      path: [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
      ],
      pathIndex: 0,
    });
    // atan2(-1, 0) = -π/2 → facing north
    expect(computeUnitDirAngle(u)).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('returns the direction of motion for a unit walking west', () => {
    const u = makeUnit({
      path: [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      pathIndex: 0,
    });
    // atan2(0, -1) = π → facing west
    expect(computeUnitDirAngle(u)).toBeCloseTo(Math.PI, 5);
  });

  it('uses the current step (pathIndex), not the destination', () => {
    // Unit is at step 0 of 3, the direction is determined by step 0 → step 1
    const u = makeUnit({
      path: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
      pathIndex: 0,
    });
    expect(computeUnitDirAngle(u)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('uses the final step direction when pathIndex is at the penultimate entry', () => {
    const u = makeUnit({
      path: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 2 },
      ],
      pathIndex: 1,
    });
    // From step 1 (0,1) to step 2 (0,2): direction is south (π/2)
    expect(computeUnitDirAngle(u)).toBeCloseTo(Math.PI / 2, 5);
  });
});
