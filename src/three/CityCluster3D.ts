// ─── Civ-style city clusters with walls, towers, and pitched roofs ──────────
// City growth: 4 levels (0-3) driven by completed building count. Each level
// increases spire height, wall ring completeness, and plaza radius. The spire
// rise animation (0→1 over 800ms) is driven by tickCities(dt), called every
// frame from updateHexWorldScene.
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Color,
  Vector3,
  Quaternion,
  Shape,
  IcosahedronGeometry,
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
// Civic centre: stepped stone plaza under every city + monument layer so
// perimeter walls read as deliberate fortifications instead of loose props.
let plazaMesh: InstancedMesh | null = null;
let spireMesh: InstancedMesh | null = null;
let capitalLandmarkMesh: InstancedMesh | null = null;
let lastSignature = '';

// ─── City growth state ─────────────────────────────────────────────────────
// Per-city animation state for the spire rise tween (0→1 over 800ms when a
// city levels up). tickCities advances these every frame.
interface CityGrowthEntry {
  cityId: string;
  level: number;
  /** Spire rise tween: 0→1 over SPIRE_RISE_DURATION. 1 = fully grown. */
  spireRise: number;
}

const cityGrowth = new Map<string, CityGrowthEntry>();
const SPIRE_RISE_DURATION = 0.8; // 800ms

// ─── City level computation ────────────────────────────────────────────────
// 4 levels (0-3) driven by completed building count.
//   0: no buildings complete (hamlet)
//   1: 1-2 buildings complete (village)
//   2: 3-5 buildings complete (town)
//   3: 6+ buildings complete (city)
export function cityLevel(city: City): number {
  const completed = (city.buildings ?? []).filter((b) => b.state === 'complete').length;
  if (completed >= 6) return 3;
  if (completed >= 3) return 2;
  if (completed >= 1) return 1;
  return 0;
}

// Visual scaling per level: spire height multiplier, wall completeness (0-1),
// and plaza radius multiplier.
// Level 0 still has full walls (a hamlet with a palisade) — walls only get
// taller/more complete at higher levels, never disappear.
const LEVEL_SPIRE_SCALE = [0.3, 0.55, 0.8, 1.0];
const LEVEL_WALL_COMPLETENESS = [1.0, 1.0, 1.0, 1.0];
const LEVEL_PLAZA_SCALE = [0.5, 0.68, 0.85, 1.0];

export function getCityGroup(): Group {
  return cityGroup;
}

