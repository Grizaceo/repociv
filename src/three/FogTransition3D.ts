// ─── Fog of war transition: fade-in + discovery particle burst ──────────────
// When tiles are revealed (fog lifted), the fog cover fades out over 500ms
// instead of disappearing instantly. City tiles get a "discovered" particle
// burst — a brief expanding ring of gold sparkles.
//
// The transition is driven by tickFogTransition(dt), called every frame.
// Recently-revealed tiles are detected by comparing the previous unrevealed
// set with the current one — no explicit event needed, but the fog_reveal
// bridge event is what triggers the state change that feeds this system.
import {
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  SphereGeometry,
  Group,
} from 'three';
import { type Tile, tileKey } from '../types.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D, hexCornerAngle3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { sharedHexGeometry } from './hexGeometry.ts';

const transitionGroup = new Group();
transitionGroup.name = 'fog-transition';

const FADE_DURATION = 0.5; // 500ms
const PARTICLE_DURATION = 0.8; // 800ms
const PARTICLE_COUNT = 8; // sparkles per city discovery

// ─── Fade-out entries: fog covers that are animating to 0 opacity ──────────
interface FadeEntry {
  q: number;
  r: number;
  /** Remaining time in seconds (FADE_DURATION → 0). */
  timeLeft: number;
  mesh: InstancedMesh;
}

const activeFades: FadeEntry[] = [];

// ─── Particle burst entries: expanding gold sparkle rings on city tiles ────
interface ParticleEntry {
  q: number;
  r: number;
  timeLeft: number;
  sparkles: InstancedMesh;
  ring: LineSegments;
}

const activeParticles: ParticleEntry[] = [];

// ─── Previous unrevealed tile set (for detecting newly revealed tiles) ─────
let prevUnrevealedKeys = new Set<string>();

export function getFogTransitionGroup(): Group {
  return transitionGroup;
}

/** Detect newly-revealed tiles by comparing the current unrevealed set
 *  with the previous one. Creates fade-out entries and particle bursts
 *  for city tiles. Called from updateHexWorldScene on dirty frames. */
export function updateFogTransition(
  tiles: Tile[],
  getTile: (key: string) => Tile | undefined,
): void {
  const currentUnrevealed = new Set<string>();
  for (const tile of tiles) {
    if (!tile.revealed) currentUnrevealed.add(tileKey(tile.coord));
  }

  // Newly revealed = in prevUnrevealed but NOT in currentUnrevealed.
  for (const key of prevUnrevealedKeys) {
    if (currentUnrevealed.has(key)) continue;
    // This tile was just revealed.
    const parts = key.split(',');
    const q = parseInt(parts[0]!, 10);
    const r = parseInt(parts[1]!, 10);
    const tile = getTile(key);
    if (!tile) continue;

    // Start a fade-out for the fog cover.
    startFadeOut(q, r, tile);

    // If this is a city tile, add a discovery particle burst.
    if (tile.city) {
      startParticleBurst(q, r);
    }
  }

  prevUnrevealedKeys = currentUnrevealed;
}

function startFadeOut(q: number, r: number, _tile: Tile): void {
  // Skip if there's already a fade for this tile.
  for (const f of activeFades) {
    if (f.q === q && f.r === r) return;
  }

  const elev = terrainElevation(_tile.terrain);
  const pos = axialToWorld3D(q, r, elev);
  pos.y += 0.5;

  // Create a fog cover mesh (same look as the main fog cover).
  const mat = new MeshLambertMaterial({
    color: 0xc6cdc9,
    emissive: 0x5a6164,
    transparent: true,
    opacity: 0.93,
  });
  const mesh = new InstancedMesh(sharedHexGeometry, mat, 1);
  const matrix = new Matrix4().makeTranslation(pos.x, pos.y, pos.z);
  mesh.setMatrixAt(0, matrix);
  mesh.instanceMatrix.needsUpdate = true;
  transitionGroup.add(mesh);

  activeFades.push({ q, r, timeLeft: FADE_DURATION, mesh });
}

