import { describe, it, expect } from 'vitest';
import {
  LocalCamera3D,
  localGridToWorld3D,
  world3DToLocalGrid,
  isoPixelToGrid,
  LOCAL_TILE_3D,
  ISO_TILE_W,
  ISO_TILE_H,
  ISO_WALL_H,
} from './LocalCamera3D.ts';

/** The 3D frustum is widened by this so one grid step covers the same pixels
 *  as it does in the 2D iso view (a 45° camera foreshortens by cos 45°). */
const ISO_FRUSTUM_SCALE = Math.SQRT2;

describe('localGridToWorld3D', () => {
  it('maps (0,0,0) to the origin', () => {
    const v = localGridToWorld3D(0, 0, 0);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    expect(v.z).toBe(0);
  });

  // The lattice is SQUARE in world space; the camera makes the diamond. A
  // projection baked in here would be applied twice.
  it('maps grid +x to world +X, one tile', () => {
    const v = localGridToWorld3D(1, 0, 0);
    expect(v.x).toBe(LOCAL_TILE_3D);
    expect(v.y).toBe(0);
    expect(v.z).toBe(0);
  });

  it('maps grid +y to world +Z, one tile', () => {
    const v = localGridToWorld3D(0, 1, 0);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    expect(v.z).toBe(LOCAL_TILE_3D);
  });

  it('keeps tiles exactly one box apart so floors tile edge to edge', () => {
    const a = localGridToWorld3D(3, 5, 0);
    const b = localGridToWorld3D(4, 5, 0);
    expect(b.x - a.x).toBe(ISO_TILE_W);
  });

  it('maps elevation via z * ISO_WALL_H', () => {
    const v = localGridToWorld3D(2, 3, 1);
    const ground = localGridToWorld3D(2, 3, 0);
    expect(v.y).toBe(ISO_WALL_H);
    expect(v.x).toBe(ground.x);
    expect(v.z).toBe(ground.z);
  });
});

describe('isoPixelToGrid', () => {
  // The 2D renderer pans in iso pixels; the 3D scene lives in square grid
  // space. Without this unprojection both cameras drift apart on pan.
  it('inverts the 2D iso projection', () => {
    for (const pair of [
      [0, 0],
      [1, 0],
      [0, 1],
      [4, 3],
      [-2, 5],
    ]) {
      const gx = pair[0]!;
      const gy = pair[1]!;
      const px = (gx - gy) * (ISO_TILE_W / 2);
      const py = (gx + gy) * (ISO_TILE_H / 2);
      const back = isoPixelToGrid(px, py);
      expect(back.x).toBeCloseTo(gx, 9);
      expect(back.y).toBeCloseTo(gy, 9);
    }
  });
});

describe('world3DToLocalGrid — round trip', () => {
  it('inverts localGridToWorld3D for integer coords', () => {
    for (const pair of [
      [0, 0],
      [1, 0],
      [0, 1],
      [3, 2],
      [-1, 4],
    ]) {
      const gx = pair[0]!;
      const gy = pair[1]!;
      const w = localGridToWorld3D(gx, gy, 0);
      const back = world3DToLocalGrid(w.x, w.z);
      expect(Math.round(back.x)).toBe(gx);
      expect(Math.round(back.y)).toBe(gy);
    }
  });
});

describe('LocalCamera3D', () => {
  it('constructs with ortho frustum matching viewport', () => {
    const cam = new LocalCamera3D(800, 600);
    const c = cam.getCamera();
    expect(c.left).toBe(-400);
    expect(c.right).toBe(400);
    expect(c.top).toBe(300);
    expect(c.bottom).toBe(-300);
  });

  it('syncCamera applies zoom by shrinking the frustum', () => {
    const cam = new LocalCamera3D(800, 600);
    cam.syncCamera({ x: 0, y: 0, zoom: 2, cx: 400, cy: 300 });
    const c = cam.getCamera();
    expect(c.right).toBeCloseTo(200 * ISO_FRUSTUM_SCALE, 6);
    expect(c.top).toBeCloseTo(150 * ISO_FRUSTUM_SCALE, 6);
  });

  it('syncCamera moves the target', () => {
    const cam = new LocalCamera3D(800, 600);
    cam.syncCamera({ x: 100, y: 50, zoom: 1, cx: 400, cy: 300 });
    // After sync, the camera position should be offset from target
    const c = cam.getCamera();
    expect(c.position.x).not.toBe(0);
    expect(c.position.z).not.toBe(0);
  });

  it('resize updates dimensions for subsequent syncCamera', () => {
    const cam = new LocalCamera3D(800, 600);
    cam.resize(1000, 500);
    cam.syncCamera({ x: 0, y: 0, zoom: 1, cx: 500, cy: 250 });
    const c = cam.getCamera();
    expect(c.right).toBeCloseTo(500 * ISO_FRUSTUM_SCALE, 6);
    expect(c.top).toBeCloseTo(250 * ISO_FRUSTUM_SCALE, 6);
  });
});
