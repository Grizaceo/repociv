// ─── Three.js scene: terrain instancing, lights, territory, sub-groups ─────
import {
  AmbientLight,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshLambertMaterial,
  LineBasicMaterial,
  Scene,
  BufferGeometry,
  Float32BufferAttribute,
  Color,
  SphereGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { AXIAL_DIRECTIONS, type Axial } from '../hex.ts';
import { tileKey } from '../types.ts';
import { type GameState } from '../game.ts';
import { terrainElevation } from '../isoHex.ts';
import { HEX_SIZE } from '../constants.ts';
import { sharedHexGeometry } from './hexGeometry.ts';
import { axialToWorld3D, hexCornerAngle3D, TILE_HEIGHT } from './axialToWorld3D.ts';
import { instanceColorForTile } from './FogOfWar3D.ts';
import { HexPicker } from './HexPicker.ts';
import {
  createTerrainMaterial,
  updateTerrainShaderTime,
  updateTerrainShaderAtlas,
  TERRAIN_ATLAS_INDEX,
  SKY_TOP,
  SKY_HORIZON,
  FOG_DENSITY,
} from './terrainShader.ts';
import { loadTerrainAtlas, type LoadedTerrainAtlas } from './TerrainTextureAtlas.ts';
import {
  getTileDecorGroup,
  rebuildTileDecor,
  setDecorVisible,
  clearTileDecor,
} from './TileDecor3D.ts';
import {
  getCityGroup,
  rebuildCityClusters,
  setCitiesVisible,
  clearCityClusters,
  tickCities,
} from './CityCluster3D.ts';
import {
  getUnitGroup,
  rebuildUnits,
  setUnitsVisible,
  clearUnits,
  tickUnits,
} from './UnitMesh3D.ts';
import { rebuildMapLabels, getLabelGroup } from './MapLabels3D.ts';
import { rebuildGroundPlane, getGroundMesh, disposeGroundMesh } from './GroundPlane3D.ts';
import {
  getMountainPropsGroup,
  ensureMountainPropsLoad,
  rebuildMountainProps,
  clearMountainProps,
} from './MountainProps3D.ts';
import {
  getForestPropsGroup,
  ensureForestPropsLoad,
  rebuildForestProps,
  clearForestProps,
} from './ForestProps3D.ts';
import {
  getCityPropsGroup,
  ensureCityPropsLoad,
  rebuildCityProps,
  clearCityProps,
} from './CityProps3D.ts';
import { ensureUnitPropsLoad } from './UnitProps3D.ts';
import { getTileFlashGroup, flashTile, tickTileFlash, clearTileFlash } from './TileFlash3D.ts';
import { getTilePopupGroup, clearTilePopup } from './TilePopup3D.ts';
import {
  getFogTransitionGroup,
  updateFogTransition,
  tickFogTransition,
  clearFogTransition,
  _testResetPrevUnrevealed,
} from './FogTransition3D.ts';
import {
  getResourcePropsGroup,
  ensureResourcePropsLoad,
  rebuildResourceProps,
  clearResourceProps,
} from './ResourceProps3D.ts';
import { getTileYieldsGroup, rebuildTileYields, clearTileYields } from './TileYields3D.ts';
import { getRiverGroup, rebuildRivers, clearRivers } from './Rivers3D.ts';
import { createSkyDome, disposeSkyDome } from './SkyDome3D.ts';
import {
  getWonderPropsGroup,
  rebuildWonderProps,
  clearWonderProps,
  setWonderVisible,
} from './WonderProps3D.ts';

export interface HexSceneRenderOptions {
  fogEnabled: boolean;
  lod: 'low' | 'medium' | 'high';
  showStructure: boolean;
  showOps: boolean;
  showLabels: boolean;
  showKnowledge: boolean;
  showLabs: boolean;
  animTime: number;
  /** Delta time in seconds since the last frame. Drives per-frame
   *  animations (unit spawn/despawn tweens, idle pulses, walking hops)
   *  that progress independently of the dirty-flag rebuilds. */
  dt: number;
}

const terrainGroup = new Group();
terrainGroup.name = 'terrain';

let terrainMesh: InstancedMesh | null = null;
let fogCoverMesh: InstancedMesh | null = null;
let fogPuffMesh: InstancedMesh | null = null;
let fogCoverSignature = '';
// Per-city territory borders. Each entry is one ribbon Mesh (a flat colored
// band lying on the terrain) with that city's color — Civ V's glowing culture
// borders. WebGL caps line width at 1px, so LineSegments borders were
// invisible at strategic zoom; ribbons are real geometry that read at any
// distance. Caps at 50 cities; beyond that, falls back to single-color.
let territoryBorders: Mesh[] = [];
// Dirty-flag for the borders: they depend on territory shape, per-city colour,
// capital flag, the structure-layer toggle, and LOD — but NOT on unit movement,
// which also flips the global signature. Without this gate every unit step
// rebuilt all border geometry. Mirrors shorelineSignature.
let territorySignature = '';
let shorelineRings: LineSegments | null = null;
let shorelineSignature = '';
// Per-vertex base data for the in-place pulse: [cx, cy, cz, ux, uz] × vertex.
// The pulse scales each ring around its own tile center; scaling the whole
// LineSegments object would drift rings toward/away from the world origin.
let shorelineBase: Float32Array | null = null;
let foamMesh: InstancedMesh | null = null;
let foamSignature = '';
let hexGridLines: LineSegments | null = null;
let hexGridSignature = '';
let groundMeshRef: import('three').Mesh | null = null;
let groundSignature = '';
let tileCountSignature = '';
let terrainMaterial: MeshStandardMaterial | null = null;
let sunLight: DirectionalLight | null = null;
let atlasLoadStarted = false;
let loadedTerrainAtlas: LoadedTerrainAtlas | null = null;

// Fixed late-afternoon sun. Stable position is the whole point: the old
// code re-set sunLight.position every frame and made shadows swim.
const SUN_POSITION = { x: -1659, y: 1377, z: 1056 } as const;

export function createHexWorldScene(): Scene {
  const scene = new Scene();
  scene.background = SKY_TOP.clone();
  scene.fog = new FogExp2(SKY_HORIZON.getHex(), FOG_DENSITY);
  // Gradient sky dome (zenith blue → warm horizon haze); the flat
  // background colour stays underneath as fallback while shaders compile.
  scene.add(createSkyDome());

  // Civ V-style warm afternoon lighting — golden sun, warm ambient.
  // Flat-light budget (ambient + hemi) stays well under the sun so faces
  // actually model; the old 0.55/0.45 vs 1.05 split washed everything out.
  scene.add(new AmbientLight(0xdacfb6, 0.38));
  scene.add(new HemisphereLight(0xb0d8f0, 0x7aaa60, 0.34));
  sunLight = new DirectionalLight(0xffe7bd, 1.3);
  // Fixed angle: updateHexWorldScene only breathes colour/intensity.
  sunLight.position.set(SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -2800;
  sunLight.shadow.camera.right = 2800;
  sunLight.shadow.camera.top = 2800;
  sunLight.shadow.camera.bottom = -2800;
  sunLight.shadow.camera.near = 0.1;
  sunLight.shadow.camera.far = 6000;
  // Ortho frustum edits don't take effect until the projection is rebuilt —
  // without this the shadow window stays at the ±5-unit default and the
  // whole world renders unshadowed.
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.8;
  scene.add(sunLight);
  scene.add(sunLight.target);
  // Soft fill light from opposite side to reduce harsh shadows
  const fillLight = new DirectionalLight(0xd0e8ff, 0.16);
  fillLight.position.set(80, 60, -100);
  scene.add(fillLight);

  scene.add(terrainGroup);
  scene.add(getRiverGroup());
  scene.add(getTileDecorGroup());
  scene.add(getMountainPropsGroup());
  scene.add(getForestPropsGroup());
  scene.add(getCityGroup());
  scene.add(getCityPropsGroup());
  scene.add(getResourcePropsGroup());
  scene.add(getTileYieldsGroup());
  scene.add(getUnitGroup());
  scene.add(getTileFlashGroup());
  scene.add(getTilePopupGroup());
  scene.add(getFogTransitionGroup());
  scene.add(getLabelGroup());
  scene.add(getWonderPropsGroup());

  ensureTerrainAtlasLoad();
  // Props arriving flips areMountainPropsReady(), which participates in the
  // ThreeMapRenderer dirty signature — the next frame rebuilds decor (cones
  // out) and instances the glTF peaks.
  ensureMountainPropsLoad();
  ensureForestPropsLoad();
  ensureCityPropsLoad();
  ensureUnitPropsLoad();
  ensureResourcePropsLoad();

  return scene;
}

/** Edge index (corner pair e, e+1 with flat-top corners at 60i°) facing
 *  AXIAL_DIRECTIONS[k]. Edge i is centered at 60i+30°; the direction angles
 *  are 30°, −30°, −90°, 210°, 150°, 90° respectively. Passing the direction
 *  index straight through as an edge index (the old behavior) put territory
 *  borders and foam on the wrong side of the hex for 5 of 6 directions. */
const DIR_TO_EDGE = [0, 5, 4, 3, 2, 1] as const;

/** Determine dominant neighbor terrain for edge blending. */
function dominantNeighborTerrain(
  tile: { coord: Axial; terrain: string },
  getTile: (key: string) => { terrain: string } | undefined,
): number {
  const counts = new Map<string, number>();
  for (const d of AXIAL_DIRECTIONS) {
    const n = getTile(tileKey({ q: tile.coord.q + d.q, r: tile.coord.r + d.r }));
    if (!n || n.terrain === tile.terrain) continue;
    counts.set(n.terrain, (counts.get(n.terrain) ?? 0) + 1);
  }
  let best = -1;
  let bestCount = 0;
  for (const [terrain, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = TERRAIN_ATLAS_INDEX[terrain as keyof typeof TERRAIN_ATLAS_INDEX] ?? -1;
    }
  }
  return best;
}

function clearTerritoryLines(): void {
  for (const mesh of territoryBorders) {
    terrainGroup.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as MeshBasicMaterial).dispose();
  }
  territoryBorders = [];
}

function animateTerritoryPulse(animTime: number): void {
  if (territoryBorders.length === 0) return;
  const pulse = 0.9 + 0.07 * Math.sin(animTime * 2.2);
  for (const mesh of territoryBorders) {
    const mat = mesh.material as MeshBasicMaterial;
    const baseOpacity = (mat.userData.baseOpacity as number) ?? 0.5;
    mat.opacity = baseOpacity * pulse;
  }
}

// ── Civ V culture-border ribbon ────────────────────────────────────────────
// Borders are flat bands lying on the terrain, not 1px lines. Each boundary
// edge becomes a quad biased slightly INTO the owner's territory (Civ V's
// border hugs the inside of the frontier). A wider additive-blended glow band
// underneath gives the signature neon halo.
const BORDER_BAND_W = HEX_SIZE * 0.1;

interface BorderEdge {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  cx: number;
  cz: number;
  y: number;
}

/** Build a flat ribbon (XZ plane, at each edge's y) from boundary edges.
 *  `width` is the band thickness; `inset` shifts the band toward the tile
 *  centre so it reads as the owner's inner frontier. Ends are mitre-extended
 *  by half-width so consecutive segments close the corner gaps. */
export function buildRibbonGeometry(
  edges: BorderEdge[],
  width: number,
  inset: number,
): BufferGeometry {
  // Pre-sized: 2 triangles × 3 verts × 3 coords = 18 floats per edge.
  const pos = new Float32Array(edges.length * 18);
  const hw = width * 0.5;
  let o = 0;
  for (const e of edges) {
    let tx = e.x2 - e.x1;
    let tz = e.z2 - e.z1;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    // Edge normal in XZ; flip so it points toward the tile centre (inward).
    let nx = -tz;
    let nz = tx;
    const midx = (e.x1 + e.x2) * 0.5;
    const midz = (e.z1 + e.z2) * 0.5;
    if (nx * (e.cx - midx) + nz * (e.cz - midz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    // Mitre-extend the ends along the tangent so corners don't gap.
    const ax = e.x1 - tx * hw;
    const az = e.z1 - tz * hw;
    const bx = e.x2 + tx * hw;
    const bz = e.z2 + tz * hw;
    // Band spans [inset - hw, inset + hw] along the inward normal.
    const o1 = inset - hw;
    const o2 = inset + hw;
    const p1x = ax + nx * o1,
      p1z = az + nz * o1;
    const p2x = ax + nx * o2,
      p2z = az + nz * o2;
    const p3x = bx + nx * o2,
      p3z = bz + nz * o2;
    const p4x = bx + nx * o1,
      p4z = bz + nz * o1;
    pos[o++] = p1x;
    pos[o++] = e.y;
    pos[o++] = p1z;
    pos[o++] = p2x;
    pos[o++] = e.y;
    pos[o++] = p2z;
    pos[o++] = p3x;
    pos[o++] = e.y;
    pos[o++] = p3z;
    pos[o++] = p1x;
    pos[o++] = e.y;
    pos[o++] = p1z;
    pos[o++] = p3x;
    pos[o++] = e.y;
    pos[o++] = p3z;
    pos[o++] = p4x;
    pos[o++] = e.y;
    pos[o++] = p4z;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return geom;
}

/** Add a thin culture-border band. No additive glow — it read as neon UI
 *  overlay on the terrain and fought the ground for depth. */
function addBorderRibbon(edges: BorderEdge[], color: Color, bandOpacity: number): void {
  if (edges.length === 0) return;

  // Thinner band, fully inside the owner's frontier: with inset >= half-width
  // the span [inset-hw, inset+hw] starts at +0.6 (never negative = no overhang
  // into the neighbour's tile), so each civ paints only its own side of the
  // seam. Civ V borders hug the inside edge, they don't straddle it.
  const w = BORDER_BAND_W * 0.7;
  const bandGeom = buildRibbonGeometry(edges, w, w * 0.5 + HEX_SIZE * 0.012);
  const bandMat = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: bandOpacity,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    side: DoubleSide,
    fog: true,
    toneMapped: false,
  });
  bandMat.userData.baseOpacity = bandOpacity;
  const bandMesh = new Mesh(bandGeom, bandMat);
  bandMesh.renderOrder = 3;
  bandMesh.frustumCulled = false;
  terrainGroup.add(bandMesh);
  territoryBorders.push(bandMesh);
}

function rebuildTerritoryLines(
  state: GameState,
  _animTime: number,
  visible: boolean,
  lod: 'low' | 'medium' | 'high',
): void {
  // Signature gate: skip the full clear+regroup+rebuild on dirty frames where
  // only unit positions changed (the common case). Granularity matches the
  // global world signature (per-city coord + territory size), plus colour,
  // capital, the visible toggle and LOD — everything border geometry reads.
  const sig = visible
    ? `${lod}:` +
      state.world.cities
        .map(
          (c) =>
            `${tileKey(c.coord)};${c.territory.length};${c.isCapital ? 1 : 0};${
              c.color ? c.color.join(',') : ''
            }`,
        )
        .join('|')
    : 'hidden';
  if (sig === territorySignature) return;
  territorySignature = sig;

  clearTerritoryLines();
  if (!visible || lod !== 'high') return;

  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));
  const cities = state.world.cities.filter((c) => c.territory.length > 0);

  // Collect the boundary edges of a city's territory as flat ribbon segments.
  const collectEdges = (
    territory: Axial[],
    inTerritory: Set<string>,
    yOff: number,
  ): BorderEdge[] => {
    const edges: BorderEdge[] = [];
    for (const coord of territory) {
      const tile = getTile(coord);
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const center = axialToWorld3D(coord.q, coord.r, elev);
      for (let d = 0; d < 6; d++) {
        const nKey = tileKey({
          q: coord.q + AXIAL_DIRECTIONS[d]!.q,
          r: coord.r + AXIAL_DIRECTIONS[d]!.r,
        });
        // Outline each city against its own frontier: draw an edge only where
        // the city's territory meets a tile it doesn't own. Ribbons render at
        // high LOD only, so the merged-empire (low-LOD) outline path is gone.
        if (inTerritory.has(nKey)) continue;
        const e = DIR_TO_EDGE[d]!;
        const a1 = hexCornerAngle3D(e);
        const a2 = hexCornerAngle3D((e + 1) % 6);
        edges.push({
          x1: center.x + HEX_SIZE * Math.cos(a1),
          z1: center.z + HEX_SIZE * Math.sin(a1),
          x2: center.x + HEX_SIZE * Math.cos(a2),
          z2: center.z + HEX_SIZE * Math.sin(a2),
          cx: center.x,
          cz: center.z,
          // Ribbon rides just above the tile cap (depthTest + polygonOffset
          // keep it from z-fighting). The old +6.0 floated it ~half a tile up,
          // reading as a neon UI overlay instead of paint on the ground.
          y: center.y + 1.8 + yOff,
        });
      }
    }
    return edges;
  };

  // Group boundary edges by render colour, then emit one merged ribbon per
  // colour. This keeps the border draw-call count bounded (≈palette size +
  // capitals) no matter how many cities — a real workspace has dozens, and
  // the old per-city path fell back to a single flat gold past 50, throwing
  // away every civ colour. Capitals form their own brighter group.
  interface BorderGroup {
    color: Color;
    capital: boolean;
    edges: BorderEdge[];
  }
  const groups = new Map<string, BorderGroup>();
  cities.forEach((city, cityIdx) => {
    const inTerritory = new Set(city.territory.map((c) => tileKey(c)));
    // Tiny per-city y stagger so two same-colour empires sharing a frontier
    // don't z-fight once their edges land in the same merged geometry. Wraps
    // at 64 (well above realistic same-colour city counts) so the cumulative
    // lift stays sub-0.4u and never separates a ribbon from its terrain.
    const edges = collectEdges(city.territory, inTerritory, (cityIdx % 64) * 0.006);
    if (edges.length === 0) return;
    const cc = city.color ?? [0.725, 0.588, 0.329]; // 0xb99654 fallback
    const color = new Color(cc[0], cc[1], cc[2]);
    if (city.isCapital) color.lerp(new Color(1, 1, 1), 0.18);
    const key = `${city.isCapital ? 'cap' : 'c'}:${color.getHexString()}`;
    let g = groups.get(key);
    if (!g) {
      g = { color, capital: Boolean(city.isCapital), edges: [] };
      groups.set(key, g);
    }
    for (const e of edges) g.edges.push(e);
  });

  for (const g of groups.values()) {
    const baseOpacity = g.capital ? (lod === 'high' ? 0.52 : 0.44) : lod === 'high' ? 0.4 : 0.34;
    addBorderRibbon(g.edges, g.color, baseOpacity);
  }
}

