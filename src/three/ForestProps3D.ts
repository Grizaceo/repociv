// ─── Low-poly forest props (glTF clumps from asset forge + Blender) ─────────
// Pines ship as GLBs with 3-4 complete trees (trunk cylinder + 3 canopy
// cones) as separate indexed meshes; the loader merges the FIRST tree into a
// single two-group geometry (group 0 = trunk, group 1 = canopies). Deciduous
// broadleafs come from make_props_vegetation.py as single vertex-colored
// meshes. Each forest tile mixes both kinds — Civ V woodlands are mixed
// stands, not pine monocultures — batched per prop id into InstancedMesh.
import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
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

const PINE_IDS = ['forest-pine-0', 'forest-pine-1', 'forest-pine-2'] as const;
const DECIDUOUS_IDS = ['forest-deciduous-0', 'forest-deciduous-1'] as const;
const PROP_IDS = [...PINE_IDS, ...DECIDUOUS_IDS];
const TREES_PER_TILE = 11;

// Trees reach toward the hex rim (~0.43 circumradius) so adjacent forest tiles'
// canopies meet at the shared edge and read as one continuous woodland — Civ V's
// forests flow across tiles, they don't sit as a tight clump in each hex centre.
// Kept clear of the full rim (1.0) so canopies stay on their own cap at steps.
const treeOffsets: Array<[number, number]> = [
  [-0.18, 0.12],
  [0.2, -0.14],
  [-0.05, -0.2],
  [0.14, 0.18],
  [0.0, 0.0],
  [-0.4, 0.16],
  [0.4, 0.02],
  [0.1, 0.42],
  [-0.16, -0.42],
  [0.3, -0.3],
  [-0.32, -0.2],
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

/**
 * Which tree occupies slot `t` of a forest tile with hash `h`. Deterministic:
 * ~1/3 of slots go to a broadleaf, the rest keep the tile's pine variant, so
 * existing forests keep their silhouette and gain variety instead of churn.
 */
export function forestTreeKind(
  h: number,
  t: number,
): { kind: 'pine' | 'deciduous'; variant: number } {
  if ((h * 13 + t * 29) % 11 < 4) {
    return { kind: 'deciduous', variant: (h + t) % DECIDUOUS_IDS.length };
  }
  return { kind: 'pine', variant: h % PINE_IDS.length };
}

let variants: Map<string, PropVariant> | null = null;
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
  // allSettled, not all: the deciduous GLBs are newer than the pines, and a
  // stale server (vite before restart, old deploy snapshot) 404s just them.
  // That must degrade to pines-only forests, not silently erase every tree.
  Promise.allSettled(PROP_IDS.map((id) => loader.loadAsync(`/assets/3d/props/${id}.glb`))).then(
    (outcomes) => {
      const loaded = new Map<string, PropVariant>();
      outcomes.forEach((outcome, i) => {
        if (outcome.status !== 'fulfilled') return;
        const id = PROP_IDS[i]!;
        // Pine GLBs hold 3-4 whole trees (node order trunk, canopy-a/b/c,
        // trunk.001, …) — merge only the first 4 meshes so instancing gets
        // ONE tree. Deciduous GLBs are a single mesh; merge everything.
        const maxMeshes = (PINE_IDS as readonly string[]).includes(id) ? 4 : Infinity;
        try {
          loaded.set(id, mergeGlbScene(outcome.value.scene, maxMeshes));
        } catch {
          // malformed GLB — treat like a failed fetch for this id
        }
      });
      // Pines are the base note — without the full set a forest can't render.
      if (PINE_IDS.every((id) => loaded.has(id))) {
        variants = loaded;
        state = 'ready';
        lastSignature = '';
      } else {
        variants = null;
        state = 'failed';
      }
      onSettled?.();
    },
  );
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

interface TreeInstance {
  tile: Tile;
  hash: number;
  slot: number;
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

  // Bucket every (tile, slot) by the prop id that occupies it.
  const byProp = new Map<string, TreeInstance[]>();
  for (const tile of forests) {
    const h = hashCoord(tile.coord.q, tile.coord.r);
    for (let t = 0; t < TREES_PER_TILE; t++) {
      const { kind, variant } = forestTreeKind(h, t);
      let prop = kind === 'pine' ? PINE_IDS[variant]! : DECIDUOUS_IDS[variant]!;
      // Degraded load (deciduous GLB missing): fall back to the tile's pine.
      if (!variants.has(prop)) prop = PINE_IDS[h % PINE_IDS.length]!;
      const list = byProp.get(prop) ?? [];
      list.push({ tile, hash: h, slot: t });
      byProp.set(prop, list);
    }
  }

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();
  const tint = new Color();

  for (const [prop, instances] of byProp) {
    const variant = variants.get(prop)!;
    const mesh = new InstancedMesh(variant.geometry, variant.materials, instances.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    const isPine = (PINE_IDS as readonly string[]).includes(prop);
    instances.forEach(({ tile, hash: h, slot: t }, i) => {
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      const [ox, oz] = treeOffsets[t]!;
      const scale = 0.8 + ((h + t * 3) % 5) * 0.06;
      const jx = (((h >> (t & 7)) % 9) - 4) * 0.02;
      const jz = (((h >> ((t + 3) & 7)) % 9) - 4) * 0.02;
      const rotSteps = (h + t) % 6;
      pos.set(base.x + (ox + jx) * HEX_SIZE, base.y + 1.5, base.z + (oz + jz) * HEX_SIZE);
      quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
      // Broadleaf models are squatter than the pine clumps — nudge them up in
      // scale so both canopies meet at a similar height band.
      const s = HEX_SIZE * (isPine ? 0.24 : 0.3) * scale;
      scl.set(s, s, s);
      matrix.compose(pos, quat, scl);
      // Deep green canopy that recedes into the grass (see forestCanopyTint).
      const [tr, tg, tb] = forestCanopyTint(h, t);
      tint.setRGB(tr, tg, tb);
      mesh.setColorAt(i, tint);
      mesh.setMatrixAt(i, matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  }
}

export function clearForestProps(): void {
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}
