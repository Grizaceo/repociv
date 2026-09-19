// ─── CSS2D city / district labels for WebGL map ─────────────────────────────
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Group, Scene, Vector3 } from 'three';
import { type GameState } from '../game.ts';
import { type Tile, tileKey, type WonderType } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

/** Short, all-caps label for a wonder type. Matches the 2D canvas style
 *  (renderer.ts) so the WebGL and 2D views agree on what the wonder reads as:
 *  the district name, which is the manifest title. */
function wonderLabel(t: WonderType, fallbackName?: string): string | null {
  if (t === 'gaceta') return null; // native, no tile
  const name = (fallbackName ?? '').trim();
  return name ? name.toUpperCase() : null;
}

const labelGroup = new Group();
labelGroup.name = 'map-labels';

/** World-space lift of a city banner's anchor (its bottom edge) above the
 *  tile. TileYields3D anchors the city yield row at this same point and lets
 *  CSS stack it above the banner box. */
export const CITY_BANNER_LIFT = HEX_SIZE * 0.35;

let cssRenderer: CSS2DRenderer | null = null;
let lastSignature = '';

export function initLabelRenderer(container: HTMLElement): CSS2DRenderer {
  if (cssRenderer) return cssRenderer;
  cssRenderer = new CSS2DRenderer();
  cssRenderer.setSize(container.clientWidth, container.clientHeight);
  cssRenderer.domElement.style.position = 'absolute';
  cssRenderer.domElement.style.inset = '0';
  cssRenderer.domElement.style.pointerEvents = 'none';
  cssRenderer.domElement.style.zIndex = '1';
  container.appendChild(cssRenderer.domElement);
  return cssRenderer;
}

export function getLabelGroup(): Group {
  return labelGroup;
}

function makeLabel(text: string, className: string, priority = 1): CSS2DObject {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  obj.userData['priority'] = priority;
  return obj;
}

function makeCityBanner(city: {
  name: string;
  population: number;
  isCapital: boolean;
}): CSS2DObject {
  const root = document.createElement('div');
  root.className = city.isCapital
    ? 'map-label-banner map-label-banner-capital'
    : 'map-label-banner';

  const nameEl = document.createElement('div');
  nameEl.className = 'map-label-banner-name';
  nameEl.textContent = city.isCapital ? `★ ${city.name}` : city.name;

  const popEl = document.createElement('div');
  popEl.className = 'map-label-banner-pop';
  popEl.textContent = String(city.population);

  root.appendChild(nameEl);
  root.appendChild(popEl);

  const obj = new CSS2DObject(root);
  obj.center.set(0.5, 1);
  // Capitals outrank cities, cities outrank districts: when two labels fight
  // for the same pixels the more important one survives.
  obj.userData['priority'] = city.isCapital ? 3 : 2;
  return obj;
}

function clearLabels(): void {
  while (labelGroup.children.length > 0) {
    labelGroup.remove(labelGroup.children[0]!);
  }
}

function labelSignature(state: GameState, lod: string, show: boolean): string {
  if (!show) return 'off';
  // Include wonder tiles in the signature so the wonder labels rebuild when
  // the set of wonder districts changes.
  const wonderSig = Array.from(state.world.tiles.values())
    .filter((t) => t.revealed && t.district?.type === 'wonder' && t.district.wonderType)
    .map((t) => `${tileKey(t.coord)}:${t.district!.wonderType}`)
    .join('|');
  return `${lod}:${state.world.cities.map((c) => `${c.id}:${c.name}:${c.population}`).join('|')}:wonders[${wonderSig}]`;
}

