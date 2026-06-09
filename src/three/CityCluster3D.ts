// ─── Civ-style city clusters (low-poly boxes) ───────────────────────────────
import {
  BoxGeometry,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Color,
  Vector3,
} from 'three';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const cityGroup = new Group();
cityGroup.name = 'cities';

let clusterMesh: InstancedMesh | null = null;
let capitalMesh: InstancedMesh | null = null;
let capitalStar: InstancedMesh | null = null;
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

function disposeMesh(mesh: InstancedMesh): void {
  mesh.geometry.dispose();
  const mat = mesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else mat.dispose();
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
    const dotMat = new MeshStandardMaterial({
      color: new Color(0xc8a84b),
      emissive: new Color(0x403010),
      emissiveIntensity: 0.3,
    });
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
    const geom = new BoxGeometry(HEX_SIZE * 0.16, HEX_SIZE * 0.2, HEX_SIZE * 0.16);
    const mat = new MeshLambertMaterial({ color: new Color(0xb89050) });
    const count = normalCities.length * 5;
    clusterMesh = new InstancedMesh(geom, mat, count);
    let idx = 0;
    for (const city of normalCities) {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const h = hashCoord(city.coord.q, city.coord.r);
      const offsets = [
        [0, 0, 1],
        [-0.14, 0.1, 0.85],
        [0.16, -0.1, 0.9],
        [0.06, 0.16, 0.75],
        [-0.1, -0.12, 0.7],
      ] as const;
      for (const [ox, oz, ht] of offsets) {
        const m = new Matrix4().makeTranslation(
          base.x + ox * HEX_SIZE,
          base.y + 4 + ht * 6 + (h % 4),
          base.z + oz * HEX_SIZE,
        );
        m.scale(new Vector3(1, ht, 1));
        clusterMesh.setMatrixAt(idx++, m);
      }
    }
    clusterMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(clusterMesh);
  }

  if (capitals.length > 0) {
    const geom = new BoxGeometry(HEX_SIZE * 0.22, HEX_SIZE * 0.5, HEX_SIZE * 0.22);
    const mat = new MeshStandardMaterial({
      color: new Color(0xd4af37),
      emissive: new Color(0x604010),
      emissiveIntensity: 0.25,
    });
    capitalMesh = new InstancedMesh(geom, mat, capitals.length);
    capitals.forEach((city, i) => {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const pos = axialToWorld3D(city.coord.q, city.coord.r, elev);
      pos.y += 14;
      capitalMesh!.setMatrixAt(i, new Matrix4().makeTranslation(pos.x, pos.y, pos.z));
    });
    capitalMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(capitalMesh);

    const starGeom = new ConeGeometry(HEX_SIZE * 0.1, HEX_SIZE * 0.18, 4);
    const starMat = new MeshStandardMaterial({
      color: 0xf0d060,
      emissive: 0xf0d060,
      emissiveIntensity: 0.8,
    });
    capitalStar = new InstancedMesh(starGeom, starMat, capitals.length);
    capitals.forEach((city, i) => {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const pos = axialToWorld3D(city.coord.q, city.coord.r, elev);
      pos.y += 28;
      const m = new Matrix4().makeTranslation(pos.x, pos.y, pos.z);
      capitalStar!.setMatrixAt(i, m);
    });
    capitalStar.instanceMatrix.needsUpdate = true;
    cityGroup.add(capitalStar);
  }
}

export function clearCityClusters(): void {
  while (cityGroup.children.length > 0) {
    const child = cityGroup.children[0] as InstancedMesh;
    cityGroup.remove(child);
    disposeMesh(child);
  }
  clusterMesh = null;
  capitalMesh = null;
  capitalStar = null;
}

export function setCitiesVisible(visible: boolean): void {
  cityGroup.visible = visible;
}
