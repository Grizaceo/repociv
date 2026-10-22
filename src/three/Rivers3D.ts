// ─── Civ V-style rivers: deterministic ribbon meshes from highlands to sea ───
//
// Approach decision (iter7): GEOMETRY ribbons through tile centers, not the
// edge-mask shader plan from docs/plans/rivers-plan.md. Rationale:
//   - A Catmull-Rom ribbon serpentines for real; the edge-mask approach renders
//     disconnected bands perpendicular to the flow at each tile boundary.
//   - No terrain-shader change → no cache-key bump, no per-instance attribute.
//   - Rivers are DERIVED data (recomputed deterministically from the tile
//     layout each rebuild) — no Tile field, no save-format migration.
//
// Determinism contract: paths depend only on the tile layout (terrain per
// coord), via coordinate hashes — no Math.random, no Date. The same world
// always grows the same rivers, so goldens stay run-to-run stable.
import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  CatmullRomCurve3,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Color,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGlbScene, type MergedGlb } from './mergeGlbScene.ts';
import { AXIAL_DIRECTIONS, axialDistance, type Axial } from '../hex.ts';
import { tileKey, type Tile } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { worldTerrainSurfaceY } from './terrainSurfaceY.ts';

const riverGroup = new Group();
riverGroup.name = 'rivers';
let lastSignature = '';

type BridgeVariant = MergedGlb & { norm: number; minY: number };
let bridgeVariant: BridgeVariant | null = null;
let bridgeLoadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';

export function areRiverBridgesReady(): boolean {
  return bridgeLoadState === 'ready';
}

export function ensureRiverBridgeLoad(onSettled?: () => void): void {
  if (bridgeLoadState !== 'idle') return;
  bridgeLoadState = 'loading';
  const loader = new GLTFLoader();
  loader
    .loadAsync('/assets/3d/props/kenney/bridge.glb')
    .then((gltf) => {
      const merged = mergeGlbScene(gltf.scene);
      merged.geometry.computeBoundingBox();
      const bb = merged.geometry.boundingBox!;
      const size = new Vector3().subVectors(bb.max, bb.min);
      const norm = 1 / Math.max(size.x, size.y, size.z, 1e-6);
      bridgeVariant = { ...merged, norm, minY: bb.min.y };
      bridgeLoadState = 'ready';
      lastSignature = '';
      onSettled?.();
    })
    .catch(() => {
      bridgeVariant = null;
      bridgeLoadState = 'failed';
      onSettled?.();
    });
}

