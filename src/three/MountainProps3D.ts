// ─── Low-poly mountain props (glTF, iter3 gap #3 pilot) ─────────────────────
// Replaces the procedural cone decor on mountain tiles with faceted, snow-capped
// peaks (public/assets/3d/props/mountain-{0,1,2}.glb). The active producer is
// scripts/make_mountain_props.mjs (no Blender needed — three.js GLTFExporter),
// which models craggy flat-shaded crags in the iter13 relief style; the older
// smooth-cone Blender variant lives in scripts/blender/make_props.py. One
// InstancedMesh per variant; placement is a deterministic hash of the tile
// coord (variant + 60°-step rotation + scale jitter), so rebuilds and golden
// captures are stable.
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { terrainSurfaceY } from './terrainSurfaceY.ts';

const propsGroup = new Group();
propsGroup.name = 'mountain-props';

type PropVariant = MergedGlb;

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

let variants: PropVariant[] | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
const activeMeshes: InstancedMesh[] = [];

export function getMountainPropsGroup(): Group {
  return propsGroup;
}

/** Ready = glbs loaded and instancing is active (cone decor is skipped). */
export function areMountainPropsReady(): boolean {
  return state === 'ready';
}

/** Settled = load finished one way or the other. The golden-capture script
 *  waits on this so a capture never races the async glb load. */
export function areMountainPropsSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

export function ensureMountainPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  Promise.all([0, 1, 2].map((i) => loader.loadAsync(`/assets/3d/props/mountain-${i}.glb`)))
    .then((gltfs) => {
      variants = gltfs.map((gltf) => mergeGlbScene(gltf.scene));
      state = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      // Keep the procedural cone decor as fallback (TileDecor3D checks
      // areMountainPropsReady()).
      variants = null;
      state = 'failed';
      onSettled?.();
    });
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663));
}

export function rebuildMountainProps(tiles: Tile[]): void {
  if (state !== 'ready' || !variants) return;

  // Unrevealed peaks would poke through the fog-cover clouds — skip them
  // (TileDecor3D applies the same filter to the cone fallback).
  const mountains = tiles.filter((t) => t.terrain === 'mountain' && t.revealed);
  const signature = mountains.map((t) => `${tileKey(t.coord)}:${t.city ? 1 : 0}`).join('|');
  if (signature === lastSignature && activeMeshes.length > 0) return;
  if (signature === lastSignature && mountains.length === 0) return;
  lastSignature = signature;

  clearMountainProps();
  if (mountains.length === 0) return;

  const byVariant: Tile[][] = [[], [], []];
  for (const tile of mountains) {
    byVariant[hashCoord(tile.coord.q, tile.coord.r) % 3]!.push(tile);
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

    group.forEach((tile, i) => {
      const h = hashCoord(tile.coord.q, tile.coord.r);
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      // 60°-step rotation + small scale jitter, all from the coord hash.
      const rotSteps = (h >> 3) % 6;
      const jitter = 0.4 + ((h >> 5) % 5) * 0.02; // 0.40..0.48 × HEX_SIZE
      // City mountain tiles shrink and shift to the rim so the city stays
      // readable and the peak flanks the wall ring instead of clipping roofs.
      const cityScale = tile.city ? 0.48 : 1.0;
      const offAngle = ((h >> 7) % 6) * (Math.PI / 3) + Math.PI / 6;
      const offMag = tile.city ? HEX_SIZE * 0.46 : 0;
      const offX = Math.cos(offAngle) * offMag;
      const offZ = Math.sin(offAngle) * offMag;
      const surfaceY = terrainSurfaceY(tile, offX, offZ);
      pos.set(base.x + offX, surfaceY, base.z + offZ);
      quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
      const s = HEX_SIZE * jitter * cityScale;
      scl.set(s, s, s);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(i, matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  });
}

export function clearMountainProps(): void {
  // Geometry/material belong to the loaded glTF variants and are reused
  // across rebuilds — dispose only the per-rebuild InstancedMesh wrappers.
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}
