// ─── Low-poly forest props (glTF clumps from asset forge) ───────────────────
// Each GLB contains 3-4 complete pine trees (trunk cylinder + 3 canopy cones)
// as separate indexed meshes. The loader merges the FIRST tree into a single
// two-group geometry (group 0 = trunk, group 1 = canopies) so InstancedMesh
// renders full trees — brown trunk, green conical canopy — in two draw calls.
import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const propsGroup = new Group();
propsGroup.name = 'forest-props';

type PropVariant = MergedGlb;

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

const PROP_IDS = ['forest-pine-0', 'forest-pine-1', 'forest-pine-2'] as const;
const TREES_PER_TILE = 11;

// Trees reach toward the hex rim (~0.43 circumradius) so adjacent forest tiles'
// canopies meet at the shared edge and read as one continuous woodland — Civ V's
// forests flow across tiles, they don't sit as a tight clump in each hex centre.
// Kept clear of the full rim (1.0) so canopies stay on their own cap at steps.
const treeOffsets: Array<[number, number]> = [
  [-0.18, 0.12],
  [0.20, -0.14],
  [-0.05, -0.20],
  [0.14, 0.18],
  [0.0, 0.0],
  [-0.40, 0.16],
  [0.40, 0.02],
  [0.10, 0.42],
  [-0.16, -0.42],
  [0.30, -0.30],
  [-0.32, -0.20],
];

/**
 * Per-tree canopy tint. Civ V forests read as a mottled DEEP green that recedes
 * into the grassland — never a warm, bright dot. The green channel always
 * dominates (R < G) and total luminance stays below the grass biome, so on the
 * strategic overview forests sink in as shade instead of popping as the golden
 * rosettes the old warm+bright formula (R up to 1.14) produced.
 */
export function forestCanopyTint(h: number, t: number): [number, number, number] {
  const vb = 0.62 + ((h * 7 + t * 13) % 7) * 0.035; // 0.62..0.83 base green
  const vw = ((h * 3 + t * 5) % 5) * 0.02; // 0..0.08 subtle mottle
  // R factor 0.82..0.90 stays strictly below 1.0 → green-dominant for every tree.
  return [vb * (0.82 + vw), vb, vb * 0.78];
}

let variants: PropVariant[] | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
const activeMeshes: InstancedMesh[] = [];

export function getForestPropsGroup(): Group {
  return propsGroup;
}

export function areForestPropsReady(): boolean {
  return state === 'ready';
}

export function areForestPropsSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

export function ensureForestPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  Promise.all(PROP_IDS.map((id) => loader.loadAsync(`/assets/3d/props/${id}.glb`)))
    .then((gltfs) => {
      // Node order is trunk, canopy-a/b/c, trunk.001, … so the first 4
      // meshes are one complete tree — instancing handles the clumping.
      variants = gltfs.map((gltf) => mergeGlbScene(gltf.scene, 4));
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

export function rebuildForestProps(tiles: Tile[]): void {
  if (state !== 'ready' || !variants) return;

  const forests = tiles.filter((t) => t.terrain === 'forest' && t.revealed);
  const signature = forests.map((t) => tileKey(t.coord)).join('|');
  if (signature === lastSignature && activeMeshes.length > 0) return;
  if (signature === lastSignature && forests.length === 0) return;
  lastSignature = signature;

  clearForestProps();
  if (forests.length === 0) return;

  const byVariant: Tile[][] = [[], [], []];
  for (const tile of forests) {
    byVariant[hashCoord(tile.coord.q, tile.coord.r) % 3]!.push(tile);
  }

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();
  const tint = new Color();

  byVariant.forEach((group, vi) => {
    if (group.length === 0) return;
    const variant = variants![vi]!;
    const instanceCount = group.length * TREES_PER_TILE;
    const mesh = new InstancedMesh(
      variant.geometry,
      variant.materials,
      instanceCount,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    let i = 0;
    for (const tile of group) {
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      const h = hashCoord(tile.coord.q, tile.coord.r);

      for (let t = 0; t < TREES_PER_TILE; t++) {
        const [ox, oz] = treeOffsets[t]!;
        const scale = 0.80 + ((h + t * 3) % 5) * 0.06;
        const jx = (((h >> (t & 7)) % 9) - 4) * 0.020;
        const jz = (((h >> ((t + 3) & 7)) % 9) - 4) * 0.020;
        const rotSteps = (h + t) % 6;
        pos.set(
          base.x + (ox + jx) * HEX_SIZE,
          base.y + 1.5,
          base.z + (oz + jz) * HEX_SIZE,
        );
        quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
        const s = HEX_SIZE * 0.24 * scale;
        scl.set(s, s, s);
        matrix.compose(pos, quat, scl);
        // Deep green canopy that recedes into the grass (see forestCanopyTint).
        const [tr, tg, tb] = forestCanopyTint(h, t);
        tint.setRGB(tr, tg, tb);
        mesh.setColorAt(i, tint);
        mesh.setMatrixAt(i++, matrix);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  });
}

export function clearForestProps(): void {
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}
