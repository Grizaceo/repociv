// ─── Unit figurines: Civ V-style hero / unit markers ────────────────────────
// Lifecycle: rebuildUnits does incremental add/remove. New units enter a
// "spawning" state (scale 0→1, 300ms ease-out). Units that leave the visible
// set enter "despawning" (scale 1→0, 200ms ease-in) and are removed when the
// tween completes. tickUnits(animTime, dt) runs every frame to advance the
// tweens, idle breath, and terrain-locked walk (yaw + stride + lean) —
// independent of the dirty rebuild cycle. No skeletal clips.
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
import { axialToWorld3D, world3DToAxialFraction } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { stackOffsets } from '../unitStack.ts';
import {
  areUnitPropsReady,
  getUnitPropParts,
  getUnitPropPartsForType,
  isUnitTintPart,
  unitPropsSignature,
  type UnitPropPart,
} from './UnitProps3D.ts';
import { terrainSurfaceY } from './terrainSurfaceY.ts';
import {
  catmullRom,
  catmullRomTangent,
  expFollow,
  idleBreathScale,
  LEAN_MAX,
  lerpAngle,
  POSE_FOLLOW,
  strideLift,
  stridePhase,
  SWAY_MAX,
  yawToward,
  YAW_FOLLOW,
} from './unitWalkPose.ts';

const unitGroup = new Group();
unitGroup.name = 'units';

let lastSignature = '';
const unitObjects: Mesh[][] = [];

// ─── Per-unit lifecycle state ───────────────────────────────────────────────
type UnitLifeState = 'spawning' | 'alive' | 'despawning';

interface UnitEntry {
  group: Group;
  unitId: string;
  unitType: Unit['type'];
  usedGlb: boolean;
  lifeState: UnitLifeState;
  /** Tween progress 0→1 for spawn, 1→0 for despawn. */
  tween: number;
  /** Per-unit phase offset for idle breath so they don't all inhale in sync. */
  idlePhase: number;
  /** Current stride lift (0 when grounded). Always small; never a hex hop. */
  strideY: number;
  /** Smoothed yaw around Y (radians), facing the march vector. */
  yaw: number;
  /** Smoothed forward lean (radians). */
  lean: number;
  /** Smoothed side sway (radians). */
  sway: number;
  /** Whether this unit is currently moving (drives walk pose). */
  moving: boolean;
  /** Current interpolated world position (updated by movement tween). */
  currentPos: { x: number; y: number; z: number };
  /** Path for movement tween (axial coords). */
  path: { q: number; r: number }[];
  /** Current step in path. */
  pathIndex: number;
  /** Progress between path[pathIndex] and path[pathIndex+1] (0-1). */
  pathProgress: number;
  /** Live tile lookup so feet can sample the displaced surface at XZ. */
  getTile: (key: string) => Tile | undefined;
}

export type { UnitEntry };

const unitEntries = new Map<string, UnitEntry>();

const UNIT_SURFACE_CLEARANCE = HEX_SIZE * 0.04;

export function getUnitGroup(): Group {
  return unitGroup;
}

function sameAxialPath(a: { q: number; r: number }[], b: { q: number; r: number }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.q !== b[i]!.q || a[i]!.r !== b[i]!.r) return false;
  }
  return true;
}

function waypointXZ(q: number, r: number): { x: number; z: number } {
  const p = axialToWorld3D(q, r, 0);
  return { x: p.x, z: p.z };
}

function pathControl(path: { q: number; r: number }[], i: number): { x: number; z: number } {
  const clamped = Math.max(0, Math.min(path.length - 1, i));
  const c = path[clamped]!;
  return waypointXZ(c.q, c.r);
}

function samplePathXZ(
  path: { q: number; r: number }[],
  index: number,
  t: number,
): { x: number; z: number; dx: number; dz: number } {
  const p0 = pathControl(path, index - 1);
  const p1 = pathControl(path, index);
  const p2 = pathControl(path, index + 1);
  const p3 = pathControl(path, index + 2);
  return {
    x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
    z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
    dx: catmullRomTangent(p0.x, p1.x, p2.x, p3.x, t),
    dz: catmullRomTangent(p0.z, p1.z, p2.z, p3.z, t),
  };
}

/** Feet sit on the shader-mirrored surface at the unit's actual XZ, not the hex centre. */
function surfaceYAt(
  worldX: number,
  worldZ: number,
  getTile: (key: string) => Tile | undefined,
): number {
  const frac = world3DToAxialFraction(worldX, worldZ);
  let rq = Math.round(frac.q);
  let rr = Math.round(frac.r);
  const rs = Math.round(-frac.q - frac.r);
  const dq = Math.abs(rq - frac.q);
  const dr = Math.abs(rr - frac.r);
  const ds = Math.abs(rs - (-frac.q - frac.r));
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  const tile = getTile(tileKey({ q: rq, r: rr }));
  if (!tile) return axialToWorld3D(rq, rr, 0).y + UNIT_SURFACE_CLEARANCE;
  const base = axialToWorld3D(tile.coord.q, tile.coord.r, terrainElevation(tile.terrain));
  return terrainSurfaceY(tile, worldX - base.x, worldZ - base.z, getTile) + UNIT_SURFACE_CLEARANCE;
}