/** Shoreline rings: rebuild geometry only when ocean tiles change.
 *  Per-frame pulse writes vertex positions in place, avoiding allocations.
 *  The tile scan + signature build allocate, so they only run on dirty
 *  frames — the world signature already covers terrain/revealed changes. */
function rebuildShorelineRings(state: GameState, animTime: number, stateDirty = true): void {
  if (!stateDirty) {
    animateShorelinePulse(animTime);
    return;
  }
  const tiles = Array.from(state.world.tiles.values());
  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));

  // Check which ocean tiles have land neighbors (need shoreline display)
  const shorelineTiles = tiles.filter((t) => {
    if (t.terrain !== 'ocean' || !t.revealed) return false;
    const neighbors = AXIAL_DIRECTIONS.map((d) =>
      getTile({ q: t.coord.q + d.q, r: t.coord.r + d.r }),
    );
    return neighbors.some((n) => n && n.terrain !== 'ocean');
  });
  const shorelineSig = shorelineTiles.map((t) => tileKey(t.coord)).join(',');

  // Geometry rebuild only when shoreline composition changes
  if (shorelineSig !== shorelineSignature) {
    shorelineSignature = shorelineSig;

    if (shorelineRings) {
      terrainGroup.remove(shorelineRings);
      shorelineRings.geometry.dispose();
      (shorelineRings.material as LineBasicMaterial).dispose();
      shorelineRings = null;
      shorelineBase = null;
    }

    if (shorelineTiles.length === 0) return;

    const segments: number[] = [];
    const base: number[] = [];
    for (const tile of shorelineTiles) {
      const elev = terrainElevation(tile.terrain);
      const center = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      for (let i = 0; i < 6; i++) {
        const a = hexCornerAngle3D(i);
        const b = hexCornerAngle3D((i + 1) % 6);
        // x/z are filled in by the per-frame pulse below; cache each
        // vertex's ring center + unit offset so the update is in-place.
        segments.push(center.x, center.y + 1.2, center.z, center.x, center.y + 1.2, center.z);
        base.push(center.x, center.y + 1.2, center.z, Math.cos(a), Math.sin(a));
        base.push(center.x, center.y + 1.2, center.z, Math.cos(b), Math.sin(b));
      }
    }

    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
    const mat = new LineBasicMaterial({
      color: 0x96dcff,
      transparent: true,
      opacity: 0.35,
    });
    shorelineBase = new Float32Array(base);
    shorelineRings = new LineSegments(geom, mat);
    terrainGroup.add(shorelineRings);
  }

  animateShorelinePulse(animTime);
}

