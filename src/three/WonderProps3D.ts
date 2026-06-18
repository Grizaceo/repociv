// ─── RepoCiv — Wonder 3D props (procedural, low-poly, no asset deps) ─────────
//
// Distinguishes Bibliotheca (temple) and Institutum (laboratorium) as distinct
// 3D structures in the WebGL map, replacing the generic "sacred tile" decor
// that `buildSacred()` in TileDecor3D produces for every district.type==='wonder'.
//
// Pattern mirrors CityProps3D.ts: a single Group, dirty-check by tile signature,
// `rebuildWonderProps(tiles)` rebuilds only on signature change, `clearWonderProps()`
// disposes cleanly. Procedural-first (no GLB dependency) so this lands without
// the asset-forge pipeline; F7 (GLB swap-in) is a later optimisation.
//
// Layer gating: `setWonderVisible(type, visible)` toggles per-wonder visibility
// independently, matching the 2D canvas behaviour where bibliotheca gates on
// the `knowledge` layer and institutum on the `labs` layer.

import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Color,
  Vector3,
} from 'three';
import { type Tile } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const wonderGroup = new Group();
wonderGroup.name = 'wonder-props';

let lastSignature = '';
const activeMeshes: Mesh[] = [];

// Sub-groups so we can hide one wonder type independently of the other
const bibliothecaGroup = new Group();
bibliothecaGroup.name = 'wonder-bibliotheca';
const institutumGroup = new Group();
institutumGroup.name = 'wonder-institutum';
// Holds every user-connected wonder that isn't one of the two built-in
// examples — rendered with a neutral monument silhouette.
const genericGroup = new Group();
genericGroup.name = 'wonder-generic';
wonderGroup.add(bibliothecaGroup);
wonderGroup.add(institutumGroup);
wonderGroup.add(genericGroup);

export function getWonderPropsGroup(): Group {
  return wonderGroup;
}

export function areWonderPropsReady(): boolean {
  return true; // procedural — no async load
}

// ─── Procedural geometries ───────────────────────────────────────────────────

/**
 * Bibliotheca Alexandrina — temple silhouette.
 * 3-tier stepped dais + 6-column hex ring + low pediment + small emissive gem
 * at the apex. Echoes the 2D canvas temple (renderer.ts:624-766).
 */
function buildBibliotheca(): Group {
  const g = new Group();
  g.name = 'bibliotheca';

  const stoneMat = new MeshStandardMaterial({
    color: new Color(0xc9bfa6),
    roughness: 0.78,
    metalness: 0.04,
  });
  const colMat = new MeshStandardMaterial({
    color: new Color(0xe6dcc2),
    roughness: 0.62,
    metalness: 0.08,
  });
  const roofMat = new MeshStandardMaterial({
    color: new Color(0x8a9bb0),
    roughness: 0.50,
    metalness: 0.10,
  });
  const gemMat = new MeshStandardMaterial({
    color: new Color(0xe8c66a),
    emissive: new Color(0xa8842e),
    emissiveIntensity: 0.55,
    roughness: 0.18,
    metalness: 0.35,
    transparent: true,
    opacity: 0.85,
  });

  // 3-tier stepped dais (each smaller as it rises)
  const daisHeights = [0.04, 0.05, 0.05];
  const daisRadii   = [0.42, 0.34, 0.26];
  for (let i = 0; i < 3; i++) {
    const h = HEX_SIZE * daisHeights[i]!;
    const r = HEX_SIZE * daisRadii[i]!;
    const dais = new Mesh(new CylinderGeometry(r, r * 1.05, h, 6), stoneMat);
    dais.position.y = h * 0.5 + i * h;
    dais.castShadow = true;
    dais.receiveShadow = true;
    g.add(dais);
  }
  const topDais = HEX_SIZE * (daisHeights[0]! + daisHeights[1]! + daisHeights[2]!);

  // 6 columns on a hex ring at the top dais
  const colR    = HEX_SIZE * 0.030;
  const colH    = HEX_SIZE * 0.34;
  const colRing = HEX_SIZE * 0.20;
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI * 2 / 6) * i;
    const col = new Mesh(new CylinderGeometry(colR, colR, colH, 8), colMat);
    col.position.set(Math.cos(ang) * colRing, topDais + colH * 0.5, Math.sin(ang) * colRing);
    col.castShadow = true;
    g.add(col);
  }

  // Pediment: low triangular prism sitting on top of the columns, point up.
  // CylinderGeometry(0, pedW, pedH, 3, 1) is a 3-sided cone (point at y=+pedH/2,
  // base at y=-pedH/2). It already has the right vertical orientation by default
  // — no rotation needed. We narrow it in Z (scale.z = pedL/pedW) to make it
  // a flat triangular prism instead of a tetrahedral cone.
  const pedW = HEX_SIZE * 0.50;
  const pedH = HEX_SIZE * 0.08;
  const pedL = HEX_SIZE * 0.16;
  const ped  = new Mesh(new CylinderGeometry(0, pedW, pedH, 3, 1), roofMat);
  ped.scale.set(1, 1, pedL / pedW);
  ped.position.y = topDais + colH + pedH * 0.5;  // base sits flush on the columns
  ped.castShadow = true;
  g.add(ped);

  // Glow gem at apex
  const gem = new Mesh(
    new SphereGeometry(HEX_SIZE * 0.045, 8, 6),
    gemMat,
  );
  gem.position.y = topDais + colH + pedH + HEX_SIZE * 0.04;
  g.add(gem);

  return g;
}

