// ─── Terrain scatter props (desert palms/rocks, ice shards, hill shrubs) ────
// Civ V dresses its "empty" biomes with sparse decor: palms clustered at
// oases, boulders in open desert, pressure-ridge ice, low scrub on hills.
// GLBs come from scripts/blender/make_props_vegetation.py; each is a complete
// low-poly cluster (vertex-colored, flat-shaded) instanced per matching tile.
// Density is deliberately sparse — hash-gated so most tiles stay clean and
// the decor reads as landmarks, not noise.
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type Terrain, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const propsGroup = new Group();
propsGroup.name = 'terrain-scatter';

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

const PROP_IDS = [
  'desert-palm-0',
  'desert-palm-1',
  'desert-rock-0',
  'desert-rock-1',
  'ice-shard-0',
  'ice-shard-1',
  'shrub-0',
  'shrub-1',
] as const;

type PropId = (typeof PROP_IDS)[number];

interface Placement {
  /** Offset from the tile centre in hex-size units. */
  offset: [number, number];
  scale: number;
}

// One recipe = the prop instances a single tile receives. Offsets stay
// within ~0.45 circumradius so clusters keep clear of tile edges/steps.
interface ScatterRecipe {
  prop: PropId;
  placements: Placement[];
}

/**
 * Recipes per terrain, chosen by tile hash. `null` = tile stays bare.
 * Sparseness ratio (bare : dressed) tuned per biome — desert stays mostly
 * open sand, ice mostly flat sheet, hills get scrub a bit more often.
 */
const DESERT_RECIPES: Array<ScatterRecipe[] | null> = [
  null,
  null,
  null,
  [
    {
      prop: 'desert-palm-0',
      placements: [
        { offset: [-0.12, 0.08], scale: 1.0 },
        { offset: [0.22, -0.14], scale: 0.85 },
      ],
    },
  ],
  null,
  [{ prop: 'desert-rock-0', placements: [{ offset: [0.1, 0.16], scale: 1.0 }] }],
  null,
  [
    { prop: 'desert-palm-1', placements: [{ offset: [0.05, 0.2], scale: 0.95 }] },
    { prop: 'desert-rock-1', placements: [{ offset: [-0.28, -0.18], scale: 0.8 }] },
  ],
  [{ prop: 'desert-palm-0', placements: [{ offset: [0.18, 0.1], scale: 0.9 }] }],
  [{ prop: 'desert-rock-1', placements: [{ offset: [-0.15, -0.05], scale: 1.1 }] }],
];

const ICE_RECIPES: Array<ScatterRecipe[] | null> = [
  null,
  [{ prop: 'ice-shard-0', placements: [{ offset: [-0.08, 0.1], scale: 1.0 }] }],
  null,
  null,
  [{ prop: 'ice-shard-1', placements: [{ offset: [0.14, -0.12], scale: 0.9 }] }],
  null,
  [
    { prop: 'ice-shard-0', placements: [{ offset: [0.24, 0.18], scale: 0.7 }] },
    { prop: 'ice-shard-1', placements: [{ offset: [-0.2, -0.22], scale: 1.0 }] },
  ],
  null,
];

const HILLS_RECIPES: Array<ScatterRecipe[] | null> = [
  null,
  [
    {
      prop: 'shrub-0',
      placements: [
        { offset: [0.18, -0.1], scale: 1.0 },
        { offset: [-0.24, 0.2], scale: 0.75 },
      ],
    },
  ],
  null,
  [{ prop: 'shrub-1', placements: [{ offset: [-0.1, -0.24], scale: 0.9 }] }],
  [{ prop: 'shrub-0', placements: [{ offset: [0.05, 0.26], scale: 0.8 }] }],
  null,
  [
    {
      prop: 'shrub-1',
      placements: [
        { offset: [0.28, 0.12], scale: 1.05 },
        { offset: [-0.18, -0.12], scale: 0.7 },
      ],
    },
  ],
  null,
];

const RECIPES_BY_TERRAIN: Partial<Record<Terrain, Array<ScatterRecipe[] | null>>> = {
  desert: DESERT_RECIPES,
  ice: ICE_RECIPES,
  hills: HILLS_RECIPES,
};

/** Test-only view of the recipe tables (offset bounds, prop id validity). */
export const _testRecipes = { RECIPES_BY_TERRAIN, PROP_IDS };

// Base scale per prop family (models have footprint radius ~1).
function propBaseScale(prop: PropId): number {
  if (prop.startsWith('desert-palm')) return 0.22;
  if (prop.startsWith('desert-rock')) return 0.26;
  if (prop.startsWith('ice-shard')) return 0.26;
  return 0.2; // shrub
}

let variants: Map<PropId, MergedGlb> | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
const activeMeshes: InstancedMesh[] = [];

export function getTerrainScatterGroup(): Group {
  return propsGroup;
}

export function isTerrainScatterReady(): boolean {
  return state === 'ready';
}

export function isTerrainScatterSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

export function ensureTerrainScatterLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  Promise.all(PROP_IDS.map((id) => loader.loadAsync(`/assets/3d/props/${id}.glb`)))
    .then((gltfs) => {
      variants = new Map(PROP_IDS.map((id, i) => [id, mergeGlbScene(gltfs[i]!.scene)]));
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

interface Instance {
  tile: Tile;
  placement: Placement;
  hash: number;
  slot: number;
}

export function rebuildTerrainScatter(tiles: Tile[]): void {
  if (state !== 'ready' || !variants) return;

  const scatterTiles = tiles.filter(
    (t) => t.revealed && !t.city && RECIPES_BY_TERRAIN[t.terrain] !== undefined,
  );
  const signature = scatterTiles.map((t) => `${tileKey(t.coord)}:${t.terrain}`).join('|');
  if (signature === lastSignature && (activeMeshes.length > 0 || scatterTiles.length === 0)) return;
  lastSignature = signature;

  clearTerrainScatter();
  if (scatterTiles.length === 0) return;

  const byProp = new Map<PropId, Instance[]>();
  for (const tile of scatterTiles) {
    const recipes = RECIPES_BY_TERRAIN[tile.terrain]!;
    const hash = hashCoord(tile.coord.q, tile.coord.r);
    const recipe = recipes[hash % recipes.length];
    if (!recipe) continue;
    let slot = 0;
    for (const entry of recipe) {
      const list = byProp.get(entry.prop) ?? [];
      for (const placement of entry.placements) {
        list.push({ tile, placement, hash, slot: slot++ });
      }
      byProp.set(entry.prop, list);
    }
  }

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();

  for (const [prop, instances] of byProp) {
    if (instances.length === 0) continue;
    const variant = variants.get(prop)!;
    const mesh = new InstancedMesh(variant.geometry, variant.materials, instances.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    instances.forEach(({ tile, placement, hash, slot }, i) => {
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      const [ox, oz] = placement.offset;
      const jx = (((hash >> (slot & 7)) % 9) - 4) * 0.015;
      const jz = (((hash >> ((slot + 3) & 7)) % 9) - 4) * 0.015;
      const rotSteps = (hash + slot) % 6;
      pos.set(base.x + (ox + jx) * HEX_SIZE, base.y + 1.5, base.z + (oz + jz) * HEX_SIZE);
      quat.setFromAxisAngle(up, rotSteps * (Math.PI / 3));
      const jitter = 0.9 + ((hash + slot * 7) % 5) * 0.05;
      const s = HEX_SIZE * propBaseScale(prop) * placement.scale * jitter;
      scl.set(s, s, s);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(i, matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  }
}

export function clearTerrainScatter(): void {
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}
