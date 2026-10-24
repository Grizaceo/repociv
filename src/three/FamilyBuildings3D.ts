// Knowledge-city family buildings. Enabled by default; VITE_MESHY_PREVIEW=0
// restores Kenney fallbacks. Meshy license is still unverified.
import { Box3, Group, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HEX_SIZE } from '../constants.ts';
import {
  FAMILY_BUILDING_IDS,
  familyBuildingUrl,
  type FamilyBuildingId,
} from './familyBuildingAssets.ts';

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';
const templates = new Map<FamilyBuildingId, Group>();
const states = new Map<FamilyBuildingId, LoadState>(FAMILY_BUILDING_IDS.map((id) => [id, 'idle']));

export function isMemoryArchiveType(type: string): boolean {
  return /(^|[-_])(memory|archive|knowledge|bibliotheca|wiki)($|[-_])/.test(type.toLowerCase());
}

/** Enabled by default; set VITE_MESHY_PREVIEW=0 to force Kenney fallbacks. */
export function familyPreviewEnabled(): boolean {
  return import.meta.env.VITE_MESHY_PREVIEW !== '0';
}

/** Preserve authored PBR materials and UVs; geometry/material clones own disposal.
 * Textures remain shared with the cached template and are never disposed on rebuild. */
export function prepareFamilyBuilding(source: Group, id: FamilyBuildingId): Group {
  const model = source.clone(true);
  model.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    obj.geometry = obj.geometry.clone();
    obj.material = Array.isArray(obj.material)
      ? obj.material.map((m) => m.clone())
      : obj.material.clone();
    obj.castShadow = true;
    obj.receiveShadow = true;
  });
  const bounds = new Box3().setFromObject(model);
  const size = bounds.getSize(new Vector3());
  if (bounds.isEmpty() || !Number.isFinite(size.length()) || size.length() === 0) {
    throw new Error(`Family building ${id} has no finite volume`);
  }
  // A width/depth diagonal <= 0.50 hex fits the existing 0.26-hex terrain probe.
  const scale = Math.min(
    (HEX_SIZE * 0.5) / Math.max(Math.hypot(size.x, size.z), 1e-6),
    (HEX_SIZE * 0.62) / Math.max(size.y, 1e-6),
  );
  const center = bounds.getCenter(new Vector3());
  const pivot = new Group();
  pivot.name = `wonder-${id}`;
  const normalized = new Group();
  normalized.scale.setScalar(scale);
  model.position.sub(new Vector3(center.x, bounds.min.y, center.z));
  normalized.add(model);
  pivot.add(normalized);
  return pivot;
}

function disposeProbe(probe: Group): void {
  probe.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.forEach((m) => m.dispose());
  });
}

/** Starts each building's load once; every failure keeps the ordinary wonder. */
export function ensureFamilyBuildingsLoad(onSettled?: () => void): void {
  if (!familyPreviewEnabled()) return;
  const loader = new GLTFLoader();
  for (const id of FAMILY_BUILDING_IDS) {
    if (states.get(id) !== 'idle') continue;
    states.set(id, 'loading');
    loader
      .loadAsync(familyBuildingUrl(id))
      .then((gltf) => {
        // Validate before publishing the template, so fallback always remains usable.
        disposeProbe(prepareFamilyBuilding(gltf.scene, id));
        templates.set(id, gltf.scene);
        states.set(id, 'ready');
        onSettled?.();
      })
      .catch(() => {
        states.set(id, 'failed');
        onSettled?.();
      });
  }
}

export function familyBuildingState(id: FamilyBuildingId): LoadState {
  return states.get(id) ?? 'idle';
}

/** Compact load signature so map and wonder rebuilds notice every async swap. */
export function familyBuildingsSignature(): string {
  return FAMILY_BUILDING_IDS.map((id) => (states.get(id) ?? 'idle')[0]).join('');
}

export function familyBuildingsLoading(): boolean {
  return FAMILY_BUILDING_IDS.some((id) => states.get(id) === 'loading');
}

export function createFamilyBuilding(id: FamilyBuildingId | null): Group | null {
  const template = id ? templates.get(id) : undefined;
  return template && id ? prepareFamilyBuilding(template, id) : null;
}