/** Per-frame pulse: write vertex x/z in place (no allocations). Each ring
 *  scales around its own tile center — matching the original per-tile
 *  `r = HEX_SIZE * pulse * 0.82` look. Scaling the whole LineSegments
 *  object instead would drift rings toward/away from the world origin. */
function animateShorelinePulse(animTime: number): void {
  if (!shorelineRings || !shorelineBase) return;
  const pulse = 0.88 + 0.08 * Math.sin(animTime * 2);
  const r = HEX_SIZE * 0.82 * pulse;
  const posAttr = shorelineRings.geometry.getAttribute('position') as Float32BufferAttribute;
  const arr = posAttr.array as Float32Array;
  const vertexCount = arr.length / 3;
  for (let v = 0; v < vertexCount; v++) {
    const b = v * 5;
    arr[v * 3] = shorelineBase[b]! + shorelineBase[b + 3]! * r;
    arr[v * 3 + 2] = shorelineBase[b + 2]! + shorelineBase[b + 4]! * r;
  }
  posAttr.needsUpdate = true;
}

/** Foam spheres at coast-land edges. */
function rebuildFoam(state: GameState, _animTime: number): void {
  const tiles = Array.from(state.world.tiles.values());
  const sig = tiles
    .filter((t) => t.terrain === 'ocean' && t.revealed)
    .map((t) => tileKey(t.coord))
    .join(',');
  if (sig === foamSignature) return;
  foamSignature = sig;

  if (foamMesh) {
    terrainGroup.remove(foamMesh);
    foamMesh.geometry.dispose();
    (foamMesh.material as MeshLambertMaterial).dispose();
    foamMesh = null;
  }

  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));
  // 3 dots per shore edge: full-size at the midpoint, smaller ones offset
  // along the edge tangent — a broken foam line like Civ V's coast, not a
  // string of even beads.
  const foamPositions: Array<{ x: number; y: number; z: number; s: number }> = [];

  for (const tile of state.world.tiles.values()) {
    if (tile.terrain !== 'ocean' || !tile.revealed) continue;
    const elev = terrainElevation(tile.terrain);
    const center = axialToWorld3D(tile.coord.q, tile.coord.r, elev);

    for (let i = 0; i < 6; i++) {
      const d = AXIAL_DIRECTIONS[i]!;
      const neighbor = getTile({ q: tile.coord.q + d.q, r: tile.coord.r + d.r });
      if (!neighbor || neighbor.terrain === 'ocean') continue;

      // Foam at the midpoint of the edge actually facing this neighbor
      const e = DIR_TO_EDGE[i]!;
      const a = hexCornerAngle3D(e);
      const b = hexCornerAngle3D((e + 1) % 6);
      const mx = center.x + (HEX_SIZE * Math.cos(a) + HEX_SIZE * Math.cos(b)) * 0.5;
      const mz = center.z + (HEX_SIZE * Math.sin(a) + HEX_SIZE * Math.sin(b)) * 0.5;
      // Edge tangent (corner a → corner b), for the side dots
      let tx = Math.cos(b) - Math.cos(a);
      let tz = Math.sin(b) - Math.sin(a);
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      foamPositions.push({ x: mx, y: center.y + 1.0, z: mz, s: 1.0 });
      foamPositions.push({
        x: mx + tx * HEX_SIZE * 0.22,
        y: center.y + 1.0,
        z: mz + tz * HEX_SIZE * 0.22,
        s: 0.55,
      });
      foamPositions.push({
        x: mx - tx * HEX_SIZE * 0.22,
        y: center.y + 1.0,
        z: mz - tz * HEX_SIZE * 0.22,
        s: 0.55,
      });
    }
  }

  if (foamPositions.length === 0) return;

  const foamGeom = new SphereGeometry(HEX_SIZE * 0.08, 6, 4);
  const foamMat = new MeshLambertMaterial({
    color: 0xe8f8ff,
    transparent: true,
    opacity: 0.55,
  });
  foamMesh = new InstancedMesh(foamGeom, foamMat, foamPositions.length);
  const m = new Matrix4();
  const fs = new Vector3();
  foamPositions.forEach((pos, i) => {
    fs.set(pos.s, pos.s * 0.8, pos.s);
    m.makeScale(fs.x, fs.y, fs.z);
    m.setPosition(pos.x, pos.y, pos.z);
    foamMesh!.setMatrixAt(i, m);
  });
  foamMesh.instanceMatrix.needsUpdate = true;
  terrainGroup.add(foamMesh);
}