function applyWalkPose(group: Group, yaw: number, lean: number, sway: number): void {
  group.rotation.order = 'YXZ';
  group.rotation.y = yaw;
  group.rotation.x = lean;
  group.rotation.z = sway;
}

function placeOnPath(entry: UnitEntry): void {
  if (entry.path.length < 2 || entry.pathIndex >= entry.path.length - 1) return;
  const t = Math.min(1, Math.max(0, entry.pathProgress));
  const sample = samplePathXZ(entry.path, entry.pathIndex, t);
  entry.currentPos = {
    x: sample.x,
    y: surfaceYAt(sample.x, sample.z, entry.getTile),
    z: sample.z,
  };
  entry.group.position.set(
    entry.currentPos.x,
    entry.currentPos.y + entry.strideY,
    entry.currentPos.z,
  );
  entry.group.userData.baseY = entry.currentPos.y;
}

const HERO_TYPES = new Set(['hero', 'lexo', 'claude', 'codex', 'cursor', 'openclaw']);

/** Forge GLB figurine: shared geometry, per-unit tinted material clones.
 *  The GLB worker has 5 material slots (skin, shirt, pants, tool wood,
 *  tool metal). We preserve the sculpted GLB colours and only tint the
 *  shirt (part index 1, the largest body area) toward the agent colour
 *  so ownership reads at a glance without nuking the whole figurine. */
function buildGlbFigurine(parts: UnitPropPart[], isHero: boolean, col: Color): Group {
  const group = new Group();
  parts.forEach((part, i) => {
    const mat = (part.material as MeshStandardMaterial).clone();
    // Part 1 = shirt/robe/cloak/tabard → tint with agent colour (Civ V player colour).
    // All other parts keep their original GLB colours so the figurine still
    // reads clearly (skin, boots, staff/pickaxe/shield/sword).
    if (isUnitTintPart(parts, i, mat)) {
      mat.color.lerp(col, 0.55);
      mat.emissive.copy(col);
      mat.emissiveIntensity = isHero ? 0.4 : 0.22;
    }
    const mesh = new Mesh(part.geometry, mat);
    mesh.applyMatrix4(part.matrix);
    mesh.userData.sharedGeometry = true;
    mesh.castShadow = true;
    group.add(mesh);
  });
  // GLB is ~1.15 Blender units tall (feet at Z=0, origin at bottom).
  // Scale to be clearly visible among mountain props (ROCK_H ≈ HEX_SIZE*0.82)
  // without dominating the tile. 0.38 gives ~22.7 units tall — between the
  // mountain base (pos.y+2) and the snow cap (pos.y+44), so the worker
  // reads as standing among the peaks rather than buried by them.
  const s = HEX_SIZE * (isHero ? 0.44 : 0.38);
  group.scale.setScalar(s);
  // Outer wrapper stays unscaled so the hero crown keeps absolute sizing.
  const wrapper = new Group();
  wrapper.rotation.order = 'YXZ';
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
    const parts =
      (typeof getUnitPropPartsForType === 'function' ? getUnitPropPartsForType(unit.type) : null) ??
      getUnitPropParts();
    if (parts && parts.length > 0) {
      const group = buildGlbFigurine(parts, isHero, col);
      if (isHero) addHeroCrown(group, col, HEX_SIZE * 0.46);
      return group;
    }
  }

  const group = new Group();
  group.rotation.order = 'YXZ';

  const bodyMat = new MeshStandardMaterial({
    color: col,
    emissive: col,
    emissiveIntensity: isHero ? 0.45 : 0.25,
    roughness: 0.55,
    metalness: isHero ? 0.35 : 0.1,
  });

  // Base: flat disc (feet)
  const baseGeom = new CylinderGeometry(HEX_SIZE * 0.1, HEX_SIZE * 0.13, HEX_SIZE * 0.04, 8);
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
    addHeroCrown(group, col, head.position.y + headR + HEX_SIZE * 0.1);
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

