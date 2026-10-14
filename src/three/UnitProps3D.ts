// ─── Low-poly unit props (glTF from asset forge) ─────────────────────────────
// Loads role-specific unit figurines under public/assets/3d/props/units/*.glb
// with fallback to public/assets/3d/props/unit-worker-0.glb (bundle repociv-civv-r1).
// Unlike mountain/forest props, each unit GLB keeps several meshes/primitives
// with distinct materials (skin, tintable garment at slot 1, wood, metal/gem),
// so the loader preserves every part with its baked local transform.
// UnitMesh3D and LocalAgent3D consume the parts per unit, cloning materials to
// tint slot 1 with the agent color — geometries stay shared and are never
// disposed per rebuild.
import { BufferGeometry, Group, Material, Matrix4, Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Unit } from '../types.ts';

export type UnitPropPart = {
  geometry: BufferGeometry;
  material: Material;
  matrix: Matrix4;
};

export const UNIT_ROLE_GLB_IDS = [
  'unit-mage',
  'unit-engineer',
  'unit-rogue',
  'unit-knight',
] as const;

export type UnitRoleGlbId = (typeof UNIT_ROLE_GLB_IDS)[number];

/** Maps every Unit['type'] to its role figurine GLB id:
 *  - Mage / Coordinator → hero, claude, openclaw
 *  - Engineer / Builder → worker, codex, cursor
 *  - Rogue / Ranger     → scout, caravan
 *  - Knight / Guardian  → praetorian, army, lexo
 */
export function unitRoleGlbForType(unitType: Unit['type']): UnitRoleGlbId {
  switch (unitType) {
    case 'hero':
    case 'claude':
    case 'openclaw':
      return 'unit-mage';
    case 'worker':
    case 'codex':
    case 'cursor':
      return 'unit-engineer';
    case 'scout':
    case 'caravan':
      return 'unit-rogue';
    case 'praetorian':
    case 'army':
    case 'lexo':
      return 'unit-knight';
    default:
      return 'unit-engineer';
  }
}

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

let parts: UnitPropPart[] | null = null;
const roleParts = new Map<UnitRoleGlbId, UnitPropPart[]>();
let state: PropsState = 'idle';

export function areUnitPropsReady(): boolean {
  return state === 'ready';
}

/** Settled = load finished one way or the other. The golden-capture script
 *  waits on this so a capture never races the async glb load. */
export function areUnitPropsSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

export function getUnitPropParts(): UnitPropPart[] | null {
  return parts;
}

/** Returns the loaded GLB parts for a given unitType, falling back to
 *  unit-worker-0.glb parts if the role GLB is unavailable, or null if no GLB
 *  has loaded yet (triggering the procedural cone+sphere fallback). */
export function getUnitPropPartsForType(unitType: Unit['type']): UnitPropPart[] | null {
  const roleId = unitRoleGlbForType(unitType);
  return roleParts.get(roleId) ?? parts;
}

export function extractUnitPartsFromScene(scene: Group): UnitPropPart[] {
  scene.updateMatrixWorld(true);
  const found: UnitPropPart[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (mesh.isMesh) {
      found.push({
        geometry: mesh.geometry,
        material: mesh.material as Material,
        matrix: mesh.matrixWorld.clone(),
      });
    }
  });
  return found;
}

export function ensureUnitPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();

  const workerPromise = loader.loadAsync('/assets/3d/props/unit-worker-0.glb').then((gltf) => {
    const found = extractUnitPartsFromScene(gltf.scene);
    if (found.length === 0) throw new Error('glb without mesh');
    parts = found;
  });

  const rolePromises = UNIT_ROLE_GLB_IDS.map((roleId) =>
    loader.loadAsync(`/assets/3d/props/units/${roleId}.glb`).then((gltf) => {
      const found = extractUnitPartsFromScene(gltf.scene);
      if (found.length === 0) throw new Error(`role glb ${roleId} without mesh`);
      roleParts.set(roleId, found);
    }),
  );

  Promise.allSettled([workerPromise, ...rolePromises]).then(() => {
    if (!parts && roleParts.size > 0) {
      parts = roleParts.get('unit-engineer') ?? roleParts.values().next().value ?? null;
    }
    if (parts || roleParts.size > 0) {
      state = 'ready';
    } else {
      parts = null;
      state = 'failed';
    }
    onSettled?.();
  });
}
