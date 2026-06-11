// ─── Low-poly forest props (glTF clumps from asset forge) ───────────────────
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
propsGroup.name = 'forest-props';

type PropVariant = { geometry: BufferGeometry; material: Material };

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

const PROP_IDS = ['forest-pine-0', 'forest-pine-1', 'forest-pine-2'] as const;
const TREES_PER_TILE = 7;

const treeOffsets: Array<[number, number]> = [
  [-0.20, 0.14],
  [0.22, -0.16],
  [-0.06, -0.22],
  [0.16, 0.20],
  [-0.28, -0.06],
  [0.30, 0.04],
  [0.00, 0.02],
];

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
      variants = gltfs.map((gltf) => {
        let found: Mesh | null = null;
        gltf.scene.traverse((obj) => {
          if (!found && (obj as Mesh).isMesh) found = obj as Mesh;
        });
        if (!found) throw new Error('glb without mesh');
        const mesh = found as Mesh;
        return { geometry: mesh.geometry, material: mesh.material as Material };
      });
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

  byVariant.forEach((group, vi) => {
    if (group.length === 0) return;
    const variant = variants![vi]!;
    const instanceCount = group.length * TREES_PER_TILE;
    const mesh = new InstancedMesh(variant.geometry, variant.material, instanceCount);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    let i = 0;
    for (const tile of group) {
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      const h = hashCoord(tile.coord.q, tile.coord.r);

      for (let t = 0; t < TREES_PER_TILE; t++) {
        const [ox, oz] = treeOffsets[t]!;
        const scale = 0.80 + ((h + t * 3) % 5) * 0.06;
        const jx = (((h >> (t & 7)) % 9) - 4) * 0.012;
        const jz = (((h >> ((t + 3) & 7)) % 9) - 4) * 0.012;
        const rotSteps = (h + t) % 6;
        pos.set(
          base.x + (ox + jx) * HEX_SIZE,
          base.y + 1.5,
          base.z + (oz + jz) * HEX_SIZE,
        );
        quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
        const s = HEX_SIZE * 0.42 * scale;
        scl.set(s, s, s);
        matrix.compose(pos, quat, scl);
        mesh.setMatrixAt(i++, matrix);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
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
