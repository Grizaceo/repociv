// ─── Low-poly unit props (glTF from asset forge) ─────────────────────────────
// Loads role-specific unit figurines under public/assets/3d/props/units/*.glb
// with fallback to public/assets/3d/props/unit-worker-0.glb (bundle repociv-civv-r1).
// Unlike mountain/forest props, each unit GLB keeps several meshes/primitives
// with distinct materials (skin, tintable garment at slot 1, wood, metal/gem),
// so the loader preserves every part with its baked local transform.
// UnitMesh3D and LocalAgent3D consume the parts per unit, cloning materials to
// tint slot 1 with the agent color — geometries stay shared and are never
// disposed per rebuild.
import { Box3, BufferGeometry, Group, Material, Matrix4, Mesh } from 'three';
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

/** Knowledge-city Meshy PBR figurines. Overlay replaces Phase 5 fantasy kits when preview is on. */
export const KNOWLEDGE_CITY_UNIT_URLS: Record<UnitRoleGlbId, string> = {
  'unit-mage': '/assets/3d/props/meshy/unit-coordinator-map.glb',
  'unit-engineer': '/assets/3d/props/meshy/unit-builder-map.glb',
  'unit-rogue': '/assets/3d/props/meshy/unit-ranger-map.glb',
  'unit-knight': '/assets/3d/props/meshy/unit-guardian-map.glb',
};

/** Meshy figurines are a single PBR mesh; Phase 5 / CSG kits tint slot 1. */
export function isUnitTintPart(
  parts: UnitPropPart[],
  index: number,
  mat: { name: string },
): boolean {
  return parts.length === 1 || index === 1 || mat.name.includes('tint');
}

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
const roleSources = new Map<UnitRoleGlbId, string>();
let state: PropsState = 'idle';

/** Ready flag plus which GLB won per role, so overlay cannot silently lose to KayKit. */
export function unitPropsSignature(): string {
  if (state !== 'ready') return state;
  return `ready:${UNIT_ROLE_GLB_IDS.map((id) => roleSources.get(id) ?? '').join('|')}`;
}

export function getUnitRoleSource(roleId: UnitRoleGlbId): string | undefined {
  return roleSources.get(roleId);
}

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
  const box = new Box3().setFromObject(scene);
  if (!box.isEmpty() && Number.isFinite(box.min.y) && Math.abs(box.min.y) > 1e-6) {
    scene.position.y -= box.min.y;
    scene.updateMatrixWorld(true);
  }
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

function loadUnitParts(loader: GLTFLoader, url: string): Promise<UnitPropPart[]> {
  return loader.loadAsync(url).then((gltf) => {
    const found = extractUnitPartsFromScene(gltf.scene);
    if (found.length === 0) throw new Error(`glb without mesh: ${url}`);
    return found;
  });
}

export function ensureUnitPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  const overlayOn = import.meta.env['VITE_MESHY_PREVIEW'] !== '0';

  const workerPromise = loadUnitParts(loader, '/assets/3d/props/unit-worker-0.glb').then(
    (found) => {
      parts = found;
    },
  );

  const rolePromises = UNIT_ROLE_GLB_IDS.map((roleId) => {
    const url = `/assets/3d/props/units/${roleId}.glb`;
    return loadUnitParts(loader, url).then((found) => {
      roleParts.set(roleId, found);
      roleSources.set(roleId, url);
    });
  });

  // Overlay must run after Phase 5 writes roleParts. Loading both in parallel
  // let the smaller KayKit files finish last and replace knowledge-city figurines.
  Promise.allSettled([workerPromise, ...rolePromises])
    .then(async () => {
      if (!overlayOn) return;
      await Promise.all(
        UNIT_ROLE_GLB_IDS.map((roleId) => {
          const url = KNOWLEDGE_CITY_UNIT_URLS[roleId];
          return loadUnitParts(loader, url)
            .then((found) => {
              roleParts.set(roleId, found);
              roleSources.set(roleId, url);
            })
            .catch(() => {
              // Keep the Phase 5 figurine if the knowledge-city copy is missing.
            });
        }),
      );
    })
    .then(() => {
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
