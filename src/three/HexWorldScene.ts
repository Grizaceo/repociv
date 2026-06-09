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
import { terrainElevation, hexCornerAngle } from '../isoHex.ts';
import { HEX_SIZE } from '../constants.ts';
import { sharedHexGeometry } from './hexGeometry.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
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
let territoryLines: LineSegments | null = null;
let shorelineRings: LineSegments | null = null;
let foamMesh: InstancedMesh | null = null;
let foamSignature = '';
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

  // Civ V-style warm afternoon lighting
  scene.add(new AmbientLight(0xd4cfc0, 0.55));
  scene.add(new HemisphereLight(0xb0d8f0, 0x7aaa60, 0.45));
  sunLight = new DirectionalLight(0xfff8e8, 1.05);
  sunLight.position.set(-100, 200, 60);
  scene.add(sunLight);
  // Soft fill light from opposite side to reduce harsh shadows
  const fillLight = new DirectionalLight(0xd0e8ff, 0.18);
  fillLight.position.set(80, 60, -100);
  scene.add(fillLight);

  scene.add(terrainGroup);
  scene.add(getTileDecorGroup());
  scene.add(getCityGroup());
  scene.add(getUnitGroup());
  scene.add(getLabelGroup());

  ensureTerrainAtlasLoad();

  return scene;
}

function hexEdgeMidpoint(
  coord: Axial,
  edgeIndex: number,
  elev: number,
): [number, number, number] {
  const center = axialToWorld3D(coord.q, coord.r, elev);
  const a = hexCornerAngle(edgeIndex);
  const b = hexCornerAngle((edgeIndex + 1) % 6);
  const x =
    center.x + (HEX_SIZE * Math.cos(a) + HEX_SIZE * Math.cos(b)) * 0.5;
  const z =
    center.z + (HEX_SIZE * Math.sin(a) + HEX_SIZE * Math.sin(b)) * 0.5;
  return [x, center.y + 1.5, z];
}

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

function rebuildTerritoryLines(
  state: GameState,
  animTime: number,
  visible: boolean,
  lod: 'low' | 'medium' | 'high',
): void {
  if (territoryLines) {
    terrainGroup.remove(territoryLines);
    territoryLines.geometry.dispose();
    (territoryLines.material as LineBasicMaterial).dispose();
    territoryLines = null;
  }
  if (!visible) return;

  const allTerritory = new Set<string>();
  for (const city of state.world.cities) {
    for (const c of city.territory) allTerritory.add(tileKey(c));
  }

  const segments: number[] = [];
  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));

  for (const city of state.world.cities) {
    if (city.territory.length === 0) continue;
    const inTerritory = new Set(city.territory.map((c) => tileKey(c)));

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
        const [x1, y1, z1] = hexEdgeMidpoint(coord, d, elev);
        const [x2, y2, z2] = hexEdgeMidpoint(coord, (d + 1) % 6, elev);
        segments.push(x1, y1, z1, x2, y2, z2);
      }
    }
  }

  if (segments.length === 0) return;

  const pulse = 0.90 + 0.06 * Math.sin(animTime * 2.2);
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const mat = new LineBasicMaterial({
    color: new Color(0xb99654).multiplyScalar(pulse),
    transparent: true,
    opacity: lod === 'high' ? 0.18 : 0.12,
    linewidth: 2,
  });
  territoryLines = new LineSegments(geom, mat);
  terrainGroup.add(territoryLines);
}