/** Per-frame foam breath: one material-opacity write, allocation-free.
 *  Deterministic under ?freeze (input is animTime). */
function animateFoamPulse(animTime: number): void {
  if (!foamMesh) return;
  (foamMesh.material as MeshLambertMaterial).opacity = 0.45 + 0.15 * Math.sin(animTime * 1.7);
}

function rebuildGround(state: GameState): void {
  const tiles = Array.from(state.world.tiles.values());
  const sig = `${tiles.length}`;
  if (sig === groundSignature && groundMeshRef) return;
  groundSignature = sig;

  if (groundMeshRef) {
    terrainGroup.remove(groundMeshRef);
    groundMeshRef = null;
  }
  rebuildGroundPlane(state);
  const mesh = getGroundMesh();
  if (mesh) {
    groundMeshRef = mesh;
    // Insert at index 0 so ground renders behind tiles
    terrainGroup.add(mesh);
  }
}

function rebuildFogCover(state: GameState): void {
  const unrevealed = Array.from(state.world.tiles.values()).filter((t) => !t.revealed);
  const signature =
    unrevealed.length === 0
      ? 'none'
      : `${unrevealed.length}:${unrevealed.map((t) => tileKey(t.coord)).join(',')}`;

  if (signature === fogCoverSignature && (unrevealed.length === 0 || fogCoverMesh)) return;
  fogCoverSignature = signature;

  if (fogCoverMesh) {
    terrainGroup.remove(fogCoverMesh);
    fogCoverMesh.dispose();
    fogCoverMesh = null;
  }
  if (fogPuffMesh) {
    terrainGroup.remove(fogPuffMesh);
    fogPuffMesh.geometry.dispose();
    (fogPuffMesh.material as MeshLambertMaterial).dispose();
    fogPuffMesh = null;
  }

  if (unrevealed.length === 0) return;

  // Civ V unexplored look: pale cloud cover, not a near-black void. The old
  // 0x2a2a35 slate read as black wedges wherever an unrevealed hill/mountain
  // poked between revealed tiles. Emissive lifts the Lambert side faces so
  // the prism flanks stay cloud-gray instead of going black in shade.
  const mat = new MeshLambertMaterial({
    color: 0xc6cdc9,
    emissive: 0x5a6164,
    transparent: true,
    opacity: 0.93,
  });
  fogCoverMesh = new InstancedMesh(sharedHexGeometry, mat, unrevealed.length);

  const matrix = new Matrix4();
  unrevealed.forEach((tile, i) => {
    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    pos.y += 0.5;
    matrix.makeTranslation(pos.x, pos.y, pos.z);
    fogCoverMesh!.setMatrixAt(i, matrix);
  });
  fogCoverMesh.instanceMatrix.needsUpdate = true;
  terrainGroup.add(fogCoverMesh);

  // Cloud tops: 3 squashed puffs per unrevealed tile turn the flat prism
  // lid into Civ V's billowing unexplored cover. Hash-deterministic
  // placement (same coords → same puffs → SHA-stable goldens), static —
  // no per-frame cost, the fog reads volumetric from the play camera.
  const puffGeom = new SphereGeometry(HEX_SIZE * 0.3, 8, 6);
  const puffMat = new MeshLambertMaterial({
    color: 0xdde3e1,
    emissive: 0x767d80,
    transparent: true,
    opacity: 0.9,
  });
  const PUFFS = 3;
  fogPuffMesh = new InstancedMesh(puffGeom, puffMat, unrevealed.length * PUFFS);
  const puffSpots: Array<[number, number]> = [
    [-0.18, -0.1],
    [0.2, 0.06],
    [-0.02, 0.2],
  ];
  const pPos = new Vector3();
  const pQuat = new Quaternion();
  const pScl = new Vector3();
  const up = new Vector3(0, 1, 0);
  let pi = 0;
  for (const tile of unrevealed) {
    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const h = Math.abs((tile.coord.q * 73856093) ^ (tile.coord.r * 19349663));
    for (let p = 0; p < PUFFS; p++) {
      const [ox, oz] = puffSpots[p]!;
      const jx = (((h >> (p * 2)) % 9) - 4) * 0.015;
      const jz = (((h >> (p * 2 + 3)) % 9) - 4) * 0.015;
      const sc = 0.85 + ((h >> (p + 5)) % 5) * 0.1;
      pPos.set(pos.x + (ox + jx) * HEX_SIZE, pos.y + 2.5, pos.z + (oz + jz) * HEX_SIZE);
      pQuat.setFromAxisAngle(up, ((h + p * 53) % 6) * (Math.PI / 3));
      pScl.set(sc * 1.35, sc * 0.42, sc * 1.0);
      matrix.compose(pPos, pQuat, pScl);
      fogPuffMesh.setMatrixAt(pi++, matrix);
    }
  }
  fogPuffMesh.instanceMatrix.needsUpdate = true;
  terrainGroup.add(fogPuffMesh);
}

