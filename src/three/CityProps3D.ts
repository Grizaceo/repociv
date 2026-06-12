// ─── Capital city prop (warm stone glTF from asset forge) ───────────────────
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const propsGroup = new Group();
propsGroup.name = 'city-props';

type PropVariant = MergedGlb;

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

let variant: PropVariant | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
let activeMesh: InstancedMesh | null = null;

export function getCityPropsGroup(): Group {
  return propsGroup;
}

export function areCityPropsReady(): boolean {
  return state === 'ready';
}

export function areCityPropsSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

export function ensureCityPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  loader
    .loadAsync('/assets/3d/props/city-capital-0.glb')
    .then((gltf) => {
      // 7 meshes (base/keep/roof/towers/wing) on 2 materials — merge them
      // all; first-mesh-only renders the bare base cube.
      variant = mergeGlbScene(gltf.scene);
      state = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      variant = null;
      state = 'failed';
      onSettled?.();
    });
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

export function rebuildCityProps(
  cities: City[],
  getTile: (key: string) => Tile | undefined,
  lod: 'low' | 'medium' | 'high',
): void {
  if (state !== 'ready' || !variant || lod === 'low') {
    clearCityProps();
    return;
  }

  const capitals = cities.filter((c) => c.isCapital);
  const signature = capitals.map((c) => `${c.id}:${c.population}`).join('|');
  if (signature === lastSignature && activeMesh) return;
  lastSignature = signature;

  clearCityProps();
  if (capitals.length === 0) return;

  const mesh = new InstancedMesh(variant.geometry, variant.materials, capitals.length);
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();

  capitals.forEach((city, i) => {
    const tile = getTile(tileKey(city.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
    const h = hashCoord(city.coord.q, city.coord.r);
    const rotSteps = h % 6;
    pos.set(base.x, base.y + 2, base.z);
    quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
    const s = HEX_SIZE * 0.40;
    scl.set(s, s, s);
    matrix.compose(pos, quat, scl);
    mesh.setMatrixAt(i, matrix);
  });

  mesh.instanceMatrix.needsUpdate = true;
  activeMesh = mesh;
  propsGroup.add(mesh);
}

export function clearCityProps(): void {
  if (activeMesh) {
    propsGroup.remove(activeMesh);
    activeMesh.dispose();
    activeMesh = null;
  }
}
