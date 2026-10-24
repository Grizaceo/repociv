// ─── Macro WebGL camera orbit (Civ V-style yaw/pitch around look-at) ─────────
// Pure math: the 2D Camera stays the look-at target; yaw/pitch live on that
// struct and syncCamera() places the perspective camera. No OrbitControls.

/** Default elevation from the XZ plane (radians). ~35.5°. */
export const CAMERA_TILT = 0.62;
export const CAMERA_BASE_DISTANCE = 320;
/** Extra +Z offset as a fraction of distance — slight south bias at yaw=0. */
export const CAMERA_Z_BIAS = 0.38;

/** Stay above the terrain; never a true zenith. */
export const ORBIT_PITCH_MIN = 0.22; // ~12.6°
export const ORBIT_PITCH_MAX = 1.15; // ~66°
/** Radians per second while Q/E are held. */
export const ORBIT_YAW_SPEED = 1.2;
/** Radians per pixel of middle-mouse drag. */
export const ORBIT_MMB_SENSITIVITY = 0.005;

export function clampOrbitPitch(pitch: number): number {
  return Math.min(ORBIT_PITCH_MAX, Math.max(ORBIT_PITCH_MIN, pitch));
}

/** Camera offset from the look-at target. Yaw 0 + default pitch matches the
 *  historical fixed Civ camera (west/south of the target, looking in). */
export function orbitOffset(
  dist: number,
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number } {
  const dx = -dist * Math.cos(pitch);
  const dz = dist * CAMERA_Z_BIAS;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: dx * cos - dz * sin,
    y: dist * Math.sin(pitch),
    z: dx * sin + dz * cos,
  };
}