export function getRiverGroup(): Group {
  return riverGroup;
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

/** Max rivers per world; sources must be at least this far apart. */
const MAX_RIVERS = 4;
const MIN_SOURCE_SEPARATION = 5;
/** Minimum BFS distance to the sea for a tile to qualify as a source. */
const MIN_SOURCE_DIST = 3;

/** Control-point clearance above the rendered terrain cap (worldTerrainSurfaceY
 *  mirrors the shader's ramp + relief, so no per-biome lift is needed). */
const RIVER_CLEARANCE = 1.3;

interface RiverPath {
  /** Tile-center control points, last one reaching into the river mouth. */
  points: Vector3[];
  /** Whether each control point sits on a revealed tile (mouth inherits
   *  the ocean tile's flag). Unrevealed stretches are skipped at build. */
  revealed: boolean[];
  /** World position of the mouth (for foam), null if the river ends inland. */
  mouth: Vector3 | null;
}

/** Deterministic river layout: BFS distance-to-ocean over the whole tile map,
 *  then greedy descent from the highest qualified sources. Computed over ALL
 *  tiles (revealed or not) so revealing new land never re-routes a river. */
export function computeRiverPaths(tiles: Map<string, Tile>): RiverPath[] {
  // Multi-source BFS from every ocean tile.
  const dist = new Map<string, number>();
  let frontier: Axial[] = [];
  for (const t of tiles.values()) {
    if (t.terrain === 'ocean') {
      dist.set(tileKey(t.coord), 0);
      frontier.push(t.coord);
    }
  }
  if (frontier.length === 0) return [];
  while (frontier.length > 0) {
    const next: Axial[] = [];
    for (const c of frontier) {
      const d = dist.get(tileKey(c))!;
      for (const dir of AXIAL_DIRECTIONS) {
        const n = { q: c.q + dir.q, r: c.r + dir.r };
        const nk = tileKey(n);
        if (!tiles.has(nk) || dist.has(nk)) continue;
        dist.set(nk, d + 1);
        next.push(n);
      }
    }
    frontier = next;
  }

  // Sources: highland tiles far from the sea, deterministic order.
  const candidates = Array.from(tiles.values())
    .filter((t) => {
      if (t.terrain !== 'mountain' && t.terrain !== 'hills') return false;
      const d = dist.get(tileKey(t.coord));
      return d !== undefined && d >= MIN_SOURCE_DIST;
    })
    .sort((a, b) => {
      const dd = dist.get(tileKey(b.coord))! - dist.get(tileKey(a.coord))!;
      return dd !== 0 ? dd : tileKey(a.coord).localeCompare(tileKey(b.coord));
    });

  const sources: Tile[] = [];
  for (const c of candidates) {
    if (sources.length >= MAX_RIVERS) break;
    if (sources.every((s) => axialDistance(s.coord, c.coord) >= MIN_SOURCE_SEPARATION)) {
      sources.push(c);
    }
  }

  const occupied = new Set<string>(); // tiles already carrying a river
  const paths: RiverPath[] = [];

  for (const source of sources) {
    const path: Tile[] = [source];
    const visited = new Set<string>([tileKey(source.coord)]);
    let current = source;
    let mouth: Vector3 | null = null;
    let joined = false;

    for (let step = 0; step < 64; step++) {
      const d = dist.get(tileKey(current.coord))!;
      // Downhill candidates: neighbors strictly closer to the sea.
      const downs: Tile[] = [];
      for (const dir of AXIAL_DIRECTIONS) {
        const nk = tileKey({ q: current.coord.q + dir.q, r: current.coord.r + dir.r });
        const nd = dist.get(nk);
        const nt = tiles.get(nk);
        if (nt && nd !== undefined && nd < d && !visited.has(nk)) downs.push(nt);
      }
      if (downs.length === 0) break;
      // Deterministic meander: hash picks among the equally-valid descents.
      // (BFS neighbors differ by at most one hop, so every descent is at
      // d-1: all land, or — one hop from the coast — all sea.)
      const h = hashCoord(current.coord.q, current.coord.r);
      const next = downs[(h + step) % downs.length]!;

      if (next.terrain === 'ocean') {
        // Mouth: stop at the shared edge, reaching slightly into the sea.
        const landTop = axialToWorld3D(
          current.coord.q,
          current.coord.r,
          terrainElevation(current.terrain),
        );
        // Ocean tops sit at elevation −1 (y = −12, bevel flattened to the
        // cap): drop the mouth to just above the water so the last span
        // reads as a short cascade down the coastal cliff, not a ribbon
        // hovering 13 units over the sea.
        const sea = axialToWorld3D(next.coord.q, next.coord.r, terrainElevation('ocean'));
        // Reach further into the sea tile (0.70) and sit just at the water
        // surface (+0.5, was +1.0) so the ribbon dips into the ocean and
        // merges gaplessly instead of hovering over a coastal seam.
        mouth = new Vector3(
          landTop.x + (sea.x - landTop.x) * 0.7,
          sea.y + 0.5,
          landTop.z + (sea.z - landTop.z) * 0.7,
        );
        break;
      }
      path.push(next);
      visited.add(tileKey(next.coord));
      if (occupied.has(tileKey(next.coord))) {
        joined = true; // flow into an existing river — confluence, stop here
        break;
      }
      current = next;
    }

    // A river needs a run of at least 2 tiles, and either a mouth or a join.
    if (path.length < 2 || (mouth === null && !joined)) continue;
    for (const t of path) occupied.add(tileKey(t.coord));

    const { points, revealed } = edgeRoutePath(path, mouth, tiles);
    paths.push({ points, revealed, mouth });
  }
  return paths;
}

/** World-space center of a tile; callers only use its XZ (heights come from
 *  the terrain surface at each control point). */
function tileCenterWorld(t: Tile): Vector3 {
  return axialToWorld3D(t.coord.q, t.coord.r, terrainElevation(t.terrain));
}

/** Snap a control point onto the rendered terrain cap plus clearance. */
function onSurface(p: Vector3, tiles: Map<string, Tile>, clearance = RIVER_CLEARANCE): Vector3 {
  p.y = worldTerrainSurfaceY(p.x, p.z, tiles) + clearance;
  return p;
}

function dirIndexBetween(from: Axial, to: Axial): number {
  const dq = to.q - from.q;
  const dr = to.r - from.r;
  return AXIAL_DIRECTIONS.findIndex((d) => d.q === dq && d.r === dr);
}

/** Corner of tile t between its neighbors in directions k and k+1: the
 *  centroid of the three mutually-adjacent centers. The key is the sorted
 *  triple of tile keys, so all three tiles name the corner the same way. */
function hexCorner(t: Axial, k: number): { key: string; x: number; z: number } {
  const d1 = AXIAL_DIRECTIONS[((k % 6) + 6) % 6]!;
  const d2 = AXIAL_DIRECTIONS[(((k + 1) % 6) + 6) % 6]!;
  const trio = [t, { q: t.q + d1.q, r: t.r + d1.r }, { q: t.q + d2.q, r: t.r + d2.r }];
  let x = 0;
  let z = 0;
  for (const c of trio) {
    const w = axialToWorld3D(c.q, c.r, 0);
    x += w.x / 3;
    z += w.z / 3;
  }
  return { key: trio.map(tileKey).sort().join('|'), x, z };
}

/** Route a tile-center descent along the hex EDGE graph (Civ V draws rivers
 *  along edges, not across tile interiors): the shortest corner-to-corner walk
 *  over the edges of the path tiles, from the edge between the source and the
 *  next tile to the edge where the river ends (the coast edge for a mouth, the
 *  edge into the joined tile otherwise). Every span lies on a real tile
 *  boundary and every turn is ±60°, so the ribbon never cuts through a tile's
 *  mountain or city and never doubles back. (Routing through edge MIDPOINTS
 *  instead turned 90-120° wherever two walks met on the same side.) */
export function edgeRoutePath(
  path: Tile[],
  mouth: Vector3 | null,
  tiles: Map<string, Tile>,
): {
  points: Vector3[];
  revealed: boolean[];
} {
  const first = path[0]!;
  const last = path[path.length - 1]!;
  const c0 = tileCenterWorld(first);
  const c1 = tileCenterWorld(path[1]!);
  // Start the spring on the source flank toward path[1] (outside the central peak)
  const spring = onSurface(c0.clone().lerp(c1, 0.36), tiles, 1.4);
  const points: Vector3[] = [spring];
  const revealed: boolean[] = [first.revealed];

  // A mouth ends on the coast edge of the last tile; a join ends on the edge
  // into the joined (last) tile, whose own edges belong to the other river.
  const walkTiles = mouth ? path : path.slice(0, -1);
  const endFrom = mouth ? last : path[path.length - 2]!;
  let endDir: number;
  if (mouth) {
    // The mouth lies on the line from the last center toward the sea center.
    const lc = tileCenterWorld(last);
    let best = -Infinity;
    endDir = 0;
    for (let k = 0; k < 6; k++) {
      const d = AXIAL_DIRECTIONS[k]!;
      const n = axialToWorld3D(last.coord.q + d.q, last.coord.r + d.r, 0);
      const dot = (n.x - lc.x) * (mouth.x - lc.x) + (n.z - lc.z) * (mouth.z - lc.z);
      if (dot > best) {
        best = dot;
        endDir = k;
      }
    }
  } else {
    endDir = dirIndexBetween(endFrom.coord, last.coord);
  }
  // Edge of tile t in direction k joins its corners k-1 and k.
  const edgeEnds = (t: Tile, k: number) => [hexCorner(t.coord, k - 1), hexCorner(t.coord, k)];

  // Corner graph over the walk tiles' edges; remember which walk tiles touch
  // each corner (revealed flag) and where it is.
  const adj = new Map<string, string[]>();
  const pos = new Map<string, { x: number; z: number }>();
  const touching = new Map<string, Tile[]>();
  for (const t of walkTiles) {
    for (let k = 0; k < 6; k++) {
      const a = hexCorner(t.coord, k);
      const b = hexCorner(t.coord, k + 1);
      for (const c of [a, b]) {
        pos.set(c.key, c);
        if (!adj.has(c.key)) adj.set(c.key, []);
      }
      adj.get(a.key)!.push(b.key);
      adj.get(b.key)!.push(a.key);
      const list = touching.get(a.key) ?? [];
      if (!list.includes(t)) list.push(t);
      touching.set(a.key, list);
    }
  }

  // BFS from both ends of the first edge to either end of the final edge.
  const goals = new Set(edgeEnds(endFrom, endDir).map((c) => c.key));
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const c of edgeEnds(first, dirIndexBetween(first.coord, path[1]!.coord))) {
    if (!prev.has(c.key)) {
      prev.set(c.key, null);
      queue.push(c.key);
    }
  }
  let reached: string | null = null;
  for (let i = 0; i < queue.length && reached === null; i++) {
    const cur = queue[i]!;
    if (goals.has(cur)) {
      reached = cur;
      break;
    }
    for (const n of adj.get(cur) ?? []) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      queue.push(n);
    }
  }
  const corners: string[] = [];
  for (let c = reached; c !== null; c = prev.get(c) ?? null) corners.unshift(c);

  for (const key of corners) {
    const c = pos.get(key)!;
    points.push(onSurface(new Vector3(c.x, 0, c.z), tiles));
    revealed.push((touching.get(key) ?? []).every((t) => t.revealed));
  }
  if (mouth) {
    points.push(mouth);
    revealed.push(last.revealed);
  } else {
    // Join: finish at the middle of the edge into the joined tile.
    const end = onSurface(
      tileCenterWorld(endFrom).add(tileCenterWorld(last)).multiplyScalar(0.5),
      tiles,
    );
    points.push(end);
    revealed.push(endFrom.revealed && last.revealed);
  }
  return { points, revealed };
}