function citySignature(cities: City[]): string {
  return cities
    .map((c) => {
      const bucket =
        c.population <= 30
          ? 'a'
          : c.population <= 120
            ? 'b'
            : c.population <= 350
              ? 'c'
              : c.population <= 800
                ? 'd'
                : 'e';
      const lvl = cityLevel(c);
      return `${c.id}:${c.coord.q},${c.coord.r}:${c.isCapital ? 1 : 0}:${bucket}:L${lvl}`;
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

  // ── Update growth state: detect level changes, start spire rise ────────
  for (const city of cities) {
    const lvl = cityLevel(city);
    const existing = cityGrowth.get(city.id);
    if (!existing) {
      // First time seeing this city: start at full rise for its level.
      cityGrowth.set(city.id, { cityId: city.id, level: lvl, spireRise: 1 });
    } else if (existing.level !== lvl) {
      // Level changed: restart the spire rise tween from 0.
      existing.level = lvl;
      existing.spireRise = 0;
    }
  }
  // Clean up cities that no longer exist.
  const cityIds = new Set(cities.map((c) => c.id));
  for (const id of cityGrowth.keys()) {
    if (!cityIds.has(id)) cityGrowth.delete(id);
  }

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

  // ── Civic centre: stepped stone plaza + monuments ──────────────────────────
  // Plaza radius and spire height scale with city level.
  {
    const plazaGeom = new CylinderGeometry(HEX_SIZE * 0.3, HEX_SIZE * 0.46, HEX_SIZE * 0.1, 14);
    const plazaMat = new MeshStandardMaterial({ color: new Color(0xc9bfa6), roughness: 0.92 });
    const spireGeom = new CylinderGeometry(HEX_SIZE * 0.013, HEX_SIZE * 0.032, HEX_SIZE * 0.46, 6);
    const spireMat = new MeshStandardMaterial({ color: new Color(0xe4ddca), roughness: 0.5 });
    const landmarkGeom = new CylinderGeometry(
      HEX_SIZE * 0.022,
      HEX_SIZE * 0.046,
      HEX_SIZE * 0.38,
      6,
    );
    const landmarkMat = new MeshStandardMaterial({
      color: new Color(0xd9cca2),
      roughness: 0.55,
      emissive: new Color(0x3a3220),
      emissiveIntensity: 0.15,
    });

    plazaMesh = new InstancedMesh(plazaGeom, plazaMat, cities.length);
    plazaMesh.receiveShadow = true;
    if (normalCities.length > 0) {
      spireMesh = new InstancedMesh(spireGeom, spireMat, normalCities.length);
      spireMesh.castShadow = true;
    }
    if (capitals.length > 0) {
      capitalLandmarkMesh = new InstancedMesh(landmarkGeom, landmarkMat, capitals.length * 2);
      capitalLandmarkMesh.castShadow = true;
    }

    let plazaIdx = 0,
      spireIdx = 0,
      landmarkIdx = 0;
    for (const city of cities) {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const lvl = cityLevel(city);
      const growth = cityGrowth.get(city.id);
      const rise = growth?.spireRise ?? 1;
      const plazaScale = LEVEL_PLAZA_SCALE[lvl]!;

      // Plaza: scale the instance by level multiplier.
      const plazaM = new Matrix4().makeTranslation(base.x, base.y + 1.5, base.z);
      plazaM.scale(new Vector3(plazaScale, 1, plazaScale));
      plazaMesh.setMatrixAt(plazaIdx++, plazaM);

      if (!city.isCapital && spireMesh) {
        // Spire: height scales with level × rise tween.
        const spireHScale = LEVEL_SPIRE_SCALE[lvl]! * rise;
        const spireM = new Matrix4().makeTranslation(
          base.x,
          base.y + 4 + HEX_SIZE * 0.21 * spireHScale,
          base.z + HEX_SIZE * 0.24,
        );
        spireM.scale(new Vector3(1, spireHScale, 1));
        spireMesh.setMatrixAt(spireIdx++, spireM);
      } else if (city.isCapital && capitalLandmarkMesh) {
        const h = hashCoord(city.coord.q, city.coord.r);
        const axis = (h % 6) * (Math.PI / 3);
        for (let li = 0; li < 2; li++) {
          const angle = axis + li * Math.PI;
          capitalLandmarkMesh.setMatrixAt(
            landmarkIdx++,
            new Matrix4().makeTranslation(
              base.x + Math.cos(angle) * HEX_SIZE * 0.42,
              base.y + 4 + HEX_SIZE * 0.15,
              base.z + Math.sin(angle) * HEX_SIZE * 0.42,
            ),
          );
        }
      }
    }
    plazaMesh.instanceMatrix.needsUpdate = true;
    cityGroup.add(plazaMesh);
    if (spireMesh) {
      spireMesh.instanceMatrix.needsUpdate = true;
      cityGroup.add(spireMesh);
    }
    if (capitalLandmarkMesh) {
      capitalLandmarkMesh.instanceMatrix.needsUpdate = true;
      cityGroup.add(capitalLandmarkMesh);
    }
  }

  // ── Normal cities: buildings + roofs + perimeter walls + corner towers ─────
  // Civ V palette: pale stone/stucco walls, terracotta roofs, finer silhouettes.
  if (normalCities.length > 0) {
    // Taller, thinner blocks so they read as buildings rather than dunes
    const bldGeom = new BoxGeometry(HEX_SIZE * 0.12, HEX_SIZE * 0.28, HEX_SIZE * 0.12);
    const bldMat = new MeshLambertMaterial({ color: new Color(0xc8c0b0) });
    const roofGeom = new ConeGeometry(HEX_SIZE * 0.1, HEX_SIZE * 0.12, 4);
    // flatShading on the 4-sided roof cone so each triangular face has a
    // hard normal — reads as a pitched terracotta roof, not a smooth wand.
    const roofMat = new MeshStandardMaterial({
      color: new Color(0xb0563a),
      roughness: 0.65,
      flatShading: true,
    });
    // Perimeter wall: a closed hexagonal RING (outer hex with inner hex hole,
    // extruded). ONE geometry per city, not 6 separate boxes. The previous
    // 6-box design left gaps at every corner, so walls read as 6 scattered
    // dots instead of one continuous fortification.
    let ringWallGeom: ExtrudeGeometry;
    {
      const outerR = HEX_SIZE * 0.4;
      const innerR = HEX_SIZE * 0.34;
      const wallH = HEX_SIZE * 0.12;
      const ring = new Shape();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const x = Math.cos(a) * outerR;
        const z = Math.sin(a) * outerR;
        if (i === 0) ring.moveTo(x, z);
        else ring.lineTo(x, z);
      }
      ring.closePath();
      const hole = new Shape();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const x = Math.cos(a) * innerR;
        const z = Math.sin(a) * innerR;
        if (i === 0) hole.moveTo(x, z);
        else hole.lineTo(x, z);
      }
      hole.closePath();
      ring.holes.push(hole);
      // ExtrudeGeometry extrudes the shape (in its 2D plane) along +Z. We want
      // the wall to lie flat on the ground (shape in X-Z) and grow upward in Y,
      // so we rotate the geometry: X→X, Y→Z, Z→-Y after a -π/2 X-rotation.
      const wall3d = new ExtrudeGeometry(ring, { depth: wallH, bevelEnabled: false });
      wall3d.rotateX(-Math.PI / 2);
      // After rotation the extrusion direction points -Y. Flip the Z coords
      // so the wall extrudes upward instead of sinking into the ground.
      wall3d.scale(1, 1, -1);
      ringWallGeom = wall3d;
    }
    const wallGeom: ExtrudeGeometry = ringWallGeom;
    const wallMat = new MeshLambertMaterial({ color: new Color(0xb0a898) });
    const towerGeom = new CylinderGeometry(HEX_SIZE * 0.025, HEX_SIZE * 0.03, HEX_SIZE * 0.18, 6);
    const towerMat = new MeshLambertMaterial({ color: new Color(0xa09880) });

    // Density keyed on population (files in repo). Civ V cities read as a dense
    // cluster of dwellings inside the walls, not a handful of huts — so the caps
    // are generous (max 11, matching the `offsets` ring layout below).
    function buildingCountForCity(pop: number): number {
      if (pop <= 30) return 3;
      if (pop <= 120) return 5;
      if (pop <= 350) return 7;
      if (pop <= 800) return 9;
      return 11;
    }

    // Capitals with the GLB keep get 3 village-style satellite houses so
    // the tile reads as a building CLUSTER (Civ V capitals are never one
    // monolith). The procedural-capital fallback builds its own compound,
    // so satellites only apply while the glTF prop is live.
    const satellitesPerCapital = areCityPropsReady() ? 3 : 0;
    const bldCount =
      normalCities.reduce((s, c) => s + buildingCountForCity(c.population), 0) +
      capitals.length * satellitesPerCapital;
    const roofCount = bldCount;
    // Perimeter wall: ONE closed hexagonal ring per city (was 6 separate
    // box segments that left corner gaps → walls read as scattered dots).
    // Wall completeness: level 0 = no walls, level 1+ = walls present.
    // The ring geometry is always created; the scale.y = 0 trick hides
    // incomplete walls (they're underground). A per-instance Y-scale
    // controls how much of the wall is visible.
    const wallCount = normalCities.length;
    const towerCount = normalCities.length * 4; // 4 corner towers

    clusterMesh = new InstancedMesh(bldGeom, bldMat, bldCount);
    roofMesh = new InstancedMesh(roofGeom, roofMat, roofCount);
    wallMesh = new InstancedMesh(wallGeom, wallMat, wallCount);
    towerMesh = new InstancedMesh(towerGeom, towerMat, towerCount);

    let bldIdx = 0,
      roofIdx = 0,
      wallIdx = 0,
      towerIdx = 0;

    for (const city of normalCities) {
      const tile = getTile(tileKey(city.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
      const h = hashCoord(city.coord.q, city.coord.r);
      const count = buildingCountForCity(city.population);
      const lvl = cityLevel(city);
      const wallComplete = LEVEL_WALL_COMPLETENESS[lvl]!;

      // Building footprints — concentric rings inside the wall (inner radius
      // 0.34·HEX). Centre tower + inner ring + outer ring = 11 dwellings, all
      // kept within ~0.24·HEX of centre so the 0.12·HEX footprints stay clear of
      // the perimeter wall. Heights vary for a layered Civ-V silhouette.
      const offsets: Array<[number, number, number]> = [
        [0, 0, 1.0],
        // inner ring (r≈0.13)
        [0.092, 0.092, 0.85],
        [-0.092, 0.092, 0.78],
        [-0.092, -0.092, 0.88],
        [0.092, -0.092, 0.72],
        // outer ring (r≈0.24)
        [0.24, 0, 0.7],
        [0.12, 0.208, 0.66],
        [-0.12, 0.208, 0.74],
        [-0.24, 0, 0.68],
        [-0.12, -0.208, 0.62],
        [0.12, -0.208, 0.76],
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
        const rot = new Quaternion().setFromAxisAngle(
          new Vector3(0, 1, 0),
          ((h + bldIdx) % 4) * (Math.PI / 4),
        );
        roofM.multiply(new Matrix4().makeRotationFromQuaternion(rot));
        roofMesh.setMatrixAt(roofIdx++, roofM);
      }

      // Perimeter wall: ONE closed hexagonal ring centered on the city,
      // raised to sit on top of the plaza. Wall completeness scales the
      // instance Y so incomplete walls are underground (invisible).
      const wallY = base.y + 5.5;
      {
        const m = new Matrix4().makeTranslation(base.x, wallY, base.z);
        // Scale Y by wall completeness: 0 = fully underground, 1 = full height.
        m.scale(new Vector3(1, wallComplete, 1));
        wallMesh.setMatrixAt(wallIdx++, m);
      }

      // Corner towers: only render when walls are at least 40% complete.
      const cornerAngles = [0, Math.PI / 3, Math.PI, (4 * Math.PI) / 3];
      const towerYScale = Math.max(0, wallComplete);
      for (const ca of cornerAngles) {
        const tx = base.x + Math.cos(ca) * HEX_SIZE * 0.42;
        const tz = base.z + Math.sin(ca) * HEX_SIZE * 0.42;
        const towerM = new Matrix4().makeTranslation(tx, wallY + HEX_SIZE * 0.09, tz);
        towerM.scale(new Vector3(1, towerYScale, 1));
        towerMesh.setMatrixAt(towerIdx++, towerM);
      }
    }

    // Capital satellite houses (ring around the GLB keep, clear of its
    // 0.27·HEX half-footprint).
    if (satellitesPerCapital > 0) {
      const satAngles = [0, (Math.PI * 2) / 3 + 0.35, (Math.PI * 4) / 3 - 0.2];
      for (const city of capitals) {
        const tile = getTile(tileKey(city.coord));
        const elev = tile ? terrainElevation(tile.terrain) : 0;
        const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
        const h = hashCoord(city.coord.q, city.coord.r);
        for (let si = 0; si < satellitesPerCapital; si++) {
          const angle = satAngles[si]! + (h % 6) * (Math.PI / 3);
          const r = HEX_SIZE * (0.5 + ((h >> (si + 2)) % 3) * 0.04);
          const sx = base.x + Math.cos(angle) * r;
          const sz = base.z + Math.sin(angle) * r;
          const ht = 0.58 + ((h >> si) % 3) * 0.09;
          const m = new Matrix4().makeTranslation(sx, base.y + 4 + ht * 7, sz);
          m.scale(new Vector3(1, ht, 1));
          clusterMesh.setMatrixAt(bldIdx++, m);
          const roofY = base.y + 4 + ht * 7 + HEX_SIZE * 0.28 * ht * 0.5 + HEX_SIZE * 0.04;
          const roofM = new Matrix4().makeTranslation(sx, roofY, sz);
          const rot = new Quaternion().setFromAxisAngle(
            new Vector3(0, 1, 0),
            ((h + si) % 4) * (Math.PI / 4),
          );
          roofM.multiply(new Matrix4().makeRotationFromQuaternion(rot));
          roofMesh.setMatrixAt(roofIdx++, roofM);
        }
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
    const bldGeom = new BoxGeometry(HEX_SIZE * 0.2, HEX_SIZE * 0.55, HEX_SIZE * 0.2);
    const bldMat = new MeshStandardMaterial({
      color: new Color(0xd4c8b8),
      emissive: new Color(0x504840),
      emissiveIntensity: 0.18,
    });
    const roofGeom = new ConeGeometry(HEX_SIZE * 0.14, HEX_SIZE * 0.16, 4);
    // flatShading on the capital roof so the 4 triangular faces have hard
    // normals — matches the normal-city roof treatment.
    const roofMat = new MeshStandardMaterial({
      color: new Color(0xa86048),
      roughness: 0.5,
      flatShading: true,
    });
    // Capital dome: low-poly icosahedron flattened, not a smooth sphere.
    // The old SphereGeometry(12,8,PI/2) was a perfect plastic hemisphere.
    const domeGeom = new IcosahedronGeometry(HEX_SIZE * 0.12, 0);
    domeGeom.scale(1, 0.55, 1);
    const domeMat = new MeshStandardMaterial({
      color: new Color(0xe8dcc8),
      emissive: new Color(0x605840),
      emissiveIntensity: 0.12,
      roughness: 0.3,
      metalness: 0.25,
      flatShading: true,
    });
    const wallGeom = new BoxGeometry(HEX_SIZE * 0.7, HEX_SIZE * 0.1, HEX_SIZE * 0.025);
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
    const wallCount = capitals.length * 8; // 8 wall segments for more complex shape
    const towerCount = capitals.length * 6; // 6 towers

    capitalMesh = new InstancedMesh(bldGeom, bldMat, bldCount);
    capitalRoofMesh = new InstancedMesh(roofGeom, roofMat, roofCount);
    capitalDomeMesh = new InstancedMesh(domeGeom, domeMat, capitals.length);
    capitalWallMesh = new InstancedMesh(wallGeom, wallMat, wallCount);
    capitalTowerMesh = new InstancedMesh(towerGeom, towerMat, towerCount);
    capitalStar = new InstancedMesh(starGeom, starMat, capitals.length);

    let bldIdx = 0,
      roofIdx = 0,
      wallIdx = 0,
      towerIdx = 0;
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

/** Per-frame animation: advance spire rise tweens for cities that leveled up.
 *  Called every frame from updateHexWorldScene, independent of dirty state.
 *  When dt=0 (frozen animTime), tweens freeze — goldens stay deterministic.
 *  The tween completion triggers a signature change (spireRise goes 0→1) which
 *  forces a rebuild on the next dirty frame, applying the full-height spire. */
export function tickCities(dt: number): void {
  let needsRebuild = false;
  for (const entry of cityGrowth.values()) {
    if (entry.spireRise < 1) {
      entry.spireRise += dt / SPIRE_RISE_DURATION;
      if (entry.spireRise >= 1) {
        entry.spireRise = 1;
      }
      // The spire height is baked into the instance matrix at rebuild time.
      // We need a rebuild to update the visual. The cheapest way: invalidate
      // the signature. But we can't call rebuildCityClusters here because we
      // don't have the cities/tiles. Instead, we set a flag that the next
      // updateHexWorldScene picks up.
      needsRebuild = true;
    }
  }
  if (needsRebuild) {
    // Invalidate the signature so the next rebuildCityClusters call
    // reconstructs with updated spire heights.
    lastSignature += '~';
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
  plazaMesh = null;
  spireMesh = null;
  capitalLandmarkMesh = null;
  // Note: cityGrowth is NOT cleared here — it persists across rebuilds
  // so that spire rise tweens survive the signature-change rebuild.
  // Use _testClearGrowth() in tests to reset state between cases.
}

export function setCitiesVisible(visible: boolean): void {
  cityGroup.visible = visible;
}

// ─── Test-only exports ─────────────────────────────────────────────────────
export function _testGetGrowth(cityId: string): CityGrowthEntry | undefined {
  return cityGrowth.get(cityId);
}

export function _testClearGrowth(): void {
  cityGrowth.clear();
  lastSignature = '';
}
