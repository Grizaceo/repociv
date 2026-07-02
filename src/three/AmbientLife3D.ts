// ─── Ambient life: city flags, ocean birds, capital chimney smoke ────────────
// The Civ V map is never still — banners ripple, gulls circle the coast,
// hearth smoke drifts from the capital. Everything here is driven by
// animTime (so ?freeze=<s> pins it for goldens), costs a handful of tiny
// meshes, and hides below high LOD so the strategic overview pays nothing.
import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { type City, type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

const lifeGroup = new Group();
lifeGroup.name = 'ambient-life';

export function getAmbientLifeGroup(): Group {
  return lifeGroup;
}

function hashCoord(q: number, r: number): number {
  return Math.abs((q * 73856093) ^ (r * 19349663)) % 997;
}

// ─── City flags ──────────────────────────────────────────────────────────────

const FLAG_POLE_H = HEX_SIZE * 0.78;
const FLAG_W = HEX_SIZE * 0.3;
const FLAG_H = HEX_SIZE * 0.19;

/** Cloth wave: amplitude grows toward the free edge (uv.x=1), pinned at the
 *  pole (uv.x=0). Brightness follows the wave slope so folds read without
 *  scene lighting. */
const FLAG_VERTEX = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vFold;
  void main() {
    vUv = uv;
    vec3 p = position;
    float phase = uv.x * 7.0 - uTime * 4.2;
    float amp = 0.16 * uv.x * ${FLAG_W.toFixed(1)};
    p.z += sin(phase) * amp;
    vFold = cos(phase) * uv.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const FLAG_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vFold;
  void main() {
    vec3 c = uColor;
    // darker hem strip + wave-fold shading
    c *= mix(0.82, 1.0, step(0.12, vUv.y));
    c *= 0.88 + 0.18 * vFold;
    gl_FragColor = vec4(c, 1.0);
  }
`;

interface FlagEntry {
  material: ShaderMaterial;
}

const flagEntries: FlagEntry[] = [];
let flagGeometry: PlaneGeometry | null = null;
let poleGeometry: CylinderGeometry | null = null;
let poleMaterial: MeshLambertMaterial | null = null;

/** Deterministic flag anchor: pole planted off-centre on the city tile so it
 *  clears the keep, direction picked by the tile hash. */
export function flagOffset(q: number, r: number): [number, number] {
  const h = hashCoord(q, r);
  const ang = ((h % 6) * Math.PI) / 3 + Math.PI / 6;
  const d = HEX_SIZE * 0.34;
  return [Math.cos(ang) * d, Math.sin(ang) * d];
}

function buildFlag(city: City, getTile: (key: string) => Tile | undefined): Group {
  const g = new Group();
  const tile = getTile(tileKey(city.coord));
  const elev = tile ? terrainElevation(tile.terrain) : 0;
  const base = axialToWorld3D(city.coord.q, city.coord.r, elev);
  const [ox, oz] = flagOffset(city.coord.q, city.coord.r);

  if (!flagGeometry) flagGeometry = new PlaneGeometry(FLAG_W, FLAG_H, 8, 3);
  if (!poleGeometry) poleGeometry = new CylinderGeometry(0.6, 0.8, FLAG_POLE_H, 5);
  if (!poleMaterial) {
    poleMaterial = new MeshLambertMaterial({ color: new Color(0x6b5a44) });
  }

  const pole = new Mesh(poleGeometry, poleMaterial);
  pole.position.set(base.x + ox, base.y + 2 + FLAG_POLE_H * 0.5, base.z + oz);
  g.add(pole);

  const color = city.color ?? [0.85, 0.75, 0.4];
  const material = new ShaderMaterial({
    vertexShader: FLAG_VERTEX,
    fragmentShader: FLAG_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(color[0], color[1], color[2]) },
    },
    side: DoubleSide,
  });
  flagEntries.push({ material });

  const cloth = new Mesh(flagGeometry, material);
  // hoist at the pole top; plane pivot is its centre, so shift half a width
  cloth.position.set(
    base.x + ox + FLAG_W * 0.5 + 0.8,
    base.y + 2 + FLAG_POLE_H - FLAG_H * 0.55,
    base.z + oz,
  );
  // face a stable, hash-picked direction
  cloth.rotation.y = ((hashCoord(city.coord.q, city.coord.r) % 4) * Math.PI) / 2 + 0.35;
  g.add(cloth);
  return g;
}

// ─── Ocean birds ─────────────────────────────────────────────────────────────

const BIRD_COUNT = 3;
// Low glide: at gameplay zoom the vertical half-frame is only ~50 world
// units, so a higher altitude projects the gulls clean off the top edge.
const BIRD_ALTITUDE = 26;

/** Deterministic bird anchors: revealed ocean tiles, hash-spread so the
 *  gulls don't stack on one tile. Exported for tests. */
export function pickBirdAnchors(tiles: Tile[], count: number): Tile[] {
  const ocean = tiles
    .filter((t) => t.terrain === 'ocean' && t.revealed)
    .sort(
      (a, b) =>
        hashCoord(a.coord.q, a.coord.r) - hashCoord(b.coord.q, b.coord.r) ||
        tileKey(a.coord).localeCompare(tileKey(b.coord)),
    );
  if (ocean.length === 0) return [];
  const picked: Tile[] = [];
  const step = Math.max(1, Math.floor(ocean.length / count));
  for (let i = 0; i < count && i * step < ocean.length; i++) {
    picked.push(ocean[i * step]!);
  }
  return picked;
}

/** Gull silhouette: two swept-back wing triangles meeting at the body. */
function buildBirdGeometry(): BufferGeometry {
  const geom = new BufferGeometry();
  const s = 5.5;
  // body point, wing tips slightly raised and swept back
  const verts = new Float32Array([
    // left wing
    0,
    0,
    0,
    -s,
    s * 0.35,
    s * 0.55,
    -s * 0.15,
    0.1,
    s * 0.5,
    // right wing
    0,
    0,
    0,
    s * 0.15,
    0.1,
    s * 0.5,
    s,
    s * 0.35,
    s * 0.55,
  ]);
  geom.setAttribute('position', new Float32BufferAttribute(verts, 3));
  geom.computeVertexNormals();
  return geom;
}

interface BirdState {
  anchor: Vector3;
  radius: number;
  speed: number;
  phase: number;
}

let birdMesh: InstancedMesh | null = null;
let birdStates: BirdState[] = [];

/** Circular glide + wing-bob, a pure function of animTime (freeze-safe). */
export function birdTransform(
  b: { anchor: { x: number; z: number }; radius: number; speed: number; phase: number },
  animTime: number,
): { x: number; y: number; z: number; yaw: number; roll: number } {
  const a = b.phase + animTime * b.speed;
  return {
    x: b.anchor.x + Math.cos(a) * b.radius,
    y: BIRD_ALTITUDE + 2.4 * Math.sin(animTime * 1.1 + b.phase * 3.0),
    z: b.anchor.z + Math.sin(a) * b.radius,
    yaw: -a - Math.PI / 2, // tangent to the circle
    roll: 0.35 * Math.sin(animTime * 5.2 + b.phase * 7.0), // wing beat
  };
}

// ─── Capital chimney smoke ───────────────────────────────────────────────────

const PUFFS_PER_CAPITAL = 5;
const SMOKE_RISE = 26;
const SMOKE_CYCLE = 6.5; // seconds per puff loop

interface PuffState {
  origin: Vector3;
  phase: number;
  drift: number;
}

let smokeMesh: InstancedMesh | null = null;
let puffStates: PuffState[] = [];

/** Puff transform along its loop: rises, swells, shrinks out near the top.
 *  Pure in animTime so ?freeze pins it. Exported for tests. */
export function puffTransform(
  p: { phase: number; drift: number },
  animTime: number,
): { lift: number; scale: number; sway: number } {
  const t = (animTime / SMOKE_CYCLE + p.phase) % 1;
  const swell = 0.5 + 1.3 * t;
  const fadeOut = 1 - smoothstep01((t - 0.8) / 0.2);
  return {
    lift: t * SMOKE_RISE,
    scale: Math.max(0.001, swell * fadeOut),
    sway: Math.sin(t * 5.2 + p.phase * 11) * (1.2 + p.drift) * t,
  };
}

function smoothstep01(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let lastSignature = '';
const flagGroups: Group[] = [];

export function rebuildAmbientLife(
  tiles: Tile[],
  cities: City[],
  getTile: (key: string) => Tile | undefined,
): void {
  const anchors = pickBirdAnchors(tiles, BIRD_COUNT);
  const signature =
    cities
      .map(
        (c) =>
          `${c.id}:${c.coord.q},${c.coord.r}:${c.isCapital ? 1 : 0}:${(c.color ?? []).join('.')}`,
      )
      .join('|') +
    '#' +
    anchors.map((t) => tileKey(t.coord)).join('|');
  if (signature === lastSignature) return;
  lastSignature = signature;

  clearAmbientLife();

  // Flags — one per revealed city
  for (const city of cities) {
    const tile = getTile(tileKey(city.coord));
    if (!tile?.revealed) continue;
    const flag = buildFlag(city, getTile);
    flagGroups.push(flag);
    lifeGroup.add(flag);
  }

  // Birds — instanced gulls circling ocean anchors
  if (anchors.length > 0) {
    const geom = buildBirdGeometry();
    // Pale gull-white: dark silhouettes vanish against the deep sea blue.
    const mat = new MeshBasicMaterial({ color: new Color(0xe8edf2), side: DoubleSide });
    birdMesh = new InstancedMesh(geom, mat, anchors.length);
    // Instances fly far from the mesh origin and move every frame; the
    // bounding sphere three computes from the FIRST frame's matrices would
    // cull them whenever the camera leaves that spot. A handful of tris —
    // always draw.
    birdMesh.frustumCulled = false;
    initInstancesHidden(birdMesh);
    birdStates = anchors.map((t, i) => {
      const h = hashCoord(t.coord.q, t.coord.r);
      const base = axialToWorld3D(t.coord.q, t.coord.r, terrainElevation(t.terrain));
      return {
        anchor: new Vector3(base.x, 0, base.z),
        radius: HEX_SIZE * (1.0 + (h % 4) * 0.15),
        speed: 0.22 + (h % 3) * 0.05,
        phase: (h % 12) * 0.52 + i * 2.1,
      };
    });
    lifeGroup.add(birdMesh);
  }

  // Smoke — instanced puffs over each revealed capital
  const capitals = cities.filter((c) => c.isCapital && getTile(tileKey(c.coord))?.revealed);
  if (capitals.length > 0) {
    const geom = new IcosahedronGeometry(2.2, 0);
    const mat = new MeshLambertMaterial({
      color: new Color(0xd8dade),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    smokeMesh = new InstancedMesh(geom, mat, capitals.length * PUFFS_PER_CAPITAL);
    smokeMesh.frustumCulled = false;
    initInstancesHidden(smokeMesh);
    puffStates = [];
    for (const cap of capitals) {
      const tile = getTile(tileKey(cap.coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const base = axialToWorld3D(cap.coord.q, cap.coord.r, elev);
      const h = hashCoord(cap.coord.q, cap.coord.r);
      // chimney sits on the keep's shoulder
      const ox = Math.cos((h % 7) * 0.9) * HEX_SIZE * 0.16;
      const oz = Math.sin((h % 7) * 0.9) * HEX_SIZE * 0.16;
      for (let i = 0; i < PUFFS_PER_CAPITAL; i++) {
        puffStates.push({
          origin: new Vector3(base.x + ox, base.y + 2 + HEX_SIZE * 0.42, base.z + oz),
          phase: i / PUFFS_PER_CAPITAL + (h % 5) * 0.037,
          drift: (h % 3) * 0.4,
        });
      }
    }
    lifeGroup.add(smokeMesh);
  }

  // Force the first tick to lay out instances even under ?freeze.
  lastTickTime = Number.NaN;
}

/** Zero-scale every instance so nothing flashes at the world origin on the
 *  single frame between rebuild (dirty pass) and the first tick layout. */
function initInstancesHidden(mesh: InstancedMesh): void {
  const zero = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, zero);
  mesh.instanceMatrix.needsUpdate = true;
}

const tickMatrix = new Matrix4();
const tickQuat = new Quaternion();
const tickPos = new Vector3();
const tickScale = new Vector3();
const yawAxis = new Vector3(0, 1, 0);
const rollAxis = new Vector3(0, 0, 1);
const rollQuat = new Quaternion();
let lastTickTime = Number.NaN;

export function tickAmbientLife(animTime: number, lod: 'low' | 'medium' | 'high'): void {
  // Strategic overview pays nothing: hide and skip all matrix math.
  const visible = lod === 'high';
  lifeGroup.visible = visible;
  if (!visible) return;
  if (animTime === lastTickTime) return; // frozen frame — layout already done
  lastTickTime = animTime;

  for (const entry of flagEntries) {
    entry.material.uniforms.uTime!.value = animTime;
  }

  if (birdMesh) {
    birdStates.forEach((b, i) => {
      const t = birdTransform(b, animTime);
      tickPos.set(t.x, t.y, t.z);
      tickQuat.setFromAxisAngle(yawAxis, t.yaw);
      rollQuat.setFromAxisAngle(rollAxis, t.roll);
      tickQuat.multiply(rollQuat);
      tickScale.set(1, 1, 1);
      tickMatrix.compose(tickPos, tickQuat, tickScale);
      birdMesh!.setMatrixAt(i, tickMatrix);
    });
    birdMesh.instanceMatrix.needsUpdate = true;
  }

  if (smokeMesh) {
    puffStates.forEach((p, i) => {
      const t = puffTransform(p, animTime);
      tickPos.set(p.origin.x + t.sway, p.origin.y + t.lift, p.origin.z + t.sway * 0.6);
      tickQuat.identity();
      tickScale.set(t.scale, t.scale * 0.85, t.scale);
      tickMatrix.compose(tickPos, tickQuat, tickScale);
      smokeMesh!.setMatrixAt(i, tickMatrix);
    });
    smokeMesh.instanceMatrix.needsUpdate = true;
  }
}

export function clearAmbientLife(): void {
  for (const g of flagGroups) {
    lifeGroup.remove(g);
    g.traverse((obj) => {
      const m = obj as Mesh;
      if (!m.isMesh) return;
      // cloth materials are per-city; pole geometry/material are shared
      if (m.material instanceof ShaderMaterial) m.material.dispose();
    });
  }
  flagGroups.length = 0;
  flagEntries.length = 0;

  if (birdMesh) {
    lifeGroup.remove(birdMesh);
    birdMesh.geometry.dispose();
    (birdMesh.material as MeshBasicMaterial).dispose();
    birdMesh.dispose();
    birdMesh = null;
  }
  birdStates = [];

  if (smokeMesh) {
    lifeGroup.remove(smokeMesh);
    smokeMesh.geometry.dispose();
    (smokeMesh.material as MeshLambertMaterial).dispose();
    smokeMesh.dispose();
    smokeMesh = null;
  }
  puffStates = [];
}

/** Full teardown (renderer dispose): also drops the shared flag assets. */
export function disposeAmbientLife(): void {
  clearAmbientLife();
  flagGeometry?.dispose();
  flagGeometry = null;
  poleGeometry?.dispose();
  poleGeometry = null;
  poleMaterial?.dispose();
  poleMaterial = null;
  lastSignature = '';
}

/** @internal test hook */
export function _ambientLifeSignature(): string {
  return lastSignature;
}
