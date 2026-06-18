// ─── Unit figurines: Civ V-style hero / unit markers ────────────────────────
// Lifecycle: rebuildUnits does incremental add/remove. New units enter a
// "spawning" state (scale 0→1, 300ms ease-out). Units that leave the visible
// set enter "despawning" (scale 1→0, 200ms ease-in) and are removed when the
// tween completes. tickUnits(animTime, dt) runs every frame to advance the
// tweens, idle pulse, and per-step walking hop — independent of the dirty
// rebuild cycle.
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

// ─── Per-unit lifecycle state ───────────────────────────────────────────────
type UnitLifeState = 'spawning' | 'alive' | 'despawning';

interface UnitEntry {
  group: Group;
  unitId: string;
  lifeState: UnitLifeState;
  /** Tween progress 0→1 for spawn, 1→0 for despawn. */
  tween: number;
  /** Per-unit phase offset for idle pulse so they don't all pulse in sync. */
  idlePhase: number;
  /** Current hop height (0 when grounded). */
  hopY: number;
  /** Whether this unit is currently moving (drives hop animation). */
  moving: boolean;
}

export type { UnitEntry, UnitLifeState };

const unitEntries = new Map<string, UnitEntry>();

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

/** Dispose all meshes inside a figurine group (materials always, geometries
 *  only if not shared GLB parts). */
