// ─── Three.js scene: terrain instancing, lights, territory, sub-groups ─────
import {
  AmbientLight,
  DirectionalLight,
  FogExp2,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  LineBasicMaterial,
  Scene,
  BufferGeometry,
  Float32BufferAttribute,
  Color,
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
let territoryLines: LineSegments | null = null;
let tileCountSignature = '';

export function createHexWorldScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x050505);
  scene.fog = new FogExp2(0x050505, 0.0008);

  scene.add(new AmbientLight(0xc8c0b0, 0.55));
  const sun = new DirectionalLight(0xfff5e0, 0.85);
  sun.position.set(-120, 180, 80);
  scene.add(sun);

  scene.add(terrainGroup);
  scene.add(getTileDecorGroup());
  scene.add(getCityGroup());
  scene.add(getUnitGroup());

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

function rebuildTerritoryLines(state: GameState, animTime: number, visible: boolean): void {
  if (territoryLines) {
    terrainGroup.remove(territoryLines);
    territoryLines.geometry.dispose();
    (territoryLines.material as LineBasicMaterial).dispose();
    territoryLines = null;
  }
  if (!visible) return;

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
        if (inTerritory.has(nKey)) continue;
        const [x1, y1, z1] = hexEdgeMidpoint(coord, d, elev);
        const [x2, y2, z2] = hexEdgeMidpoint(coord, (d + 1) % 6, elev);
        segments.push(x1, y1, z1, x2, y2, z2);
      }
    }
  }

  if (segments.length === 0) return;

  const pulse = 0.75 + 0.25 * Math.sin(animTime * 3);
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const mat = new LineBasicMaterial({
    color: new Color(0xc8a84b).multiplyScalar(pulse),
  });
  territoryLines = new LineSegments(geom, mat);
  terrainGroup.add(territoryLines);
}

function rebuildTerrainMesh(state: GameState, fogEnabled: boolean, picker: HexPicker): void {
  const tiles = Array.from(state.world.tiles.values());
  const signature = `${tiles.length}:${tiles.map((t) => tileKey(t.coord)).join(',')}`;
  if (signature === tileCountSignature && terrainMesh) {
    // Update colors only (fog may change every frame)
    tiles.forEach((tile, i) => {
      terrainMesh!.setColorAt(i, instanceColorForTile(tile, fogEnabled));
    });
    if (terrainMesh.instanceColor) terrainMesh.instanceColor.needsUpdate = true;
    return;
  }
  tileCountSignature = signature;

  if (terrainMesh) {
    terrainGroup.remove(terrainMesh);
    terrainMesh.dispose();
    terrainMesh = null;
  }

  const mat = new MeshLambertMaterial({ vertexColors: true });
  terrainMesh = new InstancedMesh(sharedHexGeometry, mat, tiles.length);

  const instanceEntries: Array<{ instanceId: number; coord: Axial }> = [];
  const matrix = new Matrix4();

  tiles.forEach((tile, i) => {
    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    matrix.makeTranslation(pos.x, pos.y, pos.z);
    terrainMesh!.setMatrixAt(i, matrix);
    terrainMesh!.setColorAt(i, instanceColorForTile(tile, fogEnabled));
    instanceEntries.push({ instanceId: i, coord: tile.coord });
  });

  terrainMesh.frustumCulled = false;
  terrainMesh.instanceMatrix.needsUpdate = true;
  if (terrainMesh.instanceColor) terrainMesh.instanceColor.needsUpdate = true;
  terrainGroup.add(terrainMesh);
  picker.setInstanceMap(instanceEntries);
}

export function getTerrainMesh(): InstancedMesh | null {
  return terrainMesh;
}

export function updateHexWorldScene(
  _scene: Scene,
  state: GameState,
  opts: HexSceneRenderOptions,
  picker: HexPicker,
): void {
  rebuildTerrainMesh(state, opts.fogEnabled, picker);

  rebuildTerritoryLines(state, opts.animTime, opts.showStructure);

  setDecorVisible(opts.showStructure || opts.showOps);
  rebuildTileDecor(Array.from(state.world.tiles.values()), opts.lod);

  setCitiesVisible(opts.showStructure);
  rebuildCityClusters(state.world.cities, (key) => state.world.tiles.get(key), opts.lod);

  setUnitsVisible(true);
  rebuildUnits(state.world.units, (key) => state.world.tiles.get(key));
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
  if (territoryLines) {
    terrainGroup.remove(territoryLines);
    territoryLines.geometry.dispose();
    (territoryLines.material as LineBasicMaterial).dispose();
    territoryLines = null;
  }
  tileCountSignature = '';
  scene.clear();
}
