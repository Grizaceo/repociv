// ─── City props (KayKit Medieval Hexagon Pack — CC0, Meshy overlay) ─────────
// Cities render as multi-building clusters. KayKit faction-red models are the
// fallback (hand-painted texture atlas, CC0 — see
// public/assets/3d/props/kaykit/LICENSE-KayKit.txt). When VITE_MESHY_PREVIEW
// !== '0', living-knowledge-city Meshy modules overlay those part ids
// (dwelling, guild, forum, citadel, civic plaza). Each city level maps to a
// RECIPE: a list of parts with hex-fraction offsets, per-part scale (as a
// fraction of HEX_SIZE of the part's longest bbox side) and a rotation step
// (×60°). Part geometries are bbox-normalized at load so recipe scales are
// footprint-independent. Walls and towers come from CityWalls3D;
// CityCluster3D only draws a procedural fallback while the kits are loading
// or failed.
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { cityLevel } from './CityCluster3D.ts';
import { familyBuildingUrl } from './familyBuildingAssets.ts';
import {
  PROP_SURFACE_CLEARANCE,
  terrainFootprintMaxY,
  terrainSurfaceY,
} from './terrainSurfaceY.ts';
import { terrainRevision } from './terrainRevision.ts';

const propsGroup = new Group();
propsGroup.name = 'city-props';

type PropVariant = MergedGlb & { norm: number };

type PropsState = 'idle' | 'loading' | 'ready' | 'failed';

const KAYKIT_DIR = '/assets/3d/props/kaykit/buildings/red';
const KENNEY_DIR = '/assets/3d/props/kenney';

// Unique part ids across all recipes — one .gltf (+.bin+png) each.
const PROP_IDS = [
  'building_castle_red',
  'building_church_red',
  'building_tavern_red',
  'building_market_red',
  'building_home_A_red',
  'building_home_B_red',
  'building_well_red',
] as const;

export const BANNER_PROP_IDS = ['banner-green', 'banner-red'] as const;
export type BannerPropId = (typeof BANNER_PROP_IDS)[number];
export const MESHY_CITY_PLAZA_URL = familyBuildingUrl('civic-plaza');

/** Wave 1 step 2 settlement modules. Overlay replaces KayKit when preview is on. */
export const MESHY_SETTLEMENT_URLS = {
  'city-dwelling': '/assets/3d/props/meshy/city-dwelling-map.glb',
  'city-guild': '/assets/3d/props/meshy/city-guild-map.glb',
  'city-forum': '/assets/3d/props/meshy/city-forum-map.glb',
  'city-citadel': '/assets/3d/props/meshy/city-citadel-map.glb',
} as const;

export const SETTLEMENT_OVERLAY: Partial<Record<(typeof PROP_IDS)[number], string>> = {
  building_home_A_red: MESHY_SETTLEMENT_URLS['city-dwelling'],
  building_home_B_red: MESHY_SETTLEMENT_URLS['city-dwelling'],
  building_market_red: MESHY_SETTLEMENT_URLS['city-guild'],
  building_tavern_red: MESHY_SETTLEMENT_URLS['city-guild'],
  building_church_red: MESHY_SETTLEMENT_URLS['city-forum'],
  building_castle_red: MESHY_SETTLEMENT_URLS['city-citadel'],
  building_well_red: MESHY_CITY_PLAZA_URL,
};

type PartId = (typeof PROP_IDS)[number];

export function cityBannerId(city: City, tile: Tile | undefined): BannerPropId {
  if (tile?.skillHealth === 'broken' || tile?.skillHealth === 'stale') {
    return 'banner-red';
  }
  if (city.buildings?.some((b) => b.state === 'failed')) {
    return 'banner-red';
  }
  return 'banner-green';
}

interface RecipePart {
  id: PartId;
  ox: number; // offset in HEX_SIZE fractions
  oz: number;
  s: number; // longest-bbox-side as fraction of HEX_SIZE
  rot: number; // extra rotation steps ×60°
}