/** Civ V-style subtle hex grid: very faint white lines on revealed tile edges.
 *  Visible only when showStructure is true (layer toggle). Low LOD thins it further. */
function rebuildHexGrid(state: GameState, visible: boolean, lod: 'low' | 'medium' | 'high'): void {
  const tiles = Array.from(state.world.tiles.values());
  const sig = `${visible}:${lod}:${tiles.filter((t) => t.revealed).length}`;
  if (sig === hexGridSignature && hexGridLines) return;
  hexGridSignature = sig;

  if (hexGridLines) {
    terrainGroup.remove(hexGridLines);
    hexGridLines.geometry.dispose();
    (hexGridLines.material as LineBasicMaterial).dispose();
    hexGridLines = null;
  }
  if (!visible) return;

  // Civ V grid = actual hex outlines. The old implementation pushed
  // center-to-center segments — a triangular lattice crossing every tile
  // face, which read as seams on flat ocean. Draw each tile's real edges
  // instead, deduped so interior edges render once.
  const segments: number[] = [];
  const drawn = new Set<string>();
  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));

  for (const tile of tiles) {
    if (!tile.revealed) continue;
    const elev = terrainElevation(tile.terrain);
    const center = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    for (let d = 0; d < 6; d++) {
      const nCoord = {
        q: tile.coord.q + AXIAL_DIRECTIONS[d]!.q,
        r: tile.coord.r + AXIAL_DIRECTIONS[d]!.r,
      };
      const nKey = tileKey(nCoord);
      const selfKey = tileKey(tile.coord);
      const ek = selfKey < nKey ? `${selfKey}|${nKey}` : `${nKey}|${selfKey}`;
      if (drawn.has(ek)) continue;
      drawn.add(ek);
      const n = getTile(nCoord);
      // Open sea reads as one continuous surface in Civ V — drawing the
      // grid there was the strongest "tiled jelly" cue on the ocean. Keep
      // the grid on land and along the coastline.
      if (tile.terrain === 'ocean' && (!n || n.terrain === 'ocean')) continue;
      // Lines sit on the higher tile's top so steps don't bury them.
      const nElev = n ? terrainElevation(n.terrain) : elev;
      const y = Math.max(elev, nElev) * TILE_HEIGHT + 1.5;
      const e = DIR_TO_EDGE[d]!;
      const a1 = hexCornerAngle3D(e);
      const a2 = hexCornerAngle3D((e + 1) % 6);
      segments.push(
        center.x + HEX_SIZE * Math.cos(a1),
        y,
        center.z + HEX_SIZE * Math.sin(a1),
        center.x + HEX_SIZE * Math.cos(a2),
        y,
        center.z + HEX_SIZE * Math.sin(a2),
      );
    }
  }

  if (segments.length === 0) return;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const mat = new LineBasicMaterial({
    // Warm-dark groove, not cold white. At <5% white the grid read as nothing
    // (or cold speckle) over warm terrain; a faint earth-dark line reads as a
    // recessed seam UNDER the paint — Civ V's lattice that ties tiles together.
    color: 0x3a2f22,
    transparent: true,
    opacity: lod === 'high' ? 0.1 : lod === 'medium' ? 0.07 : 0.035,
    linewidth: 1,
  });
  hexGridLines = new LineSegments(geom, mat);
  terrainGroup.add(hexGridLines);
}