function startParticleBurst(q: number, r: number): void {
  // Skip if there's already a particle effect for this tile.
  for (const p of activeParticles) {
    if (p.q === q && p.r === r) return;
  }

  const tileElev = 0; // We don't have the tile here; use 0 as default.
  const center = axialToWorld3D(q, r, tileElev);

  // Sparkle particles: small gold spheres that expand outward.
  const sparkleGeom = new SphereGeometry(HEX_SIZE * 0.03, 6, 4);
  const sparkleMat = new MeshLambertMaterial({
    color: 0xffd040,
    emissive: 0xffd040,
    emissiveIntensity: 0.8,
    transparent: true,
    opacity: 1.0,
  });
  const sparkles = new InstancedMesh(sparkleGeom, sparkleMat, PARTICLE_COUNT);
  const matrix = new Matrix4();
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
    const x = center.x + Math.cos(angle) * HEX_SIZE * 0.1;
    const z = center.z + Math.sin(angle) * HEX_SIZE * 0.1;
    matrix.makeTranslation(x, center.y + 2, z);
    sparkles.setMatrixAt(i, matrix);
  }
  sparkles.instanceMatrix.needsUpdate = true;
  transitionGroup.add(sparkles);

  // Expanding gold ring.
  const segments: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a1 = hexCornerAngle3D(i);
    const a2 = hexCornerAngle3D((i + 1) % 6);
    const y = center.y + 1.5;
    segments.push(
      center.x + HEX_SIZE * 0.3 * Math.cos(a1), y, center.z + HEX_SIZE * 0.3 * Math.sin(a1),
      center.x + HEX_SIZE * 0.3 * Math.cos(a2), y, center.z + HEX_SIZE * 0.3 * Math.sin(a2),
    );
  }
  const ringGeom = new BufferGeometry();
  ringGeom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const ringMat = new LineBasicMaterial({
    color: 0xffd040,
    transparent: true,
    opacity: 0.9,
    linewidth: 3,
  });
  const ring = new LineSegments(ringGeom, ringMat);
  transitionGroup.add(ring);

  activeParticles.push({ q, r, timeLeft: PARTICLE_DURATION, sparkles, ring });
}

/** Per-frame: advance fade-out timers and particle animations.
 *  Frozen dt=0 keeps goldens stable (transitions freeze). */
export function tickFogTransition(dt: number): void {
  // ── Fade-outs ───────────────────────────────────────────────────────
  for (let i = activeFades.length - 1; i >= 0; i--) {
    const fade = activeFades[i]!;
    fade.timeLeft -= dt;
    if (fade.timeLeft <= 0) {
      transitionGroup.remove(fade.mesh);
      fade.mesh.geometry.dispose();
      (fade.mesh.material as MeshLambertMaterial).dispose();
      activeFades.splice(i, 1);
      continue;
    }
    const alpha = fade.timeLeft / FADE_DURATION;
    (fade.mesh.material as MeshLambertMaterial).opacity = 0.93 * alpha;
  }

  // ── Particle bursts ─────────────────────────────────────────────────
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i]!;
    p.timeLeft -= dt;
    if (p.timeLeft <= 0) {
      transitionGroup.remove(p.sparkles);
      p.sparkles.geometry.dispose();
      (p.sparkles.material as MeshLambertMaterial).dispose();
      transitionGroup.remove(p.ring);
      p.ring.geometry.dispose();
      (p.ring.material as LineBasicMaterial).dispose();
      activeParticles.splice(i, 1);
      continue;
    }

    const progress = 1 - p.timeLeft / PARTICLE_DURATION; // 0→1
    const ringScale = 0.3 + progress * 0.7; // expand from 0.3 to 1.0
    const ringAlpha = (1 - progress) * 0.9;

    // Update ring: rewrite positions with expanded radius.
    const tileElev = 0;
    const center = axialToWorld3D(p.q, p.r, tileElev);
    const posAttr = p.ring.geometry.getAttribute('position') as Float32BufferAttribute;
    const arr = posAttr.array as Float32Array;
    for (let j = 0; j < 6; j++) {
      const a1 = hexCornerAngle3D(j);
      const a2 = hexCornerAngle3D((j + 1) % 6);
      const y = center.y + 1.5;
      arr[j * 6]     = center.x + HEX_SIZE * ringScale * Math.cos(a1);
      arr[j * 6 + 1] = y;
      arr[j * 6 + 2] = center.z + HEX_SIZE * ringScale * Math.sin(a1);
      arr[j * 6 + 3] = center.x + HEX_SIZE * ringScale * Math.cos(a2);
      arr[j * 6 + 4] = y;
      arr[j * 6 + 5] = center.z + HEX_SIZE * ringScale * Math.sin(a2);
    }
    posAttr.needsUpdate = true;
    (p.ring.material as LineBasicMaterial).opacity = ringAlpha;

    // Fade sparkles.
    (p.sparkles.material as MeshLambertMaterial).opacity = 1 - progress;
  }
}

export function clearFogTransition(): void {
  for (const fade of activeFades) {
    transitionGroup.remove(fade.mesh);
    fade.mesh.geometry.dispose();
    (fade.mesh.material as MeshLambertMaterial).dispose();
  }
  activeFades.length = 0;

  for (const p of activeParticles) {
    transitionGroup.remove(p.sparkles);
    p.sparkles.geometry.dispose();
    (p.sparkles.material as MeshLambertMaterial).dispose();
    transitionGroup.remove(p.ring);
    p.ring.geometry.dispose();
    (p.ring.material as LineBasicMaterial).dispose();
  }
  activeParticles.length = 0;

  prevUnrevealedKeys = new Set();
}

// ─── Test-only exports ─────────────────────────────────────────────────────
export function _testFadeCount(): number {
  return activeFades.length;
}

export function _testParticleCount(): number {
  return activeParticles.length;
}

export function _testResetPrevUnrevealed(): void {
  prevUnrevealedKeys = new Set();
}