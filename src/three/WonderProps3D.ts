// ─── RepoCiv — Wonder 3D props (Blender GLB + procedural fallback) ───────────
//
// Renders a neutral monument on every district.type==='wonder' tile, replacing
// the generic "sacred tile" decor that `buildSacred()` in TileDecor3D produces.
//
// Pattern mirrors CityProps3D.ts: a single Group, dirty-check by tile signature,
// `rebuildWonderProps(tiles)` rebuilds only on signature change, `clearWonderProps()`
// disposes cleanly. Wonders are user-connected iframe services, so there is no
// per-product model — the procedural builder below carries the silhouette and
// visibility follows the `structure` layer.

import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  Color,
  Vector3,
} from 'three';
import { type Tile } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { PROP_SURFACE_CLEARANCE, terrainSurfaceY } from './terrainSurfaceY.ts';

const wonderGroup = new Group();
wonderGroup.name = 'wonder-props';

let lastSignature = '';
const activeMeshes: Mesh[] = [];

// Holds every connected wonder — rendered with a neutral monument silhouette.
const genericGroup = new Group();
genericGroup.name = 'wonder-generic';
wonderGroup.add(genericGroup);

export function getWonderPropsGroup(): Group {
  return wonderGroup;
}

export function areWonderPropsReady(): boolean {
  return true; // procedural — a wonder can always be drawn
}

/** Debug/capture probe: procedural props have no async load, so they are
 *  settled as soon as the module is live. Kept as a named probe because the
 *  screenshot tooling waits on it before framing a shot. */
export function areWonderPropsSettled(): boolean {
  return true;
}

// ─── Procedural geometries ───────────────────────────────────────────────────

/**
 * Connected wonder — neutral monument for any user-defined iframe service.
 * Stepped dais + central faceted spire + emissive crystal node so it reads as
 * "a wonder" without claiming a specific identity. Uses flat-shaded low-poly
 * geometry (iter13 style) instead of smooth cones/spheres.
 */
function buildGenericWonder(): Group {
  const g = new Group();
  g.name = 'wonder-generic-inst';

  const stoneMat = new MeshStandardMaterial({
    color: new Color(0xb9b2a4),
    roughness: 0.74,
    metalness: 0.06,
  });
  const spireMat = new MeshStandardMaterial({
    color: new Color(0x9aa0ad),
    roughness: 0.5,
    metalness: 0.16,
    flatShading: true,
  });
  const nodeMat = new MeshStandardMaterial({
    color: new Color(0x7fb0e8),
    emissive: new Color(0x2f6fae),
    emissiveIntensity: 0.6,
    roughness: 0.2,
    metalness: 0.3,
    transparent: true,
    opacity: 0.82,
    flatShading: true,
  });

  // 2-tier dais
  const daisHeights = [0.05, 0.05];
  const daisRadii = [0.38, 0.28];
  let stacked = 0;
  for (let i = 0; i < 2; i++) {
    const h = HEX_SIZE * daisHeights[i]!;
    const r = HEX_SIZE * daisRadii[i]!;
    const dais = new Mesh(new CylinderGeometry(r, r * 1.05, h, 6), stoneMat);
    dais.position.y = stacked + h * 0.5;
    dais.castShadow = true;
    dais.receiveShadow = true;
    g.add(dais);
    stacked += h;
  }

  // Central spire — a faceted hex tower tapering to a point, replacing the
  // old 4-sided smooth cone. flatShading + 6 segments gives the craggy
  // obelisk silhouette the iter13 style demands.
  const spireH = HEX_SIZE * 0.42;
  const spireTopR = HEX_SIZE * 0.015;
  const spireBaseR = HEX_SIZE * 0.07;
  const spire = new Mesh(new CylinderGeometry(spireTopR, spireBaseR, spireH, 6), spireMat);
  spire.position.y = stacked + spireH * 0.5;
  spire.castShadow = true;
  g.add(spire);

  // Emissive crystal at the apex — an octahedron reads as a faceted gem
  // instead of the old smooth sphere that looked like a marble.
  const node = new Mesh(new OctahedronGeometry(HEX_SIZE * 0.06, 0), nodeMat);
  node.position.y = stacked + spireH + HEX_SIZE * 0.03;
  g.add(node);

  return g;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function wonderSignature(tiles: Tile[]): string {
  return tiles
    .filter((t) => t.revealed && t.district?.type === 'wonder' && t.district.wonderType)
    .map((t) => `${t.coord.q},${t.coord.r}:${t.district!.wonderType}`)
    .join('|');
}

function disposeMesh(m: Mesh): void {
  m.geometry.dispose();
  const mat = m.material;
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat.dispose();
}

function clearGroupContents(g: Group): void {
  while (g.children.length > 0) {
    const child = g.children[0] as Mesh | Group;
    g.remove(child);
    if ((child as Mesh).isMesh) {
      disposeMesh(child as Mesh);
    } else {
      // nested Group: recurse to dispose meshes
      (child as Group).traverse((obj) => {
        if ((obj as Mesh).isMesh) disposeMesh(obj as Mesh);
      });
    }
  }
  activeMeshes.length = 0;
}

export function rebuildWonderProps(tiles: Tile[]): void {
  if (tiles.length === 0) {
    clearGroupContents(genericGroup);
    lastSignature = '';
    return;
  }

  const sig = wonderSignature(tiles);
  if (sig === lastSignature) return;
  lastSignature = sig;

  clearGroupContents(genericGroup);

  // Build each wonder instance at its tile centre
  for (const tile of tiles) {
    if (!tile.revealed) continue;
    if (tile.district?.type !== 'wonder' || !tile.district.wonderType) continue;

    const elev = terrainElevation(tile.terrain);
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, elev);

    // 'gaceta' is native (no server, no structure) — never rendered as a prop
    // even if some tile carried it.
    if (tile.district.wonderType === 'gaceta') continue;

    const wonderY = terrainSurfaceY(tile) + PROP_SURFACE_CLEARANCE;
    const inst = buildGenericWonder();
    inst.position.set(pos.x, wonderY, pos.z);
    genericGroup.add(inst);
  }
}

export function clearWonderProps(): void {
  clearGroupContents(genericGroup);
  lastSignature = '';
}

/** Wonder prop visibility — follows the `structure` layer. */
export function setWonderVisible(visible: boolean): void {
  genericGroup.visible = visible;
}

/** @internal test hook — exposes the current signature so tests can assert
 *  that rebuilds happen exactly when wonder tiles change. */
export function _wonderPropsSignature(): string {
  return lastSignature;
}

// Internal references kept to satisfy strict unused-var checks in
// some bundlers. These are imported by HexWorldScene for the dirty
// signature (toggled by `areWonderPropsReady()`).
const _vec = new Vector3();
void _vec;
