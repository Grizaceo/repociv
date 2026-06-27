// ─── Tile popup: 3D billboard showing city info on tile click ───────────────
// When a tile is inspected (clicked), a CSS2D popup appears above the tile
// showing city name, yields, garrison, and owner. The popup is positioned
// in 3D world space and faces the camera (CSS2D billboards always face the
// camera by default). The popup auto-dismisses after a few seconds or when
// another tile is clicked.
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Group } from 'three';
import { type Tile, type City, type Unit } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { escapeHtml } from '../ui/escapeHtml.ts';

const popupGroup = new Group();
popupGroup.name = 'tile-popup';

let activePopup: CSS2DObject | null = null;

export function getTilePopupGroup(): Group {
  return popupGroup;
}

/** Show a popup for a tile. Replaces any existing popup. */
export function showTilePopup(
  tile: Tile,
  coord: { q: number; r: number },
  city: City | undefined,
  garrison: Unit[],
): void {
  clearTilePopup();

  const elev = terrainElevation(tile.terrain);
  const pos = axialToWorld3D(coord.q, coord.r, elev);
  pos.y += HEX_SIZE * 0.6;

  const el = document.createElement('div');
  el.className = 'tile-popup-3d';

  const yields = tile.resources;
  const cityName = city?.name ?? 'Unclaimed';
  const owner = city?.isCapital ? 'Capital' : city ? 'City' : 'Wilderness';
  const garrisonCount = garrison.length;

  el.innerHTML = `
    <div class="tile-popup-header">${escapeHtml(cityName)}</div>
    <div class="tile-popup-row"><span class="tile-popup-label">Owner</span><span class="tile-popup-value">${escapeHtml(owner)}</span></div>
    <div class="tile-popup-row"><span class="tile-popup-label">Gold</span><span class="tile-popup-value">${yields.gold}</span></div>
    <div class="tile-popup-row"><span class="tile-popup-label">Science</span><span class="tile-popup-value">${yields.science}</span></div>
    <div class="tile-popup-row"><span class="tile-popup-label">Prod</span><span class="tile-popup-value">${yields.production}</span></div>
    <div class="tile-popup-row"><span class="tile-popup-label">Garrison</span><span class="tile-popup-value">${garrisonCount}</span></div>
  `;

  const obj = new CSS2DObject(el);
  obj.position.set(pos.x, pos.y, pos.z);
  obj.center.set(0.5, 0.5);
  activePopup = obj;
  popupGroup.add(obj);
}

export function clearTilePopup(): void {
  if (activePopup) {
    popupGroup.remove(activePopup);
    // CSS2DObject elements need manual DOM cleanup.
    const el = activePopup.element;
    if (el.parentNode) el.parentNode.removeChild(el);
    activePopup = null;
  }
}

/** Check if a popup is currently shown. */
export function isPopupVisible(): boolean {
  return activePopup !== null;
}