function rebuildShorelineRings(state: GameState, animTime: number): void {
  if (shorelineRings) {
    terrainGroup.remove(shorelineRings);
    shorelineRings.geometry.dispose();
    (shorelineRings.material as LineBasicMaterial).dispose();
    shorelineRings = null;
  }

  const segments: number[] = [];
  const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));
  const pulse = 0.88 + 0.08 * Math.sin(animTime * 2);

  for (const tile of state.world.tiles.values()) {
    if (tile.terrain !== 'ocean' || !tile.revealed) continue;
    const neighbors = AXIAL_DIRECTIONS.map((d) =>
      getTile({ q: tile.coord.q + d.q, r: tile.coord.r + d.r }),
    );
    if (!neighbors.some((n) => n && n.terrain !== 'ocean')) continue;

    const elev = terrainElevation(tile.terrain);
    const center = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    const r = HEX_SIZE * pulse * 0.82;
    for (let i = 0; i < 6; i++) {
      const a = hexCornerAngle(i);
      const b = hexCornerAngle((i + 1) % 6);
      segments.push(
        center.x + r * Math.cos(a),
        center.y + 1.2,
        center.z + r * Math.sin(a),
        center.x + r * Math.cos(b),
        center.y + 1.2,
        center.z + r * Math.sin(b),
      );
    }
  }

  if (segments.length === 0) return;

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const mat = new LineBasicMaterial({
    color: 0x96dcff,
    transparent: true,
    opacity: 0.35,
  });
  shorelineRings = new LineSegments(geom, mat);
  terrainGroup.add(shorelineRings);
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

      // Foam at edge midpoints
      const a = hexCornerAngle(i);
      const b = hexCornerAngle((i + 1) % 6);
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

  const mat = new MeshLambertMaterial({
    color: 0x0a0a14,
    transparent: true,
    opacity: 0.72,
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
  const instanceEntries: Array<{ instanceId: number; coord: Axial }> = [];
  const matrix = new Matrix4();

  const getTile = (key: string) => state.world.tiles.get(key);

  tiles.forEach((tile, i) => {
    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    matrix.makeTranslation(pos.x, pos.y, pos.z);
    terrainMesh!.setMatrixAt(i, matrix);
    terrainMesh!.setColorAt(i, instanceColorForTile(tile, fogEnabled));
    terrainIndices[i] = TERRAIN_ATLAS_INDEX[tile.terrain];
    neighborIndices[i] = dominantNeighborTerrain(tile, getTile);
    instanceEntries.push({ instanceId: i, coord: tile.coord });
  });

  terrainMesh.geometry.setAttribute('instanceTerrain', new InstancedBufferAttribute(terrainIndices, 1));
  terrainMesh.geometry.setAttribute('instanceNeighborTerrain', new InstancedBufferAttribute(neighborIndices, 1));
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

export function updateHexWorldScene(
  scene: Scene,
  state: GameState,
  opts: HexSceneRenderOptions,
  picker: HexPicker,
): void {
  if (terrainMaterial) updateTerrainShaderTime(terrainMaterial, opts.animTime);

  if (sunLight) {
    const t = opts.animTime * 0.04;
    const warmth = 0.88 + 0.12 * Math.sin(t);
    sunLight.color.setRGB(1, 0.97 * warmth, 0.90 * warmth);
    sunLight.intensity = 1.0 + 0.08 * Math.sin(t * 0.6);
    // Slow arc across the sky
    sunLight.position.set(
      -100 + 30 * Math.sin(t * 0.3),
      180 + 20 * Math.sin(t * 0.2),
      60 + 15 * Math.cos(t * 0.25),
    );
  }

  rebuildTerrainMesh(state, opts.fogEnabled, picker);
  rebuildGround(state);
  rebuildTerritoryLines(state, opts.animTime, opts.showStructure, opts.lod);
  rebuildShorelineRings(state, opts.animTime);
  rebuildFoam(state, opts.animTime);

  setDecorVisible(opts.showStructure || opts.showOps);
  rebuildTileDecor(Array.from(state.world.tiles.values()), opts.lod, state);

  setCitiesVisible(opts.showStructure);
  rebuildCityClusters(state.world.cities, (key) => state.world.tiles.get(key), opts.lod);

  setUnitsVisible(true);
  rebuildUnits(state.world.units, (key) => state.world.tiles.get(key));

  rebuildMapLabels(scene, state, opts.lod, opts.showLabels, (key) => state.world.tiles.get(key));
}

export function disposeHexWorldScene(scene: Scene): void {
  clearTileDecor();
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
  if (territoryLines) {
    terrainGroup.remove(territoryLines);
    territoryLines.geometry.dispose();
    (territoryLines.material as LineBasicMaterial).dispose();
    territoryLines = null;
  }
  if (shorelineRings) {
    terrainGroup.remove(shorelineRings);
    shorelineRings.geometry.dispose();
    (shorelineRings.material as LineBasicMaterial).dispose();
    shorelineRings = null;
  }
  if (foamMesh) {
    terrainGroup.remove(foamMesh);
    foamMesh.geometry.dispose();
    (foamMesh.material as MeshLambertMaterial).dispose();
    foamMesh = null;
  }
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
