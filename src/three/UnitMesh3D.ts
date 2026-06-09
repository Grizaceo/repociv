// ─── Unit markers as instanced capsules (Y anchored to tile top) ────────────
import {
  CapsuleGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
} from 'three';
import { type Unit, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const unitGroup = new Group();
unitGroup.name = 'units';

let unitMesh: InstancedMesh | null = null;
let lastSignature = '';

export function getUnitGroup(): Group {
  return unitGroup;
}

export function rebuildUnits(
  units: Unit[],
  getTile: (key: string) => Tile | undefined,
): void {
  const visibleUnits = units.filter((unit) => {
    const tile = getTile(tileKey(unit.coord));
    return !tile || tile.revealed;
  });

  const signature = visibleUnits
    .map((u) => `${u.id}:${u.coord.q},${u.coord.r}:${u.state}`)
    .join('|');
  if (signature === lastSignature) return;
  lastSignature = signature;

  clearUnits();

  if (visibleUnits.length === 0) return;

  const geom = new CapsuleGeometry(HEX_SIZE * 0.12, HEX_SIZE * 0.18, 4, 8);
  const mat = new MeshLambertMaterial({ vertexColors: true });
  unitMesh = new InstancedMesh(geom, mat, visibleUnits.length);

  visibleUnits.forEach((unit, i) => {
    const tile = getTile(tileKey(unit.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const pos = axialToWorld3D(unit.coord.q, unit.coord.r, elev);
    pos.y += HEX_SIZE * 0.2;
    unitMesh!.setMatrixAt(i, new Matrix4().makeTranslation(pos.x, pos.y, pos.z));
    unitMesh!.setColorAt(i, new Color(unit.color));
  });

  unitMesh.instanceMatrix.needsUpdate = true;
  if (unitMesh.instanceColor) unitMesh.instanceColor.needsUpdate = true;
  unitGroup.add(unitMesh);
}

export function clearUnits(): void {
  while (unitGroup.children.length > 0) {
    const child = unitGroup.children[0]!;
    unitGroup.remove(child);
    if ('geometry' in child) (child as InstancedMesh).geometry.dispose();
    if ('material' in child) {
      const mat = (child as InstancedMesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  }
  unitMesh = null;
}

export function setUnitsVisible(visible: boolean): void {
  unitGroup.visible = visible;
}
