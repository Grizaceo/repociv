// ─── Per-tile 3D decor — Civ V-style silhouettes ────────────────────────────
import {
  ConeGeometry,
  CylinderGeometry,
  BoxGeometry,
  SphereGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Group,
  Color,
  Vector3,
} from 'three';
import { type Tile, type Terrain, tileKey } from '../types.ts';
import { type GameState } from '../game.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { areMountainPropsReady } from './MountainProps3D.ts';
import { areForestPropsReady } from './ForestProps3D.ts';
import { areResourcePropsReady } from './ResourceProps3D.ts';
import { HEX_SIZE } from '../constants.ts';

const decorGroup = new Group();
decorGroup.name = 'tile-decor';
let lastSignature = '';

// Track every instanced mesh added so we can dispose cleanly
const activeMeshes: InstancedMesh[] = [];

function decorSignature(tiles: Tile[]): string {
  return tiles
    .map((t) => `${tileKey(t.coord)}:${t.terrain}:${t.revealed ? 1 : 0}`)
    .join('|');
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

function disposeMesh(m: InstancedMesh): void {
  m.geometry.dispose();
  const mat = m.material;
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat.dispose();
}

function addMesh(mesh: InstancedMesh): void {
  activeMeshes.push(mesh);
  decorGroup.add(mesh);
}

export function getTileDecorGroup(): Group {
  return decorGroup;
}

// ── Mountain: 2 peaks per tile, rock cone + snow cap flush at tip ─────────────
//  ConeGeometry default: tip at +height/2 (up), base at -height/2 (down).
//  We position the cone CENTER so that base sits at tile surface:
//    center_Y = tileY + ROCK_H/2        → base at tileY, tip at tileY + ROCK_H

const ROCK_H   = HEX_SIZE * 0.82;   // taller so mountains read vertical from gameplay camera
const ROCK_R   = HEX_SIZE * 0.16;   // slimmer base so peaks don't look like horizontal boulders
const SNOW_H   = HEX_SIZE * 0.26;   // slightly taller cap to keep tip contrast visible
const SNOW_R   = HEX_SIZE * 0.075;  // tighter cap base

function buildMountains(tiles: Array<{ tile: Tile; variant: number }>): void {
  if (tiles.length === 0) return;

  const rockGeom = new ConeGeometry(ROCK_R, ROCK_H, 6);
  const rockMat  = new MeshStandardMaterial({
    color:    new Color(0x7a7870),
    roughness: 0.85,
    metalness: 0.04,
  });

  const snowGeom = new ConeGeometry(SNOW_R, SNOW_H, 6);
  const snowMat  = new MeshStandardMaterial({
    color:    new Color(0xf0f2f8),
    emissive: new Color(0xc8d4e8),
    emissiveIntensity: 0.18,
    roughness: 0.50,
    metalness: 0.0,
  });

  const PEAKS = 2;
  const maxPeaks = tiles.length * PEAKS;
  if (maxPeaks === 0) return;

  const rockMesh = new InstancedMesh(rockGeom, rockMat, maxPeaks);
  const snowMesh = new InstancedMesh(snowGeom, snowMat, maxPeaks);
  rockMesh.castShadow = true;
  snowMesh.castShadow = true;

  let idx = 0;
  const q  = new Quaternion();
  const sv = new Vector3();
  const pv = new Vector3();

  for (const { tile, variant } of tiles) {
    const elev = terrainElevation(tile.terrain);
    const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    // Slight Y pad so decor sits above the tile's top face (+bevel)
    const yFloor = base.y + 2;

    const offsets: Array<[number, number, number]> = tile.city
      ? [
          [ 0.26, 0, -0.20 ],
          [-0.24, 0,  0.18 ],
        ]
      : [
          [ 0.00, 0,  0.00 ],
          [-0.16, 0,  0.12 ],
        ];

    for (let p = 0; p < PEAKS; p++) {
      const [ox, , oz] = offsets[p]!;
      // City mountain tiles keep the center readable by pushing slimmer peaks to the rim.
      const sc    = tile.city
        ? (p === 0 ? 0.66 + (variant % 4) * 0.03 : 0.54 + (variant % 3) * 0.03)
        : (p === 0 ? 0.92 + (variant % 5) * 0.04 : 0.66 + (variant % 4) * 0.03);
      const rockH = ROCK_H * sc;
      const snowH = SNOW_H * sc;
      const tx = base.x + ox * HEX_SIZE;
      const tz = base.z + oz * HEX_SIZE;

      // Rock: center at yFloor + rockH/2 → base sits at yFloor
      pv.set(tx, yFloor + rockH * 0.5, tz);
      sv.set(sc, sc, sc);
      rockMesh.setMatrixAt(idx, new Matrix4().compose(pv, q, sv));

      // Snow: base sits at rock tip (yFloor + rockH)
      pv.set(tx, yFloor + rockH + snowH * 0.5, tz);
      sv.set(sc, sc, sc);
      snowMesh.setMatrixAt(idx, new Matrix4().compose(pv, q, sv));

      idx++;
    }
  }

  rockMesh.count = idx;
  snowMesh.count = idx;
  rockMesh.instanceMatrix.needsUpdate = true;
  snowMesh.instanceMatrix.needsUpdate = true;
  addMesh(rockMesh);
  addMesh(snowMesh);
}

// ── Forest: trunk cylinder + 3 stacked cones = pine tree ────────────────────

function buildForests(tiles: Tile[]): void {
  if (tiles.length === 0) return;
  const TREES_PER_TILE = 7;

  const trunkGeom  = new CylinderGeometry(HEX_SIZE * 0.018, HEX_SIZE * 0.025, HEX_SIZE * 0.18, 5);
  const trunkMat   = new MeshLambertMaterial({ color: new Color(0x3a2810) });

  // Three cone tiers (bottom to top, each smaller)
  const cone1Geom  = new ConeGeometry(HEX_SIZE * 0.095, HEX_SIZE * 0.22, 7);
  const cone2Geom  = new ConeGeometry(HEX_SIZE * 0.075, HEX_SIZE * 0.20, 7);
  const cone3Geom  = new ConeGeometry(HEX_SIZE * 0.055, HEX_SIZE * 0.17, 7);
  const foliageMat = new MeshLambertMaterial({ color: new Color(0x1a4214) });
  const topMat     = new MeshLambertMaterial({ color: new Color(0x1e5218) });

  const total = tiles.length * TREES_PER_TILE;
  const trunkMesh  = new InstancedMesh(trunkGeom, trunkMat,  total);
  const cone1Mesh  = new InstancedMesh(cone1Geom, foliageMat, total);
  const cone2Mesh  = new InstancedMesh(cone2Geom, foliageMat, total);
  const cone3Mesh  = new InstancedMesh(cone3Geom, topMat,     total);

  // Tree positions relative to tile centre (in fraction of HEX_SIZE).
  // 7 per tile so the canopy reads as a Civ V clump, not 4 lone pines;
  // per-tile hash jitter below breaks the repeated-stamp look.
  const treeOffsets: Array<[number, number]> = [
    [-0.20,  0.14],
    [ 0.22, -0.16],
    [-0.06, -0.22],
    [ 0.16,  0.20],
    [-0.28, -0.06],
    [ 0.30,  0.04],
    [ 0.00,  0.02],
  ];

  let idx = 0;
  const mat = new Matrix4();
  for (const tile of tiles) {
    const elev = terrainElevation(tile.terrain);
    const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h    = hashCoord(tile.coord.q, tile.coord.r);

    for (let t = 0; t < TREES_PER_TILE; t++) {
      const [ox, oz] = treeOffsets[t]!;
      const scale    = 0.80 + ((h + t * 3) % 5) * 0.06;
      const jx       = (((h >> (t & 7)) % 9) - 4) * 0.012;
      const jz       = (((h >> ((t + 3) & 7)) % 9) - 4) * 0.012;
      const tx       = base.x + (ox + jx) * HEX_SIZE;
      const tz       = base.z + (oz + jz) * HEX_SIZE;
      const ty       = base.y;

      const trunkH = HEX_SIZE * 0.18 * scale;

      // Trunk
      mat.makeScale(scale, scale, scale);
      mat.setPosition(tx, ty + trunkH * 0.5 + 1, tz);
      trunkMesh.setMatrixAt(idx, mat.clone());

      // Bottom cone tier
      mat.makeScale(scale, scale, scale);
      mat.setPosition(tx, ty + trunkH + HEX_SIZE * 0.10 * scale, tz);
      cone1Mesh.setMatrixAt(idx, mat.clone());

      // Mid cone tier
      mat.makeScale(scale * 0.84, scale * 0.84, scale * 0.84);
      mat.setPosition(tx, ty + trunkH + HEX_SIZE * 0.24 * scale, tz);
      cone2Mesh.setMatrixAt(idx, mat.clone());

      // Top cone tier
      mat.makeScale(scale * 0.68, scale * 0.68, scale * 0.68);
      mat.setPosition(tx, ty + trunkH + HEX_SIZE * 0.37 * scale, tz);
      cone3Mesh.setMatrixAt(idx, mat.clone());

      idx++;
    }
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  cone1Mesh.instanceMatrix.needsUpdate = true;
  cone2Mesh.instanceMatrix.needsUpdate = true;
  cone3Mesh.instanceMatrix.needsUpdate = true;
  addMesh(trunkMesh);
  addMesh(cone1Mesh);
  addMesh(cone2Mesh);
  addMesh(cone3Mesh);
}

// ── Hills: 3 overlapping rounded bumps ──────────────────────────────────────

function buildHills(tiles: Tile[]): void {
  if (tiles.length === 0) return;

  const bumpGeom = new SphereGeometry(HEX_SIZE * 0.30, 12, 8);
  // Baked-atlas hills mean (191,209,141) × 0.82 — same family as the
  // terrain cell, darkened just enough to read as relief. White base so the
  // per-instance mottling (setColorAt) reads as the literal bump colour.
  const bumpMat  = new MeshLambertMaterial({ color: new Color(0xffffff) });

  const total    = tiles.length * 4;
  const bumpMesh = new InstancedMesh(bumpGeom, bumpMat, total);

  const offsets: Array<[number, number, number, number]> = [
    [  0.00, 0.52,  0.00, 1.00 ],
    [ -0.22, 0.44,  0.14, 0.86 ],
    [  0.20, 0.44, -0.12, 0.82 ],
    [ -0.06, 0.38,  0.20, 0.74 ],
  ];

  // Civ V hills aren't a flat olive plate — sunlit crowns and shaded folds.
  // Mottle each bump around the base tone (0x9dab74) with hash-stable
  // brightness + a slight warm/cool swing so adjacent bumps separate.
  const base = new Color(0x9dab74);
  const tint = new Color();
  let idx = 0;
  const mat = new Matrix4();
  for (const tile of tiles) {
    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h    = hashCoord(tile.coord.q, tile.coord.r);
    let b = 0;
    for (const [ox, oy, oz, sc] of offsets) {
      mat.makeScale(sc * 1.1, sc * 0.48, sc * 1.0);
      mat.setPosition(pos.x + ox * HEX_SIZE, pos.y - 1 + oy * HEX_SIZE * 0.30, pos.z + oz * HEX_SIZE);
      bumpMesh.setMatrixAt(idx, mat.clone());
      const bright = 0.84 + ((h + b * 7) % 11) / 11 * 0.30;   // 0.84..1.14
      const warm   = ((h >> 2) + b) % 2 === 0 ? 1.05 : 0.95;  // sun vs shade
      tint.setRGB(base.r * bright * warm, base.g * bright, base.b * bright * 0.96);
      bumpMesh.setColorAt(idx, tint);
      idx++;
      b++;
    }
  }
  bumpMesh.instanceMatrix.needsUpdate = true;
  if (bumpMesh.instanceColor) bumpMesh.instanceColor.needsUpdate = true;
  addMesh(bumpMesh);
}

// ── Desert: low rounded dune mounds ──────────────────────────────────────────

function buildDesert(tiles: Tile[]): void {
  if (tiles.length === 0) return;

  // Soft squashed-sphere mounds. The old decor was cone frustums rotated 90°
  // to lie flat as "ridges" — from the play camera they read as tipped-over
  // mountains. Civ V desert is mostly texture; a few wide, very low mounds
  // give relief without competing with the baked dune bands.
  const duneGeom = new SphereGeometry(HEX_SIZE * 0.22, 14, 10);
  // Baked-atlas desert mean (209,196,163) × 1.07 — sun-catching sand in
  // the same warm-gray family as the dune bands, not saturated yellow. White
  // base so per-instance mottling (setColorAt) is the literal dune colour.
  const duneMat  = new MeshLambertMaterial({ color: new Color(0xffffff) });

  const MOUNDS = 3;
  const duneMesh = new InstancedMesh(duneGeom, duneMat, tiles.length * MOUNDS);

  const spots: Array<[number, number]> = [
    [-0.14, -0.08],
    [ 0.16,  0.10],
    [-0.02,  0.20],
  ];

  // Sand catches and loses the sun in bands — mottle each mound around the
  // base tone so the desert reads as drifting dunes, not one flat sheet.
  const duneBase = new Color(0xe0d2ae);
  const duneTint = new Color();
  let idx = 0;
  const mat = new Matrix4();
  const scaleV = new Vector3();
  const up = new Vector3(0, 1, 0);
  for (const tile of tiles) {
    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h    = hashCoord(tile.coord.q, tile.coord.r);
    for (let d = 0; d < MOUNDS; d++) {
      const [ox, oz] = spots[d]!;
      const scale = 0.72 + ((h + d * 7) % 5) * 0.09;
      const rot = new Quaternion().setFromAxisAngle(
        up, ((h + d * 37) % 180) * (Math.PI / 180),
      );
      // Wide × very low × elongated — a dune, not a boulder. The sphere
      // centre sits near the tile top so the lower half stays buried.
      scaleV.set(scale * 1.5, scale * 0.22, scale * 0.9);
      mat.compose(
        new Vector3(pos.x + ox * HEX_SIZE, pos.y + 0.6, pos.z + oz * HEX_SIZE),
        rot,
        scaleV,
      );
      duneMesh.setMatrixAt(idx, mat.clone());
      const bright = 0.90 + ((h + d * 13) % 9) / 9 * 0.16;   // 0.90..1.06
      duneTint.setRGB(duneBase.r * bright, duneBase.g * bright, duneBase.b * bright * 0.98);
      duneMesh.setColorAt(idx, duneTint);
      idx++;
    }
  }
  duneMesh.instanceMatrix.needsUpdate = true;
  if (duneMesh.instanceColor) duneMesh.instanceColor.needsUpdate = true;
  addMesh(duneMesh);
}

// ── Ice: crystalline spikes + flat base platform ─────────────────────────────

function buildIce(tiles: Tile[]): void {
  if (tiles.length === 0) return;

  // Spike: sharp 4-sided crystal
  const spikeGeom = new ConeGeometry(HEX_SIZE * 0.045, HEX_SIZE * 0.32, 4);
  const spikeMat  = new MeshStandardMaterial({
    color:     new Color(0xd8eef8),
    emissive:  new Color(0x8ab8d8),
    emissiveIntensity: 0.15,
    roughness: 0.2,
    metalness: 0.1,
  });

  // Base slab: thin flat box — exact baked-atlas ice mean (207,229,240)
  // so the platform melts into the cell instead of reading paper-white.
  const slabGeom  = new BoxGeometry(HEX_SIZE * 0.60, HEX_SIZE * 0.05, HEX_SIZE * 0.60);
  const slabMat   = new MeshLambertMaterial({
    color: new Color(0xcfe5f0),
    transparent: true,
    opacity: 0.80,
  });

  const total     = tiles.length * 4;
  const spikeMesh = new InstancedMesh(spikeGeom, spikeMat, total);
  const slabMesh  = new InstancedMesh(slabGeom,  slabMat,  tiles.length);

  const spikePos: Array<[number, number]> = [
    [ 0.00,  0.00],
    [-0.16,  0.12],
    [ 0.18, -0.10],
    [-0.08, -0.18],
  ];

  let spikeIdx = 0;
  const mat = new Matrix4();
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h    = hashCoord(tile.coord.q, tile.coord.r);

    // Slab
    mat.makeTranslation(pos.x, pos.y + 0.6, pos.z);
    slabMesh.setMatrixAt(i, mat.clone());

    // Spikes
    for (let s = 0; s < 4; s++) {
      const [ox, oz] = spikePos[s]!;
      const scale    = 0.65 + ((h + s * 11) % 7) * 0.06;
      mat.makeScale(scale, scale, scale);
      mat.setPosition(pos.x + ox * HEX_SIZE, pos.y + 1.2 + scale * HEX_SIZE * 0.15, pos.z + oz * HEX_SIZE);
      spikeMesh.setMatrixAt(spikeIdx++, mat.clone());
    }
  }
  spikeMesh.instanceMatrix.needsUpdate = true;
  slabMesh.instanceMatrix.needsUpdate  = true;
  addMesh(slabMesh);
  addMesh(spikeMesh);
}

// ── Sacred: stone circle + glowing altar ─────────────────────────────────────

function buildSacred(tiles: Tile[]): void {
  if (tiles.length === 0) return;

  // When the forge obelisk GLB is live (ResourceProps3D), it takes the
  // centre of the circle — keep only the standing stones here.
  const glbMarker = areResourcePropsReady();

  // Standing stones — weathered gilded-stone monoliths (matches shader v20 sacred)
  const stoneGeom = new BoxGeometry(HEX_SIZE * 0.085, HEX_SIZE * 0.28, HEX_SIZE * 0.055);
  const stoneMat  = new MeshStandardMaterial({
    color:    new Color(0x9a8f76),
    emissive: new Color(0x4a3d22),
    emissiveIntensity: 0.14,
    roughness: 0.88,
    metalness: 0.05,
  });

  let altarMesh: InstancedMesh | null = null;
  let gemMesh: InstancedMesh | null = null;
  if (!glbMarker) {
    // Altar cube at centre (procedural fallback while the GLB is absent)
    const altarGeom = new BoxGeometry(HEX_SIZE * 0.18, HEX_SIZE * 0.10, HEX_SIZE * 0.18);
    const altarMat  = new MeshStandardMaterial({
      color:    new Color(0xa89878),
      emissive: new Color(0x584820),
      emissiveIntensity: 0.20,
      roughness: 0.72,
      metalness: 0.08,
    });

    // Floating gem above altar
    const gemGeom = new BoxGeometry(HEX_SIZE * 0.08, HEX_SIZE * 0.08, HEX_SIZE * 0.08);
    const gemMat  = new MeshStandardMaterial({
      color:    new Color(0xe8c66a),
      emissive: new Color(0xa8842e),
      emissiveIntensity: 0.45,
      roughness: 0.18,
      metalness: 0.35,
      transparent: true,
      opacity: 0.72,
    });
    altarMesh = new InstancedMesh(altarGeom, altarMat, tiles.length);
    gemMesh   = new InstancedMesh(gemGeom,   gemMat,   tiles.length);
  }

  const STONES = 6;
  const stoneMesh = new InstancedMesh(stoneGeom, stoneMat, tiles.length * STONES);

  let idx = 0;
  const mat = new Matrix4();
  for (const tile of tiles) {
    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);

    // Stone ring
    for (let s = 0; s < STONES; s++) {
      const angle  = (Math.PI * 2 / STONES) * s;
      const radius = HEX_SIZE * 0.30;
      const tx     = pos.x + Math.cos(angle) * radius;
      const tz     = pos.z + Math.sin(angle) * radius;
      const stoneH = HEX_SIZE * 0.28;
      mat.makeRotationY(angle + Math.PI / 2);
      mat.setPosition(tx, pos.y + stoneH * 0.5 + 1, tz);
      stoneMesh.setMatrixAt(idx, mat.clone());
      idx++;
    }

    if (altarMesh && gemMesh) {
      // Central altar
      mat.identity();
      mat.setPosition(pos.x, pos.y + HEX_SIZE * 0.05 + 1, pos.z);
      altarMesh.setMatrixAt(tiles.indexOf(tile), mat.clone());

      // Floating gem above altar
      mat.makeRotationY(Math.PI / 4);
      mat.setPosition(pos.x, pos.y + HEX_SIZE * 0.26 + 1, pos.z);
      gemMesh.setMatrixAt(tiles.indexOf(tile), mat.clone());
    }
  }
  stoneMesh.instanceMatrix.needsUpdate = true;
  addMesh(stoneMesh);
  if (altarMesh && gemMesh) {
    altarMesh.instanceMatrix.needsUpdate = true;
    gemMesh.instanceMatrix.needsUpdate   = true;
    addMesh(altarMesh);
    addMesh(gemMesh);
  }
}