/** Insert a hash-offset midpoint between consecutive controls so straight
 *  hex-to-hex runs still meander (Civ V rivers are never straight lines). */
function meander(
  points: Vector3[],
  revealed: boolean[],
  tiles: Map<string, Tile>,
): { pts: Vector3[]; rev: boolean[] } {
  const pts: Vector3[] = [];
  const rev: boolean[] = [];
  for (let i = 0; i < points.length; i++) {
    pts.push(points[i]!);
    rev.push(revealed[i]!);
    if (i === points.length - 1) break;
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    // Gentle perpendicular offset scaled by span length so short corner spans
    // never cusp or loop.
    const h = hashCoord(Math.round(a.x + b.x), Math.round(a.z + b.z));
    const spanScale = Math.min(1, len / (HEX_SIZE * 0.85));
    const amp = (((h % 7) - 3) / 3) * HEX_SIZE * 0.075 * spanScale;
    const mx = (a.x + b.x) / 2 + (-dz / len) * amp;
    const mz = (a.z + b.z) / 2 + (dx / len) * amp;
    const isMouthSpan = i === points.length - 2 && b.y < -5;
    const my = isMouthSpan
      ? (a.y + b.y) / 2
      : Math.max((a.y + b.y) / 2, worldTerrainSurfaceY(mx, mz, tiles) + 1.3);
    pts.push(new Vector3(mx, my, mz));
    rev.push(revealed[i]! && revealed[i + 1]!);
  }
  return { pts, rev };
}

