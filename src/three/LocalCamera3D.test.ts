import { describe, it, expect } from 'vitest';
import {
  LocalCamera3D,
  localGridToWorld3D,
  world3DToLocalGrid,
  ISO_TILE_W,
  ISO_TILE_H,
  ISO_WALL_H,
} from './LocalCamera3D.ts';

describe('localGridToWorld3D', () => {
  it('maps (0,0,0) to the origin', () => {
    const v = localGridToWorld3D(0, 0, 0);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    expect(v.z).toBe(0);
  });

  it('maps (1,0,0) one tile along the iso horizontal axis', () => {
    const v = localGridToWorld3D(1, 0, 0);
    expect(v.x).toBe(ISO_TILE_W / 2);
    expect(v.y).toBe(0);
    expect(v.z).toBe(ISO_TILE_H / 2);
  });

  it('maps (0,1,0) along the iso diagonal', () => {
    const v = localGridToWorld3D(0, 1, 0);
    expect(v.x).toBe(-ISO_TILE_W / 2);
    expect(v.y).toBe(0);
    expect(v.z).toBe(ISO_TILE_H / 2);
  });

  it('maps elevation via z * ISO_WALL_H', () => {
    const v = localGridToWorld3D(2, 3, 1);
    const ground = localGridToWorld3D(2, 3, 0);
    expect(v.y).toBe(ISO_WALL_H);
    expect(v.x).toBe(ground.x);
    expect(v.z).toBe(ground.z);
  });
});

describe('world3DToLocalGrid — round trip', () => {
  it('inverts localGridToWorld3D for integer coords', () => {
    for (const pair of [[0, 0], [1, 0], [0, 1], [3, 2], [-1, 4]]) {
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
    expect(c.right).toBe(200);
    expect(c.top).toBe(150);
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
    expect(c.right).toBe(500);
    expect(c.top).toBe(250);
  });
});
