// ─── Civ-style city clusters with walls, towers, and pitched roofs ──────────
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Color,
  Vector3,
  Quaternion,
} from 'three';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const cityGroup = new Group();
cityGroup.name = 'cities';

let clusterMesh: InstancedMesh | null = null;
let roofMesh: InstancedMesh | null = null;
let wallMesh: InstancedMesh | null = null;
let towerMesh: InstancedMesh | null = null;
let capitalMesh: InstancedMesh | null = null;
let capitalRoofMesh: InstancedMesh | null = null;
let capitalDomeMesh: InstancedMesh | null = null;
let capitalWallMesh: InstancedMesh | null = null;
let capitalTowerMesh: InstancedMesh | null = null;
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

  // ── Normal cities: buildings + roofs + perimeter walls + corner towers ─────
  if (normalCities.length > 0) {
    const bldGeom = new BoxGeometry(HEX_SIZE * 0.16, HEX_SIZE * 0.2, HEX_SIZE * 0.16);
    const bldMat = new MeshLambertMaterial({ color: new Color(0xb89050) });
    const roofGeom = new ConeGeometry(HEX_SIZE * 0.11, HEX_SIZE * 0.10, 4);
    const roofMat = new MeshLambertMaterial({ color: new Color(0x8a6040) });
    const wallGeom = new BoxGeometry(HEX_SIZE * 0.55, HEX_SIZE * 0.06, HEX_SIZE * 0.02);
    const wallMat = new MeshLambertMaterial({ color: new Color(0x9a8060) });
    const towerGeom = new CylinderGeometry(HEX_SIZE * 0.03, HEX_SIZE * 0.035, HEX_SIZE * 0.14, 6);
    const towerMat = new MeshLambertMaterial({ color: new Color(0xa08050) });

    const bldCount = normalCities.length * 5;
    const roofCount = normalCities.length * 5;
    const wallCount = normalCities.length * 6;   // 6 wall segments
    const towerCount = normalCities.length * 4;  // 4 corner towers

    clusterMesh = new InstancedMesh(bldGeom, bldMat, bldCount);
    roofMesh    = new InstancedMesh(roofGeom, roofMat, roofCount);
    wallMesh    = new InstancedMesh(wallGeom, wallMat, wallCount);
    towerMesh   = new InstancedMesh(towerGeom, towerMat, towerCount);

    let bldIdx = 0, roofIdx = 0, wallIdx = 0, towerIdx = 0;
    const q = new Quaternion();

    for (const city of normalCities) {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const h = hashCoord(city.coord.q, city.coord.r);

      // Buildings
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
        clusterMesh.setMatrixAt(bldIdx++, m);

        // Triangular roof on top
        const roofY = base.y + 4 + ht * 6 + (h % 4) + HEX_SIZE * 0.2 * ht * 0.5 + HEX_SIZE * 0.05;
        const roofM = new Matrix4().makeTranslation(
          base.x + ox * HEX_SIZE,
          roofY,
          base.z + oz * HEX_SIZE,
        );
        roofM.scale(new Vector3(1, 1, 1));
        // Rotate roof to align with building
        const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ((h + bldIdx) % 4) * (Math.PI / 4));
        roofM.multiply(new Matrix4().makeRotationFromQuaternion(rot));
        roofMesh.setMatrixAt(roofIdx++, roofM);
      }

      // Perimeter walls (thin, around the tile edge)
      const wallY = base.y + 3.5;
      for (let wi = 0; wi < 6; wi++) {
        const angle = (Math.PI / 3) * wi;
        const wx = base.x + Math.cos(angle) * HEX_SIZE * 0.38;
        const wz = base.z + Math.sin(angle) * HEX_SIZE * 0.38;
        const wallM = new Matrix4().makeTranslation(wx, wallY, wz);
        q.setFromAxisAngle(new Vector3(0, 1, 0), angle + Math.PI / 2);
        wallM.multiply(new Matrix4().makeRotationFromQuaternion(q));
        wallMesh.setMatrixAt(wallIdx++, wallM);
      }

      // Corner towers
      const cornerAngles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
      for (const ca of cornerAngles) {
        const tx = base.x + Math.cos(ca) * HEX_SIZE * 0.42;
        const tz = base.z + Math.sin(ca) * HEX_SIZE * 0.42;
        const towerM = new Matrix4().makeTranslation(tx, wallY + HEX_SIZE * 0.07, tz);
        towerMesh.setMatrixAt(towerIdx++, towerM);
      }
    }

    clusterMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
    wallMesh.instanceMatrix.needsUpdate = true;
    towerMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(clusterMesh);
    cityGroup.add(roofMesh);
    cityGroup.add(wallMesh);
    cityGroup.add(towerMesh);
  }

  // ── Capitals: larger buildings + dome + complex walls + towers + star ────────
  if (capitals.length > 0) {
    const bldGeom = new BoxGeometry(HEX_SIZE * 0.22, HEX_SIZE * 0.5, HEX_SIZE * 0.22);
    const bldMat = new MeshStandardMaterial({
      color: new Color(0xd4af37),
      emissive: new Color(0x604010),
      emissiveIntensity: 0.25,
    });
    const roofGeom = new ConeGeometry(HEX_SIZE * 0.15, HEX_SIZE * 0.14, 4);
    const roofMat = new MeshStandardMaterial({ color: new Color(0xb89040), roughness: 0.5 });
    const domeGeom = new SphereGeometry(HEX_SIZE * 0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new MeshStandardMaterial({
      color: new Color(0xe8c860),
      emissive: new Color(0x605020),
      emissiveIntensity: 0.15,
      roughness: 0.3,
      metalness: 0.4,
    });
    const wallGeom = new BoxGeometry(HEX_SIZE * 0.70, HEX_SIZE * 0.08, HEX_SIZE * 0.025);
    const wallMat = new MeshStandardMaterial({ color: new Color(0x8a7040), roughness: 0.7 });
    const towerGeom = new CylinderGeometry(HEX_SIZE * 0.04, HEX_SIZE * 0.045, HEX_SIZE * 0.20, 6);
    const towerMat = new MeshStandardMaterial({ color: new Color(0x9a8048), roughness: 0.6 });

    const starGeom = new ConeGeometry(HEX_SIZE * 0.1, HEX_SIZE * 0.18, 4);
    const starMat = new MeshStandardMaterial({
      color: 0xf0d060,
      emissive: 0xf0d060,
      emissiveIntensity: 0.8,
    });

    const bldCount = capitals.length;
    const roofCount = capitals.length;
    const wallCount = capitals.length * 8;  // 8 wall segments for more complex shape
    const towerCount = capitals.length * 6; // 6 towers

    capitalMesh     = new InstancedMesh(bldGeom, bldMat, bldCount);
    capitalRoofMesh = new InstancedMesh(roofGeom, roofMat, roofCount);
    capitalDomeMesh = new InstancedMesh(domeGeom, domeMat, capitals.length);
    capitalWallMesh = new InstancedMesh(wallGeom, wallMat, wallCount);
    capitalTowerMesh = new InstancedMesh(towerGeom, towerMat, towerCount);
    capitalStar     = new InstancedMesh(starGeom, starMat, capitals.length);

    let bldIdx = 0, roofIdx = 0, wallIdx = 0, towerIdx = 0;
    const q = new Quaternion();

    for (const city of capitals) {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);

      // Main building
      capitalMesh.setMatrixAt(bldIdx++, new Matrix4().makeTranslation(base.x, base.y + 14, base.z));

      // Roof on main building
      const roofY = base.y + 14 + HEX_SIZE * 0.5 * 0.5 + HEX_SIZE * 0.07;
      const roofM = new Matrix4().makeTranslation(base.x, roofY, base.z);
      capitalRoofMesh.setMatrixAt(roofIdx++, roofM);

      // Central dome (half-sphere sitting on roof)
      const domeY = roofY + HEX_SIZE * 0.07;
      const domeM = new Matrix4().makeTranslation(base.x, domeY, base.z);
      capitalDomeMesh.setMatrixAt(bldIdx - 1, domeM); // reuse index

      // Complex walls (octagonal-ish, 8 segments)
      const wallY = base.y + 5;
      for (let wi = 0; wi < 8; wi++) {
        const angle = (Math.PI / 4) * wi;
        const wx = base.x + Math.cos(angle) * HEX_SIZE * 0.48;
        const wz = base.z + Math.sin(angle) * HEX_SIZE * 0.48;
        const wallM = new Matrix4().makeTranslation(wx, wallY, wz);
        q.setFromAxisAngle(new Vector3(0, 1, 0), angle + Math.PI / 2);
        wallM.multiply(new Matrix4().makeRotationFromQuaternion(q));
        capitalWallMesh.setMatrixAt(wallIdx++, wallM);
      }

      // 6 towers (corners + midpoints)
      for (let ti = 0; ti < 6; ti++) {
        const angle = (Math.PI / 3) * ti;
        const tx = base.x + Math.cos(angle) * HEX_SIZE * 0.52;
        const tz = base.z + Math.sin(angle) * HEX_SIZE * 0.52;
        const towerM = new Matrix4().makeTranslation(tx, wallY + HEX_SIZE * 0.10, tz);
        capitalTowerMesh.setMatrixAt(towerIdx++, towerM);
      }

      // Star on top of dome
      const starY = domeY + HEX_SIZE * 0.12 + HEX_SIZE * 0.09;
      const starM = new Matrix4().makeTranslation(base.x, starY, base.z);
      capitalStar.setMatrixAt(bldIdx - 1, starM);
    }

    capitalMesh.instanceMatrix.needsUpdate = true;
    capitalRoofMesh.instanceMatrix.needsUpdate = true;
    capitalDomeMesh.instanceMatrix.needsUpdate = true;
    capitalWallMesh.instanceMatrix.needsUpdate = true;
    capitalTowerMesh.instanceMatrix.needsUpdate = true;
    capitalStar.instanceMatrix.needsUpdate = true;
    cityGroup.add(capitalMesh);
    cityGroup.add(capitalRoofMesh);
    cityGroup.add(capitalDomeMesh);
    cityGroup.add(capitalWallMesh);
    cityGroup.add(capitalTowerMesh);
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
  roofMesh = null;
  wallMesh = null;
  towerMesh = null;
  capitalMesh = null;
  capitalRoofMesh = null;
  capitalDomeMesh = null;
  capitalWallMesh = null;
  capitalTowerMesh = null;
  capitalStar = null;
}

export function setCitiesVisible(visible: boolean): void {
  cityGroup.visible = visible;
}