function rebuildTerrainMesh(state: GameState, fogEnabled: boolean, picker: HexPicker): void {
  const tiles = Array.from(state.world.tiles.values());
  const signature = `${tiles.length}:${tiles.map((t) => tileKey(t.coord)).join(',')}`;
  if (signature === tileCountSignature && terrainMesh) {
    tiles.forEach((tile, i) => {
      terrainMesh!.setColorAt(i, instanceColorForTile(tile, fogEnabled));
    });
    if (terrainMesh.instanceColor) terrainMesh.instanceColor.needsUpdate = true;
    // P5: Update city colors for territory fill tint (territory may have changed)
    const cityColorAttr = terrainMesh.geometry.getAttribute('instanceCityColor') as
      | InstancedBufferAttribute
      | undefined;
    if (cityColorAttr) {
      const tileCityColor = new Map<string, [number, number, number]>();
      for (const city of state.world.cities) {
        const c = city.color;
        if (!c) continue;
        for (const coord of city.territory) tileCityColor.set(tileKey(coord), c);
        tileCityColor.set(tileKey(city.coord), c);
      }
      tiles.forEach((tile, i) => {
        const cc = tileCityColor.get(tileKey(tile.coord));
        if (cc) {
          cityColorAttr.array[i * 3] = cc[0];
          cityColorAttr.array[i * 3 + 1] = cc[1];
          cityColorAttr.array[i * 3 + 2] = cc[2];
        } else {
          cityColorAttr.array[i * 3] = 1;
          cityColorAttr.array[i * 3 + 1] = 1;
          cityColorAttr.array[i * 3 + 2] = 1;
        }
      });
      cityColorAttr.needsUpdate = true;
    }
    rebuildFogCover(state);
    return;
  }
  tileCountSignature = signature;

  if (terrainMesh) {
    terrainGroup.remove(terrainMesh);
    terrainMesh.dispose();
    terrainMesh = null;
  }

  if (
    !terrainMaterial ||
    !!(terrainMaterial.userData as { atlasBound?: boolean }).atlasBound !==
      !!loadedTerrainAtlas?.texture
  ) {
    if (terrainMaterial) terrainMaterial.dispose();
    terrainMaterial = createTerrainMaterial({
      terrainAtlas: loadedTerrainAtlas?.texture ?? null,
      normalAtlas: loadedTerrainAtlas?.normalTexture ?? null,
      roughnessAtlas: loadedTerrainAtlas?.roughnessTexture ?? null,
    });
    (terrainMaterial.userData as { atlasBound?: boolean }).atlasBound =
      !!loadedTerrainAtlas?.texture;
  }
  // Clone shared geometry so we can safely attach an instanceTerrain attribute
  const clonedGeom = sharedHexGeometry.clone();
  terrainMesh = new InstancedMesh(clonedGeom, terrainMaterial, tiles.length);
  terrainMesh.receiveShadow = true;
  terrainMesh.castShadow = false;

  const terrainIndices = new Float32Array(tiles.length);
  const neighborIndices = new Float32Array(tiles.length);
  const coastMasks = new Float32Array(tiles.length);
  const sideCullMasks = new Float32Array(tiles.length);
  const oceanDepths = new Float32Array(tiles.length);
  const cityColors = new Float32Array(tiles.length * 3);
  const instanceEntries: Array<{ instanceId: number; coord: Axial }> = [];
  const matrix = new Matrix4();

  const getTile = (key: string) => state.world.tiles.get(key);

  // Ocean depth: BFS hops from the nearest coastal water tile, normalized to
  // 0..1 at 3 hops. Drives the Civ V shallow-turquoise → deep-blue gradient
  // (and the specular falloff) in the terrain shader.
  const oceanHops = new Map<string, number>();
  {
    let frontier: Axial[] = [];
    for (const tile of tiles) {
      if (tile.terrain !== 'ocean') continue;
      const coastal = AXIAL_DIRECTIONS.some((d) => {
        const n = getTile(tileKey({ q: tile.coord.q + d.q, r: tile.coord.r + d.r }));
        return n !== undefined && n.terrain !== 'ocean';
      });
      if (coastal) {
        oceanHops.set(tileKey(tile.coord), 0);
        frontier.push(tile.coord);
      }
    }
    while (frontier.length > 0) {
      const next: Axial[] = [];
      for (const c of frontier) {
        const hops = oceanHops.get(tileKey(c))!;
        for (const d of AXIAL_DIRECTIONS) {
          const nc = { q: c.q + d.q, r: c.r + d.r };
          const nk = tileKey(nc);
          const n = getTile(nk);
          if (!n || n.terrain !== 'ocean' || oceanHops.has(nk)) continue;
          oceanHops.set(nk, hops + 1);
          next.push(nc);
        }
      }
      frontier = next;
    }
  }

  // Build tileKey → city color map for territory fill tint (P5)
  const tileCityColor = new Map<string, [number, number, number]>();
  for (const city of state.world.cities) {
    const c = city.color;
    if (!c) continue;
    for (const coord of city.territory) {
      tileCityColor.set(tileKey(coord), c);
    }
    // City center tile
    tileCityColor.set(tileKey(city.coord), c);
  }

  tiles.forEach((tile, i) => {
    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    matrix.makeTranslation(pos.x, pos.y, pos.z);
    terrainMesh!.setMatrixAt(i, matrix);
    terrainMesh!.setColorAt(i, instanceColorForTile(tile, fogEnabled));
    terrainIndices[i] = TERRAIN_ATLAS_INDEX[tile.terrain];
    neighborIndices[i] = dominantNeighborTerrain(tile, getTile);
    // 6-bit mask (AXIAL_DIRECTIONS order) of edges where ocean meets land —
    // drives the Civ V shoreline foam ring in terrainShader.ts. Both sides
    // of the boundary get their bit so the foam straddles the shared edge.
    let mask = 0;
    const selfOcean = tile.terrain === 'ocean';
    AXIAL_DIRECTIONS.forEach((d, k) => {
      const n = getTile(tileKey({ q: tile.coord.q + d.q, r: tile.coord.r + d.r }));
      if (n && (n.terrain === 'ocean') !== selfOcean) mask |= 1 << k;
    });
    coastMasks[i] = mask;
    // Cull side faces where a neighbor shares the same elevation step.
    let sideCull = 0;
    AXIAL_DIRECTIONS.forEach((d, k) => {
      const n = getTile(tileKey({ q: tile.coord.q + d.q, r: tile.coord.r + d.r }));
      if (n && terrainElevation(n.terrain) === elev) sideCull |= 1 << k;
    });
    sideCullMasks[i] = sideCull;
    // Average the integer BFS hop count with the ocean neighbors': raw
    // per-tile hops render as hex-shaped depth bands on the open sea;
    // fractional averages read as one continuous deep→shallow gradient.
    if (tile.terrain === 'ocean') {
      let sum = oceanHops.get(tileKey(tile.coord)) ?? 3;
      let cnt = 1;
      for (const d of AXIAL_DIRECTIONS) {
        const nk = tileKey({ q: tile.coord.q + d.q, r: tile.coord.r + d.r });
        const n = getTile(nk);
        if (n?.terrain === 'ocean') {
          sum += oceanHops.get(nk) ?? 3;
          cnt++;
        }
      }
      oceanDepths[i] = Math.min(1, sum / cnt / 3);
    } else {
      oceanDepths[i] = 0;
    }
    instanceEntries.push({ instanceId: i, coord: tile.coord });
    // P5: Territory fill tint — look up city color for this tile
    const cc = tileCityColor.get(tileKey(tile.coord));
    if (cc) {
      cityColors[i * 3] = cc[0];
      cityColors[i * 3 + 1] = cc[1];
      cityColors[i * 3 + 2] = cc[2];
    } else {
      cityColors[i * 3] = 1;
      cityColors[i * 3 + 1] = 1;
      cityColors[i * 3 + 2] = 1;
    }
  });

  terrainMesh.geometry.setAttribute(
    'instanceTerrain',
    new InstancedBufferAttribute(terrainIndices, 1),
  );
  terrainMesh.geometry.setAttribute(
    'instanceNeighborTerrain',
    new InstancedBufferAttribute(neighborIndices, 1),
  );
  terrainMesh.geometry.setAttribute(
    'instanceCoastMask',
    new InstancedBufferAttribute(coastMasks, 1),
  );
  terrainMesh.geometry.setAttribute(
    'instanceSideCullMask',
    new InstancedBufferAttribute(sideCullMasks, 1),
  );
  terrainMesh.geometry.setAttribute(
    'instanceOceanDepth',
    new InstancedBufferAttribute(oceanDepths, 1),
  );
  terrainMesh.geometry.setAttribute(
    'instanceCityColor',
    new InstancedBufferAttribute(cityColors, 3),
  );
  terrainMesh.frustumCulled = false;
  terrainMesh.instanceMatrix.needsUpdate = true;
  if (terrainMesh.instanceColor) terrainMesh.instanceColor.needsUpdate = true;
  terrainGroup.add(terrainMesh);
  picker.setInstanceMap(instanceEntries);
  rebuildFogCover(state);
}

