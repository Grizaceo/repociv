// ─── Three.js scene: terrain instancing, lights, territory, sub-groups ─────
import {
  AmbientLight,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  MeshLambertMaterial,
  LineBasicMaterial,
  Scene,
  BufferGeometry,
  Float32BufferAttribute,
  Color,
  SphereGeometry,
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
} from './CityCluster3D.ts';
import {
  getUnitGroup,
  rebuildUnits,
  setUnitsVisible,
  clearUnits,
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
import { getTileYieldsGroup, rebuildTileYields, clearTileYields } from './TileYields3D.ts';
import { getRiverGroup, rebuildRivers, clearRivers } from './Rivers3D.ts';
import { createSkyDome, disposeSkyDome } from './SkyDome3D.ts';

export interface HexSceneRenderOptions {
  fogEnabled: boolean;
  lod: 'low' | 'medium' | 'high';
  showStructure: boolean;
  showOps: boolean;
  showLabels: boolean;
  animTime: number;
}

const terrainGroup = new Group();
terrainGroup.name = 'terrain';

let terrainMesh: InstancedMesh | null = null;
let fogCoverMesh: InstancedMesh | null = null;
let fogCoverSignature = '';
let territoryInner: LineSegments | null = null;
let territoryCapitalInner: LineSegments | null = null;
let territoryGlow: LineSegments | null = null;
let territoryLod: 'low' | 'medium' | 'high' = 'medium';
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

export function createHexWorldScene(): Scene {
  const scene = new Scene();
  scene.background = SKY_TOP.clone();
  scene.fog = new FogExp2(SKY_HORIZON.getHex(), FOG_DENSITY);
  // Gradient sky dome (zenith blue → warm horizon haze); the flat
  // background colour stays underneath as fallback while shaders compile.
  scene.add(createSkyDome());

  // Civ V-style warm afternoon lighting — golden sun, warm ambient
  scene.add(new AmbientLight(0xdacfb6, 0.55));
  scene.add(new HemisphereLight(0xb0d8f0, 0x7aaa60, 0.45));
  sunLight = new DirectionalLight(0xffeecb, 1.05);
  sunLight.position.set(-100, 200, 60);
  scene.add(sunLight);
  // Soft fill light from opposite side to reduce harsh shadows
  const fillLight = new DirectionalLight(0xd0e8ff, 0.18);
  fillLight.position.set(80, 60, -100);
  scene.add(fillLight);

  scene.add(terrainGroup);
  scene.add(getRiverGroup());
  scene.add(getTileDecorGroup());
  scene.add(getMountainPropsGroup());
  scene.add(getForestPropsGroup());
  scene.add(getCityGroup());
  scene.add(getCityPropsGroup());
  scene.add(getTileYieldsGroup());
  scene.add(getUnitGroup());
  scene.add(getLabelGroup());

  ensureTerrainAtlasLoad();
  // Props arriving flips areMountainPropsReady(), which participates in the
  // ThreeMapRenderer dirty signature — the next frame rebuilds decor (cones
  // out) and instances the glTF peaks.
  ensureMountainPropsLoad();
  ensureForestPropsLoad();
  ensureCityPropsLoad();
  ensureUnitPropsLoad();

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
  for (const line of [territoryInner, territoryCapitalInner, territoryGlow]) {
    if (!line) continue;
    terrainGroup.remove(line);
    line.geometry.dispose();
    (line.material as LineBasicMaterial).dispose();
  }
  territoryInner = null;
  territoryCapitalInner = null;
  territoryGlow = null;
}

function animateTerritoryPulse(animTime: number): void {
  if (!territoryInner && !territoryCapitalInner && !territoryGlow) return;
  const pulse = 0.90 + 0.06 * Math.sin(animTime * 2.2);
  if (territoryInner) {
    const mat = territoryInner.material as LineBasicMaterial;
    mat.opacity = (territoryLod === 'high' ? 0.45 : 0.38) * pulse;
  }
  if (territoryCapitalInner) {
    const mat = territoryCapitalInner.material as LineBasicMaterial;
    mat.opacity = (territoryLod === 'high' ? 0.50 : 0.42) * pulse;
  }
  if (territoryGlow) {
    const mat = territoryGlow.material as LineBasicMaterial;
    mat.opacity = 0.12 * pulse;
  }
}

function rebuildTerritoryLines(
  state: GameState,
  _animTime: number,
  visible: boolean,
  lod: 'low' | 'medium' | 'high',
): void {
  clearTerritoryLines();
  if (!visible) return;
  territoryLod = lod;

  const allTerritory = new Set<string>();
  for (const city of state.world.cities) {
    for (const c of city.territory) allTerritory.add(tileKey(c));
  }

  const normalInner: number[] = [];
  const capitalInner: number[] = [];
  const glowSegments: number[] = [];
  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));

  for (const city of state.world.cities) {
    if (city.territory.length === 0) continue;
    const inTerritory = new Set(city.territory.map((c) => tileKey(c)));
    const innerSegments = city.isCapital ? capitalInner : normalInner;

    for (const coord of city.territory) {
      const tile = getTile(coord);
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      for (let d = 0; d < 6; d++) {
        const neighbor = {
          q: coord.q + AXIAL_DIRECTIONS[d]!.q,
          r: coord.r + AXIAL_DIRECTIONS[d]!.r,
        };
        const nKey = tileKey(neighbor);
        if (lod === 'low') {
          if (allTerritory.has(nKey)) continue;
        } else if (inTerritory.has(nKey)) {
          continue;
        }
        const e = DIR_TO_EDGE[d]!;
        const center = axialToWorld3D(coord.q, coord.r, elev);
        const a1 = hexCornerAngle3D(e);
        const a2 = hexCornerAngle3D((e + 1) % 6);
        const x1 = center.x + HEX_SIZE * Math.cos(a1);
        const z1 = center.z + HEX_SIZE * Math.sin(a1);
        const x2 = center.x + HEX_SIZE * Math.cos(a2);
        const z2 = center.z + HEX_SIZE * Math.sin(a2);
        const y = center.y + 1.5;
        innerSegments.push(x1, y, z1, x2, y, z2);
        const mx = (x1 + x2) * 0.5;
        const mz = (z1 + z2) * 0.5;
        const dx = mx - center.x;
        const dz = mz - center.z;
        const len = Math.hypot(dx, dz) || 1;
        const push = HEX_SIZE * 0.02;
        glowSegments.push(
          x1 + (dx / len) * push, y, z1 + (dz / len) * push,
          x2 + (dx / len) * push, y, z2 + (dz / len) * push,
        );
      }
    }
  }

  if (normalInner.length === 0 && capitalInner.length === 0) return;

  if (normalInner.length > 0) {
    const innerGeom = new BufferGeometry();
    innerGeom.setAttribute('position', new Float32BufferAttribute(normalInner, 3));
    territoryInner = new LineSegments(
      innerGeom,
      new LineBasicMaterial({
        color: new Color(0xb99654),
        transparent: true,
        opacity: lod === 'high' ? 0.45 : 0.38,
        linewidth: 2,
      }),
    );
    terrainGroup.add(territoryInner);
  }
  if (capitalInner.length > 0) {
    const capGeom = new BufferGeometry();
    capGeom.setAttribute('position', new Float32BufferAttribute(capitalInner, 3));
    territoryCapitalInner = new LineSegments(
      capGeom,
      new LineBasicMaterial({
        color: new Color(0xf0d060),
        transparent: true,
        opacity: lod === 'high' ? 0.50 : 0.42,
        linewidth: 2,
      }),
    );
    terrainGroup.add(territoryCapitalInner);
  }

  const glowGeom = new BufferGeometry();
  glowGeom.setAttribute('position', new Float32BufferAttribute(glowSegments, 3));
  territoryGlow = new LineSegments(
    glowGeom,
    new LineBasicMaterial({
      color: new Color(0xf0d060),
      transparent: true,
      opacity: 0.12,
      linewidth: 3,
    }),
  );
  terrainGroup.add(territoryGlow);
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
  const foamPositions: Array<{ x: number; y: number; z: number }> = [];

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
      foamPositions.push({ x: mx, y: center.y + 1.0, z: mz });
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
  foamPositions.forEach((pos, i) => {
    m.makeTranslation(pos.x, pos.y, pos.z);
    foamMesh!.setMatrixAt(i, m);
  });
  foamMesh.instanceMatrix.needsUpdate = true;
  terrainGroup.add(foamMesh);
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
      // Lines sit on the higher tile's top so steps don't bury them.
      const nElev = n ? terrainElevation(n.terrain) : elev;
      const y = Math.max(elev, nElev) * TILE_HEIGHT + 1.5;
      const e = DIR_TO_EDGE[d]!;
      const a1 = hexCornerAngle3D(e);
      const a2 = hexCornerAngle3D((e + 1) % 6);
      segments.push(
        center.x + HEX_SIZE * Math.cos(a1), y, center.z + HEX_SIZE * Math.sin(a1),
        center.x + HEX_SIZE * Math.cos(a2), y, center.z + HEX_SIZE * Math.sin(a2),
      );
    }
  }

  if (segments.length === 0) return;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const mat = new LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: lod === 'high' ? 0.045 : lod === 'medium' ? 0.030 : 0.015,
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
    rebuildFogCover(state);
    return;
  }
  tileCountSignature = signature;

  if (terrainMesh) {
    terrainGroup.remove(terrainMesh);
    terrainMesh.dispose();
    terrainMesh = null;
  }

  if (!terrainMaterial) terrainMaterial = createTerrainMaterial({
    terrainAtlas: loadedTerrainAtlas?.texture ?? null,
    normalAtlas: loadedTerrainAtlas?.normalTexture ?? null,
    roughnessAtlas: loadedTerrainAtlas?.roughnessTexture ?? null,
  });
  // Clone shared geometry so we can safely attach an instanceTerrain attribute
  const clonedGeom = sharedHexGeometry.clone();
  terrainMesh = new InstancedMesh(clonedGeom, terrainMaterial, tiles.length);

  const terrainIndices = new Float32Array(tiles.length);
  const neighborIndices = new Float32Array(tiles.length);
  const coastMasks = new Float32Array(tiles.length);
  const oceanDepths = new Float32Array(tiles.length);
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
    oceanDepths[i] =
      tile.terrain === 'ocean'
        ? Math.min(1, (oceanHops.get(tileKey(tile.coord)) ?? 3) / 3)
        : 0;
    instanceEntries.push({ instanceId: i, coord: tile.coord });
  });

  terrainMesh.geometry.setAttribute('instanceTerrain', new InstancedBufferAttribute(terrainIndices, 1));
  terrainMesh.geometry.setAttribute('instanceNeighborTerrain', new InstancedBufferAttribute(neighborIndices, 1));
  terrainMesh.geometry.setAttribute('instanceCoastMask', new InstancedBufferAttribute(coastMasks, 1));
  terrainMesh.geometry.setAttribute('instanceOceanDepth', new InstancedBufferAttribute(oceanDepths, 1));
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
        updateTerrainShaderAtlas(terrainMaterial, atlas.texture, atlas.normalTexture, atlas.roughnessTexture);
      }
      // Always dispose + null so the next rebuild creates a fresh material via
      // createTerrainMaterial({terrainAtlas: atlas.texture, ...}) — this avoids
      // the race where atlas loads before onBeforeCompile fires for the first time.
      if (terrainMaterial) {
        terrainMaterial.dispose();
        terrainMaterial = null;
      }
    }
    tileCountSignature = '';
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
    sunLight.color.setRGB(1, 0.94 * warmth, 0.80 * warmth);
    sunLight.intensity = 1.0 + 0.08 * Math.sin(t * 0.6);
    // Slow arc across the sky
    sunLight.position.set(
      -100 + 30 * Math.sin(t * 0.3),
      180 + 20 * Math.sin(t * 0.2),
      60 + 15 * Math.cos(t * 0.25),
    );
  }

  // Shoreline: geometry scan only on dirty frames (its inputs — terrain +
  // revealed — are covered by the world signature); the pulse animation
  // runs every frame, allocation-free. Foam is purely state-driven.
  rebuildShorelineRings(state, opts.animTime, stateDirty);
  animateTerritoryPulse(opts.animTime);
  if (stateDirty) rebuildFoam(state, opts.animTime);

  // State-driven rebuilds: only when the world actually changed. These
  // are the heavy ones (terrain mesh, ground plane, territory lines,
  // city clusters, units, labels). Skipping them on idle frames is
  // the entire point of the dirty-flag.
  if (!stateDirty) return;
  rebuildTerrainMesh(state, opts.fogEnabled, picker);
  rebuildGround(state);
  rebuildTerritoryLines(state, opts.animTime, opts.showStructure, opts.lod);

  setDecorVisible(opts.showStructure || opts.showOps);
  rebuildHexGrid(state, opts.showStructure, opts.lod);
  rebuildTileDecor(Array.from(state.world.tiles.values()), opts.lod, state);
  // Mountain silhouettes are terrain, not toggleable decor — always visible.
  rebuildMountainProps(Array.from(state.world.tiles.values()));
  rebuildForestProps(Array.from(state.world.tiles.values()));
  rebuildRivers(state.world.tiles);

  setCitiesVisible(opts.showStructure);
  rebuildCityClusters(state.world.cities, (key) => state.world.tiles.get(key), opts.lod);
  rebuildCityProps(state.world.cities, (key) => state.world.tiles.get(key), opts.lod);
  rebuildTileYields(Array.from(state.world.tiles.values()), opts.lod, opts.showStructure);

  setUnitsVisible(true);
  rebuildUnits(state.world.units, (key) => state.world.tiles.get(key));

  rebuildMapLabels(scene, state, opts.lod, opts.showLabels, (key) => state.world.tiles.get(key));
}

export function disposeHexWorldScene(scene: Scene): void {
  clearTileDecor();
  clearMountainProps();
  clearForestProps();
  clearCityProps();
  clearTileYields();
  clearRivers();
  disposeSkyDome();
  clearCityClusters();
  clearUnits();
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
  fogCoverSignature  = '';
  foamSignature      = '';
  groundSignature    = '';
  scene.clear();
}
