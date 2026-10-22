// ─── Sacred-marker props (glTF from asset forge) ─────────────────────────────
// Loads sacred-marker-0.glb (obelisk with glowing cap) from bundle
// repociv-civv-r1 and places it on revealed sacred tiles that carry neither a
// city (the capital's castle owns its centre) nor a wonder. TileDecor3D skips
// its procedural stone circle + altar while areResourcePropsReady().
//
// High-yield tiles get no physical prop: in this world only repo cities reach
// the old crystal threshold, and a crystal on every city rim cluttered the
// plazas. The CSS2D yield icons in TileYields3D carry that readout alone.
//
// The GLB keeps several meshes with distinct materials, so each part gets
// its own InstancedMesh (instance matrix = tile transform × part transform).
import {
  BufferGeometry,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { PROP_SURFACE_CLEARANCE, terrainSurfaceY } from './terrainSurfaceY.ts';

const propsGroup = new Group();
propsGroup.name = 'resource-props';

type PropPart = { geometry: BufferGeometry; material: Material; matrix: Matrix4 };

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

let markerParts: PropPart[] | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
const activeMeshes: InstancedMesh[] = [];

export function getResourcePropsGroup(): Group {
  return propsGroup;
}

export function areResourcePropsReady(): boolean {
  return state === 'ready';
}

/** Settled = load finished one way or the other (golden-capture wait). */
export function areResourcePropsSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

function extractParts(scene: Group): PropPart[] {
  scene.updateMatrixWorld(true);
  const parts: PropPart[] = [];
  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (mesh.isMesh) {
      parts.push({
        geometry: mesh.geometry,
        material: mesh.material as Material,
        matrix: mesh.matrixWorld.clone(),
      });
    }
  });
  if (parts.length === 0) throw new Error('glb without mesh');
  return parts;
}

export function ensureResourcePropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  loader
    .loadAsync('/assets/3d/props/sacred-marker-0.glb')
    .then((marker) => {
      markerParts = extractParts(marker.scene as unknown as Group);
      state = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      // TileDecor3D keeps the procedural stone circle + altar as fallback.
      markerParts = null;
      state = 'failed';
      onSettled?.();
    });
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663));
}

function instanceParts(parts: PropPart[], tiles: Tile[], baseScale: number): void {
  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const tileMatrix = new Matrix4();
  const instMatrix = new Matrix4();

  for (const part of parts) {
    const mesh = new InstancedMesh(part.geometry, part.material, tiles.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    tiles.forEach((tile, i) => {
      const h = hashCoord(tile.coord.q, tile.coord.r);
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      const rotSteps = (h >> 3) % 6;
      const jitter = 1.0 + ((h >> 5) % 5) * 0.04; // 1.00..1.16
      // City/district tiles: shift to the rim and shrink so the plates
      // stay readable (MountainProps3D city-branch convention).
      const crowded = Boolean(tile.city) || Boolean(tile.district);
      const offAngle = ((h >> 7) % 6) * (Math.PI / 3) + Math.PI / 6;
      const offMag = crowded ? HEX_SIZE * 0.34 : 0;
      const crowdScale = crowded ? 0.7 : 1.0;
      const offX = Math.cos(offAngle) * offMag;
      const offZ = Math.sin(offAngle) * offMag;
      const surfaceY = terrainSurfaceY(tile, offX, offZ) + PROP_SURFACE_CLEARANCE;
      pos.set(base.x + offX, surfaceY, base.z + offZ);
      quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
      const s = HEX_SIZE * baseScale * jitter * crowdScale;
      scl.set(s, s, s);
      tileMatrix.compose(pos, quat, scl);
      instMatrix.multiplyMatrices(tileMatrix, part.matrix);
      mesh.setMatrixAt(i, instMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  }
}

export function rebuildResourceProps(tiles: Tile[]): void {
  if (state !== 'ready' || !markerParts) return;

  const sacreds = tiles.filter(
    (t) => t.terrain === 'sacred' && t.revealed && !t.city && t.district?.type !== 'wonder',
  );
  const signature = sacreds.map((t) => `${tileKey(t.coord)}:${t.district ? 1 : 0}`).join('|');
  if (signature === lastSignature && activeMeshes.length > 0) return;
  if (signature === lastSignature && sacreds.length === 0) return;
  lastSignature = signature;

  clearResourceProps();
  if (sacreds.length > 0) instanceParts(markerParts, sacreds, 0.3);
}

export function clearResourceProps(): void {
  // Geometry/material belong to the loaded glTF parts and are reused
  // across rebuilds — dispose only the per-rebuild InstancedMesh wrappers.
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}
