// ─── City walls (KayKit modular wall kit — CC0) ─────────────────────────────
// Replaces the procedural hexagonal wall ring (CityCluster3D) with the KayKit
// modular wall set: straight segments along each hex edge, one taller gate
// piece per city, and a faction tower at each hex vertex. Loads independently
// of the building GLBs so walls can ship/settle even if the building pack
// fails (and vice versa).
//
// Layout math (matches the procedural ring in CityCluster3D):
//   • wall body hexagon circumradius R = 0.42·HEX (procedural outerR)
//   • hex vertex k at angle k·60°, radius R; edge k connects vertex k → k+1
//   • hex edge length == circumradius → edge span in HEX fractions = 0.42
//   • straight pieces span t ∈ [0.30, 0.70] of the edge (corners keep 30%
//     clearance each side), centered at t=0.5, long axis aligned to the edge
//   • gate replaces the straight piece on edge (hash % 6) — full edge span,
//     arch reads as the city entrance
//   • towers at all 6 vertices (alternating A/B variant by city hash)
//
// Each part is bbox-normalized at load (unit longest side); instance scale
// then sets its real-world longest side as s·HEX.
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { PROP_SURFACE_CLEARANCE } from './terrainSurfaceY.ts';

const wallPropsGroup = new Group();
wallPropsGroup.name = 'city-walls';

type WallVariant = MergedGlb & { norm: number };
type WallPropsState = 'idle' | 'loading' | 'ready' | 'failed';

const WALL_IDS = [
  'wall_straight',
  'wall_straight_gate',
  'wall_corner_A_inside',
  'wall_corner_A_outside',
] as const;

const TOWER_IDS = ['building_tower_A_red', 'building_tower_B_red'] as const;

type PartId = (typeof WALL_IDS)[number] | (typeof TOWER_IDS)[number];

const WALLS_DIR = '/assets/3d/props/kaykit/buildings/neutral';
const TOWERS_DIR = '/assets/3d/props/kaykit/buildings/red';

let wallVariants: Map<PartId, WallVariant> | null = null;
let wallState: WallPropsState = 'idle';
let wallLastSignature = '';
const activeWallMeshes: InstancedMesh[] = [];

export function getCityWallsGroup(): Group {
  return wallPropsGroup;
}

export function areCityWallsReady(): boolean {
  return wallState === 'ready';
}

export function areCityWallsSettled(): boolean {
  return wallState === 'ready' || wallState === 'failed';
}

