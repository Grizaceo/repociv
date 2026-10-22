// Local-only art trial. Never bundles/distributes the license-pending binary.
import { Box3, Group, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HEX_SIZE } from '../constants.ts';

export const MEMORY_ARCHIVE_PREVIEW_URL =
  '/assets-src/meshy/memory-archive/textured/archive-map.glb';
let template: Group | null = null;
let state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';

export function isMemoryArchiveType(type: string): boolean {
  return /(^|[-_])(memory|archive|knowledge|bibliotheca|wiki)($|[-_])/.test(type.toLowerCase());
}

/** Preserve authored PBR materials and UVs; geometry/material clones own disposal.
 * Textures remain shared with the cached template and are never disposed on rebuild. */
export function prepareMemoryArchive(source: Group): Group {
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
    throw new Error('Memory archive has no finite volume');
  }
  // A width/depth diagonal <= 0.50 hex fits the existing 0.26-hex terrain probe.
  const scale = Math.min(
    (HEX_SIZE * 0.5) / Math.max(Math.hypot(size.x, size.z), 1e-6),
    (HEX_SIZE * 0.62) / Math.max(size.y, 1e-6),
  );
  const center = bounds.getCenter(new Vector3());
  const pivot = new Group();
  pivot.name = 'wonder-memory-archive';
  const normalized = new Group();
  normalized.scale.setScalar(scale);
  model.position.sub(new Vector3(center.x, bounds.min.y, center.z));
  normalized.add(model);
  pivot.add(normalized);
  return pivot;
}

export function ensureMemoryArchiveLoad(onSettled?: () => void): void {
  if (!import.meta.env.DEV || import.meta.env.VITE_MESHY_PREVIEW !== '1' || state !== 'idle') {
    return;
  }
  state = 'loading';
  new GLTFLoader()
    .loadAsync(MEMORY_ARCHIVE_PREVIEW_URL)
    .then((gltf) => {
      // Validate before publishing the template, so fallback always remains usable.
      const probe = prepareMemoryArchive(gltf.scene);
      probe.traverse((obj) => {
        if (!(obj instanceof Mesh)) return;
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((m) => m.dispose());
      });
      template = gltf.scene;
      state = 'ready';
      onSettled?.();
    })
    .catch(() => {
      state = 'failed';
      onSettled?.();
    });
}

export function memoryArchiveState(): string {
  return state;
}

export function createMemoryArchive(type: string): Group | null {
  return template && isMemoryArchiveType(type) ? prepareMemoryArchive(template) : null;
}
