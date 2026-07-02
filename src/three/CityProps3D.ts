// ─── City props (warm stone glTF clusters from asset forge) ─────────────────
// Capitals get the keep GLB; non-capital cities get a level-appropriate
// centrepiece (hamlet longhouse → village + watchtower → town bell tower)
// so growth reads on the map the way Civ V's sprawl does. Level variants
// come from scripts/blender/make_props_city.py; the procedural cluster
// (CityCluster3D) still supplies plaza, walls, and satellite houses.
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { cityLevel } from './CityCluster3D.ts';

const propsGroup = new Group();
propsGroup.name = 'city-props';

type PropVariant = MergedGlb;

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

// Index 0 is the capital keep; 1-3 are the non-capital level centrepieces.
const PROP_IDS = ['city-capital-0', 'city-hamlet-0', 'city-village-0', 'city-town-0'] as const;

// cityLevel() 0-3 → variant index into PROP_IDS (town serves levels 2 and 3).
const LEVEL_VARIANT = [1, 2, 3, 3] as const;
// Level 3 towns are the same GLB scaled up — a non-capital "city".
const LEVEL_SCALE = [0.3, 0.32, 0.34, 0.4] as const;

let variants: PropVariant[] | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
const activeMeshes: InstancedMesh[] = [];

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
  Promise.all(PROP_IDS.map((id) => loader.loadAsync(`/assets/3d/props/${id}.glb`)))
    .then((gltfs) => {
      // Capital keep is 7 meshes (base/keep/roof/towers/wing) on 2 materials;
      // level centrepieces are single meshes — merge everything either way.
      variants = gltfs.map((gltf) => mergeGlbScene(gltf.scene));
      state = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      variants = null;
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
  if (state !== 'ready' || !variants || lod === 'low') {
    clearCityProps();
    return;
  }

  const signature = cities
    .map((c) => `${c.id}:${c.isCapital ? 1 : 0}:L${cityLevel(c)}`)
    .join('|');
  if (signature === lastSignature && activeMeshes.length > 0) return;
  if (signature === lastSignature && cities.length === 0) return;
  lastSignature = signature;

  clearCityProps();
  if (cities.length === 0) return;

  // Bucket cities per variant: capitals → keep, others → level centrepiece.
  const byVariant: Array<Array<{ city: City; scale: number }>> = PROP_IDS.map(() => []);
  for (const city of cities) {
    if (city.isCapital) {
      byVariant[0]!.push({ city, scale: 0.4 });
    } else {
      const lvl = cityLevel(city);
      byVariant[LEVEL_VARIANT[lvl]!]!.push({ city, scale: LEVEL_SCALE[lvl]! });
    }
  }

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();

  byVariant.forEach((group, vi) => {
    if (group.length === 0) return;
    const variant = variants![vi]!;
    const mesh = new InstancedMesh(variant.geometry, variant.materials, group.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    group.forEach(({ city, scale }, i) => {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const h = hashCoord(city.coord.q, city.coord.r);
      const rotSteps = h % 6;
      pos.set(base.x, base.y + 2, base.z);
      quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
      const s = HEX_SIZE * scale;
      scl.set(s, s, s);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(i, matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  });
}

export function clearCityProps(): void {
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}