export function ensureCityWallsLoad(onSettled?: () => void): void {
  if (wallState !== 'idle') return;
  wallState = 'loading';
  const loader = new GLTFLoader();
  const jobs: Array<{ id: PartId; url: string }> = [
    ...WALL_IDS.map((id) => ({ id, url: `${WALLS_DIR}/${id}.gltf` })),
    ...TOWER_IDS.map((id) => ({ id, url: `${TOWERS_DIR}/${id}.gltf` })),
  ];
  Promise.all(jobs.map((j) => loader.loadAsync(j.url).then((g) => ({ j, g }))))
    .then((loaded) => {
      wallVariants = new Map();
      for (const { j, g } of loaded) {
        const merged = mergeGlbScene(g.scene);
        merged.geometry.computeBoundingBox();
        const bb = merged.geometry.boundingBox!;
        const size = new Vector3().subVectors(bb.max, bb.min);
        const norm = 1 / Math.max(size.x, size.y, size.z, 1e-6);
        wallVariants.set(j.id, { ...merged, norm });
      }
      wallState = 'ready';
      wallLastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      wallVariants = null;
      wallState = 'failed';
      onSettled?.();
    });
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

// ─── Per-city wall layout ───────────────────────────────────────────────────
// World-space segments for one city's wall ring. Longest sides per part
// (measured from the source .gltf):
//   wall_straight 2.0 (length) · wall_straight_gate 2.0 · tower_A/B 1.2-1.4
// scale s is expressed as the piece's LONGEST side in HEX fractions.
interface WallPiece {
  id: PartId;
  /** center position, world space (x,z) */
  x: number;
  z: number;
  /** Y rotation (radians) aligning the piece's long axis */
  rot: number;
  /** longest-side scale in HEX fractions */
  s: number;
}

// Edge-length share covered by a straight piece (30% clearance per side for
// the corner/tower pieces at the vertices).
const STRAIGHT_SPAN = 0.4;
// Vertex radius (hex circumradius at the wall ring) in HEX fractions.
const RING_R = 0.42;

function buildWallPieces(q: number, r: number, base: { x: number; z: number }): {
  pieces: WallPiece[];
} {
  const pieces: WallPiece[] = [];
  const h = hashCoord(q, r);
  const gateEdge = h % 6;
  const towerVariant: PartId = h % 2 === 0 ? 'building_tower_A_red' : 'building_tower_B_red';

  for (let i = 0; i < 6; i++) {
    const a0 = (Math.PI / 3) * i;
    const a1 = (Math.PI / 3) * (i + 1);
    const v0x = Math.cos(a0) * RING_R;
    const v0z = Math.sin(a0) * RING_R;
    const v1x = Math.cos(a1) * RING_R;
    const v1z = Math.sin(a1) * RING_R;
    const edgeAngle = Math.atan2(v1z - v0z, v1x - v0x);
    // Towers at every vertex (place before skipping the gate edge — the gate
    // edge still gets its two flanking towers).
    pieces.push({
      id: towerVariant,
      x: base.x + v0x * HEX_SIZE,
      z: base.z + v0z * HEX_SIZE,
      // Tower variant's long axis is Y (it's a tower); rotate to face outward.
      rot: -a0 + Math.PI / 2,
      s: 0.24,
    });
    if (i === gateEdge) {
      // Gate spans the full edge (arch centered at edge midpoint).
      const mx = (v0x + v1x) / 2;
      const mz = (v0z + v1z) / 2;
      pieces.push({
        id: 'wall_straight_gate',
        x: base.x + mx * HEX_SIZE,
        z: base.z + mz * HEX_SIZE,
        rot: -edgeAngle,
        s: 0.42,
      });
      continue;
    }
    // Straight piece: centered at edge midpoint, spanning STRAIGHT_SPAN of
    // the edge, long axis (local X) aligned to the edge direction.
    const mx = (v0x + v1x) / 2;
    const mz = (v0z + v1z) / 2;
    pieces.push({
      id: 'wall_straight',
      x: base.x + mx * HEX_SIZE,
      z: base.z + mz * HEX_SIZE,
      rot: -edgeAngle,
      s: RING_R * STRAIGHT_SPAN,
    });
  }
  return { pieces };
}

interface WallInstanceSpec {
  part: WallPiece;
  base: { x: number; y: number; z: number };
}

export function rebuildCityWalls(
  cities: City[],
  getTile: (key: string) => Tile | undefined,
  lod: 'low' | 'medium' | 'high',
): void {
  if (wallState !== 'ready' || !wallVariants || lod === 'low') {
    clearCityWalls();
    return;
  }
  const signature = cities.map((c) => `${c.id}:${c.coord.q},${c.coord.r}`).join('|');
  if (signature === wallLastSignature && activeWallMeshes.length > 0) return;
  if (signature === wallLastSignature && cities.length === 0) return;
  wallLastSignature = signature;
  clearCityWalls();
  if (cities.length === 0) return;

  const byPart = new Map<PartId, WallInstanceSpec[]>();
  for (const city of cities) {
    const tile = getTile(tileKey(city.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
    const { pieces } = buildWallPieces(city.coord.q, city.coord.r, base);
    for (const part of pieces) {
      const bucket = byPart.get(part.id);
      const spec: WallInstanceSpec = { part, base };
      if (bucket) bucket.push(spec);
      else byPart.set(part.id, [spec]);
    }
  }

  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);
  const matrix = new Matrix4();

  for (const [id, specs] of byPart) {
    const variant = wallVariants.get(id);
    if (!variant) continue;
    variant.geometry.computeBoundingBox();
    const minY = variant.geometry.boundingBox?.min.y ?? 0;
    const mesh = new InstancedMesh(variant.geometry, variant.materials, specs.length);
    mesh.castShadow = true;

    for (let i = 0; i < specs.length; i++) {
      const { part, base } = specs[i]!;
      const s = HEX_SIZE * part.s * variant.norm;
      // Parts rest on y=0 in model space; lift so minY sits at the surface.
      const y = base.y - minY * s + PROP_SURFACE_CLEARANCE;
      pos.set(part.x, y, part.z);
      quat.setFromAxisAngle(up, part.rot);
      scl.set(s, s, s);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    activeWallMeshes.push(mesh);
    wallPropsGroup.add(mesh);
  }
}

export function clearCityWalls(): void {
  for (const mesh of activeWallMeshes) {
    wallPropsGroup.remove(mesh);
    mesh.dispose();
  }
  activeWallMeshes.length = 0;
}

// Test-only exports
export function _testWallIds(): readonly string[] {
  return [...WALL_IDS, ...TOWER_IDS];
}

export function _testWallConstants(): { RING_R: number; STRAIGHT_SPAN: number } {
  return { RING_R, STRAIGHT_SPAN };
}