// ── Plains grass patches (high LOD) ─────────────────────────────────────────

function buildGrass(tiles: Tile[]): void {
  if (tiles.length === 0) return;

  const geom = new BoxGeometry(HEX_SIZE * 0.16, HEX_SIZE * 0.10, HEX_SIZE * 0.05);
  // Baked-atlas plains mean (186,219,132) × 0.85 — grass tufts one shade
  // under the cell instead of the old saturated green.
  const mat  = new MeshLambertMaterial({ color: new Color(0x9eba70) });
  const mesh = new InstancedMesh(geom, mat, tiles.length * 2);

  let idx = 0;
  const m = new Matrix4();
  for (const tile of tiles) {
    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h    = hashCoord(tile.coord.q, tile.coord.r);
    for (let g = 0; g < 2; g++) {
      const angle = ((h + g * 17) % 36) * (Math.PI / 18);
      m.makeTranslation(
        pos.x + Math.cos(angle) * HEX_SIZE * 0.18,
        pos.y + 1.2,
        pos.z + Math.sin(angle) * HEX_SIZE * 0.18,
      );
      mesh.setMatrixAt(idx++, m.clone());
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  addMesh(mesh);
}

// ── Plains farms (high LOD) ──────────────────────────────────────────────────

function buildFarms(tiles: Tile[]): void {
  if (tiles.length === 0) return;

  // Civ V farms read as golden wheat strips, not slabs: the old single
  // 0x4e7832 box was darker than the grass and pockmarked every plains
  // span with green rectangles. Two thin wheat strips per farm, rotated
  // together by the coord hash.
  const geom = new BoxGeometry(HEX_SIZE * 0.40, HEX_SIZE * 0.045, HEX_SIZE * 0.13);
  const mat  = new MeshLambertMaterial({ color: new Color(0xbfa14f) });
  const mesh = new InstancedMesh(geom, mat, tiles.length * 2);

  const m = new Matrix4();
  const one = new Vector3(1, 1, 1);
  let idx = 0;
  for (const tile of tiles) {
    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h    = hashCoord(tile.coord.q, tile.coord.r);
    const rot  = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (h % 12) * (Math.PI / 6));
    for (const s of [-1, 1]) {
      const off = new Vector3(0, 0, s * HEX_SIZE * 0.085).applyQuaternion(rot);
      m.compose(new Vector3(pos.x + off.x, pos.y + 1.0, pos.z + off.z), rot, one);
      mesh.setMatrixAt(idx++, m.clone());
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  addMesh(mesh);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function rebuildTileDecor(
  tiles: Tile[],
  lod: 'low' | 'medium' | 'high',
  _state?: GameState,
): void {
  if (lod === 'low') {
    clearTileDecor();
    return;
  }

  // Props readiness participates: when the mountain glbs land, the cones
  // must rebuild out of the decor set even though the tiles didn't change.
  const signature = `${lod}:m${areMountainPropsReady() ? 1 : 0}:f${areForestPropsReady() ? 1 : 0}:r${areResourcePropsReady() ? 1 : 0}:${decorSignature(tiles)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  clearTileDecor();

  const mountains: Array<{ tile: Tile; variant: number }> = [];
  const forests:   Tile[] = [];
  const hills:     Tile[] = [];
  const deserts:   Tile[] = [];
  const ices:      Tile[] = [];
  const sacreds:   Tile[] = [];
  const grass:     Tile[] = [];
  const farms:     Tile[] = [];

  for (const tile of tiles) {
    if (!tile.revealed) continue;
    const h = hashCoord(tile.coord.q, tile.coord.r);
    switch (tile.terrain) {
      case 'mountain':
        // glTF props (MountainProps3D) replace the cones; keep the cone
        // decor only as fallback while/if the glbs are unavailable.
        if (!areMountainPropsReady()) mountains.push({ tile, variant: h });
        break;
      case 'forest':
        if (!areForestPropsReady()) forests.push(tile);
        break;
      case 'hills':
        hills.push(tile);
        break;
      case 'desert':
        deserts.push(tile);
        break;
      case 'ice':
        ices.push(tile);
        break;
      case 'sacred':
        // Wonder tiles (district.type==='wonder') are handled by
        // WonderProps3D — the procedural temple / laboratorium replaces
        // the generic standing-stones + altar + gem. Skip them here so
        // we don't double-stack geometry on the same hex.
        if (tile.district?.type === 'wonder') break;
        sacreds.push(tile);
        break;
      case 'plains':
        if (h % 5 === 0) farms.push(tile);
        else if (h % 3 === 0) grass.push(tile);
        break;
      default:
        break;
    }
  }

  buildMountains(mountains);
  buildForests(forests);
  buildHills(hills);
  buildDesert(deserts);
  buildIce(ices);
  buildSacred(sacreds);
  buildGrass(grass);
  buildFarms(farms);
}

export function clearTileDecor(): void {
  while (decorGroup.children.length > 0) {
    const child = decorGroup.children[0] as InstancedMesh;
    decorGroup.remove(child);
    disposeMesh(child);
  }
  activeMeshes.length = 0;
  lastSignature = '';
}

export function setDecorVisible(visible: boolean): void {
  decorGroup.visible = visible;
}

/** @internal test hook */
export function _terrainNeedsDecor(terrain: Terrain): boolean {
  return (
    terrain === 'mountain' ||
    terrain === 'forest'   ||
    terrain === 'plains'   ||
    terrain === 'hills'    ||
    terrain === 'desert'   ||
    terrain === 'ice'      ||
    terrain === 'sacred'
  );
}