/**
 * Institutum Scientiarum (LabHub) — laboratorium silhouette.
 * Flat dais + 4 corner obelisks + central dome + large emissive glow at the
 * top. Echoes the 2D canvas flask (renderer.ts:624-766).
 */
function buildInstitutum(): Group {
  const g = new Group();
  g.name = 'institutum';

  const daisMat = new MeshStandardMaterial({
    color: new Color(0xb5a892),
    roughness: 0.72,
    metalness: 0.06,
  });
  const obMat = new MeshStandardMaterial({
    color: new Color(0x6e7d5a),
    roughness: 0.55,
    metalness: 0.12,
  });
  const domeMat = new MeshStandardMaterial({
    color: new Color(0xd4cba8),
    roughness: 0.45,
    metalness: 0.18,
  });
  const glowMat = new MeshStandardMaterial({
    color: new Color(0x6bd8a8),
    emissive: new Color(0x2a9c70),
    emissiveIntensity: 0.65,
    roughness: 0.20,
    metalness: 0.25,
    transparent: true,
    opacity: 0.78,
  });

  // Flat dais
  const daisH = HEX_SIZE * 0.05;
  const daisR = HEX_SIZE * 0.36;
  const dais  = new Mesh(new CylinderGeometry(daisR, daisR * 1.04, daisH, 6), daisMat);
  dais.position.y = daisH * 0.5;
  dais.castShadow = true;
  dais.receiveShadow = true;
  g.add(dais);

  // 4 corner obelisks (tall thin cones) on the rim
  const obH = HEX_SIZE * 0.36;
  const obR = HEX_SIZE * 0.045;
  const obRing = HEX_SIZE * 0.26;
  for (let i = 0; i < 4; i++) {
    const ang = (Math.PI * 2 / 4) * i + Math.PI / 4;
    const ob  = new Mesh(new ConeGeometry(obR, obH, 5), obMat);
    ob.position.set(Math.cos(ang) * obRing, daisH + obH * 0.5, Math.sin(ang) * obRing);
    ob.castShadow = true;
    g.add(ob);
  }

  // Central dome (top half of a sphere, flat side down)
  const domeR = HEX_SIZE * 0.20;
  const dome  = new Mesh(
    new SphereGeometry(domeR, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    domeMat,
  );
  dome.position.y = daisH;
  dome.castShadow = true;
  g.add(dome);

  // Glow core at top of dome (the "experiment")
  const glow = new Mesh(
    new SphereGeometry(HEX_SIZE * 0.075, 10, 8),
    glowMat,
  );
  glow.position.y = daisH + domeR + HEX_SIZE * 0.02;
  g.add(glow);

  return g;
}

/**
 * Generic connected wonder — neutral monument for any user-defined iframe
 * service that isn't one of the two built-in examples. Stepped dais + central
 * obelisk + emissive node so it reads as "a wonder" without claiming a
 * specific identity. Deliberately distinct from the temple/laboratorium.
 */
function buildGenericWonder(): Group {
  const g = new Group();
  g.name = 'wonder-generic-inst';

  const stoneMat = new MeshStandardMaterial({
    color: new Color(0xb9b2a4),
    roughness: 0.74,
    metalness: 0.06,
  });
  const obMat = new MeshStandardMaterial({
    color: new Color(0x9aa0ad),
    roughness: 0.5,
    metalness: 0.16,
  });
  const nodeMat = new MeshStandardMaterial({
    color: new Color(0x7fb0e8),
    emissive: new Color(0x2f6fae),
    emissiveIntensity: 0.6,
    roughness: 0.2,
    metalness: 0.3,
    transparent: true,
    opacity: 0.82,
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

  // Central obelisk (tapered)
  const obH = HEX_SIZE * 0.42;
  const obelisk = new Mesh(new ConeGeometry(HEX_SIZE * 0.11, obH, 4), obMat);
  obelisk.position.y = stacked + obH * 0.5;
  obelisk.rotation.y = Math.PI / 4;
  obelisk.castShadow = true;
  g.add(obelisk);

  // Emissive node at the apex
  const node = new Mesh(new SphereGeometry(HEX_SIZE * 0.05, 8, 6), nodeMat);
  node.position.y = stacked + obH + HEX_SIZE * 0.03;
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
    clearGroupContents(bibliothecaGroup);
    clearGroupContents(institutumGroup);
    clearGroupContents(genericGroup);
    lastSignature = '';
    return;
  }

  const sig = wonderSignature(tiles);
  if (sig === lastSignature) return;
  lastSignature = sig;

  clearGroupContents(bibliothecaGroup);
  clearGroupContents(institutumGroup);
  clearGroupContents(genericGroup);

  // Build each wonder instance at its tile centre
  for (const tile of tiles) {
    if (!tile.revealed) continue;
    if (tile.district?.type !== 'wonder' || !tile.district.wonderType) continue;

    const elev = terrainElevation(tile.terrain);
    const pos  = axialToWorld3D(tile.coord.q, tile.coord.r, elev);

    // 'gaceta' is native (no server, no structure) — never rendered as a prop
    // even if some tile carried it.
    if (tile.district.wonderType === 'gaceta') continue;

    if (tile.district.wonderType === 'bibliotheca') {
      const inst = buildBibliotheca();
      inst.position.set(pos.x, pos.y, pos.z);
      bibliothecaGroup.add(inst);
    } else if (tile.district.wonderType === 'institutum') {
      const inst = buildInstitutum();
      inst.position.set(pos.x, pos.y, pos.z);
      institutumGroup.add(inst);
    } else {
      // Any user-connected wonder → neutral monument.
      const inst = buildGenericWonder();
      inst.position.set(pos.x, pos.y, pos.z);
      genericGroup.add(inst);
    }
  }
}

export function clearWonderProps(): void {
  clearGroupContents(bibliothecaGroup);
  clearGroupContents(institutumGroup);
  clearGroupContents(genericGroup);
  lastSignature = '';
}

/**
 * Per-wonder visibility — bibliotheca under `knowledge` layer, institutum
 * under `labs` layer, generic (user-connected) wonders under `structure`.
 * Mirrors the 2D canvas gating (renderer.ts:1190-1225).
 */
export function setWonderVisible(
  type: 'bibliotheca' | 'institutum' | 'generic',
  visible: boolean,
): void {
  if (type === 'bibliotheca') bibliothecaGroup.visible = visible;
  else if (type === 'institutum') institutumGroup.visible = visible;
  else genericGroup.visible = visible;
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
