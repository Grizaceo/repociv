// ─── Low-poly unit props (glTF from asset forge) ─────────────────────────────
// Loads the forge-built unit figurine (public/assets/3d/props/unit-worker-0.glb,
// bundle repociv-civv-r1). Unlike mountain/forest props the GLB keeps several
// meshes with distinct materials (body + banner + head), so the loader
// preserves every part with its baked local transform. UnitMesh3D consumes
// the parts per unit, cloning materials to tint them with the agent color —
// geometries stay shared and are never disposed per rebuild.
import { BufferGeometry, Material, Matrix4, Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type UnitPropPart = {
  geometry: BufferGeometry;
  material: Material;
  matrix: Matrix4;
};

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

let parts: UnitPropPart[] | null = null;
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

export function ensureUnitPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  loader
    .loadAsync('/assets/3d/props/unit-worker-0.glb')
    .then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const found: UnitPropPart[] = [];
      gltf.scene.traverse((obj) => {
        const mesh = obj as Mesh;
        if (mesh.isMesh) {
          found.push({
            geometry: mesh.geometry,
            material: mesh.material as Material,
            matrix: mesh.matrixWorld.clone(),
          });
        }
      });
      if (found.length === 0) throw new Error('glb without mesh');
      parts = found;
      state = 'ready';
      onSettled?.();
    })
    .catch(() => {
      // UnitMesh3D keeps the procedural figurine as fallback.
      parts = null;
      state = 'failed';
      onSettled?.();
    });
}
