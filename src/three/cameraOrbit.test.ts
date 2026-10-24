import { describe, expect, it } from 'vitest';
import {
  CAMERA_TILT,
  CAMERA_Z_BIAS,
  ORBIT_PITCH_MAX,
  ORBIT_PITCH_MIN,
  clampOrbitPitch,
  orbitOffset,
} from './cameraOrbit.ts';

describe('orbitOffset', () => {
  it('matches the historical fixed camera at yaw 0 and default tilt', () => {
    const dist = 320;
    const off = orbitOffset(dist, 0, CAMERA_TILT);
    expect(off.x).toBeCloseTo(-dist * Math.cos(CAMERA_TILT));
    expect(off.y).toBeCloseTo(dist * Math.sin(CAMERA_TILT));
    expect(off.z).toBeCloseTo(dist * CAMERA_Z_BIAS);
  });

  it('keeps height and XZ radius when yaw changes (orbit around look-at)', () => {
    const dist = 200;
    const a = orbitOffset(dist, 0, CAMERA_TILT);
    const b = orbitOffset(dist, 0.7, CAMERA_TILT);
    expect(b.y).toBeCloseTo(a.y);
    const radiusA = Math.hypot(a.x, a.z);
    const radiusB = Math.hypot(b.x, b.z);
    expect(radiusB).toBeCloseTo(radiusA);
    expect(b.x).not.toBeCloseTo(a.x);
  });

  it('adds micro-pan yaw on top of user yaw instead of replacing it', () => {
    const dist = 200;
    const user = 0.4;
    const micro = 5 * (Math.PI / 180);
    const combined = orbitOffset(dist, user + micro, CAMERA_TILT);
    const userOnly = orbitOffset(dist, user, CAMERA_TILT);
    expect(combined.x).not.toBeCloseTo(userOnly.x);
    expect(combined.y).toBeCloseTo(userOnly.y);
  });

  it('raises the camera as pitch increases, without going negative', () => {
    const dist = 200;
    const low = orbitOffset(dist, 0, ORBIT_PITCH_MIN);
    const high = orbitOffset(dist, 0, ORBIT_PITCH_MAX);
    expect(low.y).toBeGreaterThan(0);
    expect(high.y).toBeGreaterThan(low.y);
    expect(high.y).toBeLessThan(dist); // sin(max) < 1, never a true zenith
  });
});

describe('clampOrbitPitch', () => {
  it('rejects a zenith and a subterranean camera', () => {
    expect(clampOrbitPitch(Math.PI / 2)).toBe(ORBIT_PITCH_MAX);
    expect(clampOrbitPitch(-0.4)).toBe(ORBIT_PITCH_MIN);
    expect(clampOrbitPitch(CAMERA_TILT)).toBe(CAMERA_TILT);
  });
});
