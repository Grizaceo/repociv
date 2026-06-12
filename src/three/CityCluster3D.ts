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
import { areCityPropsReady } from './CityProps3D.ts';

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
  return cities
    .map((c) => {
      const bucket =
        c.population <= 30 ? 'a' :
        c.population <= 120 ? 'b' :
        c.population <= 350 ? 'c' :
        c.population <= 800 ? 'd' : 'e';
      return `${c.id}:${c.coord.q},${c.coord.r}:${c.isCapital ? 1 : 0}:${bucket}`;
    })
    .join('|');
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
  // Civ V palette: pale stone/stucco walls, terracotta roofs, finer silhouettes.
  if (normalCities.length > 0) {
    // Taller, thinner blocks so they read as buildings rather than dunes
    const bldGeom = new BoxGeometry(HEX_SIZE * 0.12, HEX_SIZE * 0.28, HEX_SIZE * 0.12);
    const bldMat = new MeshLambertMaterial({ color: new Color(0xc8c0b0) });
    const roofGeom = new ConeGeometry(HEX_SIZE * 0.10, HEX_SIZE * 0.12, 4);
    const roofMat = new MeshLambertMaterial({ color: new Color(0x9e5a45) });
    const wallGeom = new BoxGeometry(HEX_SIZE * 0.55, HEX_SIZE * 0.08, HEX_SIZE * 0.02);
    const wallMat = new MeshLambertMaterial({ color: new Color(0xb0a898) });
    const towerGeom = new CylinderGeometry(HEX_SIZE * 0.025, HEX_SIZE * 0.03, HEX_SIZE * 0.18, 6);
    const towerMat = new MeshLambertMaterial({ color: new Color(0xa09880) });

    // Density keyed by population (files in repo). Max 5 buildings per city.
    function buildingCountForCity(pop: number): number {
      if (pop <= 30) return 1;
      if (pop <= 120) return 2;
      if (pop <= 350) return 3;
      if (pop <= 800) return 4;
      return 5;
    }

    const bldCount = normalCities.reduce((s, c) => s + buildingCountForCity(c.population), 0);
    const roofCount = bldCount;
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
      const count = buildingCountForCity(city.population);

      // Building footprints — clustered toward centre so walls read as a perimeter
      const offsets: Array<[number, number, number]> = [
        [0,       0,    1.00],
        [-0.10,   0.08, 0.82],
        [0.12,   -0.06, 0.88],
        [0.05,    0.14, 0.72],
        [-0.08,  -0.10, 0.68],
      ];
      for (let bi = 0; bi < count; bi++) {
        const [ox, oz, ht] = offsets[bi]!;
        const m = new Matrix4().makeTranslation(
          base.x + ox * HEX_SIZE,
          base.y + 4 + ht * 7 + (h % 4),
          base.z + oz * HEX_SIZE,
        );
        m.scale(new Vector3(1, ht, 1));
        clusterMesh.setMatrixAt(bldIdx++, m);

        // Triangular roof on top
        const roofY = base.y + 4 + ht * 7 + (h % 4) + HEX_SIZE * 0.28 * ht * 0.5 + HEX_SIZE * 0.04;
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
      const wallY = base.y + 3.2;
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
        const towerM = new Matrix4().makeTranslation(tx, wallY + HEX_SIZE * 0.09, tz);
        towerMesh.setMatrixAt(towerIdx++, towerM);
      }
    }

    clusterMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
    wallMesh.instanceMatrix.needsUpdate = true;
    towerMesh.instanceMatrix.needsUpdate = true;
    clusterMesh.castShadow = true;
    roofMesh.castShadow = true;
    cityGroup.add(clusterMesh);
    cityGroup.add(roofMesh);
    cityGroup.add(wallMesh);
    cityGroup.add(towerMesh);
  }

  // ── Capitals: glTF prop when loaded; procedural fallback otherwise ─────────
  if (capitals.length > 0 && !areCityPropsReady()) {
    const bldGeom = new BoxGeometry(HEX_SIZE * 0.20, HEX_SIZE * 0.55, HEX_SIZE * 0.20);
    const bldMat = new MeshStandardMaterial({
      color: new Color(0xd4c8b8),
      emissive: new Color(0x504840),
      emissiveIntensity: 0.18,
    });
    const roofGeom = new ConeGeometry(HEX_SIZE * 0.14, HEX_SIZE * 0.16, 4);
    const roofMat = new MeshStandardMaterial({ color: new Color(0xa86048), roughness: 0.5 });
    const domeGeom = new SphereGeometry(HEX_SIZE * 0.11, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new MeshStandardMaterial({
      color: new Color(0xe8dcc8),
      emissive: new Color(0x605840),
      emissiveIntensity: 0.12,
      roughness: 0.3,
      metalness: 0.25,
    });
    const wallGeom = new BoxGeometry(HEX_SIZE * 0.70, HEX_SIZE * 0.10, HEX_SIZE * 0.025);
    const wallMat = new MeshStandardMaterial({ color: new Color(0xb8b0a0), roughness: 0.7 });
    const towerGeom = new CylinderGeometry(HEX_SIZE * 0.035, HEX_SIZE * 0.04, HEX_SIZE * 0.24, 6);
    const towerMat = new MeshStandardMaterial({ color: new Color(0xa8a090), roughness: 0.6 });

    const starGeom = new ConeGeometry(HEX_SIZE * 0.09, HEX_SIZE * 0.16, 4);
    const starMat = new MeshStandardMaterial({
      color: 0xf0e0a8,
      emissive: 0xf0e0a8,
      emissiveIntensity: 0.7,
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

      // Main building — taller so the capital silhouette dominates
      capitalMesh.setMatrixAt(bldIdx++, new Matrix4().makeTranslation(base.x, base.y + 16, base.z));

      // Roof on main building
      const roofY = base.y + 16 + HEX_SIZE * 0.55 * 0.5 + HEX_SIZE * 0.08;
      const roofM = new Matrix4().makeTranslation(base.x, roofY, base.z);
      capitalRoofMesh.setMatrixAt(roofIdx++, roofM);

      // Central dome (half-sphere sitting on roof)
      const domeY = roofY + HEX_SIZE * 0.08;
      const domeM = new Matrix4().makeTranslation(base.x, domeY, base.z);
      capitalDomeMesh.setMatrixAt(bldIdx - 1, domeM); // reuse index

      // Complex walls (octagonal-ish, 8 segments)
      const wallY = base.y + 4.5;
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
        const towerM = new Matrix4().makeTranslation(tx, wallY + HEX_SIZE * 0.12, tz);
        capitalTowerMesh.setMatrixAt(towerIdx++, towerM);
      }

      // Star on top of dome
      const starY = domeY + HEX_SIZE * 0.11 + HEX_SIZE * 0.08;
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