// Per-level cluster recipes. Offsets keep every part's edge inside the
// procedural wall ring (inner radius 0.34·HEX): dist(ox,oz)·HEX + s·HEX/2
// must stay below it (satellite-offset rule from the wall-ring pitfall).
const RECIPES: Record<'capital' | 'hamlet' | 'village' | 'town' | 'city', RecipePart[]> = {
  capital: [
    { id: 'building_castle_red', ox: 0.0, oz: 0.0, s: 0.6, rot: 0 },
    { id: 'building_well_red', ox: 0.2, oz: 0.1, s: 0.22, rot: 1 },
  ],
  hamlet: [
    { id: 'building_home_A_red', ox: 0.0, oz: 0.06, s: 0.5, rot: 0 },
    { id: 'building_home_B_red', ox: -0.13, oz: -0.09, s: 0.28, rot: 2 },
    { id: 'building_well_red', ox: 0.18, oz: -0.1, s: 0.2, rot: 3 },
  ],
  village: [
    { id: 'building_church_red', ox: 0.02, oz: -0.05, s: 0.52, rot: 0 },
    { id: 'building_home_A_red', ox: 0.15, oz: 0.1, s: 0.26, rot: 1 },
    { id: 'building_home_B_red', ox: -0.16, oz: 0.12, s: 0.24, rot: 4 },
  ],
  town: [
    { id: 'building_tavern_red', ox: -0.05, oz: -0.03, s: 0.5, rot: 0 },
    { id: 'building_market_red', ox: 0.14, oz: 0.11, s: 0.26, rot: 2 },
    { id: 'building_home_A_red', ox: -0.15, oz: 0.15, s: 0.24, rot: 5 },
  ],
  city: [
    { id: 'building_tavern_red', ox: -0.04, oz: -0.04, s: 0.54, rot: 0 },
    { id: 'building_market_red', ox: 0.13, oz: 0.12, s: 0.28, rot: 2 },
    { id: 'building_home_A_red', ox: -0.16, oz: 0.13, s: 0.26, rot: 5 },
    { id: 'building_well_red', ox: 0.02, oz: 0.19, s: 0.2, rot: 1 },
  ],
};

// Capital suburbs: KayKit homes OUTSIDE the wall ring so the capital reads as
// a cluster spilling past its fortifications (Civ V capitals are never one
// monolith). One per alternate hex-edge direction (30°/150°/270°), clear of
// the vertex towers (inner edge > 0.5·HEX) and inside the tile (outer edge
// < hex inradius 0.866·HEX). Replaces the old procedural box satellites.
const SUBURB_R = 0.64;
const CAPITAL_SUBURBS: RecipePart[] = [
  {
    id: 'building_home_A_red',
    ox: SUBURB_R * Math.cos(Math.PI / 6),
    oz: SUBURB_R * Math.sin(Math.PI / 6),
    s: 0.22,
    rot: 1,
  },
  {
    id: 'building_home_B_red',
    ox: -SUBURB_R * Math.cos(Math.PI / 6),
    oz: SUBURB_R * Math.sin(Math.PI / 6),
    s: 0.2,
    rot: 4,
  },
  { id: 'building_home_A_red', ox: 0, oz: -SUBURB_R, s: 0.2, rot: 3 },
];

// cityLevel() 0-3 → recipe key (level 3 is a non-capital "city").
const LEVEL_RECIPE = ['hamlet', 'village', 'town', 'city'] as const;

let variants: Map<PartId, PropVariant> | null = null;
let bannerVariants: Map<BannerPropId, PropVariant> | null = null;
let state: PropsState = 'idle';
let lastSignature = '';
const activeMeshes: InstancedMesh[] = [];

export function getCityPropsGroup(): Group {
  return propsGroup;
}

export function areCityPropsReady(): boolean {
  return state === 'ready';
}

export function areCityPropsSettled(): boolean {
  return state === 'ready' || state === 'failed';
}

