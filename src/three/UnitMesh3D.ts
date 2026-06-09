// ─── Unit figurines: Civ V-style hero / unit markers ────────────────────────
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { type Unit, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const unitGroup = new Group();
unitGroup.name = 'units';

let lastSignature = '';
const unitObjects: Mesh[][] = [];

export function getUnitGroup(): Group {
  return unitGroup;
}

const HERO_TYPES = new Set(['hero', 'lexo', 'claude', 'codex', 'cursor', 'openclaw']);

function buildUnitFigurine(unit: Unit): Group {
  const group = new Group();
  const col = new Color(unit.color || '#888888');
  const isHero = HERO_TYPES.has(unit.type);

  const bodyMat = new MeshStandardMaterial({
    color: col,
    emissive: col,
    emissiveIntensity: isHero ? 0.45 : 0.25,
    roughness: 0.55,
    metalness: isHero ? 0.35 : 0.1,
  });

  // Base: flat disc (feet)
  const baseGeom = new CylinderGeometry(
    HEX_SIZE * 0.10, HEX_SIZE * 0.13, HEX_SIZE * 0.04, 8,
  );
  const base = new Mesh(baseGeom, bodyMat);
  base.position.y = HEX_SIZE * 0.02;
  base.castShadow = true;
  group.add(base);

  // Body: tapered cone torso
  const bodyGeom = new ConeGeometry(HEX_SIZE * 0.065, HEX_SIZE * 0.22, 8);
  const body = new Mesh(bodyGeom, bodyMat);
  body.position.y = HEX_SIZE * (0.04 + 0.11);
  body.castShadow = true;
  group.add(body);

  // Head: sphere
  const headR = HEX_SIZE * (isHero ? 0.072 : 0.058);
  const headGeom = new SphereGeometry(headR, 8, 6);
  const head = new Mesh(headGeom, bodyMat);
  head.position.y = HEX_SIZE * 0.04 + HEX_SIZE * 0.22 + headR;
  head.castShadow = true;
  group.add(head);

  if (isHero) {
    // Floating gem / crown above head — glowing octahedron
    const gemMat = new MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: 1.2,
      roughness: 0.1,
      metalness: 0.8,
    });
    const gemGeom = new OctahedronGeometry(HEX_SIZE * 0.055);
    const gem = new Mesh(gemGeom, gemMat);
    gem.position.y = head.position.y + headR + HEX_SIZE * 0.10;
    gem.rotation.y = Math.PI / 4;
    group.add(gem);

    // Thin halo ring around the gem
    const haloMat = new MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: 0.8,
      roughness: 0.3,
      metalness: 0.5,
      transparent: true,
      opacity: 0.65,
    });
    const haloGeom = new TorusGeometry(HEX_SIZE * 0.095, HEX_SIZE * 0.012, 4, 16);
    const halo = new Mesh(haloGeom, haloMat);
    halo.position.y = gem.position.y;
    halo.rotation.x = Math.PI / 2;
    group.add(halo);
  }

  return group;
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

  for (const unit of visibleUnits) {
    const tile = getTile(tileKey(unit.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const pos  = axialToWorld3D(unit.coord.q, unit.coord.r, elev);
    const fig  = buildUnitFigurine(unit);
    fig.position.set(pos.x, pos.y + HEX_SIZE * 0.05, pos.z);

    const meshes: Mesh[] = [];
    fig.traverse((child) => { if ((child as Mesh).isMesh) meshes.push(child as Mesh); });
    unitObjects.push(meshes);
    unitGroup.add(fig);
  }
}

export function clearUnits(): void {
  while (unitGroup.children.length > 0) {
    const child = unitGroup.children[0]!;
    unitGroup.remove(child);
    child.traverse((obj) => {
      const m = obj as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach((mt) => mt.dispose());
        else m.material.dispose();
      }
    });
  }
  unitObjects.length = 0;
}

export function setUnitsVisible(visible: boolean): void {
  unitGroup.visible = visible;
}
