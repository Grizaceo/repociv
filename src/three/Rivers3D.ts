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
  BufferGeometry,
  Float32BufferAttribute,
  CatmullRomCurve3,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Color,
  SphereGeometry,
  Vector3,
} from 'three';
import { AXIAL_DIRECTIONS, axialDistance, type Axial } from '../hex.ts';
import { tileKey, type Tile } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const riverGroup = new Group();
riverGroup.name = 'rivers';
let lastSignature = '';

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

/** Ribbon lift above the tile top face. Hills/mountain tops undulate
 *  (shader relief, amplitude HEX_SIZE*0.05 ≈ 2.6) so the river needs more
 *  clearance there than on flat biomes. */
function riverLift(terrain: Tile['terrain']): number {
  return terrain === 'hills' || terrain === 'mountain' ? 3.4 : 1.6;
}

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
      const h = hashCoord(current.coord.q, current.coord.r);
      const next = downs[(h + step) % downs.length]!;

      if (next.terrain === 'ocean') {
        // Mouth: stop at the shared edge, reaching slightly into the sea.
        const landTop = axialToWorld3D(
          current.coord.q, current.coord.r, terrainElevation(current.terrain));
        // Ocean tops sit at elevation −1 (y = −12, bevel flattened to the
        // cap): drop the mouth to just above the water so the last span
        // reads as a short cascade down the coastal cliff, not a ribbon
        // hovering 13 units over the sea.
        const sea = axialToWorld3D(next.coord.q, next.coord.r, terrainElevation('ocean'));
        // Reach further into the sea tile (0.70) and sit just at the water
        // surface (+0.5, was +1.0) so the ribbon dips into the ocean and
        // merges gaplessly instead of hovering over a coastal seam.
        mouth = new Vector3(
          landTop.x + (sea.x - landTop.x) * 0.70,
          sea.y + 0.5,
          landTop.z + (sea.z - landTop.z) * 0.70,
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

    const { points, revealed } = edgeRoutePath(path, mouth);
    paths.push({ points, revealed, mouth });
  }
  return paths;
}

/** Lifted world-space center of a tile (ribbon clearance baked in). */
function tileCenterWorld(t: Tile): Vector3 {
  const p = axialToWorld3D(t.coord.q, t.coord.r, terrainElevation(t.terrain));
  p.y += riverLift(t.terrain);
  return p;
}

/** Re-route a tile-center descent onto the hex EDGE graph (Civ V draws rivers
 *  along edges, not across tile interiors). Two facts about a regular hex grid
 *  make this exact and index-free:
 *    - the midpoint of two adjacent tile centers IS the midpoint of their
 *      shared edge (centers are mirror images across that edge), so every
 *      body control point lands on a real tile boundary, never a center;
 *    - three mutually-adjacent hexes meet at one corner = the centroid of the
 *      three centers, so a 60° turn routes mid → corner → mid with BOTH spans
 *      lying on actual edges.
 *  Only the spring head keeps the source-tile center (a river is born at a
 *  tile); the whole body hugs edges. Deterministic — same layout, same path. */
function edgeRoutePath(path: Tile[], mouth: Vector3 | null): {
  points: Vector3[];
  revealed: boolean[];
} {
  const points: Vector3[] = [tileCenterWorld(path[0]!)];
  const revealed: boolean[] = [path[0]!.revealed];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const ca = tileCenterWorld(a);
    const cb = tileCenterWorld(b);
    points.push(ca.clone().add(cb).multiplyScalar(0.5)); // shared-edge midpoint
    revealed.push(a.revealed && b.revealed);
    const c = path[i + 2];
    if (c && axialDistance(a.coord, c.coord) === 1) {
      // a, b, c mutually adjacent → 60° turn → route through their shared corner.
      points.push(ca.clone().add(cb).add(tileCenterWorld(c)).multiplyScalar(1 / 3));
      revealed.push(a.revealed && b.revealed && c.revealed);
    }
  }
  if (mouth) {
    points.push(mouth);
    revealed.push(path[path.length - 1]!.revealed);
  }
  return { points, revealed };
}

/** Insert a hash-offset midpoint between consecutive controls so straight
 *  hex-to-hex runs still meander (Civ V rivers are never straight lines). */
function meander(points: Vector3[], revealed: boolean[]): { pts: Vector3[]; rev: boolean[] } {
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
    // Perpendicular offset, ±0.20 hex, deterministic per segment position.
    const h = hashCoord(Math.round(a.x + b.x), Math.round(a.z + b.z));
    const amp = ((h % 7) - 3) / 3 * HEX_SIZE * 0.20;
    pts.push(new Vector3(
      (a.x + b.x) / 2 + (-dz / len) * amp,
      (a.y + b.y) / 2,
      (a.z + b.z) / 2 + (dx / len) * amp,
    ));
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
    positions.push(p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz);
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
  return `${tiles.length}:${h}`;
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

  for (const path of paths) {
    const { pts, rev } = meander(path.points, path.revealed);
    if (pts.length < 2) continue;
    const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
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
        appendRibbon(run, positions, indices, 1);
        run = [];
      }
    }
    appendRibbon(run, positions, indices, 1);
    if (path.mouth && path.revealed[path.revealed.length - 1]) mouths.push(path.mouth);
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
    color: new Color(0x4ca1a8),
    roughness: 0.22,
    metalness: 0.05,
    emissive: new Color(0x0e3338),
    emissiveIntensity: 0.40,
  });
  const mesh = new Mesh(geom, mat);
  riverGroup.add(mesh);

  // Mouth foam: a few pale dots where the river meets the sea, echoing the
  // coast-ring foam from the terrain shader.
  if (mouths.length > 0) {
    const foamGeom = new SphereGeometry(HEX_SIZE * 0.055, 6, 4);
    const foamMat = new MeshLambertMaterial({
      color: 0xe8f8ff,
      transparent: true,
      opacity: 0.6,
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
}

export function clearRivers(): void {
  while (riverGroup.children.length > 0) {
    const child = riverGroup.children[0] as Mesh;
    riverGroup.remove(child);
    child.geometry.dispose();
    const mat = child.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat.dispose();
  }
  lastSignature = '';
}
