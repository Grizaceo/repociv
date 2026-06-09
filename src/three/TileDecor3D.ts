// ─── Per-tile 3D decor (mountains, forests, farms) ──────────────────────────
import {
  ConeGeometry,
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Group,
  Color,
} from 'three';
import { type Tile, type Terrain, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const decorGroup = new Group();
decorGroup.name = 'tile-decor';

let mountainMesh: InstancedMesh | null = null;
let forestMesh: InstancedMesh | null = null;
let farmMesh: InstancedMesh | null = null;
let lastSignature = '';

function decorSignature(tiles: Tile[]): string {
  return tiles
    .map((t) => `${tileKey(t.coord)}:${t.terrain}:${t.revealed ? 1 : 0}`)
    .join('|');
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

export function getTileDecorGroup(): Group {
  return decorGroup;
}

export function rebuildTileDecor(tiles: Tile[], lod: 'low' | 'medium' | 'high'): void {
  if (lod === 'low') {
    clearTileDecor();
    return;
  }

  const signature = `${lod}:${decorSignature(tiles)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  clearTileDecor();

  const mountains: Tile[] = [];
  const forests: Tile[] = [];
  const farms: Tile[] = [];

  for (const tile of tiles) {
    if (!tile.revealed) continue;
    switch (tile.terrain) {
      case 'mountain':
        mountains.push(tile);
        break;
      case 'forest':
        forests.push(tile);
        break;
      case 'plains': {
        const h = hashCoord(tile.coord.q, tile.coord.r);
        if (h % 5 === 0) farms.push(tile);
        break;
      }
      default:
        break;
    }
  }

  if (mountains.length > 0) {
    const geom = new ConeGeometry(HEX_SIZE * 0.22, HEX_SIZE * 0.55, 4);
    const mat = new MeshLambertMaterial({ color: new Color(0x8a8a8a) });
    mountainMesh = new InstancedMesh(geom, mat, mountains.length);
    mountains.forEach((tile, i) => {
      const elev = terrainElevation(tile.terrain);
      const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      pos.y += HEX_SIZE * 0.08;
      const m = new Matrix4().makeTranslation(pos.x, pos.y, pos.z);
      mountainMesh!.setMatrixAt(i, m);
    });
    mountainMesh.instanceMatrix.needsUpdate = true;
    decorGroup.add(mountainMesh);
  }

  if (forests.length > 0) {
    const geom = new ConeGeometry(HEX_SIZE * 0.12, HEX_SIZE * 0.35, 5);
    const mat = new MeshLambertMaterial({ color: new Color(0x1e4a18) });
    const count = forests.length * 2;
    forestMesh = new InstancedMesh(geom, mat, count);
    let idx = 0;
    for (const tile of forests) {
      const elev = terrainElevation(tile.terrain);
      const base = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      for (let t = 0; t < 2; t++) {
        const ox = (t === 0 ? -0.15 : 0.18) * HEX_SIZE;
        const oz = (t === 0 ? 0.12 : -0.14) * HEX_SIZE;
        const m = new Matrix4().makeTranslation(base.x + ox, base.y + 4, base.z + oz);
        forestMesh.setMatrixAt(idx++, m);
      }
    }
    forestMesh.instanceMatrix.needsUpdate = true;
    decorGroup.add(forestMesh);
  }

  if (farms.length > 0 && lod === 'high') {
    const geom = new BoxGeometry(HEX_SIZE * 0.35, 1.5, HEX_SIZE * 0.25);
    const mat = new MeshLambertMaterial({ color: new Color(0x4a7038) });
    farmMesh = new InstancedMesh(geom, mat, farms.length);
    farms.forEach((tile, i) => {
      const elev = terrainElevation(tile.terrain);
      const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
      pos.y += 1;
      const m = new Matrix4().makeTranslation(pos.x, pos.y, pos.z);
      farmMesh!.setMatrixAt(i, m);
    });
    farmMesh.instanceMatrix.needsUpdate = true;
    decorGroup.add(farmMesh);
  }
}

export function clearTileDecor(): void {
  while (decorGroup.children.length > 0) {
    const child = decorGroup.children[0]!;
    decorGroup.remove(child);
    if ('geometry' in child && child.geometry) {
      (child as InstancedMesh).geometry.dispose();
    }
    if ('material' in child && child.material) {
      const mat = (child as InstancedMesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  }
  mountainMesh = null;
  forestMesh = null;
  farmMesh = null;
}

export function setDecorVisible(visible: boolean): void {
  decorGroup.visible = visible;
}

/** @internal test hook */
export function _terrainNeedsDecor(terrain: Terrain): boolean {
  return terrain === 'mountain' || terrain === 'forest' || terrain === 'plains';
}
