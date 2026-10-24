// Shared Group-transform walk pose for map units and local agents.
// No skeletal clips — Meshy/CSG/KayKit figurines are static meshes.
import { HEX_SIZE } from '../constants.ts';

/** Peak extra height while walking. Far below one terrain step (TILE_HEIGHT=12). */
export const STRIDE_HEIGHT = HEX_SIZE * 0.015;
/** Seconds for a full two-step cycle (left+right implicit foot). */
export const STRIDE_PERIOD = 0.36;
/** Idle scale amplitude. Token pulse used 5%; this is breath, not a bob. */
export const IDLE_BREATH_AMPLITUDE = 0.01;
export const IDLE_BREATH_PERIOD = 2.4;
/** Forward pitch while marching (radians). */
export const LEAN_MAX = 0.1;
/** Side-to-side weight shift (radians). */
export const SWAY_MAX = 0.045;
/** Exponential yaw follow rate. ~1/e in 140ms — turns, never snaps per hex. */
export const YAW_FOLLOW = 7;
/** Lean/sway follow (faster than yaw so the body settles with the step). */
export const POSE_FOLLOW = 10;

export function lerpAngle(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * t;
}

export function expFollow(dt: number, rate: number): number {
  if (dt <= 0) return 0;
  return 1 - Math.exp(-dt * rate);
}

export function yawToward(dx: number, dz: number, fallback: number): number {
  if (dx * dx + dz * dz < 1e-8) return fallback;
  return Math.atan2(dx, dz);
}

/** Always ≥ 0 so feet never punch through the terrain sample. */
export function strideLift(animTime: number, moving: boolean): number {
  if (!moving) return 0;
  return STRIDE_HEIGHT * Math.abs(Math.sin((animTime * Math.PI) / STRIDE_PERIOD));
}

export function stridePhase(animTime: number): number {
  return (animTime * Math.PI) / STRIDE_PERIOD;
}

export function idleBreathScale(animTime: number, phase: number, moving: boolean): number {
  if (moving) return 1;
  return (
    1 + IDLE_BREATH_AMPLITUDE * Math.sin(animTime * ((2 * Math.PI) / IDLE_BREATH_PERIOD) + phase)
  );
}

/** Catmull-Rom through hex centres: passes each waypoint, eases the corner. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export function catmullRomTangent(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  return (
    0.5 *
    (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2)
  );
}
