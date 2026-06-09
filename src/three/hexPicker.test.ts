import { describe, it, expect, beforeEach } from 'vitest';
import {
  Scene,
  OrthographicCamera,
  InstancedMesh,
  MeshLambertMaterial,
  Matrix4,
  Raycaster,
  Vector2,
} from 'three';
import { HexPicker } from './HexPicker.ts';
import { sharedHexGeometry } from './hexGeometry.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { terrainElevation } from '../isoHex.ts';
import { type Terrain } from '../types.ts';

function buildTestMesh(coords: Array<{ q: number; r: number; terrain: Terrain }>): {
  mesh: InstancedMesh;
  picker: HexPicker;
} {
  const mat = new MeshLambertMaterial();
  const mesh = new InstancedMesh(sharedHexGeometry, mat, coords.length);
  const picker = new HexPicker();
  const entries = coords.map((c, i) => {
    const elev = terrainElevation(c.terrain);
    const pos = axialToWorld3D(c.q, c.r, elev);
    mesh.setMatrixAt(i, new Matrix4().makeTranslation(pos.x, pos.y, pos.z));
    return { instanceId: i, coord: { q: c.q, r: c.r } };
  });
  mesh.instanceMatrix.needsUpdate = true;
  picker.setInstanceMap(entries);
  return { mesh, picker };
}

describe('HexPicker', () => {
  let scene: Scene;
  let camera: OrthographicCamera;

  beforeEach(() => {
    scene = new Scene();
    camera = new OrthographicCamera(-400, 400, 300, -300, 0.1, 2000);
    camera.position.set(0, 200, 200);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  });

  it('maps instance ids to axial coords and back', () => {
    const { picker } = buildTestMesh([
      { q: 0, r: 0, terrain: 'plains' },
      { q: 1, r: 0, terrain: 'forest' },
    ]);
    expect(picker.getAxialForInstance(0)).toEqual({ q: 0, r: 0 });
    expect(picker.getAxialForInstance(1)).toEqual({ q: 1, r: 0 });
    expect(picker.getInstanceForAxial({ q: 1, r: 0 })).toBe(1);
  });

  it('raycasts to the center tile', () => {
    const coords = [
      { q: 0, r: 0, terrain: 'plains' as Terrain },
      { q: 1, r: 0, terrain: 'plains' as Terrain },
      { q: 0, r: 1, terrain: 'hills' as Terrain },
    ];
    const { mesh, picker } = buildTestMesh(coords);
    scene.add(mesh);

    const center = axialToWorld3D(0, 0, 0);
    center.y += 1;
    const projected = center.clone().project(camera);
    const picked = picker.pickNdc(mesh, camera, projected.x, projected.y);
    expect(picked).toEqual({ q: 0, r: 0 });
  });

  it('returns null when ray misses all instances', () => {
    const { mesh, picker } = buildTestMesh([{ q: 0, r: 0, terrain: 'plains' }]);
    scene.add(mesh);
    const miss = picker.pickNdc(mesh, camera, 0, 0.95);
    expect(miss).toBeNull();
  });

  it('pick uses same result as manual raycaster for known tile', () => {
    const { mesh, picker } = buildTestMesh([{ q: 2, r: -1, terrain: 'mountain' }]);
    scene.add(mesh);
    const world = axialToWorld3D(2, -1, terrainElevation('mountain'));
    world.y += 1;
    const ndc = world.clone().project(camera);

    const manual = new Raycaster();
    manual.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
    const hit = manual.intersectObject(mesh, false)[0];

    const picked = picker.pickNdc(mesh, camera, ndc.x, ndc.y);
    expect(hit?.instanceId).toBe(0);
    expect(picked).toEqual({ q: 2, r: -1 });
  });
});