function disposeFigurine(group: Group): void {
  group.traverse((obj) => {
    const m = obj as Mesh;
    if (m.isMesh) {
      if (!m.userData.sharedGeometry) m.geometry.dispose();
      if (Array.isArray(m.material)) m.material.forEach((mt) => mt.dispose());
      else m.material.dispose();
    }
  });
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

  // ── Incremental update: mark missing units for despawn, add new ones ──────
  const visibleIds = new Set(visibleUnits.map((u) => u.id));

  // Mark removed units as despawning (they finish their tween in tickUnits).
  for (const [id, entry] of unitEntries) {
    if (!visibleIds.has(id) && entry.lifeState !== 'despawning') {
      entry.lifeState = 'despawning';
      entry.tween = 1; // start at full scale, shrink to 0
    }
  }

  // Add or reposition visible units.
  const newUnitObjects: Mesh[][] = [];
  for (const unit of visibleUnits) {
    const tile = getTile(tileKey(unit.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const pos  = axialToWorld3D(unit.coord.q, unit.coord.r, elev);
    const targetY = pos.y + HEX_SIZE * 0.05;

    const existing = unitEntries.get(unit.id);
    if (existing && existing.lifeState !== 'despawning') {
      // Reposition existing unit (smooth lerp handled in tickUnits for moving
      // state; instant snap for teleports / non-moving repositions).
      existing.group.position.set(pos.x, targetY, pos.z);
      existing.moving = unit.state === 'moving';
      // Collect meshes for shadow/picking consumers.
      const meshes: Mesh[] = [];
      existing.group.traverse((child) => {
        if ((child as Mesh).isMesh) meshes.push(child as Mesh);
      });
      newUnitObjects.push(meshes);
      continue;
    }

    // New unit: build figurine, start at scale 0 for spawn animation.
    const fig = buildUnitFigurine(unit);
    fig.position.set(pos.x, targetY, pos.z);
    fig.scale.setScalar(0);

    const meshes: Mesh[] = [];
    fig.traverse((child) => { if ((child as Mesh).isMesh) meshes.push(child as Mesh); });

    const entry: UnitEntry = {
      group: fig,
      unitId: unit.id,
      lifeState: 'spawning',
      tween: 0,
      idlePhase: Math.random() * Math.PI * 2,
      hopY: 0,
      moving: unit.state === 'moving',
    };
    unitEntries.set(unit.id, entry);
    unitGroup.add(fig);
    newUnitObjects.push(meshes);
  }

  // Rebuild unitObjects from all alive+spawning+despawning entries.
  // Despawning entries keep their meshes in the array until removed.
  unitObjects.length = 0;
  for (const entry of unitEntries.values()) {
    if (entry.lifeState === 'despawning') {
      const meshes: Mesh[] = [];
      entry.group.traverse((child) => {
        if ((child as Mesh).isMesh) meshes.push(child as Mesh);
      });
      unitObjects.push(meshes);
    }
  }
  for (const meshes of newUnitObjects) {
    unitObjects.push(meshes);
  }
}

/** Easing functions for lifecycle tweens. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function easeInCubic(t: number): number {
  return t * t * t;
}

// Spawn/despawn durations (seconds).
const SPAWN_DURATION = 0.30;
const DESPAWN_DURATION = 0.20;
// Idle pulse: 1.05× scale on base ring every 4s.
const IDLE_PULSE_PERIOD = 4.0;
const IDLE_PULSE_SCALE = 1.05;
// Walking hop: 12px up, 200ms ease-in-out per step.
const HOP_HEIGHT = 12;
const HOP_DURATION = 0.20;

/** Per-frame animation: spawn/despawn tweens, idle pulse, walking hop.
 *  Called every frame from updateHexWorldScene, independent of dirty state.
 *  When animTime is frozen (golden capture), dt=0 so tweens freeze too. */
export function tickUnits(animTime: number, dt: number): void {
  const toRemove: string[] = [];

  for (const [id, entry] of unitEntries) {
    if (entry.lifeState === 'spawning') {
      entry.tween += dt / SPAWN_DURATION;
      if (entry.tween >= 1) {
        entry.tween = 1;
        entry.lifeState = 'alive';
      }
      const s = easeOutCubic(entry.tween);
      entry.group.scale.setScalar(s);
    } else if (entry.lifeState === 'despawning') {
      entry.tween -= dt / DESPAWN_DURATION;
      if (entry.tween <= 0) {
        // Tween complete: remove the unit.
        unitGroup.remove(entry.group);
        disposeFigurine(entry.group);
        toRemove.push(id);
        continue;
      }
      const s = easeInCubic(entry.tween);
      entry.group.scale.setScalar(s);
    } else {
      // Alive: idle pulse + walking hop.
      // The idle pulse is a subtle scale oscillation on the whole figurine.
      // We bake it into the group scale so it composes with spawn/despawn.
      // For alive units, scale is always 1.0 base + pulse.
      const pulse = 1 + (IDLE_PULSE_SCALE - 1) * 0.5 * (1 + Math.sin(
        animTime * (2 * Math.PI / IDLE_PULSE_PERIOD) + entry.idlePhase,
      ));
      entry.group.scale.setScalar(pulse);

      // Walking hop: per-step vertical bounce when moving.
      if (entry.moving) {
        const hopPhase = (animTime / HOP_DURATION) % 1;
        // Ease-in-out sine for the hop arc.
        entry.hopY = HOP_HEIGHT * Math.sin(hopPhase * Math.PI);
      } else {
        // Settle back to ground.
        if (entry.hopY > 0.1) {
          entry.hopY *= 0.8;
        } else {
          entry.hopY = 0;
        }
      }
      // Apply hop as a Y offset on top of the base position.
      // We store the base Y in the group's position and add hopY each frame.
      // Since we can't easily separate base from hop in the group position,
      // we use userData to track the base Y.
      const baseY = (entry.group.userData.baseY as number) ?? entry.group.position.y;
      entry.group.userData.baseY = baseY;
      entry.group.position.y = baseY + entry.hopY;
    }
  }

  // Clean up completed despawns.
  for (const id of toRemove) {
    unitEntries.delete(id);
  }

  // Rebuild unitObjects array to match current entries.
  // (Only needed if entries were removed.)
  if (toRemove.length > 0) {
    unitObjects.length = 0;
    for (const entry of unitEntries.values()) {
      const meshes: Mesh[] = [];
      entry.group.traverse((child) => {
        if ((child as Mesh).isMesh) meshes.push(child as Mesh);
      });
      unitObjects.push(meshes);
    }
  }
}

export function clearUnits(): void {
  for (const entry of unitEntries.values()) {
    disposeFigurine(entry.group);
    unitGroup.remove(entry.group);
  }
  unitEntries.clear();
  unitObjects.length = 0;
  while (unitGroup.children.length > 0) {
    unitGroup.remove(unitGroup.children[0]!);
  }
  // Reset the signature so the next rebuildUnits actually reconstructs
  // the units — without this, clearUnits followed by rebuildUnits with
  // the same visible units bails early (signature unchanged) and leaves
  // the scene empty.
  lastSignature = '';
}

export function setUnitsVisible(visible: boolean): void {
  unitGroup.visible = visible;
}

// ─── Test-only exports ─────────────────────────────────────────────────────
// Exposed for unit tests to verify lifecycle state without poking at Three.js
// scene graph internals. Not part of the public rendering API.
export function _testGetEntry(id: string): UnitEntry | undefined {
  return unitEntries.get(id);
}

export function _testEntryCount(): number {
  return unitEntries.size;
}