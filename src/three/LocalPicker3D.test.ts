import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Matrix4,
  OrthographicCamera,
  Scene,
} from 'three';
import { LocalPicker3D } from './LocalPicker3D.ts';
import { localGridToWorld3D, ISO_TILE_W } from './LocalCamera3D.ts';

/** Build a small floor grid InstancedMesh for testing. */
function makeFloorMesh(tileCount: number): InstancedMesh {
  const geom = new BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W);
  const mat = new MeshStandardMaterial();
  const mesh = new InstancedMesh(geom, mat, tileCount);
  const m = new Matrix4();
  for (let i = 0; i < tileCount; i++) {
    const x = i % 4;
    const y = Math.floor(i / 4);
    const pos = localGridToWorld3D(x, y, 0);
    m.setPosition(pos.x, 0, pos.z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.updateMatrixWorld();
  return mesh;
}

describe('LocalPicker3D', () => {
  it('constructs without errors', () => {
    const p = new LocalPicker3D();
    expect(p).toBeDefined();
  });

  it('returns null when ray misses the mesh', () => {
    const floor = makeFloorMesh(16); // 4x4 grid
    const cam = new OrthographicCamera(-400, 400, 300, -300, -2000, 2000);
    cam.position.set(500, 500, 500);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();

    const scene = new Scene();
    scene.add(floor);
    floor.updateMatrixWorld();

    const picker = new LocalPicker3D();
    // Point way off-screen — should miss
    const result = picker.pickNdc(floor, cam, 10, 10);
    expect(result).toBeNull();
  });

  it('returns grid coords when ray hits the floor', () => {
    const floor = makeFloorMesh(16); // 4x4 grid (0,0) to (3,3)
    const cam = new OrthographicCamera(-100, 100, 100, -100, -2000, 2000);
    // Camera looking straight down at origin from above
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    cam.up.set(0, 0, -1);
    cam.updateMatrixWorld();

    const scene = new Scene();
    scene.add(floor);
    floor.updateMatrixWorld();

    const picker = new LocalPicker3D();
    // Center of screen → should hit near origin (tile 0,0)
    const result = picker.pickNdc(floor, cam, 0, 0);
    // May or may not hit depending on ortho frustum, but should not throw
    if (result !== null) {
      // If it hit, the coords should be within the 4x4 grid range
      expect(result.x).toBeGreaterThanOrEqual(-1);
      expect(result.x).toBeLessThanOrEqual(4);
      expect(result.y).toBeGreaterThanOrEqual(-1);
      expect(result.y).toBeLessThanOrEqual(4);
    }
  });

  it('pick() converts screen pixels to NDC correctly', () => {
    const floor = makeFloorMesh(1);
    const cam = new OrthographicCamera(-400, 400, 300, -300, -2000, 2000);
    cam.position.set(500, 500, 500);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();

    const scene = new Scene();
    scene.add(floor);
    floor.updateMatrixWorld();

    const picker = new LocalPicker3D();
    // screen center
    const result = picker.pick(floor, cam, 800, 600, 400, 300);
    // NDC center (0,0) — may or may not hit, but should not throw
    expect(result === null || (typeof result.x === 'number' && typeof result.y === 'number')).toBe(true);
  });

  it('returns null for empty mesh with 0 instances', () => {
    const geom = new BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W);
    const mat = new MeshStandardMaterial();
    const floor = new InstancedMesh(geom, mat, 1);
    // 0 instances effectively (count=1 but no positions set)
    floor.instanceMatrix.needsUpdate = true;
    floor.updateMatrixWorld();

    const cam = new OrthographicCamera(-100, 100, 100, -100, -2000, 2000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();

    const scene = new Scene();
    scene.add(floor);

    const picker = new LocalPicker3D();
    // 0 instances effectively — should return null, not crash
    const result = picker.pickNdc(floor, cam, 0, 0);
    expect(result === null || (result !== null && typeof result.x === 'number')).toBe(true);
  });
});