function ensureTerrainAtlasLoad(): void {
  if (atlasLoadStarted) return;
  atlasLoadStarted = true;
  loadTerrainAtlas().then((atlas) => {
    loadedTerrainAtlas = atlas;
    if (atlas) {
      // Try hot-update if shader already compiled
      if (terrainMaterial) {
        updateTerrainShaderAtlas(
          terrainMaterial,
          atlas.texture,
          atlas.normalTexture,
          atlas.roughnessTexture,
        );
      }
      // Always dispose + null so the next rebuild creates a fresh material via
      // createTerrainMaterial({terrainAtlas: atlas.texture, ...}) — this avoids
      // the race where atlas loads before onBeforeCompile fires for the first time.
      if (terrainMaterial) {
        terrainMaterial.dispose();
        terrainMaterial = null;
      }
    }
    // Force rebuild on next updateHexWorldScene by clearing the signature.
    // Also null the mesh so rebuildTerrainMesh can't early-return on the
    // stale untextured mesh — it must recreate with the now-loaded atlas.
    tileCountSignature = '';
    if (terrainMesh) {
      terrainGroup.remove(terrainMesh);
      terrainMesh.dispose();
      terrainMesh = null;
    }
  });
}

export function getTerrainMesh(): InstancedMesh | null {
  return terrainMesh;
}

/** True once the terrain texture atlas finished loading. Participates in the
 *  ThreeMapRenderer dirty signature: the atlas arriving must force a rebuild
 *  (it resets tileCountSignature), otherwise the world stays untextured until
 *  an unrelated state change. Also used by the golden-capture script to wait
 *  for the final visual state. */
export function isTerrainAtlasReady(): boolean {
  return loadedTerrainAtlas !== null;
}

