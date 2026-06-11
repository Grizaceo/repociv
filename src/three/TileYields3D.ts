// ─── Resource yield icons (CSS2D, aligned with flat-mode thresholds) ───────
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Group } from 'three';
import { type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const yieldGroup = new Group();
yieldGroup.name = 'tile-yields';

let lastSignature = '';

export function getTileYieldsGroup(): Group {
  return yieldGroup;
}

function yieldSignature(tiles: Tile[], lod: string, show: boolean): string {
  if (!show || lod === 'low') return 'off';
  return tiles
    .filter((t) => t.revealed)
    .map((t) => {
      const r = t.resources;
      return `${tileKey(t.coord)}:${r.gold}:${r.science}:${r.production}`;
    })
    .join('|');
}

function iconsForTile(tile: Tile): string[] {
  const res = tile.resources;
  const icons: string[] = [];
  if (res.gold >= 8) icons.push('🪙');
  if (res.science >= 4) icons.push('⚗');
  if (res.production >= 3) icons.push('⚙');
  return icons;
}

function makeYieldLabel(text: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = 'map-yield-icon';
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 0.5);
  return obj;
}

function clearYields(): void {
  while (yieldGroup.children.length > 0) {
    yieldGroup.remove(yieldGroup.children[0]!);
  }
}

export function rebuildTileYields(
  tiles: Tile[],
  lod: 'low' | 'medium' | 'high',
  showStructure: boolean,
): void {
  const sig = yieldSignature(tiles, lod, showStructure);
  if (sig === lastSignature) return;
  lastSignature = sig;
  clearYields();

  if (!showStructure || lod === 'low') return;

  for (const tile of tiles) {
    if (!tile.revealed) continue;
    const icons = iconsForTile(tile);
    if (icons.length === 0) continue;

    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    pos.y += HEX_SIZE * 0.12;

    const spacing = HEX_SIZE * 0.14;
    const startX = -((icons.length - 1) * spacing) / 2;
    icons.forEach((icon, i) => {
      const label = makeYieldLabel(icon);
      label.position.set(pos.x + startX + i * spacing, pos.y, pos.z);
      yieldGroup.add(label);
    });
  }
}

export function clearTileYields(): void {
  clearYields();
  lastSignature = '';
}