export function ensureCityPropsLoad(onSettled?: () => void): void {
  if (state !== 'idle') return;
  state = 'loading';
  const loader = new GLTFLoader();
  Promise.all(PROP_IDS.map((id) => loader.loadAsync(`${KAYKIT_DIR}/${id}.gltf`)))
    .then(async (gltfs) => {
      const next = new Map<PartId, PropVariant>();
      for (let i = 0; i < PROP_IDS.length; i++) {
        const merged = mergeGlbScene(gltfs[i]!.scene);
        // Normalize to unit longest-bbox-side so recipe scales are
        // footprint-independent across KayKit's varied model sizes.
        merged.geometry.computeBoundingBox();
        const bb = merged.geometry.boundingBox!;
        const size = new Vector3().subVectors(bb.max, bb.min);
        const norm = 1 / Math.max(size.x, size.y, size.z, 1e-6);
        next.set(PROP_IDS[i]!, { ...merged, norm });
      }
      if (import.meta.env['VITE_MESHY_PREVIEW'] !== '0') {
        const unique = new Map<string, PartId[]>();
        for (const [id, url] of Object.entries(SETTLEMENT_OVERLAY) as Array<[PartId, string]>) {
          const bucket = unique.get(url);
          if (bucket) bucket.push(id);
          else unique.set(url, [id]);
        }
        await Promise.all(
          [...unique.entries()].map(async ([url, ids]) => {
            try {
              const gltf = await loader.loadAsync(url);
              const merged = mergeGlbScene(gltf.scene);
              merged.geometry.computeBoundingBox();
              const bb = merged.geometry.boundingBox!;
              const size = new Vector3().subVectors(bb.max, bb.min);
              const norm = 1 / Math.max(size.x, size.y, size.z, 1e-6);
              for (const id of ids) next.set(id, { ...merged, norm });
            } catch {
              // Keep the KayKit fallback for this module if the Meshy copy is missing.
            }
          }),
        );
      }
      variants = next;
      try {
        const bannerGltfs = await Promise.all(
          BANNER_PROP_IDS.map((id) => loader.loadAsync(`${KENNEY_DIR}/${id}.glb`)),
        );
        const bMap = new Map<BannerPropId, PropVariant>();
        for (let i = 0; i < BANNER_PROP_IDS.length; i++) {
          const merged = mergeGlbScene(bannerGltfs[i]!.scene);
          merged.geometry.computeBoundingBox();
          const bb = merged.geometry.boundingBox!;
          const size = new Vector3().subVectors(bb.max, bb.min);
          const norm = 1 / Math.max(size.x, size.y, size.z, 1e-6);
          bMap.set(BANNER_PROP_IDS[i]!, { ...merged, norm });
        }
        bannerVariants = bMap;
      } catch {
        bannerVariants = null;
      }
      state = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      variants = null;
      bannerVariants = null;
      state = 'failed';
      onSettled?.();
    });
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

interface InstanceSpec {
  city: City;
  part: RecipePart;
  cityRot: number;
}

export function rebuildCityProps(
  cities: City[],
  getTile: (key: string) => Tile | undefined,
  lod: 'low' | 'medium' | 'high',
): void {
  if (state !== 'ready' || !variants || lod === 'low') {
    clearCityProps();
    return;
  }

  const signature =
    `t${terrainRevision()}:` +
    cities
      .map((c) => {
        const tile = getTile(tileKey(c.coord));
        const banner = cityBannerId(c, tile);
        return `${c.id}:${c.isCapital ? 1 : 0}:L${cityLevel(c)}:${banner}`;
      })
      .join('|');
  if (signature === lastSignature && activeMeshes.length > 0) return;
  if (signature === lastSignature && cities.length === 0) return;
  lastSignature = signature;

  clearCityProps();
  if (cities.length === 0) return;

  // Bucket instances per part id: capitals → castle recipe, others → level
  // recipe. Every part of every city lands in its part's InstancedMesh.
  const byPart = new Map<PartId, InstanceSpec[]>();
  for (const city of cities) {
    const recipe = city.isCapital
      ? [...RECIPES.capital, ...CAPITAL_SUBURBS]
      : RECIPES[LEVEL_RECIPE[cityLevel(city)]!];
    const cityRot = hashCoord(city.coord.q, city.coord.r) % 6;
    for (const part of recipe) {
      const bucket = byPart.get(part.id);
      const spec: InstanceSpec = { city, part, cityRot };
      if (bucket) bucket.push(spec);
      else byPart.set(part.id, [spec]);
    }
  }

  const pos = new Vector3();
  const quat = new Quaternion();
  const partQuat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();

  for (const [id, specs] of byPart) {
    const variant = variants.get(id);
    if (!variant) continue;
    variant.geometry.computeBoundingBox();
    const minY = variant.geometry.boundingBox?.min.y ?? 0;
    const mesh = new InstancedMesh(variant.geometry, variant.materials, specs.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    for (let i = 0; i < specs.length; i++) {
      const { city, part, cityRot } = specs[i]!;
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const localX = part.ox * HEX_SIZE;
      const localZ = part.oz * HEX_SIZE;
      quat.setFromAxisAngle(up, cityRot * (Math.PI / 3));
      partQuat.setFromAxisAngle(up, part.rot * (Math.PI / 3));
      quat.multiply(partQuat);
      const s = HEX_SIZE * part.s * variant.norm;
      const footR = HEX_SIZE * part.s * 0.35;
      const y = tile
        ? terrainFootprintMaxY(tile, localX, localZ, footR, getTile) -
          minY * s +
          PROP_SURFACE_CLEARANCE
        : base.y - minY * s + PROP_SURFACE_CLEARANCE;
      pos.set(base.x + localX, y, base.z + localZ);
      scl.set(s, s, s);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(i, matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    activeMeshes.push(mesh);
    propsGroup.add(mesh);
  }

  // City status banners (banner-green.glb / banner-red.glb from Kenney Fantasy Town Kit CC0)
  if (bannerVariants) {
    const byBanner = new Map<BannerPropId, Array<{ city: City; cityRot: number }>>();
    for (const city of cities) {
      const tile = getTile(tileKey(city.coord));
      const bId = cityBannerId(city, tile);
      const cityRot = hashCoord(city.coord.q, city.coord.r) % 6;
      const list = byBanner.get(bId);
      if (list) list.push({ city, cityRot });
      else byBanner.set(bId, [{ city, cityRot }]);
    }

    for (const [bId, items] of byBanner) {
      const bVar = bannerVariants.get(bId);
      if (!bVar || items.length === 0) continue;
      bVar.geometry.computeBoundingBox();
      const minY = bVar.geometry.boundingBox?.min.y ?? 0;
      const bMesh = new InstancedMesh(bVar.geometry, bVar.materials, items.length);
      bMesh.castShadow = true;
      bMesh.receiveShadow = false;

      for (let i = 0; i < items.length; i++) {
        const { city, cityRot } = items[i]!;
        const tile = getTile(tileKey(city.coord));
        const elev = tile ? terrainElevation(tile.terrain) : 0;
        const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
        const angle = cityRot * (Math.PI / 3);
        const localX = Math.cos(angle) * HEX_SIZE * 0.42;
        const localZ = Math.sin(angle) * HEX_SIZE * 0.42;
        quat.setFromAxisAngle(up, angle);
        const s = HEX_SIZE * 0.22 * bVar.norm;
        const y = tile
          ? terrainSurfaceY(tile, localX, localZ, getTile) - minY * s + PROP_SURFACE_CLEARANCE
          : base.y - minY * s + PROP_SURFACE_CLEARANCE;
        pos.set(base.x + localX, y, base.z + localZ);
        scl.set(s, s, s);
        matrix.compose(pos, quat, scl);
        bMesh.setMatrixAt(i, matrix);
      }
      bMesh.instanceMatrix.needsUpdate = true;
      activeMeshes.push(bMesh);
      propsGroup.add(bMesh);
    }
  }
}

export function clearCityProps(): void {
  for (const mesh of activeMeshes) {
    propsGroup.remove(mesh);
    mesh.dispose();
  }
  activeMeshes.length = 0;
}

// Test-only exports: recipe invariants without GL loading.
export function _testRecipes(): {
  PROP_IDS: readonly string[];
  RECIPES: typeof RECIPES;
  LEVEL_RECIPE: readonly string[];
  CAPITAL_SUBURBS: readonly RecipePart[];
} {
  return { PROP_IDS, RECIPES, LEVEL_RECIPE, CAPITAL_SUBURBS };
}
