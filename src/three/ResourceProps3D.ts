// ─── Resource & sacred-marker props (glTF from asset forge) ──────────────────
// Loads resource-crystal-0.glb (crystal cluster on a pedestal) and
// sacred-marker-0.glb (obelisk with glowing cap) from bundle repociv-civv-r1.
//
// Placement:
//   - crystal → "high resource" tiles: gold ≥ 8 AND science ≥ 4 (≈1% of the
//     live map — strategic-resource rarity, complements the CSS2D yield
//     icons in TileYields3D: the GLB is the physical presence, the icon is
//     the data readout). In this world every high-yield tile carries a
//     city/district (repos ARE the cities), so the crystal shifts to the
//     hex rim and shrinks — same convention as MountainProps3D's city
//     branch — instead of competing with the plaza.
//   - marker  → sacred tiles, replacing the procedural altar+gem at the
//     centre of the stone circle (TileDecor3D keeps the stones and skips
//     its altar when areResourcePropsReady()).
//
// Both GLBs keep several meshes with distinct materials, so each part gets
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

const propsGroup = new Group();
propsGroup.name = 'resource-props';

type PropPart = { geometry: BufferGeometry; material: Material; matrix: Matrix4 };

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

let crystalParts: PropPart[] | null = null;
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

/** High-resource tile: physical crystal presence (matches ≈1% of tiles). */
export function isCrystalTile(tile: Tile): boolean {
  return tile.resources.gold >= 8 && tile.resources.science >= 4;
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
  Promise.all([
    loader.loadAsync('/assets/3d/props/resource-crystal-0.glb'),
    loader.loadAsync('/assets/3d/props/sacred-marker-0.glb'),
  ])
    .then(([crystal, marker]) => {
      crystalParts = extractParts(crystal.scene as unknown as Group);
      markerParts = extractParts(marker.scene as unknown as Group);
      state = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      // TileDecor3D keeps the procedural altar+gem as sacred fallback;
      // crystal tiles simply stay bare (yield icons still mark them).
      crystalParts = null;
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
      pos.set(
        base.x + Math.cos(offAngle) * offMag,
        base.y + 1.5,
        base.z + Math.sin(offAngle) * offMag,
      );
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
  if (state !== 'ready' || !crystalParts || !markerParts) return;

  const crystals = tiles.filter((t) => t.revealed && isCrystalTile(t));
  const sacreds = tiles.filter((t) => t.terrain === 'sacred' && t.revealed);
  const signature =
    crystals.map((t) => `${tileKey(t.coord)}:${t.city ? 1 : 0}${t.district ? 1 : 0}`).join('|') +
    '#' +
    sacreds.map((t) => tileKey(t.coord)).join('|');
  if (signature === lastSignature && activeMeshes.length > 0) return;
  if (signature === lastSignature && crystals.length + sacreds.length === 0) return;
  lastSignature = signature;

  clearResourceProps();
  if (crystals.length > 0) instanceParts(crystalParts, crystals, 0.26);
  if (sacreds.length > 0) instanceParts(markerParts, sacreds, 0.30);
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
