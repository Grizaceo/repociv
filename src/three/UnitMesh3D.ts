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
import { areUnitPropsReady, getUnitPropParts } from './UnitProps3D.ts';

const unitGroup = new Group();
unitGroup.name = 'units';

let lastSignature = '';
const unitObjects: Mesh[][] = [];

export function getUnitGroup(): Group {
  return unitGroup;
}

const HERO_TYPES = new Set(['hero', 'lexo', 'claude', 'codex', 'cursor', 'openclaw']);

/** Forge GLB figurine: shared geometry, per-unit tinted material clones.
 *  The body keeps the sculpted GLB shading and lerps toward the agent
 *  color (Civ V piece + player color in one), the banner takes the full
 *  agent color so ownership reads at distance. */
function buildGlbFigurine(isHero: boolean, col: Color): Group {
  const group = new Group();
  const parts = getUnitPropParts()!;
  parts.forEach((part, i) => {
    const mat = (part.material as MeshStandardMaterial).clone();
    // Part 0 is the body cylinder; later parts (banner cone, head) carry
    // the accent material in the forge build.
    if (i === 0) {
      mat.color.lerp(col, 0.45);
      mat.emissive.copy(col);
      mat.emissiveIntensity = isHero ? 0.40 : 0.22;
    } else {
      mat.color.copy(col);
      mat.emissive.copy(col);
      mat.emissiveIntensity = isHero ? 0.55 : 0.35;
    }
    const mesh = new Mesh(part.geometry, mat);
    mesh.applyMatrix4(part.matrix);
    mesh.userData.sharedGeometry = true;
    mesh.castShadow = true;
    group.add(mesh);
  });
  // GLB is ~1.1 Blender units tall (scale baked); bring it to the same
  // visual height as the old procedural figurine (~0.33 × HEX_SIZE).
  const s = HEX_SIZE * (isHero ? 0.36 : 0.30);
  group.scale.setScalar(s);
  // Outer wrapper stays unscaled so the hero crown keeps absolute sizing.
  const wrapper = new Group();
  wrapper.add(group);
  return wrapper;
}

/** Floating gem + halo above the figurine (hero identity marker). */
function addHeroCrown(group: Group, col: Color, gemY: number): void {
  const gemMat = new MeshStandardMaterial({
    color: col,
    emissive: col,
    emissiveIntensity: 1.2,
    roughness: 0.1,
    metalness: 0.8,
  });
  const gemGeom = new OctahedronGeometry(HEX_SIZE * 0.055);
  const gem = new Mesh(gemGeom, gemMat);
  gem.position.y = gemY;
  gem.rotation.y = Math.PI / 4;
  group.add(gem);

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
  halo.position.y = gemY;
  halo.rotation.x = Math.PI / 2;
  group.add(halo);
}

function buildUnitFigurine(unit: Unit): Group {
  const col = new Color(unit.color || '#888888');
  const isHero = HERO_TYPES.has(unit.type);

  if (areUnitPropsReady()) {
    const group = buildGlbFigurine(isHero, col);
    if (isHero) addHeroCrown(group, col, HEX_SIZE * 0.46);
    return group;
  }

  const group = new Group();

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
    addHeroCrown(group, col, head.position.y + headR + HEX_SIZE * 0.10);
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

  // The props flag participates so the capsule→GLB swap happens the frame
  // the async load finishes, even when no unit moved.
  const signature = `uprops${areUnitPropsReady() ? 1 : 0}#` + visibleUnits
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
        // GLB part geometries are shared across all units (UnitProps3D
        // owns them); only the per-unit material clones are disposable.
        if (!m.userData.sharedGeometry) m.geometry.dispose();
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