export function updateHexWorldScene(
  scene: Scene,
  state: GameState,
  opts: HexSceneRenderOptions,
  picker: HexPicker,
  stateDirty: boolean = true,
): void {
  if (terrainMaterial) updateTerrainShaderTime(terrainMaterial, opts.animTime);

  if (sunLight) {
    const t = opts.animTime * 0.04;
    const warmth = 0.88 + 0.12 * Math.sin(t);
    // Golden-hour bias: green and especially blue sit lower than before
    // (0.97/0.90) so the low sun reads late-afternoon gold, not noon white.
    // At strategic zoom (lod low/medium) the bias deepens — the world map
    // bathes in late gold like Civ V's continent view — and relaxes when
    // zoomed in so close-up materials stay true to the atlas palette.
    const lodBias = opts.lod === 'low' ? 0.06 : opts.lod === 'medium' ? 0.03 : 0;
    sunLight.color.setRGB(1, (0.94 - lodBias) * warmth, (0.8 - lodBias * 2) * warmth);
    sunLight.intensity = 1.3 + 0.08 * Math.sin(t * 0.6);
  }

  // Shoreline: geometry scan only on dirty frames (its inputs — terrain +
  // revealed — are covered by the world signature); the pulse animation
  // runs every frame, allocation-free. Foam is purely state-driven.
  rebuildShorelineRings(state, opts.animTime, stateDirty);
  animateTerritoryPulse(opts.animTime);
  if (stateDirty) rebuildFoam(state, opts.animTime);
  animateFoamPulse(opts.animTime);
  // Per-frame unit animations (spawn/despawn tweens, idle pulse, walking
  // hop, movement tween). Runs every frame regardless of dirty state.
  // The onTileStep callback triggers a yellow tile flash when a unit
  // steps onto a new tile during the movement tween.
  tickUnits(opts.animTime, opts.dt, (q, r, elev) => flashTile(q, r, elev));
  // Per-frame city growth animations (spire rise tween). Invalidates the
  // city signature when a tween is in progress so the next dirty frame
  // rebuilds with updated spire heights.
  tickCities(opts.dt);
  // Per-frame tile flash fade-out. Frozen dt=0 keeps goldens stable.
  tickTileFlash(opts.dt);
  // Per-frame fog transition fade-out + particle animation.
  tickFogTransition(opts.dt);

  // State-driven rebuilds: only when the world actually changed. These
  // are the heavy ones (terrain mesh, ground plane, territory lines,
  // city clusters, units, labels). Skipping them on idle frames is
  // the entire point of the dirty-flag.
  // Exception: if the terrain atlas just loaded (terrainMesh was nulled
  // by ensureTerrainAtlasLoad), we must rebuild even on an idle frame.
  const atlasJustLoaded = !terrainMesh && loadedTerrainAtlas !== null;
  if (!stateDirty && !atlasJustLoaded) return;
  rebuildTerrainMesh(state, opts.fogEnabled, picker);
  rebuildGround(state);
  // Detect newly-revealed tiles and start fog fade-out transitions +
  // city discovery particle bursts. Must run AFTER rebuildTerrainMesh
  // (which calls rebuildFogCover) so the main fog cover is already updated.
  updateFogTransition(Array.from(state.world.tiles.values()), (key) => state.world.tiles.get(key));
  rebuildTerritoryLines(state, opts.animTime, opts.showStructure, opts.lod);

  setDecorVisible(opts.showStructure || opts.showOps);
  rebuildHexGrid(state, opts.showStructure, opts.lod);
  rebuildTileDecor(Array.from(state.world.tiles.values()), opts.lod, state);
  // Mountain silhouettes are terrain, not toggleable decor — always visible.
  rebuildMountainProps(Array.from(state.world.tiles.values()));
  rebuildForestProps(Array.from(state.world.tiles.values()));
  rebuildResourceProps(Array.from(state.world.tiles.values()));
  rebuildRivers(state.world.tiles);

  setCitiesVisible(opts.showStructure);
  rebuildCityClusters(state.world.cities, (key) => state.world.tiles.get(key), opts.lod);
  rebuildCityProps(state.world.cities, (key) => state.world.tiles.get(key), opts.lod);
  rebuildTileYields(Array.from(state.world.tiles.values()), opts.lod, opts.showStructure);

  setUnitsVisible(true);
  rebuildUnits(state.world.units, (key) => state.world.tiles.get(key));

  // Wonder 3D props (bibliotheca temple / institutum laboratorium). Layer
  // gating mirrors the 2D canvas: bibliotheca under knowledge, institutum
  // under labs. Both default-ON so the wonders stay visible when only the
  // `structure` layer is enabled.
  setWonderVisible('bibliotheca', opts.showKnowledge);
  setWonderVisible('institutum', opts.showLabs);
  setWonderVisible('generic', opts.showStructure);
  rebuildWonderProps(Array.from(state.world.tiles.values()));

  rebuildMapLabels(scene, state, opts.lod, opts.showLabels, (key) => state.world.tiles.get(key));
}

export function disposeHexWorldScene(scene: Scene): void {
  clearTileDecor();
  clearMountainProps();
  clearForestProps();
  clearCityProps();
  clearResourceProps();
  clearTileYields();
  clearRivers();
  clearWonderProps();
  disposeSkyDome();
  clearCityClusters();
  clearUnits();
  clearTileFlash();
  clearTilePopup();
  clearFogTransition();
  if (terrainMesh) {
    terrainGroup.remove(terrainMesh);
    terrainMesh.dispose();
    terrainMesh = null;
  }
  if (fogCoverMesh) {
    terrainGroup.remove(fogCoverMesh);
    fogCoverMesh.dispose();
    fogCoverMesh = null;
  }
  if (fogPuffMesh) {
    terrainGroup.remove(fogPuffMesh);
    fogPuffMesh.geometry.dispose();
    (fogPuffMesh.material as MeshLambertMaterial).dispose();
    fogPuffMesh = null;
  }
  clearTerritoryLines();
  if (shorelineRings) {
    terrainGroup.remove(shorelineRings);
    shorelineRings.geometry.dispose();
    (shorelineRings.material as LineBasicMaterial).dispose();
    shorelineRings = null;
  }
  shorelineBase = null;
  if (foamMesh) {
    terrainGroup.remove(foamMesh);
    foamMesh.geometry.dispose();
    (foamMesh.material as MeshLambertMaterial).dispose();
    foamMesh = null;
  }
  if (hexGridLines) {
    terrainGroup.remove(hexGridLines);
    hexGridLines.geometry.dispose();
    (hexGridLines.material as LineBasicMaterial).dispose();
    hexGridLines = null;
  }
  // Reset rebuild signatures: a disposed scene must rebuild everything on
  // recreate, even when the world state (and thus each signature) is the
  // same — otherwise toggling render modes leaves ocean/fog/ground empty.
  shorelineSignature = '';
  foamSignature = '';
  hexGridSignature = '';
  fogCoverSignature = '';
  groundSignature = '';
  tileCountSignature = '';
  territorySignature = '';
  if (groundMeshRef) {
    terrainGroup.remove(groundMeshRef);
    disposeGroundMesh();
    groundMeshRef = null;
  }
  if (terrainMaterial) {
    terrainMaterial.dispose();
    terrainMaterial = null;
  }
  tileCountSignature = '';
  fogCoverSignature = '';
  foamSignature = '';
  groundSignature = '';
  scene.clear();
}