export function rebuildMapLabels(
  scene: Scene,
  state: GameState,
  lod: 'low' | 'medium' | 'high',
  showLabels: boolean,
  getTile: (key: string) => Tile | undefined,
): void {
  const sig = labelSignature(state, lod, showLabels);
  if (sig === lastSignature) return;
  lastSignature = sig;
  clearLabels();

  if (!showLabels || lod === 'low') {
    if (!labelGroup.parent) scene.add(labelGroup);
    return;
  }

  for (const city of state.world.cities) {
    const tile = getTile(tileKey(city.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const pos = axialToWorld3D(city.coord.q, city.coord.r, elev);
    pos.y += CITY_BANNER_LIFT;

    const label = makeCityBanner(city);
    label.position.copy(pos);
    labelGroup.add(label);

    if (lod === 'high' && city.districts && city.districts.length > 0) {
      for (const dist of city.districts) {
        const dt = getTile(tileKey(dist.coord));
        const de = dt ? terrainElevation(dt.terrain) : elev;
        const dp = axialToWorld3D(dist.coord.q, dist.coord.r, de);
        dp.y += HEX_SIZE * 0.2;
        const dlabel = makeLabel(dist.name, 'map-label map-label-district');
        dlabel.position.copy(dp);
        labelGroup.add(dlabel);
      }
    }

    if (tile?.skillHealth) {
      const health = tile.skillHealth;
      const icon = '⚡';
      const cls =
        health === 'ok'
          ? 'map-label map-label-health-ok'
          : health === 'stale'
            ? 'map-label map-label-health-stale'
            : 'map-label map-label-health-broken';
      const hp = axialToWorld3D(city.coord.q, city.coord.r, elev);
      hp.y += HEX_SIZE * 0.55;
      hp.x += HEX_SIZE * 0.45;
      const hlabel = makeLabel(icon, cls);
      hlabel.position.copy(hp);
      labelGroup.add(hlabel);
    }
  }

  // Wonder labels — one banner per district tile where district.type==='wonder'.
  // Sits above the structure (the dais top) so the label doesn't overlap the
  // gem/glow on the apex.
  for (const tile of state.world.tiles.values()) {
    if (!tile.revealed) continue;
    if (tile.district?.type !== 'wonder' || !tile.district.wonderType) continue;
    const label = wonderLabel(tile.district.wonderType, tile.district.name);
    if (!label) continue;
    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);
    pos.y += HEX_SIZE * 0.65;
    const lbl = makeLabel(label, 'map-label map-label-wonder');
    lbl.position.copy(pos);
    labelGroup.add(lbl);
  }

  if (!labelGroup.parent) scene.add(labelGroup);
}

/** Screen band the HUD owns at the top of the viewport: the resource strip and
 *  the hotkey ribbon. A 3D label projected into it collides with chrome the
 *  user needs, so it is dropped rather than drawn behind. */
const HUD_TOP_BAND_PX = 78;
/** Extra breathing room around each kept label before the next one is culled. */
const LABEL_GUTTER_PX = 6;

const _projected = new Vector3();

/** Cached element size. Reading offsetWidth per label per frame forces a
 *  layout flush and stalls the render loop; labels only change size when their
 *  text changes, which happens on rebuild, not per frame. */
function labelSize(el: HTMLElement): { w: number; h: number } {
  const cached = (el as HTMLElement & { _rcSize?: { w: number; h: number } })._rcSize;
  if (cached && cached.w > 0) return cached;
  const size = { w: el.offsetWidth, h: el.offsetHeight };
  (el as HTMLElement & { _rcSize?: { w: number; h: number } })._rcSize = size;
  return size;
}

/** Hide labels that land under the HUD or on top of a higher-priority label.
 *
 *  Civ V never draws two overlapping place names; without this the map's top
 *  strip turns into a pile of repo names stacked on the hotkey ribbon, which is
 *  exactly what a 10-repo workspace produced. Positions come from projecting
 *  the label's world position — no getBoundingClientRect, so no layout thrash. */
function declutterLabels(camera: import('three').Camera, width: number, height: number): void {
  type Box = { l: number; t: number; r: number; b: number };
  const kept: Box[] = [];

  const entries = labelGroup.children
    .filter((o): o is CSS2DObject => o instanceof CSS2DObject)
    .map((obj) => {
      _projected.setFromMatrixPosition(obj.matrixWorld).project(camera);
      return {
        obj,
        el: obj.element as HTMLElement,
        priority: (obj.userData['priority'] as number) ?? 1,
        x: (_projected.x * 0.5 + 0.5) * width,
        y: (-_projected.y * 0.5 + 0.5) * height,
        behind: _projected.z > 1,
      };
    })
    // Highest priority first, then top-down, so the survivor of an overlap is
    // deterministic across frames and labels don't flicker as the camera moves.
    .sort((a, b) => b.priority - a.priority || a.y - b.y);

  for (const e of entries) {
    if (e.behind) {
      e.el.style.visibility = 'hidden';
      continue;
    }
    const { w, h } = labelSize(e.el);
    // center is (0.5, 1): the anchor sits at the label's bottom edge.
    const box: Box = {
      l: e.x - w / 2 - LABEL_GUTTER_PX,
      t: e.y - h - LABEL_GUTTER_PX,
      r: e.x + w / 2 + LABEL_GUTTER_PX,
      b: e.y + LABEL_GUTTER_PX,
    };
    const underHud = box.t < HUD_TOP_BAND_PX;
    const collides = kept.some((k) => box.l < k.r && box.r > k.l && box.t < k.b && box.b > k.t);
    if (underHud || collides) {
      e.el.style.visibility = 'hidden';
      continue;
    }
    e.el.style.visibility = '';
    kept.push(box);
  }
}

export function renderLabels(
  scene: Scene,
  camera: import('three').Camera,
  width: number,
  height: number,
): void {
  if (!cssRenderer) return;
  cssRenderer.setSize(width, height);
  cssRenderer.render(scene, camera);
  declutterLabels(camera, width, height);
}

export function disposeLabels(_container: HTMLElement): void {
  clearLabels();
  lastSignature = '';
  if (cssRenderer) {
    cssRenderer.domElement.remove();
    cssRenderer = null;
  }
}