/** Triangulate one revealed run of curve samples into a flat ribbon strip. */
function appendRibbon(
  samples: Vector3[],
  positions: number[],
  indices: number[],
  widthScale: number,
  tiles: Map<string, Tile>,
): void {
  if (samples.length < 2) return;
  const baseVertex = positions.length / 3;
  const halfW = HEX_SIZE * 0.078 * widthScale;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    const prev = samples[Math.max(0, i - 1)]!;
    const next = samples[Math.min(samples.length - 1, i + 1)]!;
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    // Width grows toward the mouth (downstream = increasing i).
    const w = halfW * (0.7 + 0.6 * (i / (samples.length - 1)));
    const nx = (-tz / tl) * w;
    const nz = (tx / tl) * w;
    // Keep both banks strictly above the rendered terrain cap at (x ± nx, z ± nz)
    // so neither side of the river ribbon ever clips underground on slopes.
    const isMouthEnd = i >= samples.length - 2 && p.y < -5;
    const y = isMouthEnd
      ? p.y
      : Math.max(
          p.y,
          worldTerrainSurfaceY(p.x, p.z, tiles) + 1.2,
          worldTerrainSurfaceY(p.x + nx, p.z + nz, tiles) + 1.2,
          worldTerrainSurfaceY(p.x - nx, p.z - nz, tiles) + 1.2,
        );
    positions.push(p.x + nx, y, p.z + nz, p.x - nx, y, p.z - nz);
  }
  // Winding: counter-clockwise seen from +Y so the face normal points up
  // (the first attempt wound them downward — the whole river backface-culled).
  for (let i = 0; i < samples.length - 1; i++) {
    const a = baseVertex + i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function riverSignature(tiles: Tile[]): string {
  // Terrain layout + revealed set are the only inputs.
  let h = 0;
  for (const t of tiles) {
    const s = `${tileKey(t.coord)}:${t.terrain}:${t.revealed ? 1 : 0}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${tiles.length}:${h}:b${bridgeLoadState === 'ready' ? 1 : 0}`;
}

export function rebuildRivers(tiles: Map<string, Tile>): void {
  const all = Array.from(tiles.values());
  const sig = riverSignature(all);
  if (sig === lastSignature) return;

  clearRivers();
  lastSignature = sig;

  const paths = computeRiverPaths(tiles);
  if (paths.length === 0) return;

  const positions: number[] = [];
  const indices: number[] = [];
  const mouths: Vector3[] = [];
  const bridgeSpans: Array<{ pos: Vector3; angle: number }> = [];

  for (const path of paths) {
    const { pts, rev } = meander(path.points, path.revealed, tiles);
    if (pts.length < 2) continue;
    const curve = new CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const samplesPerSpan = 6;
    const total = (pts.length - 1) * samplesPerSpan;
    // Sample the curve, tracking which control span each sample falls in so
    // unrevealed stretches drop out (rivers appear as the world is explored).
    let run: Vector3[] = [];
    for (let s = 0; s <= total; s++) {
      const t = s / total;
      const span = Math.min(pts.length - 2, Math.floor(t * (pts.length - 1)));
      const visible = rev[span]! || rev[span + 1]!;
      if (visible) {
        run.push(curve.getPoint(t));
      } else if (run.length > 0) {
        appendRibbon(run, positions, indices, 1, tiles);
        run = [];
      }
    }
    appendRibbon(run, positions, indices, 1, tiles);
    if (path.mouth && path.revealed[path.revealed.length - 1]) mouths.push(path.mouth);

    // River crossing bridge: sample directly on the meandered curve at t=0.5
    // so the bridge sits centered over the water and aligns with the flow tangent.
    if (path.points.length >= 3) {
      const midSpan = Math.min(pts.length - 2, Math.floor(0.5 * (pts.length - 1)));
      if (rev[midSpan] || rev[midSpan + 1]) {
        const p = curve.getPoint(0.5).clone();
        const tan = curve.getTangent(0.5);
        p.y = Math.max(p.y, worldTerrainSurfaceY(p.x, p.z, tiles) + 1.2);
        const flowAngle = Math.atan2(tan.z, tan.x);
        bridgeSpans.push({ pos: p, angle: flowAngle });
      }
    }
  }

  if (positions.length === 0) return;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  // Turquoise to match the coastal sea tint (terrainShader sea = rgb
  // 0.30,0.63,0.66 ≈ 0x4ca1a8) so a river reads as the SAME water as the
  // coast it flows into, not a separate blue ribbon. Low roughness keeps a
  // soft wet-specular glint from the fixed afternoon sun; the teal emissive
  // gives shallow water a faint inner glow without going neon.
  const mat = new MeshStandardMaterial({
    color: new Color(0x3a8a92),
    roughness: 0.12,
    metalness: 0.15,
    emissive: new Color(0x0a2830),
    emissiveIntensity: 0.6,
  });
  const mesh = new Mesh(geom, mat);
  riverGroup.add(mesh);

  // Mouth foam: a few pale dots where the river meets the sea, echoing the
  // coast-ring foam from the terrain shader.
  if (mouths.length > 0) {
    const foamGeom = new SphereGeometry(HEX_SIZE * 0.06, 6, 4);
    const foamMat = new MeshStandardMaterial({
      color: 0xf0faff,
      roughness: 0.25,
      metalness: 0.0,
      emissive: new Color(0xa0d0e0),
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.7,
    });
    const foam = new InstancedMesh(foamGeom, foamMat, mouths.length * 3);
    const m = new Matrix4();
    let i = 0;
    for (const mouth of mouths) {
      const h = hashCoord(Math.round(mouth.x), Math.round(mouth.z));
      for (let f = 0; f < 3; f++) {
        const a = ((h + f * 120) % 360) * (Math.PI / 180);
        m.makeTranslation(
          mouth.x + Math.cos(a) * HEX_SIZE * 0.06 * (f + 1) * 0.5,
          mouth.y + 0.2,
          mouth.z + Math.sin(a) * HEX_SIZE * 0.06 * (f + 1) * 0.5,
        );
        foam.setMatrixAt(i++, m.clone());
      }
    }
    foam.instanceMatrix.needsUpdate = true;
    riverGroup.add(foam);
  }

  // River crossings: place a 3D bridge (Kenney bridge.glb or procedural stone span)
  // at the revealed midpoint of each river path.
  if (bridgeSpans.length > 0) {
    const up = new Vector3(0, 1, 0);
    const quat = new Quaternion();
    const scl = new Vector3();
    const pos = new Vector3();
    const mat4 = new Matrix4();

    if (bridgeVariant) {
      const bMesh = new InstancedMesh(
        bridgeVariant.geometry,
        bridgeVariant.materials,
        bridgeSpans.length,
      );
      bMesh.userData.sharedGeometry = true;
      bMesh.castShadow = true;
      bMesh.receiveShadow = true;
      const s = HEX_SIZE * 0.4 * bridgeVariant.norm;
      scl.set(s, s, s);
      for (let i = 0; i < bridgeSpans.length; i++) {
        const span = bridgeSpans[i]!;
        quat.setFromAxisAngle(up, -span.angle);
        pos.set(span.pos.x, span.pos.y - bridgeVariant.minY * s, span.pos.z);
        mat4.compose(pos, quat, scl);
        bMesh.setMatrixAt(i, mat4);
      }
      bMesh.instanceMatrix.needsUpdate = true;
      riverGroup.add(bMesh);
    } else {
      const deckGeom = new BoxGeometry(HEX_SIZE * 0.12, HEX_SIZE * 0.04, HEX_SIZE * 0.28);
      const deckMat = new MeshStandardMaterial({ color: 0x8b7355, roughness: 0.78 });
      const bMesh = new InstancedMesh(deckGeom, deckMat, bridgeSpans.length);
      bMesh.castShadow = true;
      scl.set(1, 1, 1);
      for (let i = 0; i < bridgeSpans.length; i++) {
        const span = bridgeSpans[i]!;
        quat.setFromAxisAngle(up, -span.angle);
        pos.set(span.pos.x, span.pos.y + HEX_SIZE * 0.02, span.pos.z);
        mat4.compose(pos, quat, scl);
        bMesh.setMatrixAt(i, mat4);
      }
      bMesh.instanceMatrix.needsUpdate = true;
      riverGroup.add(bMesh);
    }
  }
}

export function clearRivers(): void {
  while (riverGroup.children.length > 0) {
    const child = riverGroup.children[0] as Mesh;
    riverGroup.remove(child);
    if (!child.userData.sharedGeometry) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat.dispose();
    }
  }
  lastSignature = '';
}
