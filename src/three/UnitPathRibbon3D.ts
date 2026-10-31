// ─── 3D Unit Movement Path Ribbon (Civ V / tranberry-bysa3 spline style) ────
// Renders a smooth Catmull-Rom 3D ribbon + waypoint discs + directional cone
// arrowhead along active unit movement paths. Rebuilds only when the path
// signature changes so idle frames incur zero allocations.

import {
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  TubeGeometry,
  Vector3,
} from 'three';
import { type Tile, type Unit, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { terrainSurfaceY } from './terrainSurfaceY.ts';
import { terrainRevision } from './terrainRevision.ts';

const pathGroup = new Group();
pathGroup.name = 'unit-paths';

let lastSignature = '';
const activeMeshes: Mesh[] = [];

const PATH_CLEARANCE = HEX_SIZE * 0.06;

export function getUnitPathGroup(): Group {
  return pathGroup;
}

export function clearUnitPaths(): void {
  for (const m of activeMeshes) {
    pathGroup.remove(m);
    m.geometry.dispose();
    if (Array.isArray(m.material)) m.material.forEach((mt) => mt.dispose());
    else m.material.dispose();
  }
  activeMeshes.length = 0;
  lastSignature = '';
}

export function setUnitPathsVisible(visible: boolean): void {
  pathGroup.visible = visible;
}

export function rebuildUnitPaths(
  units: Unit[],
  getTile: (key: string) => Tile | undefined,
  selectedUnitId?: string | null,
): void {
  const activeUnits = units.filter((u) => {
    if (u.hidden || u.path.length < 2) return false;
    const startIdx = Math.max(0, Math.min(u.pathIndex ?? 0, u.path.length - 1));
    if (u.path.length - startIdx < 2) return false;
    return u.state === 'moving' || u.id === selectedUnitId;
  });

  // The ribbon follows the terrain surface: the revision rebuilds it after a
  // paint even though the path itself did not change.
  const sig =
    `t${terrainRevision()}:` +
    activeUnits
      .map((u) => {
        const idx = Math.max(0, Math.min(u.pathIndex ?? 0, u.path.length - 2));
        const coords = u.path
          .slice(idx)
          .map((c) => `${c.q},${c.r}`)
          .join('>');
        return `${u.id}:${u.color}:${coords}`;
      })
      .join('|');

  if (sig === lastSignature) return;
  clearUnitPaths();
  lastSignature = sig;

  if (activeUnits.length === 0) return;

  const up = new Vector3(0, 1, 0);

  for (const unit of activeUnits) {
    const startIdx = Math.max(0, Math.min(unit.pathIndex ?? 0, unit.path.length - 2));
    const slice = unit.path.slice(startIdx);
    if (slice.length < 2) continue;

    const points = slice.map((c) => {
      const tile = getTile(tileKey(c));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const world = axialToWorld3D(c.q, c.r, elev);
      const surfY = (tile ? terrainSurfaceY(tile) : world.y) + PATH_CLEARANCE;
      return new Vector3(world.x, surfY, world.z);
    });

    const col = new Color(unit.color || '#f0c050');
    const ribbonMat = new MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.2,
    });

    const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.45);
    const tubularSegments = Math.max(8, (points.length - 1) * 10);
    const tubeGeom = new TubeGeometry(curve, tubularSegments, HEX_SIZE * 0.032, 6, false);
    const tubeMesh = new Mesh(tubeGeom, ribbonMat);
    tubeMesh.castShadow = false;
    pathGroup.add(tubeMesh);
    activeMeshes.push(tubeMesh);

    // Waypoint step pips along intermediate nodes
    for (let i = 1; i < points.length - 1; i++) {
      const pt = points[i]!;
      const pipGeom = new CylinderGeometry(
        HEX_SIZE * 0.068,
        HEX_SIZE * 0.068,
        HEX_SIZE * 0.025,
        12,
      );
      const pipMat = ribbonMat.clone();
      const pipMesh = new Mesh(pipGeom, pipMat);
      pipMesh.position.copy(pt);
      pathGroup.add(pipMesh);
      activeMeshes.push(pipMesh);
    }

    // Arrowhead cone at destination
    const dest = points[points.length - 1]!;
    const tangent = curve.getTangent(1).normalize();
    const arrowGeom = new ConeGeometry(HEX_SIZE * 0.095, HEX_SIZE * 0.22, 8);
    const arrowMat = ribbonMat.clone();
    const arrowMesh = new Mesh(arrowGeom, arrowMat);
    arrowMesh.position.copy(dest);
    const quat = new Quaternion().setFromUnitVectors(up, tangent);
    arrowMesh.quaternion.copy(quat);
    pathGroup.add(arrowMesh);
    activeMeshes.push(arrowMesh);
  }
}