export function rebuildUnits(units: Unit[], getTile: (key: string) => Tile | undefined): void {
  const visibleUnits = units.filter((unit) => {
    const tile = getTile(tileKey(unit.coord));
    return !tile || tile.revealed;
  });

  // The props flag participates so the capsule→GLB swap happens the frame
  // the async load finishes, even when no unit moved.
  const signature =
    `uprops${unitPropsSignature()}#` +
    visibleUnits.map((u) => `${u.id}:${u.type}:${u.coord.q},${u.coord.r}:${u.state}`).join('|');
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

  // Add or reposition visible units. Units sharing a hex (agents in their
  // city) stand on a ring inside it — same slots as the 2D map and clicks.
  const stack = stackOffsets(visibleUnits, (key) => !!getTile(key)?.city, HEX_SIZE);
  const newUnitObjects: Mesh[][] = [];
  for (const unit of visibleUnits) {
    const tile = getTile(tileKey(unit.coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const pos = axialToWorld3D(unit.coord.q, unit.coord.r, elev);
    const slot = stack.get(unit.id);
    if (slot) {
      pos.x += slot.x; // map x → world x, map y → world z (axialToWorld3D)
      pos.z += slot.y;
    }
    // CPU mirror of the shader-displaced terrain top. The old pos.y-only
    // placement ignored FBM dunes/ridges, so units sank into hills/desert.
    const targetY = tile
      ? terrainSurfaceY(tile) + UNIT_SURFACE_CLEARANCE
      : pos.y + UNIT_SURFACE_CLEARANCE;

    const propsReady = areUnitPropsReady();
    const existing = unitEntries.get(unit.id);
    if (existing && existing.lifeState !== 'despawning') {
      // Hot-swap procedural capsule -> role GLB (or role change) without resetting lifecycle tween
      if (existing.usedGlb !== propsReady || existing.unitType !== unit.type) {
        const prevScale = existing.group.scale.x;
        unitGroup.remove(existing.group);
        disposeFigurine(existing.group);
        const swapped = buildUnitFigurine(unit);
        swapped.position.copy(existing.group.position);
        swapped.scale.setScalar(prevScale);
        applyWalkPose(swapped, existing.yaw, existing.lean, existing.sway);
        swapped.userData.basePos = { ...existing.currentPos };
        existing.group = swapped;
        existing.usedGlb = propsReady;
        existing.unitType = unit.type;
        unitGroup.add(swapped);
      }
      // Update path/movement state for the tween. tickUnits owns pathIndex /
      // pathProgress / XZ while the same path is in flight so a dirty rebuild
      // (coord stepped) cannot snap the figurine back to the hex centre.
      const nextPath = unit.path ? [...unit.path] : [];
      const pathChanged = !sameAxialPath(existing.path, nextPath);
      existing.moving = unit.state === 'moving';
      existing.getTile = getTile;
      if (!existing.moving || pathChanged) {
        existing.path = nextPath;
        existing.pathIndex = unit.pathIndex;
        existing.pathProgress = unit.pathProgress;
        if (existing.moving && existing.path.length > 1) {
          placeOnPath(existing);
        }
      }
      if (!existing.moving) {
        existing.currentPos = { x: pos.x, y: targetY, z: pos.z };
        existing.group.position.set(pos.x, targetY, pos.z);
        existing.lean = 0;
        existing.sway = 0;
        existing.strideY = 0;
        applyWalkPose(existing.group, existing.yaw, 0, 0);
      }
      existing.group.userData.baseY = existing.currentPos.y;
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

    // Store the base position for movement tween + stride composition.
    fig.userData.basePos = { x: pos.x, y: targetY, z: pos.z };

    const meshes: Mesh[] = [];
    fig.traverse((child) => {
      if ((child as Mesh).isMesh) meshes.push(child as Mesh);
    });

    const entry: UnitEntry = {
      group: fig,
      unitId: unit.id,
      unitType: unit.type,
      usedGlb: propsReady,
      lifeState: 'spawning',
      tween: 0,
      idlePhase: idlePhaseForId(unit.id),
      strideY: 0,
      yaw: 0,
      lean: 0,
      sway: 0,
      moving: unit.state === 'moving',
      currentPos: { x: pos.x, y: targetY, z: pos.z },
      path: unit.path ? [...unit.path] : [],
      pathIndex: unit.pathIndex,
      pathProgress: unit.pathProgress,
      getTile,
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
const SPAWN_DURATION = 0.3;
const DESPAWN_DURATION = 0.2;
// Movement tween: constant-speed sample along the path. The game logic
// advances pathProgress at 2.5 hex/s; we mirror that here so the 3D
// figurine walks between dirty-flag rebuilds (which only fire when coord
// changes, not every pathProgress step).
const MOVEMENT_SPEED = 2.5; // hexes per second

/** Stable per-unit phase in [0, 2π): units breathe out of step with each
 *  other, but a given unit always lands on the same phase — Math.random()
 *  made frozen golden captures differ run to run. FNV-1a over the id. */
function idlePhaseForId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0x100000000) * Math.PI * 2;
}

function tileElev(getTile: (key: string) => Tile | undefined, q: number, r: number): number {
  const t = getTile(tileKey({ q, r }));
  return t ? terrainElevation(t.terrain) : 0;
}

/** Per-frame animation: spawn/despawn tweens, idle breath, terrain-locked
 *  walk (yaw + stride + lean), movement tween. Called every frame from
 *  updateHexWorldScene, independent of dirty state. When animTime is frozen
 *  (golden capture), dt=0 so tweens freeze too.
 *  @param onTileStep Optional callback fired when a unit steps onto a new
 *  tile during the movement tween (used by HexWorldScene to trigger tile
 *  flash). Receives (q, r, elev). */
export function tickUnits(
  animTime: number,
  dt: number,
  onTileStep?: (q: number, r: number, elev: number) => void,
): void {
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
      // Alive: movement tween + idle breath + terrain-locked walk pose.

      // ── Movement tween: walk the path, sample the surface at XZ ──────
      const walking =
        entry.moving && entry.path.length > 1 && entry.pathIndex < entry.path.length - 1;
      if (!walking && entry.moving) entry.moving = false;
      if (walking) {
        // One hex per frame max so a hitch cannot teleport along the whole path.
        entry.pathProgress += Math.min(dt, 0.4) * MOVEMENT_SPEED;
        if (entry.pathProgress >= 1 && entry.pathIndex < entry.path.length - 1) {
          entry.pathProgress -= 1;
          entry.pathIndex++;
          if (onTileStep && entry.pathIndex < entry.path.length) {
            const stepped = entry.path[entry.pathIndex]!;
            onTileStep(stepped.q, stepped.r, tileElev(entry.getTile, stepped.q, stepped.r));
          }
          if (entry.pathIndex >= entry.path.length - 1) {
            const dest = entry.path[entry.path.length - 1]!;
            const destXZ = waypointXZ(dest.q, dest.r);
            const destY = surfaceYAt(destXZ.x, destXZ.z, entry.getTile);
            entry.currentPos = { x: destXZ.x, y: destY, z: destXZ.z };
            entry.pathProgress = 0;
            entry.moving = false;
          }
        }
        if (entry.moving && entry.pathIndex < entry.path.length - 1) {
          placeOnPath(entry);
          const sample = samplePathXZ(entry.path, entry.pathIndex, Math.min(1, entry.pathProgress));
          const targetYaw = yawToward(sample.dx, sample.dz, entry.yaw);
          entry.yaw = lerpAngle(entry.yaw, targetYaw, expFollow(dt, YAW_FOLLOW));
          const kPose = expFollow(dt, POSE_FOLLOW);
          entry.lean += (LEAN_MAX - entry.lean) * kPose;
          entry.sway += (Math.sin(stridePhase(animTime)) * SWAY_MAX - entry.sway) * kPose;
        }
      }

      if (!entry.moving) {
        const kPose = expFollow(dt, POSE_FOLLOW);
        entry.lean += (0 - entry.lean) * kPose;
        entry.sway += (0 - entry.sway) * kPose;
        if (entry.strideY > 0.02) entry.strideY *= 0.8;
        else entry.strideY = 0;
      } else {
        entry.strideY = strideLift(animTime, true);
      }

      entry.group.position.set(
        entry.currentPos.x,
        entry.currentPos.y + entry.strideY,
        entry.currentPos.z,
      );
      entry.group.userData.baseY = entry.currentPos.y;
      applyWalkPose(entry.group, entry.yaw, entry.lean, entry.sway);
      entry.group.scale.setScalar(idleBreathScale(animTime, entry.idlePhase, entry.moving));
    }
  }

  // Clean up completed despawns.
  for (const id of toRemove) {
    unitEntries.delete(id);
  }

  // Rebuild unitObjects array to match current entries.
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

/** Capture-harness probe: live Group pose while a unit walks the path. */
export function unitWalkDebug(): Array<{
  id: string;
  type: Unit['type'];
  x: number;
  y: number;
  z: number;
  surfaceY: number;
  lifeState: UnitLifeState;
  strideY: number;
  yaw: number;
  lean: number;
  moving: boolean;
  pathIndex: number;
  pathProgress: number;
  pathLen: number;
}> {
  const out: ReturnType<typeof unitWalkDebug> = [];
  for (const e of unitEntries.values()) {
    out.push({
      id: e.unitId,
      type: e.unitType,
      x: e.group.position.x,
      y: e.group.position.y,
      z: e.group.position.z,
      surfaceY: e.currentPos.y,
      lifeState: e.lifeState,
      strideY: e.strideY,
      yaw: e.yaw,
      lean: e.lean,
      moving: e.moving,
      pathIndex: e.pathIndex,
      pathProgress: e.pathProgress,
      pathLen: e.path.length,
    });
  }
  return out;
}
