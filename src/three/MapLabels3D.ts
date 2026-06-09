// ─── CSS2D city / district labels for WebGL map ─────────────────────────────
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Group, Scene } from 'three';
import { type GameState } from '../game.ts';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const labelGroup = new Group();
labelGroup.name = 'map-labels';

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

function makeLabel(text: string, className: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  return obj;
}

function clearLabels(): void {
  while (labelGroup.children.length > 0) {
    labelGroup.remove(labelGroup.children[0]!);
  }
}

function labelSignature(state: GameState, lod: string, show: boolean): string {
  if (!show) return 'off';
  return `${lod}:${state.world.cities.map((c) => `${c.id}:${c.name}`).join('|')}`;
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
    pos.y += HEX_SIZE * 0.35;

    const name = city.isCapital ? `★ ${city.name}` : city.name;
    const label = makeLabel(name, city.isCapital ? 'map-label map-label-capital' : 'map-label');
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

  if (!labelGroup.parent) scene.add(labelGroup);
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
}

export function disposeLabels(_container: HTMLElement): void {
  clearLabels();
  lastSignature = '';
  if (cssRenderer) {
    cssRenderer.domElement.remove();
    cssRenderer = null;
  }
}

/** @internal */
export function _cityLabelText(city: City): string {
  return city.isCapital ? `★ ${city.name}` : city.name;
}
