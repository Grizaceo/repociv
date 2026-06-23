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
  IcosahedronGeometry,
  OctahedronGeometry,
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
  // Warm bronze-terracotta roof — the old cold blue-grey (0x8a9bb0) read as a
  // stray grey blob perched on the columns; a warm roof tone contrasts with
  // the cream stone and clearly says "roof".
  const roofMat = new MeshStandardMaterial({
    color: new Color(0xb06a3a),
    roughness: 0.55,
    metalness: 0.15,
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

  const colTop = topDais + colH;

  // Entablature: a hexagonal frieze band capping the colonnade, tying the six
  // columns into one temple top. Replaces the loose triangular pediment that
  // sat askew on the hex ring and read as a stray wedge.
  const entR = HEX_SIZE * 0.255;
  const entH = HEX_SIZE * 0.055;
  const entablature = new Mesh(
    new CylinderGeometry(entR, entR * 1.04, entH, 6),
    colMat,
  );
  entablature.position.y = colTop + entH * 0.5;
  entablature.rotation.y = Math.PI / 6; // hex flats face the column gaps
  entablature.castShadow = true;
  g.add(entablature);

  // Roof: a clean six-sided low pyramid with eaves overhanging the
  // entablature. Its hexagonal base matches the column ring, so it reads as a
  // proper tholos/temple roof instead of a mismatched flat triangle.
  const roofR = HEX_SIZE * 0.30;
  const roofH = HEX_SIZE * 0.21;
  const roof = new Mesh(new ConeGeometry(roofR, roofH, 6), roofMat);
  roof.position.y = colTop + entH + roofH * 0.5;
  roof.rotation.y = Math.PI / 6;
  roof.castShadow = true;
  g.add(roof);

  // Glow gem finial at the roof apex — faceted octahedron for consistency
  // with the iter13 flat-shaded style (the old small sphere read as a marble).
  const gem = new Mesh(
    new OctahedronGeometry(HEX_SIZE * 0.05, 0),
    gemMat,
  );
  gem.position.y = colTop + entH + roofH + HEX_SIZE * 0.03;
  g.add(gem);

  return g;
}

/**
 * Institutum Scientiarum (LabHub) — laboratorium silhouette.
 * Stepped dais + 4 corner spires (faceted hex towers, not smooth cones) +
 * central faceted dome (low-poly icosahedron, not smooth sphere) + large
 * emissive crystal (octahedron, not smooth sphere) at the top.
 * Echoes the 2D canvas flask (renderer.ts:624-766).
 */
function buildInstitutum(): Group {
  const g = new Group();
  g.name = 'institutum';

  const daisMat = new MeshStandardMaterial({
    color: new Color(0xb5a892),
    roughness: 0.72,
    metalness: 0.06,
  });
  const spireMat = new MeshStandardMaterial({
    color: new Color(0x6e7d5a),
    roughness: 0.55,
    metalness: 0.12,
    flatShading: true,
  });
  const domeMat = new MeshStandardMaterial({
    color: new Color(0xd4cba8),
    roughness: 0.45,
    metalness: 0.18,
    flatShading: true,
  });
  const glowMat = new MeshStandardMaterial({
    color: new Color(0x6bd8a8),
    emissive: new Color(0x2a9c70),
    emissiveIntensity: 0.65,
    roughness: 0.20,
    metalness: 0.25,
    transparent: true,
    opacity: 0.78,
    flatShading: true,
  });

  // Flat dais
  const daisH = HEX_SIZE * 0.05;
  const daisR = HEX_SIZE * 0.36;
  const dais  = new Mesh(new CylinderGeometry(daisR, daisR * 1.04, daisH, 6), daisMat);
  dais.position.y = daisH * 0.5;
  dais.castShadow = true;
  dais.receiveShadow = true;
  g.add(dais);

  // 4 corner spires — faceted hex towers that taper to a point, replacing
  // the old smooth 5-segment cones that read as paper wands. A 6-sided
  // cylinder with a low radialSegments + flatShading gives the craggy
  // obelisk silhouette the iter13 style demands.
  const spireH = HEX_SIZE * 0.36;
  const spireRTop = HEX_SIZE * 0.015;
  const spireRBase = HEX_SIZE * 0.055;
  const spireRing = HEX_SIZE * 0.26;
  for (let i = 0; i < 4; i++) {
    const ang = (Math.PI * 2 / 4) * i + Math.PI / 4;
    const spire = new Mesh(
      new CylinderGeometry(spireRTop, spireRBase, spireH, 6),
      spireMat,
    );
    spire.position.set(Math.cos(ang) * spireRing, daisH + spireH * 0.5, Math.sin(ang) * spireRing);
    spire.castShadow = true;
    g.add(spire);
  }

  // Central dome: a low-poly icosahedron (detail=0 → 20 flat triangles)
  // flattened to ~60% height so it reads as a dome, not a ball. The old
  // smooth SphereGeometry(12,8) was a perfect hemisphere that looked like
  // a plastic bowl under the warm PBR lights.
  const domeR = HEX_SIZE * 0.22;
  const domeGeom = new IcosahedronGeometry(domeR, 0);
  // Flatten vertically → dome shape
  domeGeom.scale(1, 0.55, 1);
  const dome = new Mesh(domeGeom, domeMat);
  dome.position.y = daisH + domeR * 0.55 * 0.5;
  dome.castShadow = true;
  g.add(dome);

  // Glow crystal at top of dome — an octahedron reads as a faceted gem,
  // not a smooth marble. The old SphereGeometry(10,8) was a polished orb.
  const glow = new Mesh(
    new OctahedronGeometry(HEX_SIZE * 0.08, 0),
    glowMat,
  );
  glow.position.y = daisH + domeR * 0.55 + HEX_SIZE * 0.04;
  g.add(glow);

  return g;
}

/**
 * Generic connected wonder — neutral monument for any user-defined iframe
 * service that isn't one of the two built-in examples. Stepped dais + central
 * faceted spire + emissive crystal node so it reads as "a wonder" without
 * claiming a specific identity. Deliberately distinct from the
 * temple/laboratorium. Uses flat-shaded low-poly geometry (iter13 style)
 * instead of smooth cones/spheres.
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
  const spire = new Mesh(
    new CylinderGeometry(spireTopR, spireBaseR, spireH, 6),
    spireMat,
  );
  spire.position.y = stacked + spireH * 0.5;
  spire.castShadow = true;
  g.add(spire);

  // Emissive crystal at the apex — an octahedron reads as a faceted gem
  // instead of the old smooth sphere that looked like a marble.
  const node = new Mesh(
    new OctahedronGeometry(HEX_SIZE * 0.06, 0),
    nodeMat,
  );
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
