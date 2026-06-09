// ─── Civ-style city clusters (low-poly boxes) ───────────────────────────────
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Color,
} from 'three';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const cityGroup = new Group();
cityGroup.name = 'cities';

let clusterMesh: InstancedMesh | null = null;
let capitalMesh: InstancedMesh | null = null;
let lastSignature = '';

export function getCityGroup(): Group {
  return cityGroup;
}

function citySignature(cities: City[]): string {
  return cities.map((c) => `${c.id}:${c.coord.q},${c.coord.r}:${c.isCapital ? 1 : 0}`).join('|');
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

export function rebuildCityClusters(
  cities: City[],
  getTile: (key: string) => Tile | undefined,
  lod: 'low' | 'medium' | 'high',
): void {
  const signature = `${lod}:${citySignature(cities)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  clearCityClusters();

  if (lod === 'low') {
    const dotGeom = new BoxGeometry(6, 6, 6);
    const dotMat = new MeshLambertMaterial({ color: new Color(0xc8a84b) });
    clusterMesh = new InstancedMesh(dotGeom, dotMat, cities.length);
    cities.forEach((city, i) => {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const pos = axialToWorld3D(city.coord.q, city.coord.r, elev);
      pos.y += 8;
      clusterMesh!.setMatrixAt(i, new Matrix4().makeTranslation(pos.x, pos.y, pos.z));
    });
    clusterMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(clusterMesh);
    return;
  }

  const normalCities = cities.filter((c) => !c.isCapital);
  const capitals = cities.filter((c) => c.isCapital);

  if (normalCities.length > 0) {
    const geom = new BoxGeometry(HEX_SIZE * 0.18, HEX_SIZE * 0.22, HEX_SIZE * 0.18);
    const mat = new MeshLambertMaterial({ color: new Color(0xb89050) });
    const count = normalCities.length * 4;
    clusterMesh = new InstancedMesh(geom, mat, count);
    let idx = 0;
    for (const city of normalCities) {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const offsets = [
        [0, 0],
        [-0.12, 0.1],
        [0.14, -0.08],
        [0.05, 0.15],
      ] as const;
      for (const [ox, oz] of offsets) {
        const h = hashCoord(city.coord.q, city.coord.r);
        const m = new Matrix4().makeTranslation(
          base.x + ox * HEX_SIZE,
          base.y + 6 + (h % 5),
          base.z + oz * HEX_SIZE,
        );
        clusterMesh.setMatrixAt(idx++, m);
      }
    }
    clusterMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(clusterMesh);
  }

  if (capitals.length > 0) {
    const geom = new BoxGeometry(HEX_SIZE * 0.28, HEX_SIZE * 0.45, HEX_SIZE * 0.28);
    const mat = new MeshLambertMaterial({ color: new Color(0xd4af37) });
    capitalMesh = new InstancedMesh(geom, mat, capitals.length);
    capitals.forEach((city, i) => {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const pos = axialToWorld3D(city.coord.q, city.coord.r, elev);
      pos.y += 10;
      capitalMesh!.setMatrixAt(i, new Matrix4().makeTranslation(pos.x, pos.y, pos.z));
    });
    capitalMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(capitalMesh);
  }
}

export function clearCityClusters(): void {
  while (cityGroup.children.length > 0) {
    const child = cityGroup.children[0]!;
    cityGroup.remove(child);
    if ('geometry' in child) (child as InstancedMesh).geometry.dispose();
    if ('material' in child) {
      const mat = (child as InstancedMesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  }
  clusterMesh = null;
  capitalMesh = null;
}

export function setCitiesVisible(visible: boolean): void {
  cityGroup.visible = visible;
}
